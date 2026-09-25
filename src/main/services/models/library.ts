// Local model library: scans every models folder (see home.ts: the chosen
// folder, Stability Matrix's shared Models, ComfyUI's models/ and extra paths,
// Stitch's own folder and folders installed into), reads
// Stability Matrix `.cm-info.json` sidecars and keeps small cached thumbnails.
import { app, nativeImage } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import type { LocalModel, ModelMeta } from '@shared/types'
import { kindForFolder } from '@shared/civitai'
import { emit } from '../../ipc'
import { MODEL_EXT, modelRoots, type Root } from './home'
import { cachedRating, drainRatings, hasPendingRatings, queueRating } from './ratings'

export { LAYOUT, MODEL_EXT, destinationDir, insideRoots, modelRoots, type Root } from './home'

const PREVIEW_SUFFIXES = ['.preview.jpeg', '.preview.jpg', '.preview.png', '.preview.webp', '.preview.gif', '.preview.mp4', '.preview.webm', '.jpeg', '.jpg', '.png', '.webp']

/** `C:\…\Lora\foo.safetensors` → `C:\…\Lora\foo` */
export function stemOf(modelPath: string): string {
  return join(dirname(modelPath), basename(modelPath, extname(modelPath)))
}

// ─── Sidecars ────────────────────────────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim()) : [])
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined)
/** Activation words, trimmed of the stray trailing commas Civitai often keeps. */
const words = (v: unknown): string[] => [...new Set(strs(v).map((w) => w.replace(/[,\s]+$/, '').trim()).filter(Boolean))]

/** Stability Matrix `.cm-info.json` → ModelMeta. */
export function metaFromCmInfo(j: any, fallbackName: string): ModelMeta {
  const stats = j.Stats && typeof j.Stats === 'object' ? j.Stats : undefined
  return {
    source: j.ModelId ? 'civitai' : 'local',
    modelId: num(j.ModelId),
    versionId: num(j.VersionId),
    name: str(j.UserTitle) ?? str(j.ModelName) ?? fallbackName,
    versionName: str(j.VersionName),
    civitaiType: str(j.ModelType),
    baseModel: str(j.BaseModel),
    trainedWords: words(j.TrainedWords),
    description: str(j.ModelDescription),
    versionDescription: str(j.VersionDescription),
    tags: strs(j.Tags),
    nsfw: j.Nsfw === true,
    author: str(j.AuthorUsername),
    sha256: str(j.Hashes?.SHA256)?.toUpperCase(),
    previewNsfwLevel: num(j.PreviewNsfwLevel),
    stats: stats ? { downloadCount: num(stats.downloadCount), thumbsUpCount: num(stats.thumbsUpCount), favoriteCount: num(stats.favoriteCount) } : undefined,
    fileMeta: j.FileMetadata && typeof j.FileMetadata === 'object' ? { fp: j.FileMetadata.fp ?? null, size: j.FileMetadata.size ?? null, format: j.FileMetadata.format ?? null } : undefined,
    importedAt: str(j.ImportedAt)
  }
}

/** Civitai Helper / LoRA Manager `.civitai.info` (a model-version API response) → ModelMeta. */
function metaFromCivitaiInfo(j: any, fallbackName: string): ModelMeta {
  const primary = Array.isArray(j.files) ? (j.files.find((f: any) => f.primary) ?? j.files[0]) : undefined
  return {
    source: 'civitai',
    modelId: num(j.modelId),
    versionId: num(j.id),
    name: str(j.model?.name) ?? fallbackName,
    versionName: str(j.name),
    civitaiType: str(j.model?.type),
    baseModel: str(j.baseModel),
    trainedWords: words(j.trainedWords),
    description: str(j.model?.description),
    versionDescription: str(j.description),
    tags: strs(j.model?.tags),
    nsfw: j.model?.nsfw === true,
    author: str(j.creator?.username),
    sha256: str(primary?.hashes?.SHA256)?.toUpperCase()
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

async function readJson(path: string): Promise<unknown> {
  const text = await readFile(path, 'utf8')
  return JSON.parse(text.replace(/^\uFEFF/, ''))
}

// ─── Thumbnails ──────────────────────────────────────────────────────────────

const THUMB = 480
const thumbDir = (): string => join(app.getPath('userData'), 'model-thumbs')
const thumbQueue: { src: string; dest: string }[] = []
let thumbing = false

function thumbPathFor(src: string, size: number, mtimeMs: number): string {
  const h = createHash('sha1').update(`${src.toLowerCase()}|${size}|${mtimeMs}`).digest('hex').slice(0, 24)
  return join(thumbDir(), `${h}.jpg`)
}

async function makeThumb(src: string, dest: string): Promise<boolean> {
  let img = nativeImage.createEmpty()
  if (/\.(jpe?g|png)$/i.test(src)) {
    img = nativeImage.createFromPath(src)
  } else {
    // WebP/GIF/video: ask the OS thumbnailer.
    try {
      img = await nativeImage.createThumbnailFromPath(src, { width: THUMB * 2, height: THUMB * 2 })
    } catch {
      img = nativeImage.createEmpty()
    }
  }
  if (img.isEmpty()) return false
  const { width, height } = img.getSize()
  const scale = Math.min(1, THUMB / Math.min(width, height))
  const out = scale < 1 ? img.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'good' }) : img
  await mkdir(thumbDir(), { recursive: true })
  await writeFile(dest, out.toJPEG(84))
  return true
}

