// Shared plumbing for voice providers.
import type { VoiceInfo } from '@shared/ipc'
import type { Asset, CharacterVoice, VoiceConnector } from '@shared/types'

export interface SynthArgs {
  c: VoiceConnector
  key?: string
  text: string
  voice: CharacterVoice
  instructions?: string
  model?: string
}

export interface SynthOut {
  bytes: Uint8Array
  ext: 'mp3' | 'wav'
  model?: string
  /** Resolved provider voice (speaker/voice id) actually used. */
  voiceId?: string
  /** Human name of that voice, when known (shown on clips). */
  voiceName?: string
  /** Approximate bitrate for duration estimates when ffprobe is missing. */
  kbps?: number
  note?: string
}

export interface VoiceProvider {
  voices(c: VoiceConnector, key?: string): Promise<VoiceInfo[]>
  speak(a: SynthArgs): Promise<SynthOut>
  clone?(c: VoiceConnector, key: string | undefined, name: string, sample: Asset, sampleText?: string): Promise<string>
  test(c: VoiceConnector, key?: string): Promise<string>
}

export function requireKey(c: VoiceConnector, key: string | undefined): string {
  if (!key) throw new Error(`${c.name} has no API key — add one in Connectors`)
  return key
}

/** Turn a failed HTTP response into a readable error. */
export async function httpError(res: Response, provider: string): Promise<Error> {
  let msg = ''
  const text = await res.text().catch(() => '')
  try {
    const j = JSON.parse(text) as Record<string, unknown>
    const err = j.error as { message?: string } | string | undefined
    const detail = j.detail as { message?: string } | string | undefined
    msg =
      (typeof err === 'object' ? err?.message : err) ??
      (typeof detail === 'object' ? detail?.message : detail) ??
      (j.message as string | undefined) ??
      ''
  } catch {
    msg = text.slice(0, 300)
  }
  if (!msg) {
    if (res.status === 401 || res.status === 403) msg = 'The API key was rejected'
    else if (res.status === 429) msg = 'Rate limited or out of quota'
    else if (res.status === 404) msg = 'Not found — check the voice id / region'
    else msg = res.statusText || 'Request failed'
  }
  return new Error(`${provider}: ${msg} (HTTP ${res.status})`)
}

export async function fetchOk(url: string, init: RequestInit, provider: string, timeoutMs = 120_000): Promise<Response> {
  let res: Response
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`${provider}: ${/timeout|aborted/i.test(msg) ? 'request timed out' : `could not connect (${msg})`}`)
  }
  if (!res.ok) throw await httpError(res, provider)
  return res
}

/** Split text for APIs with an input limit, on paragraph/sentence boundaries. */
export function splitForApi(text: string, max: number): string[] {
  const clean = text.trim()
  if (clean.length <= max) return [clean]
  const out: string[] = []
  let buf = ''
  const push = (): void => {
    if (buf.trim()) out.push(buf.trim())
    buf = ''
  }
  const sentences = clean.split(/(?<=[.!?…。！？])\s+|\n{2,}/)
  for (const s of sentences) {
    if ((buf + ' ' + s).length <= max) {
      buf = buf ? `${buf} ${s}` : s
      continue
    }
    push()
    let rest = s
    while (rest.length > max) {
      let cut = rest.lastIndexOf(' ', max)
      if (cut < max / 3) cut = max
      out.push(rest.slice(0, cut).trim())
      rest = rest.slice(cut).trim()
    }
    buf = rest
  }
  push()
  return out
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

/** Byte ranges of the 'fmt ' and 'data' chunks of a RIFF/WAVE file. */
function wavChunks(bytes: Uint8Array): { fmt?: Uint8Array; data?: Uint8Array } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag = (o: number): string => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3])
  const out: { fmt?: Uint8Array; data?: Uint8Array } = {}
  if (bytes.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return out
  let o = 12
  while (o + 8 <= bytes.length) {
    const id = tag(o)
    const size = Math.min(dv.getUint32(o + 4, true), bytes.length - o - 8)
    if (id === 'fmt ') out.fmt = bytes.subarray(o + 8, o + 8 + size)
    if (id === 'data') out.data = bytes.subarray(o + 8, o + 8 + size)
    o += 8 + size + (size % 2)
  }
  return out
}

/** Join WAV files that share a format into one (e.g. chunked TTS responses). */
export function concatWavs(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0]
  const first = wavChunks(parts[0])
  if (!first.fmt) return concatBytes(parts)
  const datas = parts.map((p) => wavChunks(p).data ?? new Uint8Array())
  const dataLen = datas.reduce((n, d) => n + d.length, 0)
  const header = new Uint8Array(12 + 8 + first.fmt.length + 8)
  const dv = new DataView(header.buffer)
  const put = (o: number, t: string): void => {
    for (let i = 0; i < 4; i++) header[o + i] = t.charCodeAt(i)
  }
  put(0, 'RIFF')
  dv.setUint32(4, header.length - 8 + dataLen, true)
  put(8, 'WAVE')
  put(12, 'fmt ')
  dv.setUint32(16, first.fmt.length, true)
  header.set(first.fmt, 20)
  put(20 + first.fmt.length, 'data')
  dv.setUint32(24 + first.fmt.length, dataLen, true)
  return concatBytes([header, ...datas])
}

export function isWav(bytes: Uint8Array): boolean {
  return bytes.length > 12 && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.subarray(8, 12)) === 'WAVE'
}

/** Duration of a PCM WAV file in seconds. */
export function wavDuration(bytes: Uint8Array): number | undefined {
  if (bytes.length < 44) return undefined
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag = (o: number): string => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3])
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return undefined
  let byteRate = 0
  let o = 12
  while (o + 8 <= bytes.length) {
    const id = tag(o)
    const size = dv.getUint32(o + 4, true)
    if (id === 'fmt ') byteRate = dv.getUint32(o + 16, true)
    if (id === 'data') return byteRate ? Math.min(size, bytes.length - o - 8) / byteRate : undefined
    o += 8 + size + (size % 2)
  }
  return undefined
}

export function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[ch]!)
}

/** Stable small integer from a string (seeds voice design so a description keeps its timbre). */
export function hashSeed(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0) % 2_147_483_647
}
