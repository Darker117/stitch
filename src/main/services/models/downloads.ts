// Model downloads from Civitai and Hugging Face. Every file streams into
// `<file>.part` (resumed with a Range request after an interrupted attempt),
// is checked against the expected size and sha256 when known, then renamed
// into place. Progress goes out on `download:progress`; a small queue keeps
// at most a few transfers running. Civitai downloads also get Stability
// Matrix sidecars so both apps see the model the same way.
import { createHash, type Hash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, statSync } from 'node:fs'
import { mkdir, rename, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { nanoid } from 'nanoid'
import type { CatalogFile, DownloadState } from '@shared/types'
import { folderForCivitai, folderLabel } from '@shared/civitai'
import { emit } from '../../ipc'
import { BAD_KEY, civitaiKey, civitaiOrigin, getModel, getVersion, NEED_KEY, type RawModel, type RawVersion } from './civitai'
import { rememberHash } from './hash'
import { inside, LAYOUT } from './home'
import { openHf } from './hf'
import { destinationDir, ensureThumb, invalidateLibrary } from './library'
import { buildCmInfo, pickPreview, savePreview, writeCmInfo } from './sidecar'

const MAX_PARALLEL = 2

interface Active {
  state: DownloadState
  ctrl: AbortController
  lastEmit: number
  canceled?: boolean
  start: () => void
}

const downloads = new Map<string, Active>()

function publish(a: Active, force = false): void {
  const now = Date.now()
  if (!force && now - a.lastEmit < 200) return
  a.lastEmit = now
  emit('download:progress', { ...a.state })
}

function prune(): void {
  const done = [...downloads.values()].filter((d) => d.state.status !== 'downloading' && d.state.status !== 'queued').sort((a, b) => a.state.startedAt - b.state.startedAt)
  while (downloads.size > 60 && done.length) downloads.delete(done.shift()!.state.id)
}

const pending = (d: Active): boolean => d.state.status === 'downloading' || d.state.status === 'queued'

/** Start queued transfers while there's room. */
function pump(): void {
  let running = [...downloads.values()].filter((d) => d.state.status === 'downloading').length
  const queued = [...downloads.values()].filter((d) => d.state.status === 'queued').sort((a, b) => a.state.startedAt - b.state.startedAt)
  for (const q of queued) {
    if (running >= MAX_PARALLEL) break
    running++
    q.state.status = 'downloading'
    q.state.startedAt = Date.now()
    publish(q, true)
    q.start()
  }
}

export function listDownloads(): DownloadState[] {
  return [...downloads.values()].map((d) => ({ ...d.state })).sort((a, b) => b.startedAt - a.startedAt)
}

/** Is `path` being (or about to be) downloaded? */
export function isDownloading(path: string): boolean {
  const p = resolve(path).toLowerCase()
  return [...downloads.values()].some((d) => pending(d) && d.state.path && (resolve(d.state.path).toLowerCase() === p || inside(path, d.state.path)))
}

/** The pending download for a destination path, if any. */
export function downloadFor(path: string): DownloadState | undefined {
  const p = resolve(path).toLowerCase()
  const hit = [...downloads.values()].find((d) => pending(d) && d.state.path && resolve(d.state.path).toLowerCase() === p)
  return hit ? { ...hit.state } : undefined
}

export function cancelDownload(id: string): void {
  const a = downloads.get(id)
  if (!a || !pending(a)) return
  a.canceled = true
  if (a.state.status === 'queued') {
    a.state.status = 'canceled'
    publish(a, true)
    return
  }
  a.ctrl.abort()
}

function safeName(name: string): string {
  const clean = name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/, '')
    .trim()
  return clean && !clean.startsWith('.') ? clean : `model-${Date.now()}.safetensors`
}

async function bodyMessage(res: Response): Promise<string> {
  try {
    const text = await res.text()
    try {
      const j = JSON.parse(text) as { message?: string; error?: string }
      return j.message ?? j.error ?? text.slice(0, 160)
    } catch {
      return text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160)
    }
  } catch {
    return res.statusText
  }
}

// ─── Transfer core ───────────────────────────────────────────────────────────

interface Transfer {
  /** Open the source; `offset` > 0 asks for the rest of a partial file. */
  open: (signal: AbortSignal, offset: number) => Promise<Response>
  dest: string
  /** Expected size in bytes, when known. */
  size?: number
  /** Expected sha256 (hex), when known. */
  sha256?: string
}