/** Build missing thumbnails one at a time in the background, then tell the UI. */
async function drainThumbs(): Promise<void> {
  if (thumbing) return
  thumbing = true
  let made = 0
  try {
    while (thumbQueue.length) {
      const { src, dest } = thumbQueue.shift()!
      if (existsSync(dest)) continue
      try {
        if (await makeThumb(src, dest)) {
          made++
          for (const m of cache ?? []) if (m.meta?.previewPath === src) m.meta.thumbPath = dest
        }
      } catch {
        /* unreadable preview — the UI falls back to the original */
      }
      // Let IPC breathe between decodes.
      await new Promise((r) => setTimeout(r, 15))
      if (made && made % 12 === 0) emit('models:changed', null)
    }
  } finally {
    thumbing = false
  }
  if (made) emit('models:changed', null)
}

/** Thumbnail for a preview image, generating it synchronously (used right after downloads). */
export async function ensureThumb(previewPath: string): Promise<string | undefined> {
  try {
    const st = statSync(previewPath)
    const dest = thumbPathFor(previewPath, st.size, st.mtimeMs)
    if (existsSync(dest) || (await makeThumb(previewPath, dest))) return dest
  } catch {
    /* ignore */
  }
  return undefined
}

// ─── Scan ────────────────────────────────────────────────────────────────────

let cache: LocalModel[] | null = null
let scanning: Promise<LocalModel[]> | null = null

export function invalidateLibrary(): void {
  cache = null
}

export function cachedLibrary(): LocalModel[] | null {
  return cache
}

interface Found {
  root: Root
  path: string
  name: string
  siblings: Map<string, string> // lower-case file name → actual
}

async function walk(root: Root, dir: string, prefix: string, depth: number, out: Found[]): Promise<void> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  const siblings = new Map<string, string>()
  for (const e of entries) if (e.isFile()) siblings.set(e.name.toLowerCase(), e.name)
  for (const e of entries) {
    if (e.isDirectory()) {
      if (depth < 4 && !e.name.startsWith('.')) await walk(root, join(dir, e.name), `${prefix}${e.name}/`, depth + 1, out)
    } else if (MODEL_EXT.test(e.name)) {
      out.push({ root, path: join(dir, e.name), name: prefix + e.name, siblings })
    }
  }
}

async function describe(f: Found, thumbs: Set<string>): Promise<LocalModel> {
  const file = basename(f.path)
  const stemName = basename(file, extname(file))
  const dir = dirname(f.path)
  let size = 0
  try {
    size = (await stat(f.path)).size
  } catch {
    /* vanished mid-scan */
  }
  const model: LocalModel = { folder: f.root.folder, name: f.name, path: f.path, size, kind: kindForFolder(f.root.folder) }

  let meta: ModelMeta | undefined
  const cm = f.siblings.get(`${stemName}.cm-info.json`.toLowerCase())
  const ci = f.siblings.get(`${stemName}.civitai.info`.toLowerCase())
  try {
    if (cm) meta = metaFromCmInfo(await readJson(join(dir, cm)), stemName)
    else if (ci) meta = metaFromCivitaiInfo(await readJson(join(dir, ci)), stemName)
  } catch {
    /* malformed sidecar — treat the file as unidentified */
  }

  let preview: string | undefined
  for (const suffix of PREVIEW_SUFFIXES) {
    const hit = f.siblings.get(`${stemName}${suffix}`.toLowerCase())
    if (hit) {
      preview = join(dir, hit)
      break
    }
  }
  if (preview) {
    meta ??= { source: 'local', name: stemName, trainedWords: [], tags: [], nsfw: false }
    meta.previewPath = preview
    try {
      const st = statSync(preview)
      const t = thumbPathFor(preview, st.size, st.mtimeMs)
      if (thumbs.has(basename(t))) meta.thumbPath = t
      else thumbQueue.push({ src: preview, dest: t })
      // Stability Matrix previews carry no rating of their own — look it up.
      if (meta.source === 'civitai' && meta.previewNsfwLevel === undefined) {
        const rated = cachedRating(preview, st.size, st.mtimeMs)
        if (rated !== undefined) meta.previewNsfwLevel = rated
        else if (meta.versionId) queueRating({ previewPath: preview, versionId: meta.versionId, size: st.size, mtimeMs: st.mtimeMs })
      }
    } catch {
      /* ignore */
    }
  }
  if (meta) model.meta = meta
  return model
}

async function scan(): Promise<LocalModel[]> {
  const found: Found[] = []
  for (const root of modelRoots()) {
    if (existsSync(root.dir)) await walk(root, root.dir, '', 0, found)
  }
  // ComfyUI shows one entry per folder + name; the first root wins, like ComfyUI.
  const seen = new Set<string>()
  const unique = found.filter((f) => {
    const key = `${f.root.folder}|${f.name.toLowerCase()}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  let thumbs = new Set<string>()
  try {
    thumbs = new Set(await readdir(thumbDir()))
  } catch {
    /* none yet */
  }
  const out: LocalModel[] = []
  // Small batches keep file handles bounded on big libraries.
  for (let i = 0; i < unique.length; i += 32) out.push(...(await Promise.all(unique.slice(i, i + 32).map((f) => describe(f, thumbs)))))
  out.sort((a, b) => a.folder.localeCompare(b.folder) || a.name.localeCompare(b.name))
  return out
}

/** All local models (cached until invalidated). */
export async function listLocal(refresh = false): Promise<LocalModel[]> {
  if (refresh) cache = null
  if (cache) return cache
  if (!scanning) {
    scanning = scan()
      .then((list) => {
        cache = list
        if (thumbQueue.length) void drainThumbs()
        if (hasPendingRatings())
          void drainRatings(
            (previewPath, level) => {
              for (const m of cache ?? []) if (m.meta?.previewPath === previewPath) m.meta.previewNsfwLevel = level
            },
            () => emit('models:changed', null)
          )
        return list
      })
      .finally(() => {
        scanning = null
      })
  }
  return scanning
}
