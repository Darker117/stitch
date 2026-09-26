// LAN server for the Stitch phone app: pairing, a WebSocket that carries every IPC channel and
// event, and HTTP media endpoints (range files, thumbnails, wallpapers, uploads).
//
//   GET  /api/hello                         → who is this (no auth)
//   POST /api/pair       {code|secret, …}   → { token, deviceId, … } (pairing window only)
//   WS   /api/ws                            → first message { t:'auth', token }, then RPC
//   GET  /api/f/<mediaKey>/<abs path>       → a file (Range)
//   GET  /api/t/<mediaKey>/<size>/<path>    → JPEG thumbnail (falls back to the file)
//   GET  /api/wp/<mediaKey>/<id>/<rel>      → Wallpaper Engine web wallpaper files
//   POST /api/upload?name=…  (x-stitch-token) → { path } on the PC
import { app } from 'electron'
import { randomBytes, randomInt } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { hostname, networkInterfaces } from 'node:os'
import { WebSocketServer, type WebSocket } from 'ws'
import type { EventChannel, PairingInfo, RemoteHost } from '@shared/ipc'
import { invokeHandler, onEmit } from '../ipc'
import { decode, encode } from './codec'
import { addDevice, deviceForMediaKey, deviceForToken, pcId, removeDevice, rendezvous, touchDevice, type StoredDevice } from './devices'
import { mayServe, notFound, receiveUpload, sendFile, sendWallpaperFile, thumbnail } from './files'

/** Channels a phone may not call: PC-side dialogs and pairing management. */
const BLOCKED = new Set<string>([
  'sys:pickFiles',
  'sys:pickFolder',
  'sys:saveDialog',
  'remote:setEnabled',
  'remote:pairStart',
  'remote:pairCancel',
  'remote:revoke',
  'update:install'
])

interface Client {
  ws: WebSocket
  device: StoredDevice
  alive: boolean
}

export interface RemoteHooks {
  /** Pairing or connection state changed (Settings → Phone refreshes). */
  changed: () => void
  paired: (device: StoredDevice) => void
  /** Public address (Access from anywhere), if one is up. */
  publicUrl: () => string | undefined
}

/** Where a request really came from (tunnels connect from localhost and forward the client IP). */
function clientIp(req: IncomingMessage): string {
  const cf = req.headers['cf-connecting-ip']
  if (typeof cf === 'string' && cf) return cf
  const xff = req.headers['x-forwarded-for']
  if (typeof xff === 'string' && xff) return xff.split(',')[0].trim()
  return req.socket.remoteAddress?.replace(/^::ffff:/, '') ?? ''
}

/** Failed auth/pairing attempts per address: 20 in 10 minutes locks that address out for 10 minutes. */
class Limiter {
  private hits = new Map<string, number[]>()
  blocked(ip: string): boolean {
    const now = Date.now()
    const list = (this.hits.get(ip) ?? []).filter((t) => now - t < 600_000)
    this.hits.set(ip, list)
    return list.length >= 20
  }
  fail(ip: string): void {
    const list = this.hits.get(ip) ?? []
    list.push(Date.now())
    this.hits.set(ip, list)
    if (this.hits.size > 5000) this.hits.clear()
  }
}

// ─── Addresses ───────────────────────────────────────────────────────────────

function isTailscale(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number)
  return a === 100 && b >= 64 && b <= 127
}

function isPrivate(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number)
  return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)
}

/** IPv4 addresses a phone can reach, LAN first. */
export function localHosts(): RemoteHost[] {
  const out: RemoteHost[] = []
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue
      // Skip virtual adapters (Hyper-V, WSL, VirtualBox, VMware) — phones can't reach them.
      if (/vEthernet|WSL|VirtualBox|VMware|Hyper-V|Loopback/i.test(name) && !isTailscale(a.address)) continue
      out.push({ address: a.address, label: isTailscale(a.address) ? 'Tailscale' : isPrivate(a.address) ? 'LAN' : 'Other' })
    }
  }
  const rank = (h: RemoteHost): number => (h.label === 'LAN' ? 0 : h.label === 'Tailscale' ? 1 : 2)
  return out.sort((x, y) => rank(x) - rank(y))
}

export function pcName(): string {
  return hostname().replace(/\.local$/i, '')
}

// ─── Server ──────────────────────────────────────────────────────────────────

