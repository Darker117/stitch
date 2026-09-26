import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
import type { LlmConnector } from '@shared/types'

export const DEFAULT_BASE: Record<LlmConnector['kind'], string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  openrouter: 'https://openrouter.ai/api/v1',
  ollama: 'http://127.0.0.1:11434',
  lmstudio: 'http://127.0.0.1:1234/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  'openai-compatible': 'http://127.0.0.1:5000/v1',
  device: ''
}

export function baseUrl(c: LlmConnector): string {
  return (c.baseUrl || DEFAULT_BASE[c.kind]).replace(/\/+$/, '')
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

/** Throw a readable error for a non-2xx response. */
export async function ensureOk(res: Response, what: string): Promise<void> {
  if (res.ok) return
  let detail = ''
  try {
    const text = await res.text()
    try {
      const j = JSON.parse(text)
      detail = j.error?.message ?? j.error ?? j.message ?? j.detail ?? text
      if (typeof detail !== 'string') detail = JSON.stringify(detail)
    } catch {
      detail = text
    }
  } catch {
    /* ignore */
  }
  throw new HttpError(res.status, `${what} failed (${res.status})${detail ? `: ${detail.slice(0, 400)}` : ''}`)
}

/** Iterate "data: …" payloads of a server-sent-events body. */
export async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event?: string; data: string }> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let event: string | undefined
  let data: string[] = []
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let idx: number
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '')
      buf = buf.slice(idx + 1)
      if (line === '') {
        if (data.length) yield { event, data: data.join('\n') }
        event = undefined
        data = []
      } else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
      else if (line.startsWith('event:')) event = line.slice(6).trim()
    }
  }
  if (data.length) yield { event, data: data.join('\n') }
}

/** Iterate newline-delimited JSON (Ollama). */
export async function* ndjson(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let idx: number
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (line) yield JSON.parse(line)
    }
  }
  if (buf.trim()) yield JSON.parse(buf.trim())
}

const IMG_MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }

export function imageData(path: string): { mime: string; base64: string } {
  return { mime: IMG_MIME[extname(path).toLowerCase()] ?? 'image/png', base64: readFileSync(path).toString('base64') }
}

/** Is this 4xx about a sampling parameter the model doesn't accept? */
export function isParamError(err: unknown): boolean {
  return (
    err instanceof HttpError &&
    err.status === 400 &&
    /temperature|top_p|top_k|max_tokens|unsupported|not supported|unrecognized|extra inputs|additional properties|stop/i.test(err.message)
  )
}
