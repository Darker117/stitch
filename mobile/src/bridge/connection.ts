// The live link to the PC: one WebSocket carrying every IPC call and event. It tries every known
// address (Wi-Fi, Tailscale, the public "anywhere" address), follows the PC's encrypted relay when the
// public address changes, and hops back to Wi-Fi when you get home.
import { create } from 'zustand'
import { APP_VERSION, probe, relayLookup, routeOf, savePairing, type Pairing } from './pairing'

export type LinkState = 'idle' | 'connecting' | 'ready' | 'reconnecting' | 'unpaired'

interface LinkStore {
  state: LinkState
  pairing: Pairing | null
  /** Base URL in use (e.g. http://192.168.1.2:47847 or https://…trycloudflare.com). */
  endpoint: string | null
  /** Short host for display. */
  host: string | null
  route: 'LAN' | 'Tailscale' | 'Internet'
  pcName: string
  pcVersion?: string
  error?: string
  /** Consecutive failed attempts (drives the offline UI). */
  failures: number
  /** When the link last dropped (ms), null while connected. */
  downSince: number | null
}

export const useLink = create<LinkStore>(() => ({ state: 'idle', pairing: null, endpoint: null, host: null, route: 'LAN', pcName: '', failures: 0, downSince: null }))

const hostOf = (endpoint: string): string => {
  try {
    return new URL(endpoint).host
  } catch {
    return endpoint
  }
}

// ─── Wire codec (binary as base64, like the PC side) ─────────────────────────

const BYTES = '$b64'

function toB64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

function encode(v: unknown): string {
  return JSON.stringify(v, (_k, x) => {
    if (x instanceof Uint8Array) return { [BYTES]: toB64(x) }
    if (x instanceof ArrayBuffer) return { [BYTES]: toB64(new Uint8Array(x)) }
    return x
  })
}

function decode(text: string): unknown {
  return JSON.parse(text, (_k, x) => {
    if (x && typeof x === 'object' && !Array.isArray(x) && typeof x[BYTES] === 'string' && Object.keys(x).length === 1) {
      const bin = atob(x[BYTES])
      const out = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
      return out
    }
    return x
  })
}

// ─── Connection ──────────────────────────────────────────────────────────────

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type Listener = (payload: unknown) => void

/** Calls that may legitimately run for a long time on the PC. */
const SLOW = /^(gen:wait|llm:complete|voice:|models:install|civitai:download|skills:analyze|assets:import|editor:|models:identify|sys:detect|update:check|connectors:test)/

class Link {
  private ws: WebSocket | null = null
  private seq = 0
  private pending = new Map<number, Pending>()
  private waiting: { run: () => void; fail: (e: Error) => void; timer: ReturnType<typeof setTimeout> }[] = []
  private listeners = new Map<string, Set<Listener>>()
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private localTimer: ReturnType<typeof setInterval> | null = null
  private pongAt = 0
  private attempt = 0
  private stopped = true
  private relayAt = 0
  /** Closing on purpose to hop to a better route. */
  private switching = false
  private readyListeners = new Set<() => void>()

  get ready(): boolean {
    return useLink.getState().state === 'ready'
  }

  start(pairing: Pairing): void {
    this.stopped = false
    this.attempt = 0
    useLink.setState({ pairing, pcName: pairing.pcName, state: 'connecting', error: undefined, failures: 0, downSince: null })
    this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.closeSocket()
    useLink.setState({ state: 'idle', endpoint: null, host: null })
  }

  /** Try again right now (app resumed, network changed, user tapped Retry). */
  kick(): void {
    if (this.stopped) return
    if (useLink.getState().state === 'ready') {
      this.ping()
      void this.preferLocal()
      return
    }
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.attempt = 0
    if (!this.ws) this.connect()
  }

  onReady(fn: () => void): () => void {
    this.readyListeners.add(fn)
    return () => this.readyListeners.delete(fn)
  }

  private endpointsInOrder(p: Pairing): string[] {
    // Last good first, then local before public.
    const rank = (e: string): number => (routeOf(e) === 'LAN' ? 0 : routeOf(e) === 'Tailscale' ? 1 : 2)
    const rest = [...p.endpoints].sort((a, b) => rank(a) - rank(b))
    return [...new Set(p.lastEndpoint ? [p.lastEndpoint, ...rest] : rest)]
  }

  private update(p: Pairing): void {
    useLink.setState({ pairing: p })
    if (p.pcId !== 'dev') void savePairing(p)
  }

