// Civitai REST API (https://developer.civitai.com/site/reference). Browsing is
// public; downloads and some models need the user's API key, sent as a Bearer
// token. The key lives in encrypted secrets under id "civitai".
import { app } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CivitaiFile, CivitaiImage, CivitaiModel, CivitaiQuery, CivitaiVersion } from '@shared/types'
import { FALLBACK_BASE_MODELS } from '@shared/civitai'
import { getSecret } from '../../settings'

export const NEED_KEY =
  'Civitai needs an API key for this. Click “Connect Civitai” on the Models page and paste a key from civitai.com/user/account.'
export const BAD_KEY = 'Civitai rejected your API key. Update it with “Connect Civitai” on the Models page (civitai.com/user/account).'

/** Site origin. Dev builds can point at a local stub with STITCH_CIVITAI_API. */
export function civitaiOrigin(): string {
  const override = !app.isPackaged ? process.env.STITCH_CIVITAI_API : undefined
  return (override || 'https://civitai.com').replace(/\/+$/, '')
}

export function civitaiKey(): string | undefined {
  return getSecret('civitai')?.trim() || undefined
}

export function authHeaders(key: string | null | undefined = civitaiKey()): Record<string, string> {
  const h: Record<string, string> = { 'User-Agent': 'Stitch/0.1 (+desktop)', Accept: 'application/json' }
  if (key) h.Authorization = `Bearer ${key}`
  return h
}

export class CivitaiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
  }
}

async function errorMessage(res: Response): Promise<string> {
  try {
    const text = await res.text()
    try {
      const j = JSON.parse(text) as { message?: string; error?: string | { message?: string } }
      if (typeof j.message === 'string') return j.message
      if (typeof j.error === 'string') return j.error
      if (j.error && typeof j.error === 'object' && j.error.message) return j.error.message
    } catch {
      /* not JSON */
    }
    return text.slice(0, 200)
  } catch {
    return res.statusText
  }
}

/** GET a Civitai API path (`/models?…`), with the key when one is saved. */
export async function civitaiGet<T>(path: string, opts: { key?: string | null; timeoutMs?: number } = {}): Promise<T> {
  const key = opts.key === null ? null : (opts.key ?? civitaiKey())
  let res: Response
  try {
    res = await fetch(`${civitaiOrigin()}/api/v1${path}`, { headers: authHeaders(key), signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000) })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new CivitaiError(/timeout|aborted/i.test(msg) ? 'Civitai took too long to answer. Try again in a moment.' : `Couldn't reach Civitai (${msg}).`, 0)
  }
  if (res.status === 401) throw new CivitaiError(key ? BAD_KEY : NEED_KEY, res.status)
  if (res.status === 403) throw new CivitaiError(key ? `Civitai refused access: ${await errorMessage(res)}` : NEED_KEY, res.status)
  if (res.status === 429) throw new CivitaiError('Civitai is rate-limiting requests. Wait a few seconds and try again.', 429)
  if (!res.ok) throw new CivitaiError(`Civitai error ${res.status}: ${await errorMessage(res)}`, res.status)
  return (await res.json()) as T
}

// ─── Mapping ─────────────────────────────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */
export type RawModel = any
export type RawVersion = any

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()) : [])

export function mapImage(im: any): CivitaiImage {
  return {
    url: String(im.url ?? ''),
    nsfwLevel: typeof im.nsfwLevel === 'number' ? im.nsfwLevel : 0,
    width: im.width ?? undefined,
    height: im.height ?? undefined,
    type: im.type === 'video' ? 'video' : 'image',
    hash: typeof im.hash === 'string' ? im.hash : undefined
  }
}

export function mapFile(f: any): CivitaiFile {
  return {
    id: Number(f.id),
    name: String(f.name ?? 'model.safetensors'),
    sizeKB: Number(f.sizeKB ?? 0),
    type: String(f.type ?? 'Model'),
    primary: f.primary === true,
    metadata: f.metadata ? { fp: f.metadata.fp ?? null, size: f.metadata.size ?? null, format: f.metadata.format ?? null } : undefined,
    downloadUrl: String(f.downloadUrl ?? ''),
    hashes: f.hashes && typeof f.hashes === 'object' ? f.hashes : undefined
  }
}

export function mapVersion(v: any): CivitaiVersion {
  return {
    id: Number(v.id),
    name: String(v.name ?? ''),
    baseModel: String(v.baseModel ?? 'Other'),
    trainedWords: [...new Set(strs(v.trainedWords).map((w) => w.replace(/[,\s]+$/, '').trim()).filter(Boolean))],
    description: typeof v.description === 'string' ? v.description : undefined,
    images: (Array.isArray(v.images) ? v.images : []).map(mapImage).filter((i: CivitaiImage) => i.url),
    files: (Array.isArray(v.files) ? v.files : []).map(mapFile),
    publishedAt: v.publishedAt ?? undefined,
    downloadCount: v.stats?.downloadCount ?? undefined
  }
}