async function hashFile(hash: Hash, path: string, signal: AbortSignal): Promise<void> {
  await new Promise<void>((res, rej) => {
    const rs = createReadStream(path, { highWaterMark: 4 << 20 })
    const abort = (): void => {
      rs.destroy()
      rej(new Error('aborted'))
    }
    signal.addEventListener('abort', abort, { once: true })
    rs.on('data', (c) => hash.update(c))
    rs.on('error', rej)
    rs.on('end', () => {
      signal.removeEventListener('abort', abort)
      res()
    })
  })
}

/** Content-Range start of a 206 response. */
function rangeStart(res: Response): number | undefined {
  const m = /bytes\s+(\d+)-/i.exec(res.headers.get('content-range') ?? '')
  return m ? Number(m[1]) : undefined
}

/**
 * Stream a source into `<dest>.part`, resuming an existing part when the
 * server honours the range, verify size and checksum, then move it into place.
 * On failure the part stays (the next attempt resumes) unless it's corrupt.
 */
async function transfer(a: Active, t: Transfer): Promise<void> {
  const part = `${t.dest}.part`
  const signal = a.ctrl.signal
  let offset = 0
  try {
    offset = statSync(part).size
  } catch {
    offset = 0
  }
  if (t.size && offset > t.size) {
    await unlink(part).catch(() => {})
    offset = 0
  }
  let hash = t.sha256 ? createHash('sha256') : undefined
  if (offset && hash) {
    a.state.note = 'Checking the partial download…'
    publish(a, true)
    await hashFile(hash, part, signal)
  }
  if (offset) a.state.note = 'Resuming…'

  let res = await t.open(signal, offset)
  let append = false
  if (offset > 0) {
    if (res.status === 206 && rangeStart(res) === offset) append = true
    else if (res.status === 416 && t.size && offset === t.size) {
      // The part already holds the whole file.
      await res.body?.cancel().catch(() => {})
      a.state.received = a.state.total = offset
      await finishPart(a, t, part, hash)
      return
    } else {
      // No resume support: start over.
      await res.body?.cancel().catch(() => {})
      if (res.status !== 200) res = await t.open(signal, 0)
      offset = 0
      hash = t.sha256 ? createHash('sha256') : undefined
    }
  }
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}).`)

  const len = Number(res.headers.get('content-length'))
  const total = t.size || (len > 0 ? offset + len : 0)
  a.state.total = total
  a.state.received = offset
  a.state.note = append ? `Resumed at ${Math.round((offset / (total || offset)) * 100)}%` : undefined
  publish(a, true)

  const ws = createWriteStream(part, { flags: append ? 'a' : 'w' })
  const closed = new Promise<void>((r) => ws.once('close', () => r()))
  let writeError: Error | null = null
  ws.on('error', (e) => {
    writeError = e
    a.ctrl.abort()
  })
  const reader = res.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      hash?.update(value)
      a.state.received += value.byteLength
      if (!ws.write(value)) await new Promise<void>((r) => ws.once('drain', () => r()))
      publish(a)
    }
    ws.end()
  } catch (err) {
    ws.destroy()
    if (signal.aborted || writeError) throw err
    // Network drop (undici says "terminated"): the part stays for a resume.
    const pct = total ? ` at ${Math.round((a.state.received / total) * 100)}%` : ''
    throw new Error(`The connection dropped${pct}. Press Download again to resume where it stopped.`)
  } finally {
    await closed
  }
  if (writeError) throw writeError
  if (total && a.state.received !== total) throw new Error('The download was cut short. Press Download again to resume.')
  await finishPart(a, t, part, hash)
}

async function finishPart(a: Active, t: Transfer, part: string, hash: Hash | undefined): Promise<void> {
  if (t.size && statSync(part).size !== t.size) {
    await unlink(part).catch(() => {})
    throw new Error(`Size mismatch (expected ${t.size} bytes). The partial file was removed — try again.`)
  }
  if (hash && t.sha256) {
    const got = hash.digest('hex')
    if (got.toLowerCase() !== t.sha256.toLowerCase()) {
      await unlink(part).catch(() => {})
      throw new Error('Checksum mismatch — the file is corrupt or changed upstream. The partial file was removed; try again.')
    }
  }
  // Never replace a file that appeared meanwhile; keep the download beside it.
  if (existsSync(t.dest)) throw new Error(`${t.dest} appeared while downloading, so it was left alone. The download is kept as ${part}.`)
  await rename(part, t.dest)
  a.state.note = undefined
}

/** Queue a transfer; `after` runs once the file is in place. */
function enqueue(state: DownloadState, t: Transfer, after: () => Promise<void> | void, onDone: () => void): DownloadState {
  const a: Active = { state, ctrl: new AbortController(), lastEmit: 0, start: () => undefined }
  a.start = () => {
    void (async () => {
      try {
        await mkdir(dirname(t.dest), { recursive: true })
        await transfer(a, t)
        try {
          await after()
        } catch (err) {
          console.warn('[models] post-download step for', t.dest, 'failed:', err)
        }
        a.state.status = 'done'
        a.state.total = a.state.received || a.state.total
        a.state.note = undefined
        publish(a, true)
        invalidateLibrary()
        emit('models:changed', null)
        onDone()
      } catch (err) {
        a.state.status = a.canceled ? 'canceled' : 'error'
        a.state.note = undefined
        if (!a.canceled) a.state.error = err instanceof Error ? err.message : String(err)
        publish(a, true)
        // Keep the part for a resume unless the user canceled.
        if (a.canceled) await unlink(`${t.dest}.part`).catch(() => {})
      } finally {
        pump()
      }
    })()
  }
  downloads.set(state.id, a)
  prune()
  publish(a, true)
  pump()
  return { ...a.state }
}

// ─── Civitai ─────────────────────────────────────────────────────────────────

/**
 * Fetch a Civitai download URL. The key goes only to Civitai itself: the
 * signed CDN URL it redirects to rejects requests that carry it.
 */
async function openCivitai(url: string, key: string, signal: AbortSignal, offset: number): Promise<Response> {
  const apiHost = new URL(civitaiOrigin()).host
  let current = url
  for (let hop = 0; hop < 8; hop++) {
    const u = new URL(current)
    const headers: Record<string, string> = { 'User-Agent': 'Stitch/0.1 (+desktop)' }
    if (u.host === apiHost) headers.Authorization = `Bearer ${key}`
    if (offset > 0) headers.Range = `bytes=${offset}-`
    const res = await fetch(current, { headers, redirect: 'manual', signal })
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location')
      await res.body?.cancel().catch(() => {})
      if (!loc) throw new Error('Civitai redirected without a destination.')
      current = new URL(loc, current).toString()
      continue
    }
    if (res.status === 416) return res
    if (res.status === 401) throw new Error(BAD_KEY)
    if (res.status === 403) throw new Error(`Civitai won't let this account download it: ${await bodyMessage(res)}`)
    if (res.status === 404) throw new Error('Civitai no longer has this file.')
    if (res.status === 429) throw new Error('Civitai is rate-limiting downloads. Try again in a minute.')
    if (!res.ok) throw new Error(`Download failed (${res.status}): ${await bodyMessage(res)}`)
    const type = res.headers.get('content-type') ?? ''
    if (/text\/html|application\/json/i.test(type)) throw new Error(`Civitai sent a page instead of the file: ${await bodyMessage(res)}`)
    if (!res.body) throw new Error('Civitai sent an empty response.')
    return res
  }
  throw new Error('Too many redirects while downloading.')
}

