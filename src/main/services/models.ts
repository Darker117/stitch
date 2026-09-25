// Model library + Civitai: local files with Stability Matrix sidecars,
// identify-by-hash, browse/search, key management and downloads.
import { shell } from 'electron'
import { existsSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { ModelMeta } from '@shared/types'
import { emit, handle } from '../ipc'
import { setSecret } from '../settings'
import { allInstances } from './comfy'
import { refreshModels } from './comfy/jobs'
import { CivitaiError, civitaiKey, getModel, listBaseModels, me, searchModels, versionByHash } from './models/civitai'
import { cancelDownload, isDownloading, listDownloads, startDownload } from './models/downloads'
import { sha256File } from './models/hash'
import { insideRoots, invalidateLibrary, listLocal, MODEL_EXT, metaFromCmInfo, stemOf } from './models/library'
import { buildCmInfo, pickPreview, savePreview, writeCmInfo } from './models/sidecar'

/** Tell ComfyUI instances (and through them, recipes) to re-read their model lists. */
function refreshComfy(): void {
  for (const inst of allInstances()) if (inst.online) void refreshModels(inst, true)
}

function changed(): void {
  invalidateLibrary()
  emit('models:changed', null)
  refreshComfy()
}

const identifying = new Map<string, Promise<ModelMeta | null>>()

async function identify(path: string): Promise<ModelMeta | null> {
  const full = resolve(path)
  if (!MODEL_EXT.test(full) || !insideRoots(full) || !existsSync(full)) throw new Error("That file isn't in a models folder Stitch knows about.")
  const sha = await sha256File(full)
  const version = await versionByHash(sha)
  if (!version) return null
  let model
  try {
    model = (await getModel(version.modelId)).raw
  } catch {
    model = undefined // the version alone is still enough for a useful sidecar
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const files: any[] = version.files ?? []
  const file = files.find((f) => String(f.hashes?.SHA256 ?? '').toUpperCase() === sha) ?? files.find((f) => f.primary) ?? files[0]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const images = model?.modelVersions?.find((v: any) => v.id === version.id)?.images ?? version.images
  const stem = stemOf(full)
  const hasPreview = ['.preview.jpeg', '.preview.jpg', '.preview.png', '.preview.webp'].some((s) => existsSync(stem + s))
  const pick = pickPreview(images)
  const saved = !hasPreview && pick ? await savePreview(full, pick) : undefined
  const info = buildCmInfo(model, version, file ?? { hashes: { SHA256: sha } }, saved ? pick : undefined)
  if (!(info.Hashes as { SHA256?: string | null }).SHA256) (info.Hashes as { SHA256?: string }).SHA256 = sha
  await writeCmInfo(full, info)
  changed()
  const list = await listLocal()
  return list.find((m) => m.path.toLowerCase() === full.toLowerCase())?.meta ?? metaFromCmInfo(info, stem)
}

async function remove(path: string): Promise<void> {
  const full = resolve(path)
  if (!MODEL_EXT.test(full) || !insideRoots(full)) throw new Error('Stitch only deletes model files inside your models folders.')
  if (isDownloading(full)) throw new Error('That file is still downloading — cancel the download instead.')
  const stem = stemOf(full)
  const extras = ['.cm-info.json', '.civitai.info', '.preview.jpeg', '.preview.jpg', '.preview.png', '.preview.webp', '.preview.gif', '.preview.mp4', '.preview.webm'].map((s) => stem + s)
  for (const p of [full, ...extras]) {
    if (!existsSync(p)) continue
    try {
      await shell.trashItem(p)
    } catch {
      await unlink(p)
    }
  }
  changed()
}

let status: { key: string; username?: string } | null = null

export function registerModels(): void {
  handle('models:local', (refresh) => listLocal(!!refresh))
  handle('models:identify', (path) => {
    const key = resolve(path).toLowerCase()
    const pending = identifying.get(key)
    if (pending) return pending
    const job = identify(path).finally(() => identifying.delete(key))
    identifying.set(key, job)
    return job
  })
  handle('models:delete', (path) => remove(path))

  handle('civitai:status', async () => {
    const key = civitaiKey()
    if (!key) return { hasKey: false }
    if (status?.key === key) return { hasKey: true, username: status.username }
    try {
      const u = await me(key)
      status = { key, username: u.username }
      return { hasKey: true, username: u.username }
    } catch {
      return { hasKey: true }
    }
  })
  handle('civitai:setKey', async (raw) => {
    const key = raw?.trim()
    status = null
    if (!key) {
      setSecret('civitai', null)
      return { ok: true, message: 'Civitai key removed.' }
    }
    try {
      const u = await me(key)
      setSecret('civitai', key)
      status = { key, username: u.username }
      return { ok: true, message: u.username ? `Connected as ${u.username}.` : 'Key saved and verified.' }
    } catch (err) {
      if (err instanceof CivitaiError && (err.status === 401 || err.status === 403)) {
        return { ok: false, message: 'Civitai rejected this key. Copy it again from civitai.com/user/account → API Keys.' }
      }
      setSecret('civitai', key)
      return { ok: true, message: `Saved, but Civitai couldn't verify it right now (${err instanceof Error ? err.message : String(err)}).` }
    }
  })
  handle('civitai:search', (q) => searchModels(q))
  handle('civitai:model', async (id) => (await getModel(id)).model)
  handle('civitai:baseModels', () => listBaseModels())
  handle('civitai:download', (req) => startDownload(req, refreshComfy))
  handle('civitai:cancelDownload', (id) => cancelDownload(id))
  handle('civitai:downloads', () => listDownloads())
}
