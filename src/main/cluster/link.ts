// Main side of a link: one authenticated control WebSocket to the node (requests, hardware and
// service updates), reconnecting on its own, plus local tunnels to the node's ComfyUI / rpc-server.
import { createReadStream, statSync } from 'node:fs'
import { request } from 'node:http'
import { nanoid } from 'nanoid'
import WebSocket from 'ws'
import type { LinkedNode, ModelCopy, NodeService, PcHardware } from '@shared/ipc'
import { nodeToken, touchNode, type StoredNode } from './store'
import { rankAddress } from './discovery'
import { TcpTunnel } from './tunnel'

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
}

export class NodeLink {
  state: LinkedNode['state'] = 'connecting'
  error?: string
  hw?: PcHardware
  services: NodeService[] = []
  models?: Record<string, string[]>
  version?: string
  /** Address the control socket is connected on. */
  address?: string
  copies: (ModelCopy & { abort?: () => void; at: number })[] = []
  private ws: WebSocket | null = null
  private calls = new Map<number, Pending>()
  private seq = 0
  private retry: NodeJS.Timeout | null = null
  private backoff = 0
  private closed = false
  private tunnels = new Map<string, TcpTunnel>()

  constructor(
    public rec: StoredNode,
    private readonly hooks: { changed: () => void; online: (link: NodeLink) => void }
  ) {}

  get id(): string {
    return this.rec.id
  }

