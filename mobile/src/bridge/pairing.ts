// Pairing with a Stitch PC: QR payloads, 6-digit codes, saved credentials, and the encrypted relay
// that tells the phone where the PC is when its public address changes.
import { Preferences } from '@capacitor/preferences'

export interface Rendezvous {
  topic: string
  /** AES-256-GCM key, base64. */
  key: string
}

export interface Pairing {
  pcId: string
  pcName: string
  /** Base URLs to try, best first: http://<lan ip>:47847, http://<tailscale ip>:47847, https://<public>. */
  endpoints: string[]
  token: string
  deviceId: string
  /** Scoped key for media URLs; refreshed by every `ready`. */
  mediaKey: string
  /** Endpoint that answered last time — tried first. */
  lastEndpoint?: string
  rendezvous?: Rendezvous
  pairedAt: number
}

export interface QrPayload {
  id: string
  n: string
  e: string[]
  s: string
  r?: [string, string]
}

const KEY = 'stitch.pairing'
export const APP_VERSION = '0.1.0'
export const DEFAULT_PORT = 47847

/** Older saves kept `hosts` + `port`. */
function migrate(p: Pairing & { hosts?: string[]; port?: number; lastHost?: string }): Pairing {
  if (!p.endpoints?.length && p.hosts?.length) {
    p.endpoints = p.hosts.map((h) => `http://${h}:${p.port ?? DEFAULT_PORT}`)
    if (p.lastHost) p.lastEndpoint = `http://${p.lastHost}:${p.port ?? DEFAULT_PORT}`
  }
  return p
}

export async function loadPairing(): Promise<Pairing | null> {
  try {
    const { value } = await Preferences.get({ key: KEY })
    if (value) return migrate(JSON.parse(value))
  } catch {
    /* none */
  }
  // Dev: the web build can be pointed at a PC started with STITCH_REMOTE=1.
  const env = import.meta.env as Record<string, string | undefined>
  // `?unpaired` previews the first-run screens in the dev build.
  if (env.VITE_STITCH_PC && env.VITE_STITCH_TOKEN && !location.search.includes('unpaired')) {
    const ep = parseAddress(env.VITE_STITCH_PC)!
    return { pcId: 'dev', pcName: 'Dev PC', endpoints: [ep], token: env.VITE_STITCH_TOKEN, deviceId: 'dev', mediaKey: '', pairedAt: Date.now() }
  }
  return null
}

export async function savePairing(p: Pairing): Promise<void> {
  await Preferences.set({ key: KEY, value: JSON.stringify(p) })
}

export async function clearPairing(): Promise<void> {
  await Preferences.remove({ key: KEY })
}

function b64decode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** `stitch://pair?d=<base64url json>` (or the bare JSON) → payload. */
export function parseQr(text: string): QrPayload | null {
  try {
    let json = text.trim()
    const m = /[?&]d=([A-Za-z0-9_-]+)/.exec(json)
    if (m) json = new TextDecoder().decode(b64decode(m[1]))
    const p = JSON.parse(json) as QrPayload & { h?: string[]; p?: number }
    if (!p || typeof p.s !== 'string') return null
    if (!p.e && p.h) p.e = p.h.map((h) => `http://${h}:${p.p ?? DEFAULT_PORT}`)
    return Array.isArray(p.e) && p.e.length ? p : null
  } catch {
    return null
  }
}

export interface Hello {
  app: string
  version: string
  pcId: string
  pcName: string
  pairing: boolean
}

export async function fetchTimeout(url: string, init: RequestInit = {}, ms = 3000): Promise<Response> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), ms)
  try {
    return await fetch(url, { ...init, signal: ctrl.signal })
  } finally {
    clearTimeout(t)
  }
}

/** First endpoint that answers as (the right) Stitch PC; all probed in parallel. */
export async function probe(endpoints: string[], pcId?: string, ms = 4500): Promise<{ endpoint: string; hello: Hello } | null> {
  if (!endpoints.length) return null
  return new Promise((resolve) => {
    let left = endpoints.length
    let done = false
    for (const endpoint of endpoints) {
      fetchTimeout(`${endpoint}/api/hello`, {}, ms)
        .then((r) => (r.ok ? (r.json() as Promise<Hello>) : null))
        .then((hello) => {
          if (!done && hello?.app === 'stitch' && (!pcId || pcId === 'dev' || hello.pcId === pcId)) {
            done = true
            resolve({ endpoint, hello })
          }
        })
        .catch(() => {})
        .finally(() => {
          if (--left === 0 && !done) resolve(null)
        })
    }
  })
}