export class RemoteServer {
  private server: Server | null = null
  private wss: WebSocketServer | null = null
  private clients = new Set<Client>()
  private offEmit: (() => void) | null = null
  private heartbeat: NodeJS.Timeout | null = null
  private pairing: { code: string; secret: string; expiresAt: number; failures: number } | null = null
  /** Coalesce rapid job progress (live previews) per job so phones get ~6 updates/s. */
  private throttled = new Map<string, { timer: NodeJS.Timeout; payload: unknown; event: EventChannel }>()
  port = 0
  error?: string
  private limiter = new Limiter()

  constructor(private readonly hooks: RemoteHooks) {}

  /** Every base URL a phone can try, best first: LAN, Tailscale, then the public address. */
  endpoints(): string[] {
    const list = localHosts().map((h) => `http://${h.address}:${this.port}`)
    const pub = this.hooks.publicUrl()
    if (pub) list.push(pub)
    return list
  }

  /** Tell connected phones about new addresses (e.g. the public tunnel changed). */
  announceEndpoints(): void {
    const text = encode({ t: 'endpoints', endpoints: this.endpoints(), rendezvous: rendezvous() })
    for (const c of this.clients) if (c.ws.readyState === c.ws.OPEN) c.ws.send(text)
  }

  get running(): boolean {
    return !!this.server?.listening
  }

  onlineDeviceIds(): Set<string> {
    return new Set([...this.clients].map((c) => c.device.id))
  }