export function mapModel(m: any): CivitaiModel {
  return {
    id: Number(m.id),
    name: String(m.name ?? 'Untitled'),
    type: String(m.type ?? 'Other'),
    nsfw: m.nsfw === true,
    description: typeof m.description === 'string' ? m.description : undefined,
    tags: strs(m.tags),
    creator: m.creator?.username ?? undefined,
    creatorImage: m.creator?.image ?? undefined,
    stats: m.stats ? { downloadCount: m.stats.downloadCount, thumbsUpCount: m.stats.thumbsUpCount, favoriteCount: m.stats.favoriteCount } : undefined,
    versions: (Array.isArray(m.modelVersions) ? m.modelVersions : []).map(mapVersion)
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ─── Endpoints ───────────────────────────────────────────────────────────────

export async function searchModels(q: CivitaiQuery): Promise<{ items: CivitaiModel[]; nextCursor?: string }> {
  const query = q.query?.trim()
  let cursor = q.cursor
  // Full-text search filters after paging, so a page can come back empty while
  // more results exist; skip a few of those instead of stalling the scroll.
  for (let attempt = 0; attempt < 4; attempt++) {
    const p = new URLSearchParams()
    p.set('limit', String(Math.min(100, Math.max(1, q.limit ?? 24))))
    if (query) p.set('query', query)
    for (const t of q.types ?? []) p.append('types', t)
    for (const b of q.baseModels ?? []) p.append('baseModels', b)
    if (q.sort) p.set('sort', q.sort)
    // Civitai returns nothing for a search combined with a period window.
    if (q.period && q.period !== 'AllTime' && !query) p.set('period', q.period)
    p.set('nsfw', q.nsfw ? 'true' : 'false')
    if (cursor) p.set('cursor', cursor)
    const res = await civitaiGet<{ items?: RawModel[]; metadata?: { nextCursor?: string | number } }>(`/models?${p}`)
    const items = (res.items ?? []).map(mapModel)
    const next = res.metadata?.nextCursor !== undefined && res.metadata?.nextCursor !== null ? String(res.metadata.nextCursor) : undefined
    if (items.length || !next || next === cursor) return { items, nextCursor: next && next !== cursor ? next : undefined }
    cursor = next
  }
  return { items: [], nextCursor: cursor }
}

export async function getModel(id: number): Promise<{ raw: RawModel; model: CivitaiModel }> {
  const raw = await civitaiGet<RawModel>(`/models/${encodeURIComponent(String(id))}`)
  return { raw, model: mapModel(raw) }
}

export async function getVersion(id: number): Promise<RawVersion> {
  return civitaiGet<RawVersion>(`/model-versions/${encodeURIComponent(String(id))}`)
}

/** Model version for a file hash, or null when Civitai doesn't know it. */
export async function versionByHash(sha256: string): Promise<RawVersion | null> {
  try {
    return await civitaiGet<RawVersion>(`/model-versions/by-hash/${encodeURIComponent(sha256)}`)
  } catch (err) {
    if (err instanceof CivitaiError && err.status === 404) return null
    throw err
  }
}

export async function me(key: string): Promise<{ username?: string }> {
  const j = await civitaiGet<{ username?: string; name?: string }>('/me', { key, timeoutMs: 15_000 })
  return { username: j.username ?? j.name }
}

// ─── Base models ─────────────────────────────────────────────────────────────

let baseModels: { list: string[]; at: number } | null = null
const baseFile = (): string => join(app.getPath('userData'), 'civitai-base-models.json')
const DAY = 24 * 3600 * 1000

function valid(list: unknown): list is string[] {
  return Array.isArray(list) && list.length > 5 && list.every((x) => typeof x === 'string')
}

/** Every base model Civitai currently accepts, newest list first. */
export async function listBaseModels(): Promise<string[]> {
  if (baseModels && Date.now() - baseModels.at < DAY) return baseModels.list
  if (!baseModels && existsSync(baseFile())) {
    try {
      const saved = JSON.parse(readFileSync(baseFile(), 'utf8')) as { list: string[]; at: number }
      if (valid(saved.list)) baseModels = saved
      if (baseModels && Date.now() - baseModels.at < DAY) return baseModels.list
    } catch {
      /* refetch */
    }
  }
  let list: string[] | undefined
  // 1. The live enum endpoint.
  try {
    const enums = await civitaiGet<{ BaseModel?: unknown }>('/enums', { key: null, timeoutMs: 15_000 })
    if (valid(enums.BaseModel)) list = enums.BaseModel
  } catch {
    /* fall through */
  }
  // 2. A deliberately invalid filter: older API versions answer with a
  //    validation error listing every allowed value.
  if (!list) {
    try {
      const res = await fetch(`${civitaiOrigin()}/api/v1/models?limit=1&baseModels=__stitch__`, { headers: authHeaders(null), signal: AbortSignal.timeout(15_000) })
      const text = await res.text()
      const m = /Expected\s+((?:'[^']+'\s*\|\s*)+'[^']+')/.exec(text.replace(/\\"/g, '"').replace(/"/g, "'"))
      if (m) {
        const opts = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
        if (valid(opts)) list = opts
      }
    } catch {
      /* fall through */
    }
  }
  if (list) {
    baseModels = { list, at: Date.now() }
    void writeFile(baseFile(), JSON.stringify(baseModels)).catch(() => {})
    return list
  }
  return baseModels?.list ?? FALLBACK_BASE_MODELS
}