export async function startDownload(
  req: { modelId: number; versionId: number; fileId?: number; folder?: string },
  onDone: () => void
): Promise<DownloadState> {
  const key = civitaiKey()
  if (!key) throw new Error(NEED_KEY)
  const { raw: model } = await getModel(req.modelId)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let version: RawVersion | undefined = (model.modelVersions ?? []).find((v: any) => v.id === req.versionId)
  if (!version) version = await getVersion(req.versionId)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const files: any[] = version?.files ?? []
  const file = req.fileId ? files.find((f) => f.id === req.fileId) : (files.find((f) => f.primary) ?? files.find((f) => f.type === 'Model') ?? files[0])
  if (!file?.downloadUrl) throw new Error('This version has no downloadable file.')
  if (req.folder && !(req.folder in LAYOUT)) throw new Error(`Unknown models folder "${req.folder}".`)
  const folder = req.folder || folderForCivitai(model.type, version?.baseModel, file.type)
  if (!folder) throw new Error(`Stitch doesn't know where ${model.type} models go. Pick a destination folder first.`)

  const dir = destinationDir(folder)
  const dest = join(dir, safeName(file.name))
  const existing = downloadFor(dest)
  if (existing) return existing
  if (existsSync(dest)) throw new Error(`${safeName(file.name)} is already in ${folderLabel(folder)}.`)

  const sha = typeof file.hashes?.SHA256 === 'string' ? String(file.hashes.SHA256).toLowerCase() : undefined
  const state: DownloadState = {
    id: nanoid(10),
    name: version?.name ? `${model.name} · ${version.name}` : String(model.name),
    modelId: req.modelId,
    versionId: req.versionId,
    folder,
    received: 0,
    total: Math.round(Number(file.sizeKB ?? 0) * 1024),
    status: 'queued',
    path: dest,
    startedAt: Date.now(),
    source: 'civitai'
  }
  return enqueue(
    state,
    // Civitai's sizeKB is rounded, so only the hash is authoritative.
    { dest, sha256: sha, open: (signal, offset) => openCivitai(file.downloadUrl, key, signal, offset) },
    async () => {
      // Sidecars: preview still + Stability Matrix metadata. The model is
      // already saved, so a failure here only costs the thumbnail/metadata.
      const m = model as RawModel
      const pick = pickPreview(version!.images)
      const preview = pick ? await savePreview(dest, pick) : undefined
      await writeCmInfo(dest, buildCmInfo(m, version!, file, preview ? pick : undefined))
      if (sha) await rememberHash(dest, sha.toUpperCase())
      if (preview) await ensureThumb(preview)
    },
    onDone
  )
}

