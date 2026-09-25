// Story scripts: downloading script sources for "Import from URL" (the
// renderer's CSP keeps it off the open web).
import { handle } from '../ipc'

const MAX_BYTES = 8 * 1024 * 1024
const TIMEOUT_MS = 20_000

async function fetchText(url: string): Promise<{ url: string; text: string; contentType?: string }> {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    throw new Error('That is not a valid URL')
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Only http(s) links can be imported')
  const res = await fetch(u, { headers: { 'User-Agent': 'Stitch', Accept: 'application/vnd.github+json, text/plain, application/json, */*' }, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'follow' })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText || 'request failed'}`)
  const length = Number(res.headers.get('content-length') ?? 0)
  if (length > MAX_BYTES) throw new Error('That file is too large for a script')
  const buf = await res.arrayBuffer()
  if (buf.byteLength > MAX_BYTES) throw new Error('That file is too large for a script')
  return { url: res.url || u.toString(), text: new TextDecoder('utf-8').decode(buf), contentType: res.headers.get('content-type') ?? undefined }
}

export function registerScripts(): void {
  handle('scripts:fetch', (url) => fetchText(url))
}
