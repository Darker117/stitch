import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { promisify } from 'node:util'
import { nanoid } from 'nanoid'
import type { MediaProbe } from '@shared/ipc'
import type { Asset, AssetKind } from '@shared/types'
import { handle } from '../ipc'
import { getSettings } from '../settings'
import { db } from '../store'
import { detectFfmpeg } from './system'

const run = promisify(execFile)

const KIND_BY_EXT: Record<string, AssetKind> = {
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.webp': 'image', '.gif': 'image', '.bmp': 'image', '.avif': 'image',
  '.mp4': 'video', '.webm': 'video', '.mov': 'video', '.mkv': 'video', '.m4v': 'video',
  '.mp3': 'audio', '.wav': 'audio', '.flac': 'audio', '.ogg': 'audio', '.m4a': 'audio', '.aac': 'audio', '.opus': 'audio'
}

export function kindForPath(p: string): AssetKind | undefined {
  return KIND_BY_EXT[extname(p).toLowerCase()]
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'asset'
}

/** Folder for a new asset of a kind: <library>/<kind>s/<yyyy-mm>. */
export function assetDir(kind: AssetKind): string {
  const d = new Date()
  const dir = join(getSettings().libraryDir, `${kind}s`, `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

export function newAssetPath(kind: AssetKind, ext: string, name?: string): { id: string; path: string } {
  const id = nanoid(12)
  const e = ext.startsWith('.') ? ext : `.${ext}`
  return { id, path: join(assetDir(kind), `${slug(name ?? kind)}-${id}${e}`) }
}

let ffprobePath: string | null | undefined

async function ffprobe(): Promise<string | null> {
  if (ffprobePath !== undefined) return ffprobePath
  const ff = await detectFfmpeg()
  if (!ff) return (ffprobePath = null)
  const guess = ff.replace(/ffmpeg(\.exe)?$/i, (m) => m.replace('ffmpeg', 'ffprobe'))
  ffprobePath = existsSync(guess) ? guess : null
  return ffprobePath
}

export async function probeMedia(path: string): Promise<MediaProbe> {
  const probe = await ffprobe()
  if (!probe) return { hasAudio: false, hasVideo: kindForPath(path) !== 'audio' }
  try {
    const { stdout } = await run(probe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path])
    const info = JSON.parse(stdout)
    const v = info.streams?.find((s: { codec_type: string }) => s.codec_type === 'video')
    const a = info.streams?.find((s: { codec_type: string }) => s.codec_type === 'audio')
    let fps: number | undefined
    if (v?.avg_frame_rate && v.avg_frame_rate !== '0/0') {
      const [n, d] = v.avg_frame_rate.split('/').map(Number)
      if (d) fps = n / d
    }
    const isStill = kindForPath(path) === 'image'
    return {
      duration: isStill ? undefined : Number(info.format?.duration) || undefined,
      width: v?.width,
      height: v?.height,
      hasAudio: !!a,
      hasVideo: !!v,
      fps
    }
  } catch {
    return { hasAudio: false, hasVideo: kindForPath(path) !== 'audio' }
  }
}

async function makeThumb(videoPath: string, id: string): Promise<string | undefined> {
  const ff = await detectFfmpeg()
  if (!ff) return undefined
  const out = join(getSettings().libraryDir, '.thumbs')
  mkdirSync(out, { recursive: true })
  const file = join(out, `${id}.jpg`)
  try {
    await run(ff, ['-y', '-v', 'error', '-ss', '0.5', '-i', videoPath, '-frames:v', '1', '-vf', 'scale=480:-2', file])
    return existsSync(file) ? file : undefined
  } catch {
    try {
      await run(ff, ['-y', '-v', 'error', '-i', videoPath, '-frames:v', '1', '-vf', 'scale=480:-2', file])
      return existsSync(file) ? file : undefined
    } catch {
      return undefined
    }
  }
}

/**
 * Register a file that already sits at its final location as an asset.
 * Probes dimensions/duration and makes a video poster.
 */
export async function registerAsset(id: string, path: string, kind: AssetKind, meta: Partial<Asset> = {}): Promise<Asset> {
  const probe = await probeMedia(path)
  const asset: Asset = {
    id,
    kind,
    path,
    name: meta.name ?? basename(path, extname(path)),
    createdAt: Date.now(),
    source: meta.source ?? 'generated',
    width: probe.width,
    height: probe.height,
    duration: probe.duration,
    ...meta
  }
  if (kind === 'video') asset.thumbPath = await makeThumb(path, id)
  return db('assets').put(asset)
}

export async function importFile(src: string, meta: Partial<Asset> = {}): Promise<Asset> {
  const kind = kindForPath(src)
  if (!kind) throw new Error(`Unsupported file type: ${basename(src)}`)
  const { id, path } = newAssetPath(kind, extname(src), meta.name ?? basename(src, extname(src)))
  copyFileSync(src, path)
  return registerAsset(id, path, kind, { source: 'imported', name: basename(src, extname(src)), ...meta })
}

export async function saveBytes(bytes: Uint8Array, kind: AssetKind, ext: string, meta: Partial<Asset> = {}): Promise<Asset> {
  const { id, path } = newAssetPath(kind, ext, meta.name)
  writeFileSync(path, bytes)
  return registerAsset(id, path, kind, meta)
}

export function getAsset(id: string): Asset {
  const a = db('assets').get(id)
  if (!a) throw new Error(`Asset ${id} not found`)
  return a
}

export function registerAssets(): void {
  handle('assets:import', async (paths, meta) => {
    const out: Asset[] = []
    for (const p of paths) out.push(await importFile(p, meta))
    return out
  })
  handle('assets:saveBytes', (bytes, kind, ext, meta) => saveBytes(bytes, kind, ext, meta))
  handle('assets:delete', (id, deleteFile) => {
    const a = db('assets').get(id)
    if (!a) return
    db('assets').delete(id)
    if (deleteFile) {
      for (const p of [a.path, a.thumbPath]) {
        if (p && existsSync(p) && statSync(p).isFile()) {
          try {
            unlinkSync(p)
          } catch {
            /* in use */
          }
        }
      }
    }
  })
  handle('assets:probe', (p) => probeMedia(p))
  handle('assets:copyTo', (id, dest) => {
    copyFileSync(getAsset(id).path, dest)
  })
}