// ─── Hugging Face ────────────────────────────────────────────────────────────

/** Where a catalog file lands inside a models base (folder key → dir, then its name). */
export function catalogDest(f: CatalogFile, base?: string): string {
  const dir = destinationDir(f.folder, base)
  const parts = f.name.split('/').filter(Boolean).map(safeName)
  const dest = join(dir, ...parts)
  if (!inside(dir, dest)) throw new Error(`Refusing to write outside the models folder: ${f.name}`)
  return dest
}

/** Queue a Hugging Face file to an exact destination (e.g. a GGUF for the llama.cpp text engine). */
export function startHubFile(f: { repo: string; path: string; revision?: string; size?: number; sha256?: string; dest: string; folder: string; label?: string }, onDone: () => void): DownloadState {
  const existing = downloadFor(f.dest)
  if (existing) return existing
  if (existsSync(f.dest)) throw new Error(`${f.path.split('/').pop()} is already downloaded.`)
  const state: DownloadState = {
    id: nanoid(10),
    name: f.label ?? f.path.split('/').pop() ?? f.path,
    folder: f.folder,
    received: 0,
    total: f.size ?? 0,
    status: 'queued',
    path: f.dest,
    startedAt: Date.now(),
    source: 'huggingface'
  }
  return enqueue(state, { dest: f.dest, size: f.size || undefined, sha256: f.sha256, open: (signal, offset) => openHf(f.repo, f.path, f.revision, signal, offset) }, () => undefined, onDone)
}

/** Queue one Hugging Face file into a models base (default: the models home). */
export function startHfDownload(f: CatalogFile, opts: { base?: string; group?: string; label?: string }, onDone: () => void): DownloadState {
  if (!(f.folder in LAYOUT)) throw new Error(`Unknown models folder "${f.folder}".`)
  const dest = catalogDest(f, opts.base)
  const existing = downloadFor(dest)
  if (existing) return existing
  if (existsSync(dest)) throw new Error(`${f.name} is already installed.`)
  const state: DownloadState = {
    id: nanoid(10),
    name: opts.label ?? f.name.split('/').pop() ?? f.name,
    folder: f.folder,
    received: 0,
    total: f.size,
    status: 'queued',
    path: dest,
    startedAt: Date.now(),
    source: 'huggingface',
    group: opts.group
  }
  return enqueue(state, { dest, size: f.size || undefined, sha256: f.sha256, open: (signal, offset) => openHf(f.repo, f.path, f.revision, signal, offset) }, () => undefined, onDone)
}