  private connect(): void {
    const p = useLink.getState().pairing
    if (!p || this.stopped) return
    const list = this.endpointsInOrder(p)
    const endpoint = list[this.attempt % list.length]
    const s = useLink.getState()
    useLink.setState({ state: s.state === 'connecting' || s.state === 'idle' ? 'connecting' : 'reconnecting', endpoint, host: hostOf(endpoint), route: routeOf(endpoint) })

    let ws: WebSocket
    try {
      ws = new WebSocket(`${endpoint.replace(/^http/i, 'ws')}/api/ws`)
    } catch {
      this.scheduleRetry()
      return
    }
    this.ws = ws
    let authed = false
    // Public tunnels take longer to open than the LAN.
    const openTimer = setTimeout(() => {
      if (!authed) ws.close()
    }, routeOf(endpoint) === 'Internet' ? 9000 : 4000)

    ws.onopen = () => ws.send(encode({ t: 'auth', token: p.token, device: { appVersion: APP_VERSION } }))
    ws.onmessage = (ev) => {
      let msg: {
        t: string
        id?: number
        ok?: boolean
        v?: unknown
        e?: string
        ev?: string
        p?: unknown
        reason?: string
        mediaKey?: string
        pc?: { name: string; version: string }
        endpoints?: string[]
        rendezvous?: Pairing['rendezvous']
      }
      try {
        msg = decode(String(ev.data)) as typeof msg
      } catch {
        return
      }
      switch (msg.t) {
        case 'ready': {
          authed = true
          clearTimeout(openTimer)
          this.attempt = 0
          const cur = useLink.getState().pairing ?? p
          const next: Pairing = {
            ...cur,
            lastEndpoint: endpoint,
            mediaKey: msg.mediaKey ?? cur.mediaKey,
            pcName: msg.pc?.name ?? cur.pcName,
            rendezvous: msg.rendezvous ?? cur.rendezvous,
            // Fresh list from the PC, plus whatever worked before (kept for fallback).
            endpoints: [...new Set([...(msg.endpoints ?? []), endpoint, ...cur.endpoints])].slice(0, 10)
          }
          this.update(next)
          useLink.setState({ state: 'ready', endpoint, host: hostOf(endpoint), route: routeOf(endpoint), pcName: next.pcName, pcVersion: msg.pc?.version, failures: 0, downSince: null, error: undefined })
          this.startPing()
          for (const w of this.waiting.splice(0)) {
            clearTimeout(w.timer)
            w.run()
          }
          for (const fn of this.readyListeners) fn()
          break
        }
        case 'endpoints': {
          const cur = useLink.getState().pairing
          if (cur && msg.endpoints) this.update({ ...cur, endpoints: [...new Set([...msg.endpoints, ...cur.endpoints])].slice(0, 10), rendezvous: msg.rendezvous ?? cur.rendezvous })
          break
        }
        case 'denied':
          authed = true
          clearTimeout(openTimer)
          this.stopped = true
          useLink.setState({ state: 'unpaired', error: msg.reason })
          this.failAll(new Error(msg.reason ?? 'Not paired'))
          break
        case 'res': {
          const pend = this.pending.get(msg.id!)
          if (!pend) return
          this.pending.delete(msg.id!)
          clearTimeout(pend.timer)
          if (msg.ok) pend.resolve(msg.v ?? undefined)
          else pend.reject(new Error(msg.e ?? 'Failed on the PC'))
          break
        }
        case 'ev':
          this.dispatch(msg.ev!, msg.p)
          break
        case 'pong':
          this.pongAt = Date.now()
          break
      }
    }
    ws.onclose = (ev) => {
      clearTimeout(openTimer)
      if (this.ws !== ws) return
      this.ws = null
      this.stopTimers()
      // Calls in flight can't complete on a dead socket.
      for (const [id, pend] of this.pending) {
        clearTimeout(pend.timer)
        pend.reject(new Error('Lost connection to your PC'))
        this.pending.delete(id)
      }
      if (this.switching) {
        this.switching = false
        this.attempt = 0
        this.connect()
        return
      }
      if (ev.code === 4003) {
        this.stopped = true
        useLink.setState({ state: 'unpaired', error: ev.reason || 'This phone was unpaired on the PC.' })
        return
      }
      if (useLink.getState().state === 'ready') useLink.setState({ downSince: Date.now() })
      if (!this.stopped) this.scheduleRetry()
    }
    ws.onerror = () => {
      /* onclose follows */
    }
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return
    this.attempt++
    const s = useLink.getState()
    const n = s.pairing?.endpoints.length ?? 1
    // Cycle every address quickly, then back off; after each full round ask the relay where the PC is.
    const fullRound = this.attempt % n === 0
    const round = Math.floor((this.attempt - 1) / Math.max(1, n))
    const delay = fullRound ? Math.min(8000, 600 * 2 ** Math.min(round, 4)) : 120
    useLink.setState({ state: 'reconnecting', failures: s.failures + 1, downSince: s.downSince ?? Date.now() })
    if (fullRound) void this.followRelay()
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.connect()
    }, delay)
  }

  /** The PC's public address may have changed while we were away: read it from the relay. */
  private async followRelay(): Promise<void> {
    const p = useLink.getState().pairing
    if (!p?.rendezvous || Date.now() - this.relayAt < 30_000) return
    this.relayAt = Date.now()
    const url = await relayLookup(p.rendezvous)
    const cur = useLink.getState().pairing
    if (!url || !cur || cur.endpoints[0] === url) return
    // Put it first and try it next.
    this.update({ ...cur, endpoints: [url, ...cur.endpoints.filter((e) => e !== url)].slice(0, 10), lastEndpoint: url })
    this.attempt = 0
  }

  /** Connected over the internet but home again? Hop to the direct Wi-Fi route. */
  private async preferLocal(): Promise<void> {
    const s = useLink.getState()
    if (s.state !== 'ready' || s.route === 'LAN' || !s.pairing) return
    const local = s.pairing.endpoints.filter((e) => routeOf(e) !== 'Internet' && e !== s.endpoint)
    if (!local.length) return
    const hit = await probe(local, s.pairing.pcId, 2000)
    if (!hit || useLink.getState().endpoint !== s.endpoint) return
    if (routeOf(hit.endpoint) === 'Tailscale' && s.route === 'Tailscale') return
    this.update({ ...s.pairing, lastEndpoint: hit.endpoint })
    this.attempt = 0
    // Only swap when idle, so nothing in flight is cut off.
    if (this.pending.size === 0 && this.ws) {
      this.switching = true
      this.ws.close()
    }
  }

  private closeSocket(): void {
    const ws = this.ws
    this.ws = null
    this.stopTimers()
    if (ws) {
      ws.onclose = null
      ws.close()
    }
  }

  private startPing(): void {
    this.stopTimers()
    this.pongAt = Date.now()
    this.pingTimer = setInterval(() => this.ping(), 10_000)
    this.localTimer = setInterval(() => void this.preferLocal(), 45_000)
  }

  private stopTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    if (this.localTimer) clearInterval(this.localTimer)
    this.pingTimer = null
    this.localTimer = null
  }

  private ping(): void {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    // No pong for two rounds → the socket is dead (Wi-Fi switched, PC slept).
    if (Date.now() - this.pongAt > 25_000) {
      ws.close()
      return
    }
    ws.send('{"t":"ping"}')
  }

  private failAll(err: Error): void {
    for (const [, pend] of this.pending) {
      clearTimeout(pend.timer)
      pend.reject(err)
    }
    this.pending.clear()
    for (const w of this.waiting.splice(0)) {
      clearTimeout(w.timer)
      w.fail(err)
    }
  }

  call(ch: string, args: unknown[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const send = (): void => {
        const ws = this.ws
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          reject(new Error('Lost connection to your PC'))
          return
        }
        const id = ++this.seq
        const timer = setTimeout(
          () => {
            this.pending.delete(id)
            reject(new Error(`Your PC didn't answer (${ch})`))
          },
          SLOW.test(ch) ? 30 * 60_000 : 90_000
        )
        this.pending.set(id, { resolve, reject, timer })
        ws.send(encode({ t: 'call', id, ch, a: args }))
      }
      if (this.ready && this.ws) return send()
      if (useLink.getState().state === 'unpaired') return reject(new Error('This phone is not paired with a PC'))
      // Hold the call until the link is back (briefly).
      const timer = setTimeout(() => {
        this.waiting = this.waiting.filter((w) => w.timer !== timer)
        reject(new Error("Can't reach your PC right now"))
      }, 20_000)
      this.waiting.push({ run: send, fail: reject, timer })
    })
  }

  on(event: string, fn: Listener): () => void {
    let set = this.listeners.get(event)
    if (!set) this.listeners.set(event, (set = new Set()))
    set.add(fn)
    return () => set!.delete(fn)
  }

  /** Deliver an event to listeners (from the PC, or produced on the phone). */
  dispatch(event: string, payload: unknown): void {
    const set = this.listeners.get(event)
    if (!set) return
    for (const fn of [...set]) {
      try {
        fn(payload)
      } catch (err) {
        console.error(`[link] listener for ${event} failed`, err)
      }
    }
  }

  /** Base URL of the PC's HTTP server for the current route. */
  baseUrl(): string {
    const s = useLink.getState()
    return s.endpoint ?? s.pairing?.lastEndpoint ?? s.pairing?.endpoints[0] ?? ''
  }
}

export const link = new Link()