  get online(): boolean {
    return this.state === 'online'
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${nodeToken(this.rec.id) ?? ''}` }
  }

  /** Try each known address until the node answers. */
  connect(): void {
    this.closed = false
    if (this.ws || this.retry) return
    const addrs = [...this.rec.addresses].sort((a, b) => rankAddress(a) - rankAddress(b))
    if (!addrs.length || !nodeToken(this.rec.id)) {
      this.state = 'offline'
      this.error = 'No address for this PC yet'
      this.hooks.changed()
      return
    }
    void this.tryAddresses(addrs)
  }

  private async tryAddresses(addrs: string[]): Promise<void> {
    for (const addr of addrs) {
      if (this.closed) return
      const res = await this.open(addr)
      if (res === 'ok' || res === 'revoked') return
    }
    if (!this.closed) {
      if (this.state !== 'revoked') this.state = 'offline'
      this.hooks.changed()
      this.schedule()
    }
  }

  private open(addr: string): Promise<'ok' | 'failed' | 'revoked'> {
    return new Promise((resolve) => {
      const ws = new WebSocket(`ws://${host(addr)}:${this.rec.port}/api/node/ws`, { headers: this.headers(), handshakeTimeout: 5000, perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 })
      let settled = false
      const done = (r: 'ok' | 'failed' | 'revoked'): void => {
        if (!settled) {
          settled = true
          resolve(r)
        }
      }
      ws.on('unexpected-response', (_req, res) => {
        ws.terminate()
        if (res.statusCode === 401) {
          this.state = 'revoked'
          this.error = `${this.rec.name} no longer recognises this PC — link it again.`
          this.hooks.changed()
          done('revoked')
        } else {
          this.error = res.statusCode === 403 ? `${this.rec.name} isn't offering itself as a node right now.` : `${this.rec.name} answered ${res.statusCode}`
          done('failed')
        }
      })
      ws.on('error', (err) => {
        if (!settled) this.error = `Can't reach ${this.rec.name} (${err.message})`
        done('failed')
      })
      ws.on('open', () => {
        this.ws = ws
        this.address = addr
        this.backoff = 0
        done('ok')
      })
      ws.on('message', (data) => this.onMessage(data.toString()))
      ws.on('close', (code) => {
        if (this.ws !== ws) return
        this.ws = null
        this.address = undefined
        for (const p of this.calls.values()) {
          clearTimeout(p.timer)
          p.reject(new Error(`${this.rec.name} disconnected`))
        }
        this.calls.clear()
        for (const t of this.tunnels.values()) t.reset()
        if (code === 4003) {
          this.state = 'revoked'
          this.error = `${this.rec.name} unlinked this PC.`
          this.hooks.changed()
          return
        }
        this.state = 'offline'
        this.hooks.changed()
        if (!this.closed) this.schedule()
      })
    })
  }

  private schedule(): void {
    if (this.retry || this.closed || this.state === 'revoked') return
    const delay = Math.min(30_000, 3000 * 2 ** this.backoff++)
    this.retry = setTimeout(() => {
      this.retry = null
      this.connect()
    }, delay)
  }

  /** New addresses from discovery: reconnect right away if we were stuck offline. */
  seenAt(addresses: string[], port: number): void {
    const merged = [...new Set([...addresses, ...this.rec.addresses])].sort((a, b) => rankAddress(a) - rankAddress(b)).slice(0, 6)
    const changed = merged.join() !== this.rec.addresses.join() || port !== this.rec.port
    if (changed) {
      this.rec = { ...this.rec, addresses: merged, port }
      touchNode(this.rec.id, { addresses: merged, port })
    }
    if (this.state === 'offline' && this.retry) {
      clearTimeout(this.retry)
      this.retry = null
      this.backoff = 0
      this.connect()
    }
  }

  private onMessage(text: string): void {
    let msg: { t: string; id?: number; ok?: boolean; v?: unknown; e?: string; hw?: PcHardware; services?: NodeService[]; models?: Record<string, string[]>; node?: { name?: string; version?: string } }
    try {
      msg = JSON.parse(text)
    } catch {
      return
    }
    switch (msg.t) {
      case 'ready':
        this.state = 'online'
        this.error = undefined
        this.version = msg.node?.version
        this.hw = msg.hw
        this.services = msg.services ?? []
        this.models = msg.models
        touchNode(this.rec.id, { name: msg.node?.name ?? this.rec.name, version: msg.node?.version })
        if (msg.node?.name) this.rec = { ...this.rec, name: msg.node.name }
        this.hooks.changed()
        this.hooks.online(this)
        break
      case 'hw':
        this.hw = msg.hw
        touchNode(this.rec.id, {})
        this.hooks.changed()
        break
      case 'svc':
        this.services = msg.services ?? []
        this.hooks.changed()
        break
      case 'models':
        this.models = msg.models
        this.hooks.changed()
        break
      case 'res': {
        const p = this.calls.get(msg.id ?? -1)
        if (!p) return
        this.calls.delete(msg.id!)
        clearTimeout(p.timer)
        if (msg.ok) p.resolve(msg.v)
        else p.reject(new Error(msg.e ?? 'Request failed'))
        break
      }
    }
  }

  call<T = unknown>(op: string, a: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    const ws = this.ws
    if (!ws || this.state !== 'online') return Promise.reject(new Error(`${this.rec.name} is offline`))
    const id = ++this.seq
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.calls.delete(id)
        reject(new Error(`${this.rec.name} didn't answer in time`))
      }, timeoutMs)
      this.calls.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      ws.send(JSON.stringify({ t: 'call', id, op, a }))
    })
  }

  /** Local port that relays to the node's ComfyUI or rpc-server on `gpu`. */
  async tunnel(kind: 'comfy' | 'rpc', gpu: number): Promise<number> {
    const key = `${kind}:${gpu}`
    let t = this.tunnels.get(key)
    if (!t) {
      t = new TcpTunnel(() => (this.address ? { url: `ws://${host(this.address)}:${this.rec.port}/api/node/tcp?to=${kind}&gpu=${gpu}`, headers: this.headers() } : null), `${this.rec.name} ${key}`)
      this.tunnels.set(key, t)
    }
    return t.listen()
  }

  closeTunnel(kind: 'comfy' | 'rpc', gpu: number): void {
    const key = `${kind}:${gpu}`
    this.tunnels.get(key)?.close()
    this.tunnels.delete(key)
  }

  service(kind: 'comfy' | 'rpc', gpu: number): NodeService | undefined {
    return this.services.find((s) => s.kind === kind && s.gpu === gpu)
  }

  /** Copy a model file to the node's models folder (streamed over the LAN). */
  copyModel(path: string, folder: string, name: string, onChange: () => void): ModelCopy {
    if (!this.address) throw new Error(`${this.rec.name} is offline`)
    const size = statSync(path).size
    const copy: ModelCopy & { abort?: () => void; at: number } = { id: nanoid(8), name, folder, sent: 0, total: size, state: 'copying', at: Date.now() }
    this.copies = [...this.copies.filter((c) => c.state === 'copying' || Date.now() - c.at < 60_000), copy]
    const q = new URLSearchParams({ folder, name, size: String(size) })
    const req = request({
      host: host(this.address).replace(/^\[|\]$/g, ''),
      port: this.rec.port,
      method: 'PUT',
      path: `/api/node/model?${q}`,
      headers: { ...this.headers(), 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) }
    })
    const file = createReadStream(path, { highWaterMark: 1024 * 1024 })
    let last = 0
    file.on('data', (chunk) => {
      copy.sent += chunk.length
      if (Date.now() - last > 400) {
        last = Date.now()
        onChange()
      }
    })
    const finish = (state: ModelCopy['state'], error?: string): void => {
      if (copy.state !== 'copying') return
      copy.state = state
      copy.error = error
      copy.at = Date.now()
      copy.abort = undefined
      onChange()
    }
    copy.abort = () => {
      finish('canceled')
      file.destroy()
      req.destroy()
    }
    req.on('response', (res) => {
      let body = ''
      res.on('data', (c: Buffer) => (body += c.toString()))
      res.on('end', () => {
        if (res.statusCode === 200) finish('done')
        else {
          let msg = `${res.statusCode}`
          try {
            msg = (JSON.parse(body) as { error?: string }).error ?? msg
          } catch {
            /* not json */
          }
          finish('error', msg)
        }
      })
    })
    req.on('error', (err) => finish('error', err.message))
    file.on('error', (err) => {
      finish('error', err.message)
      req.destroy()
    })
    file.pipe(req)
    onChange()
    return copy
  }

  close(): void {
    this.closed = true
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    for (const c of this.copies) c.abort?.()
    for (const t of this.tunnels.values()) t.close()
    this.tunnels.clear()
    const ws = this.ws
    this.ws = null
    ws?.close(1000, 'Main closed the link')
    for (const p of this.calls.values()) {
      clearTimeout(p.timer)
      p.reject(new Error('Link closed'))
    }
    this.calls.clear()
    this.state = 'offline'
  }

  view(): LinkedNode {
    return {
      id: this.rec.id,
      name: this.rec.name,
      address: this.address ?? this.rec.addresses[0],
      port: this.rec.port,
      state: this.state,
      error: this.state === 'online' ? undefined : this.error,
      version: this.version ?? this.rec.version,
      hardware: this.hw,
      services: this.services,
      lastSeenAt: this.rec.lastSeenAt,
      copies: this.copies.map(({ abort: _a, at: _t, ...c }) => c)
    }
  }
}

/** IPv6 literals need brackets in URLs. */
function host(addr: string): string {
  return addr.includes(':') && !addr.startsWith('[') ? `[${addr}]` : addr
}