/**
 * What the user typed → a base URL. "192.168.1.20" / "192.168.1.20:47847" → http on the LAN port;
 * a domain ("abc.trycloudflare.com", "pc.tail123.ts.net:10000") → https; full URLs are kept.
 */
export function parseAddress(input: string): string | null {
  const s = input.trim().replace(/\/+$/, '')
  if (!s) return null
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s)
      return `${u.protocol}//${u.host}`
    } catch {
      return null
    }
  }
  const m = /^\[?([^\]/]+?)\]?(?::(\d+))?$/.exec(s)
  if (!m) return null
  const host = m[1]
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host === 'localhost'
  if (isIp) return `http://${host}:${m[2] ?? DEFAULT_PORT}`
  return `https://${host}${m[2] ? `:${m[2]}` : ''}`
}

/** LAN / Tailscale / Internet — for the connection label and "prefer local". */
export function routeOf(endpoint: string | null | undefined): 'LAN' | 'Tailscale' | 'Internet' {
  if (!endpoint) return 'Internet'
  try {
    const h = new URL(endpoint).hostname
    const [a, b] = h.split('.').map(Number)
    if (a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || h === 'localhost' || h === '127.0.0.1') return 'LAN'
    if (a === 100 && b >= 64 && b <= 127) return 'Tailscale'
  } catch {
    /* fallthrough */
  }
  return 'Internet'
}

export async function pair(endpoint: string, body: { secret?: string; code?: string }, deviceName: string, rendezvousHint?: Rendezvous): Promise<Pairing> {
  const res = await fetchTimeout(
    `${endpoint}/api/pair`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, deviceName, platform: 'android', appVersion: APP_VERSION }) },
    10_000
  )
  const data = (await res.json().catch(() => ({}))) as { error?: string; token?: string; deviceId?: string; mediaKey?: string; pcId?: string; pcName?: string; endpoints?: string[]; rendezvous?: Rendezvous }
  if (!res.ok || !data.token) throw new Error(data.error ?? `Pairing failed (${res.status})`)
  const p: Pairing = {
    pcId: data.pcId!,
    pcName: data.pcName ?? 'PC',
    endpoints: [...new Set([endpoint, ...(data.endpoints ?? [])])],
    token: data.token,
    deviceId: data.deviceId!,
    mediaKey: data.mediaKey ?? '',
    lastEndpoint: endpoint,
    rendezvous: data.rendezvous ?? rendezvousHint,
    pairedAt: Date.now()
  }
  await savePairing(p)
  return p
}

// ─── Relay: where is the PC now? ─────────────────────────────────────────────

const RELAY = 'https://ntfy.sh'

/** Read the PC's latest public address from its private relay topic (AES-GCM encrypted). */
export async function relayLookup(r: Rendezvous): Promise<string | null> {
  try {
    const res = await fetchTimeout(`${RELAY}/${encodeURIComponent(r.topic)}/json?poll=1&since=24h`, {}, 8000)
    if (!res.ok) return null
    const lines = (await res.text()).split('\n').filter(Boolean)
    const key = await crypto.subtle.importKey('raw', b64decode(r.key) as BufferSource, 'AES-GCM', false, ['decrypt'])
    let best: { u: string; t: number } | null = null
    for (const line of lines) {
      try {
        const msg = JSON.parse(line) as { event?: string; message?: string }
        if (msg.event !== 'message' || !msg.message) continue
        const raw = b64decode(msg.message)
        const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) as BufferSource }, key, raw.slice(12) as BufferSource)
        const v = JSON.parse(new TextDecoder().decode(plain)) as { u: string; t: number }
        if (/^https:\/\//.test(v.u) && (!best || v.t > best.t)) best = v
      } catch {
        /* someone else's message, or tampered */
      }
    }
    return best?.u ?? null
  } catch {
    return null
  }
}
