// Civitai downloads: stream to `<file>.part` with the user's key, follow the
// redirect to the CDN (without leaking the key), report progress, then write
// Stability Matrix sidecars so both apps see the model the same way.
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { nanoid } from 'nanoid'
import type { DownloadState } from '@shared/types'
import { folderForCivitai, folderLabel } from '@shared/civitai'
import { emit } from '../../ipc'
import { BAD_KEY, civitaiKey, civitaiOrigin, getModel, getVersion, NEED_KEY, type RawModel, type RawVersion } from './civitai'
import { rememberHash } from './hash'
import { destinationDir, ensureThumb, invalidateLibrary, LAYOUT } from './library'
import { buildCmInfo, pickPreview, savePreview, writeCmInfo } from './sidecar'

interface Active {
  state: DownloadState
  ctrl: AbortController
  lastEmit: number
  canceled?: boolean
}

const downloads = new Map<string, Active>()

function publish(a: Active, force = false): void {
  const now = Date.now()
  if (!force && now - a.lastEmit < 200) return
  a.lastEmit = now
  emit('download:progress', { ...a.state })
}

function prune(): void {
  const done = [...downloads.values()].filter((d) => d.state.status !== 'downloading').sort((a, b) => a.state.startedAt - b.state.startedAt)
  while (downloads.size > 30 && done.length) downloads.delete(done.shift()!.state.id)
}

export function listDownloads(): DownloadState[] {
  return [...downloads.values()].map((d) => ({ ...d.state })).sort((a, b) => b.startedAt - a.startedAt)
}

export function isDownloading(path: string): boolean {
  const p = path.toLowerCase()
  return [...downloads.values()].some((d) => d.state.status === 'downloading' && d.state.path?.toLowerCase() === p)
}

export function cancelDownload(id: string): void {
  const a = downloads.get(id)
  if (!a || a.state.status !== 'downloading') return
  a.canceled = true
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

/**
 * Fetch a Civitai download URL. The key goes only to Civitai itself: the
 * signed CDN URL it redirects to rejects requests that carry it.
 */
async function openDownload(url: string, key: string, signal: AbortSignal): Promise<Response> {
  const apiHost = new URL(civitaiOrigin()).host
  let current = url
  for (let hop = 0; hop < 8; hop++) {
    const u = new URL(current)
    const headers: Record<string, string> = { 'User-Agent': 'Stitch/0.1 (+desktop)' }
    if (u.host === apiHost) headers.Authorization = `Bearer ${key}`
    const res = await fetch(current, { headers, redirect: 'manual', signal })
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location')
      await res.body?.cancel().catch(() => {})
      if (!loc) throw new Error('Civitai redirected without a destination.')
      current = new URL(loc, current).toString()
      continue
    }
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

/* eslint-disable @typescript-eslint/no-explicit-any */
interface Job {
  model: RawModel
  version: RawVersion
  file: any
  dest: string
  key: string
}
/* eslint-enable @typescript-eslint/no-explicit-any */

async function run(a: Active, job: Job, onDone: () => void): Promise<void> {
  const part = `${job.dest}.part`
  try {
    const res = await openDownload(job.file.downloadUrl, job.key, a.ctrl.signal)
    const len = Number(res.headers.get('content-length'))
    if (len > 0) a.state.total = len
    const ws = createWriteStream(part)
    const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()))
    let writeError: Error | null = null
    ws.on('error', (e) => {
      writeError = e
      a.ctrl.abort()
    })
    const reader = res.body!.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        a.state.received += value.byteLength
        if (!ws.write(value)) await new Promise<void>((resolve) => ws.once('drain', () => resolve()))
        publish(a)
      }
      ws.end()
    } catch (err) {
      ws.destroy()
      throw err
    } finally {
      await closed
    }
    if (writeError) throw writeError
    if (len > 0 && a.state.received !== len) throw new Error('The download was cut short. Try again.')
    await rename(part, job.dest)

    // Sidecars: preview still + Stability Matrix metadata. The model is already
    // saved, so a failure here only costs the thumbnail/metadata.
    try {
      const pick = pickPreview(job.version.images)
      const preview = pick ? await savePreview(job.dest, pick) : undefined
      await writeCmInfo(job.dest, buildCmInfo(job.model, job.version, job.file, preview ? pick : undefined))
      if (job.file.hashes?.SHA256) await rememberHash(job.dest, job.file.hashes.SHA256)
      if (preview) await ensureThumb(preview)
    } catch (err) {
      console.warn('[models] sidecar for', job.dest, 'failed:', err)
    }

    a.state.status = 'done'
    a.state.total = a.state.received
    publish(a, true)
    invalidateLibrary()
    emit('models:changed', null)
    onDone()
  } catch (err) {
    a.state.status = a.canceled ? 'canceled' : 'error'
    if (!a.canceled) a.state.error = err instanceof Error ? err.message : String(err)
    publish(a, true)
    await unlink(part).catch(() => {})
  }
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
  const existing = [...downloads.values()].find((d) => d.state.status === 'downloading' && d.state.path?.toLowerCase() === dest.toLowerCase())
  if (existing) return { ...existing.state }
  if (existsSync(dest)) throw new Error(`${safeName(file.name)} is already in ${folderLabel(folder)}.`)
  await mkdir(dir, { recursive: true })

  const state: DownloadState = {
    id: nanoid(10),
    name: version?.name ? `${model.name} · ${version.name}` : String(model.name),
    modelId: req.modelId,
    versionId: req.versionId,
    folder,
    received: 0,
    total: Math.round(Number(file.sizeKB ?? 0) * 1024),
    status: 'downloading',
    path: dest,
    startedAt: Date.now()
  }
  const a: Active = { state, ctrl: new AbortController(), lastEmit: 0 }
  downloads.set(state.id, a)
  prune()
  publish(a, true)
  void run(a, { model, version, file, dest, key }, onDone)
  return { ...state }
}