  async start(port: number): Promise<void> {
    await this.stop()
    this.error = undefined
    const server = createServer((req, res) => void this.onHttp(req, res))
    const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 * 1024, perMessageDeflate: { threshold: 8192 } })
    server.on('upgrade', (req, socket, head) => {
      if (!req.url?.startsWith('/api/ws')) return socket.destroy()
      wss.handleUpgrade(req, socket, head, (ws) => this.onSocket(ws, req))
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '0.0.0.0', () => {
        server.off('error', reject)
        resolve()
      })
    }).catch((err: NodeJS.ErrnoException) => {
      this.error = err.code === 'EADDRINUSE' ? `Port ${port} is already in use` : err.message
      throw new Error(this.error)
    })
    server.on('error', (err) => {
      this.error = err.message
      this.hooks.changed()
    })
    this.server = server
    this.wss = wss
    this.port = port
    this.offEmit = onEmit((event, payload) => this.broadcast(event, payload))
    this.heartbeat = setInterval(() => {
      for (const c of this.clients) {
        if (!c.alive) {
          c.ws.terminate()
          continue
        }
        c.alive = false
        try {
          c.ws.ping()
        } catch {
          /* closing */
        }
      }
    }, 20_000)
  }

  async stop(): Promise<void> {
    this.offEmit?.()
    this.offEmit = null
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
    for (const t of this.throttled.values()) clearTimeout(t.timer)
    this.throttled.clear()
    for (const c of this.clients) c.ws.close(1001, 'Stitch stopped the phone remote')
    this.clients.clear()
    this.wss?.close()
    this.wss = null
    const s = this.server
    this.server = null
    if (s) await new Promise<void>((r) => s.close(() => r()))
  }

  // ─── Pairing ───────────────────────────────────────────────────────────────

  startPairing(qrSvg: (text: string) => Promise<string>): Promise<PairingInfo> {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    const secret = randomBytes(18).toString('base64url')
    const expiresAt = Date.now() + 10 * 60_000
    this.pairing = { code, secret, expiresAt, failures: 0 }
    const r = rendezvous()
    const payload = { v: 2, id: pcId(), n: pcName(), e: this.endpoints(), s: secret, r: [r.topic, r.key] }
    const url = `stitch://pair?d=${Buffer.from(JSON.stringify(payload)).toString('base64url')}`
    return qrSvg(url).then((svg) => ({ code, expiresAt, url, qrSvg: svg }))
  }

  cancelPairing(): void {
    this.pairing = null
  }

  /** Revoke a device and drop its live connection. */
  revoke(id: string): void {
    removeDevice(id)
    for (const c of this.clients) if (c.device.id === id) c.ws.close(4003, 'Unpaired from the PC')
  }

  // ─── HTTP ──────────────────────────────────────────────────────────────────

  private cors(res: ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', 'content-type, x-stitch-token, range')
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS')
    res.setHeader('Access-Control-Expose-Headers', 'content-range, content-length, accept-ranges')
    // Let the phone's WebView (http://localhost) reach this private-network address.
    res.setHeader('Access-Control-Allow-Private-Network', 'true')
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }

  private async onHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.cors(res)
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }
    const url = new URL(req.url ?? '/', 'http://x')
    const parts = url.pathname.split('/').filter(Boolean)
    if (url.pathname !== '/api/hello' && this.limiter.blocked(clientIp(req))) return this.json(res, 429, { error: 'Too many attempts — wait a few minutes.' })
    try {
      if (url.pathname === '/api/hello') {
        return this.json(res, 200, { app: 'stitch', version: app.getVersion(), pcId: pcId(), pcName: pcName(), pairing: !!this.pairing && this.pairing.expiresAt > Date.now() })
      }
      if (url.pathname === '/api/pair' && req.method === 'POST') return await this.onPair(req, res)

      if (parts[0] === 'api' && (parts[1] === 'f' || parts[1] === 't' || parts[1] === 'wp')) {
        const device = deviceForMediaKey(parts[2])
        if (!device) {
          this.limiter.fail(clientIp(req))
          return notFound(res, 401, 'Not paired')
        }
        if (parts[1] === 'wp') return sendWallpaperFile(req, res, decodeURIComponent(parts[3] ?? ''), parts.slice(4).map(decodeURIComponent).join('/'))
        const rest = parts[1] === 't' ? parts.slice(4) : parts.slice(3)
        const path = filePath(rest)
        if (!path || !mayServe(path)) return notFound(res, 403, 'Forbidden')
        if (parts[1] === 't') {
          const size = Math.min(1600, Math.max(64, Number(parts[3]) || 480))
          const thumb = await thumbnail(path, size)
          return sendFile(req, res, thumb ?? path, thumb ? { 'Cache-Control': 'private, max-age=86400' } : {})
        }
        return sendFile(req, res, path)
      }

      if (url.pathname === '/api/upload' && req.method === 'POST') {
        const device = deviceForToken(req.headers['x-stitch-token'] as string | undefined)
        if (!device) {
          this.limiter.fail(clientIp(req))
          return this.json(res, 401, { error: 'Not paired' })
        }
        const path = await receiveUpload(req, url.searchParams.get('name') ?? 'upload')
        return this.json(res, 200, { path })
      }
      notFound(res)
    } catch (err) {
      console.error('[remote] http error', err)
      if (!res.headersSent) this.json(res, 500, { error: err instanceof Error ? err.message : String(err) })
      else res.end()
    }
  }

  private async onPair(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ip = clientIp(req)
    if (this.limiter.blocked(ip)) return this.json(res, 429, { error: 'Too many attempts — wait a few minutes.' })
    const body = await readJson(req)
    const p = this.pairing
    if (!p || p.expiresAt < Date.now()) return this.json(res, 403, { error: 'Pairing is closed. On the PC open Settings → Phone and press "Pair a phone".' })
    const ok = (typeof body.secret === 'string' && body.secret === p.secret) || (typeof body.code === 'string' && body.code.replace(/\D/g, '') === p.code)
    if (!ok) {
      this.limiter.fail(ip)
      p.failures++
      if (p.failures >= 5) this.pairing = null
      return this.json(res, 403, { error: p.failures >= 5 ? 'Too many wrong codes — start pairing again on the PC.' : 'That code is not right.' })
    }
    this.pairing = null
    const { device, token } = addDevice({
      name: String(body.deviceName ?? 'Phone'),
      platform: String(body.platform ?? 'android'),
      appVersion: typeof body.appVersion === 'string' ? body.appVersion : undefined,
      address: ip
    })
    this.hooks.paired(device)
    this.hooks.changed()
    this.json(res, 200, { token, deviceId: device.id, mediaKey: device.mediaKey, pcId: pcId(), pcName: pcName(), endpoints: this.endpoints(), rendezvous: rendezvous(), port: this.port })
  }

  // ─── WebSocket RPC ─────────────────────────────────────────────────────────

  private onSocket(ws: WebSocket, req: IncomingMessage): void {
    let client: Client | null = null
    const address = clientIp(req)
    if (this.limiter.blocked(address)) {
      ws.close(4029, 'Too many attempts')
      return
    }
    const authTimer = setTimeout(() => {
      if (!client) ws.close(4001, 'Auth timeout')
    }, 8000)

    ws.on('message', (data) => {
      let msg: { t: string; id?: number; ch?: string; a?: unknown[]; token?: string; device?: { name?: string; appVersion?: string } }
      try {
        msg = decode(data.toString())
      } catch {
        return
      }
      if (!client) {
        if (msg.t !== 'auth') return ws.close(4001, 'Auth first')
        const device = deviceForToken(msg.token)
        if (!device) {
          this.limiter.fail(address)
          ws.send(encode({ t: 'denied', reason: 'This phone is not paired with the PC (or was unpaired).' }))
          return ws.close(4003, 'Not paired')
        }
        clearTimeout(authTimer)
        client = { ws, device, alive: true }
        this.clients.add(client)
        touchDevice(device.id, { lastAddress: address, appVersion: msg.device?.appVersion })
        ws.send(encode({ t: 'ready', deviceId: device.id, mediaKey: device.mediaKey, pc: { id: pcId(), name: pcName(), version: app.getVersion() }, endpoints: this.endpoints(), rendezvous: rendezvous(), port: this.port }))
        this.hooks.changed()
        return
      }
      if (msg.t === 'ping') return ws.send('{"t":"pong"}')
      if (msg.t === 'call' && typeof msg.id === 'number' && typeof msg.ch === 'string') void this.onCall(client, msg.id, msg.ch, Array.isArray(msg.a) ? msg.a : [])
    })
    ws.on('pong', () => {
      if (client) client.alive = true
    })
    ws.on('close', () => {
      clearTimeout(authTimer)
      if (client) {
        this.clients.delete(client)
        touchDevice(client.device.id, {})
        this.hooks.changed()
      }
    })
    ws.on('error', () => ws.terminate())
  }

  private async onCall(client: Client, id: number, ch: string, args: unknown[]): Promise<void> {
    let reply: unknown
    try {
      if (ch === 'remote:forgetMe') {
        this.revoke(client.device.id)
        this.hooks.changed()
        reply = { t: 'res', id, ok: true, v: null }
      } else {
        if (BLOCKED.has(ch)) throw new Error(`${ch} is only available on the PC`)
        // Phone-remote settings change only through the remote:* channels (which apply them).
        if (ch === 'settings:update' && args[0] && typeof args[0] === 'object') {
          const patch = args[0] as { remote?: { background?: boolean } }
          if (patch.remote) patch.remote = patch.remote.background === undefined ? undefined : { background: patch.remote.background }
        }
        reply = { t: 'res', id, ok: true, v: (await invokeHandler(ch, args)) ?? null }
      }
    } catch (err) {
      reply = { t: 'res', id, ok: false, e: err instanceof Error ? err.message : String(err) }
    }
    if (client.ws.readyState === client.ws.OPEN) client.ws.send(encode(reply))
  }

  private broadcast(event: EventChannel, payload: unknown): void {
    if (!this.clients.size) return
    // Live previews stream many frames a second; phones get the latest ~6/s per job.
    if (event === 'gen:job') {
      const job = payload as { id: string; status: string }
      if (job.status === 'running') {
        const key = `job:${job.id}`
        const pending = this.throttled.get(key)
        if (pending) {
          pending.payload = payload
          return
        }
        this.send(event, payload)
        this.throttled.set(key, {
          event,
          payload: null,
          timer: setTimeout(() => {
            const t = this.throttled.get(key)
            this.throttled.delete(key)
            if (t?.payload) this.send(t.event, t.payload)
          }, 160)
        })
        return
      }
      const key = `job:${job.id}`
      const pending = this.throttled.get(key)
      if (pending) {
        clearTimeout(pending.timer)
        this.throttled.delete(key)
      }
    }
    this.send(event, payload)
  }

  private send(event: EventChannel, payload: unknown): void {
    const text = encode({ t: 'ev', ev: event, p: payload })
    for (const c of this.clients) if (c.ws.readyState === c.ws.OPEN) c.ws.send(text)
  }
}

/** `/api/f/<key>/C:/Users/…` → an absolute path (drive letters and UNC shares included). */
function filePath(parts: string[]): string | null {
  if (!parts.length) return null
  const joined = parts.map(decodeURIComponent).join('/')
  if (/^[a-zA-Z]:/.test(joined)) return joined
  if (process.platform !== 'win32') return '/' + joined
  return null
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > 64 * 1024) throw new Error('Body too large')
    chunks.push(chunk as Buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}
