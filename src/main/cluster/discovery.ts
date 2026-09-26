// Finding Stitch nodes on the LAN over UDP (port 47848).
//   node — listens on 47848 and answers a main's "find" with a unicast "here" (name, port, GPUs).
//   main — broadcasts "find" every few seconds from a random port (every interface's broadcast
//          address, plus 127.0.0.1 for a node on the same PC) and lists who answered recently.
// Nothing secret travels here: linking needs the code the node shows, and every request after that
// carries the link token.
import { createSocket, type RemoteInfo, type Socket } from 'node:dgram'
import { networkInterfaces } from 'node:os'

export const DISCOVERY_PORT = 47848
const FIND_EVERY = 4000
const FORGET_AFTER = 15_000

export interface Announce {
  app: 'stitch'
  t: 'here'
  v: 1
  id: string
  name: string
  port: number
  version?: string
  gpus: { name: string; memTotal: number }[]
}

export interface Seen extends Announce {
  addresses: string[]
  at: number
}

function broadcastAddresses(): string[] {
  const out = new Set<string>(['255.255.255.255', '127.0.0.1'])
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue
      const ip = a.address.split('.').map(Number)
      const mask = a.netmask.split('.').map(Number)
      out.add(ip.map((b, i) => (b & mask[i]) | (~mask[i] & 255)).join('.'))
    }
  }
  return [...out]
}

/** Rank addresses: LAN first, then Tailscale, then loopback. */
export function rankAddress(a: string): number {
  const [x, y] = a.split('.').map(Number)
  if (x === 10 || (x === 192 && y === 168) || (x === 172 && y >= 16 && y <= 31)) return 0
  if (x === 100 && y >= 64 && y <= 127) return 1
  if (x === 127) return 3
  return 2
}

/** Node side: answer finds while this PC offers itself. */
export class Responder {
  private sock: Socket | null = null
  error?: string

  constructor(private readonly announce: () => Announce | null) {}

  start(): void {
    if (this.sock) return
    const sock = createSocket({ type: 'udp4', reuseAddr: true })
    sock.on('error', (err) => {
      this.error = err.message
      console.warn('[cluster] discovery responder:', err.message)
    })
    sock.on('message', (buf, rinfo) => this.onMessage(buf, rinfo))
    sock.bind(DISCOVERY_PORT, () => {
      this.error = undefined
    })
    this.sock = sock
  }

  private onMessage(buf: Buffer, rinfo: RemoteInfo): void {
    // Only PCs on the LAN, Tailscale or this PC learn that a node is here.
    if (buf.length > 2048 || rankAddress(rinfo.address) === 2) return
    let msg: { app?: string; t?: string }
    try {
      msg = JSON.parse(buf.toString('utf8'))
    } catch {
      return
    }
    if (msg.app !== 'stitch' || msg.t !== 'find') return
    const a = this.announce()
    if (!a) return
    this.sock?.send(Buffer.from(JSON.stringify(a)), rinfo.port, rinfo.address)
  }

  stop(): void {
    try {
      this.sock?.close()
    } catch {
      /* closed */
    }
    this.sock = null
  }
}

/** Main side: look for nodes. */
export class Finder {
  private sock: Socket | null = null
  private timer: NodeJS.Timeout | null = null
  private seen = new Map<string, Seen>()

  constructor(
    private readonly selfId: () => string,
    private readonly onChange: () => void
  ) {}

  start(): void {
    if (this.sock) return
    const sock = createSocket({ type: 'udp4' })
    sock.on('error', (err) => console.warn('[cluster] discovery:', err.message))
    sock.on('message', (buf, rinfo) => this.onMessage(buf, rinfo))
    sock.bind(0, () => {
      try {
        sock.setBroadcast(true)
      } catch {
        /* no broadcast on this adapter */
      }
      this.find()
    })
    this.sock = sock
    this.timer = setInterval(() => this.find(), FIND_EVERY)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    try {
      this.sock?.close()
    } catch {
      /* closed */
    }
    this.sock = null
    if (this.seen.size) {
      this.seen.clear()
      this.onChange()
    }
  }

  list(): Seen[] {
    return [...this.seen.values()]
  }

  /** Ask now (e.g. the Computers page just opened). */
  find(): void {
    const sock = this.sock
    if (!sock) return
    const msg = Buffer.from(JSON.stringify({ app: 'stitch', t: 'find', v: 1, id: this.selfId() }))
    for (const addr of broadcastAddresses()) sock.send(msg, DISCOVERY_PORT, addr, () => {})
    // Forget PCs that stopped answering.
    let changed = false
    for (const [id, s] of this.seen) {
      if (Date.now() - s.at > FORGET_AFTER) {
        this.seen.delete(id)
        changed = true
      }
    }
    if (changed) this.onChange()
  }

  private onMessage(buf: Buffer, rinfo: RemoteInfo): void {
    if (buf.length > 8192) return
    let msg: Announce
    try {
      msg = JSON.parse(buf.toString('utf8')) as Announce
    } catch {
      return
    }
    if (msg.app !== 'stitch' || msg.t !== 'here' || typeof msg.id !== 'string' || msg.id === this.selfId()) return
    const port = Number(msg.port)
    if (!(port > 0 && port < 65536)) return
    const prev = this.seen.get(msg.id)
    const addresses = [...new Set([rinfo.address, ...(prev && Date.now() - prev.at < FORGET_AFTER ? prev.addresses : [])])].sort((a, b) => rankAddress(a) - rankAddress(b))
    const next: Seen = {
      app: 'stitch',
      t: 'here',
      v: 1,
      id: msg.id.slice(0, 40),
      name: String(msg.name ?? 'Stitch PC').slice(0, 60),
      port,
      version: typeof msg.version === 'string' ? msg.version.slice(0, 20) : undefined,
      gpus: Array.isArray(msg.gpus) ? msg.gpus.slice(0, 16).map((g) => ({ name: String(g?.name ?? 'GPU').slice(0, 80), memTotal: Number(g?.memTotal) || 0 })) : [],
      addresses,
      at: Date.now()
    }
    const sig = (s?: Seen): string => JSON.stringify(s ? [s.name, s.port, s.version, s.gpus, s.addresses] : null)
    this.seen.set(msg.id, next)
    if (sig(prev) !== sig(next)) this.onChange()
  }
}
