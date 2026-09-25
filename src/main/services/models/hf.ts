// Hugging Face access for model downloads: resolve URLs, open (ranged)
// downloads that follow the redirect to the CDN without leaking the token,
// file info from the Hub API, and the optional token for gated repos (kept
// with the other encrypted secrets under id "huggingface").
import { app } from 'electron'
import { getSecret } from '../../settings'

/** The Hub. Dev builds can point at a local stand-in server for tests (STITCH_HF_ORIGIN). */
export const HF_ORIGIN = (!app.isPackaged && process.env.STITCH_HF_ORIGIN?.replace(/\/+$/, '')) || 'https://huggingface.co'
const UA = 'Stitch/0.1 (+desktop)'

export function hfToken(): string | undefined {
  return getSecret('huggingface') || undefined
}

const encPath = (p: string): string => p.split('/').map(encodeURIComponent).join('/')

export function hfResolveUrl(repo: string, path: string, revision = 'main'): string {
  return `${HF_ORIGIN}/${repo}/resolve/${encodeURIComponent(revision)}/${encPath(path)}`
}

export function hfRepoUrl(repo: string): string {
  return `${HF_ORIGIN}/${repo}`
}

/** Hosts that may receive the token: the Hub itself, never the signed CDN it redirects to. */
function hubHost(host: string): boolean {
  return host === 'huggingface.co' || host === 'hf.co' || host === new URL(HF_ORIGIN).host
}

async function bodyMessage(res: Response): Promise<string> {
  try {
    const text = await res.text()
    try {
      const j = JSON.parse(text) as { error?: string; message?: string }
      return (j.error ?? j.message ?? text).slice(0, 200)
    } catch {
      return text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)
    }
  } catch {
    return res.statusText
  }
}

export class HfError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string
  ) {
    super(message)
  }
}

async function failure(res: Response, repo: string, path: string, token?: string): Promise<HfError> {
  const code = res.headers.get('x-error-code') ?? undefined
  const page = hfRepoUrl(repo)
  if (code === 'GatedRepo' || (res.status === 401 && !token) || res.status === 403) {
    await res.body?.cancel().catch(() => {})
    return new HfError(
      token
        ? `${repo} is gated: accept its licence at ${page} with the Hugging Face account your token belongs to, then try again.`
        : `${repo} is gated on Hugging Face. Add a Hugging Face token (Settings → Models & storage) after accepting the licence at ${page}.`,
      res.status,
      'gated'
    )
  }
  if (res.status === 401) return new HfError('Hugging Face rejected your token. Paste a fresh one from huggingface.co/settings/tokens.', 401, 'token')
  if (res.status === 404 || code === 'EntryNotFound' || code === 'RepoNotFound') {
    await res.body?.cancel().catch(() => {})
    return new HfError(`Hugging Face no longer has ${path} in ${repo}.`, 404, 'missing')
  }
  if (res.status === 429) return new HfError('Hugging Face is rate-limiting downloads. Try again in a few minutes (a token raises the limit).', 429, 'rate')
  return new HfError(`Download failed (${res.status}): ${await bodyMessage(res)}`, res.status)
}

/**
 * Open a Hub file for download, following redirects by hand so the token
 * only goes to huggingface.co. `offset` > 0 asks for the rest of a partial
 * file; callers check for 206 (or 416 when it was already complete).
 */
export async function openHf(repo: string, path: string, revision: string | undefined, signal: AbortSignal, offset = 0, token = hfToken()): Promise<Response> {
  let current = hfResolveUrl(repo, path, revision)
  for (let hop = 0; hop < 10; hop++) {
    const u = new URL(current)
    const headers: Record<string, string> = { 'User-Agent': UA }
    if (token && hubHost(u.host)) headers.Authorization = `Bearer ${token}`
    if (offset > 0) headers.Range = `bytes=${offset}-`
    const res = await fetch(current, { headers, redirect: 'manual', signal })
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location')
      await res.body?.cancel().catch(() => {})
      if (!loc) throw new Error('Hugging Face redirected without a destination.')
      current = new URL(loc, current).toString()
      continue
    }
    if (res.status === 416) return res
    if (!res.ok) throw await failure(res, repo, path, token)
    const type = res.headers.get('content-type') ?? ''
    if (/text\/html/i.test(type)) throw new Error(`Hugging Face sent a page instead of ${path}: ${await bodyMessage(res)}`)
    if (!res.body) throw new Error('Hugging Face sent an empty response.')
    return res
  }
  throw new Error('Too many redirects while downloading from Hugging Face.')
}

export interface HfFileInfo {
  size: number
  sha256?: string
  gated: boolean
}

const infoCache = new Map<string, HfFileInfo>()

/** Size / sha256 of a Hub file from a HEAD request (no download). */
export async function hfFileInfo(repo: string, path: string, revision?: string): Promise<HfFileInfo> {
  const key = `${repo}|${path}|${revision ?? 'main'}`
  const hit = infoCache.get(key)
  if (hit) return hit
  const token = hfToken()
  const headers: Record<string, string> = { 'User-Agent': UA }
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(hfResolveUrl(repo, path, revision), { method: 'HEAD', headers, redirect: 'manual' })
  if (res.status === 401 || res.headers.get('x-error-code') === 'GatedRepo') return { size: 0, gated: true }
  if (res.status >= 400) throw await failure(res, repo, path, token)
  const size = Number(res.headers.get('x-linked-size') ?? res.headers.get('content-length') ?? 0)
  const etag = (res.headers.get('x-linked-etag') ?? '').replace(/^W\//, '').replace(/"/g, '')
  const info: HfFileInfo = { size, sha256: /^[0-9a-f]{64}$/i.test(etag) ? etag.toLowerCase() : undefined, gated: false }
  infoCache.set(key, info)
  return info
}

/** Who a token belongs to (throws HfError 401 when it's invalid). */
export async function hfWhoami(token: string): Promise<{ name?: string }> {
  const res = await fetch(`${HF_ORIGIN}/api/whoami-v2`, { headers: { Authorization: `Bearer ${token}`, 'User-Agent': UA } })
  if (res.status === 401) throw new HfError('Hugging Face rejected this token.', 401, 'token')
  if (!res.ok) throw new HfError(`Hugging Face answered ${res.status}.`, res.status)
  const j = (await res.json()) as { name?: string }
  return { name: j.name }
}
