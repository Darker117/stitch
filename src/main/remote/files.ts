// Media for phones: range-served files, OS thumbnails, wallpaper folders and uploads.
import { app, nativeImage } from 'electron'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { nanoid } from 'nanoid'
import { getSettings } from '../settings'
import { db, dataDir } from '../store'
import { MIME, wallpaperRoot, wallpaperShim } from '../protocol'
import { detectStabilityMatrix, detectWallpaperEngine } from '../services/system'
import { modelBases } from '../services/models/home'

const cacheDir = (): string => join(app.getPath('userData'), 'remote-cache')
export const uploadDir = (): string => join(app.getPath('userData'), 'remote-uploads')

// ─── Which files a phone may read ────────────────────────────────────────────

let staticRoots: { at: number; roots: string[] } | null = null

function roots(): string[] {
  if (staticRoots && Date.now() - staticRoots.at < 30_000) return staticRoots.roots
  const s = getSettings()
  const list = [s.libraryDir, dataDir(), app.getPath('userData'), s.modelsDir, s.comfyDir, ...(s.extraModelDirs ?? [])]
  try {
    for (const b of modelBases()) list.push(b.dir)
  } catch {
    /* model home not ready */
  }
  const sm = detectStabilityMatrix()
  if (sm) list.push(sm.modelsDir, sm.comfyDir)
  const we = detectWallpaperEngine()
  if (we) list.push(dirname(dirname(we.workshopDir)))
  if (s.theme.background.path) list.push(dirname(s.theme.background.path))
  const out = [...new Set(list.filter((p): p is string => !!p).map((p) => resolve(p).toLowerCase()))]
  staticRoots = { at: Date.now(), roots: out }
  return out
}

/** Files under Stitch's own folders, model folders, the wallpaper, or any library asset. */
export function mayServe(path: string): boolean {
  const full = resolve(path).toLowerCase()
  if (roots().some((r) => full === r || full.startsWith(r.endsWith(sep) ? r : r + sep))) return true
  return db('assets')
    .list()
    .some((a) => resolve(a.path).toLowerCase() === full || (a.thumbPath && resolve(a.thumbPath).toLowerCase() === full))
}

// ─── Range file serving ──────────────────────────────────────────────────────

export function sendFile(req: IncomingMessage, res: ServerResponse, path: string, extraHeaders: Record<string, string> = {}): void {
  let size: number
  try {
    const st = statSync(path)
    if (!st.isFile()) return notFound(res)
    size = st.size
  } catch {
    return notFound(res)
  }
  const headers: Record<string, string | number> = {
    'Content-Type': MIME[extname(path).toLowerCase()] ?? 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=60',
    ...extraHeaders
  }
  const range = req.headers.range
  const m = range ? /bytes=(\d*)-(\d*)/.exec(range) : null
  if (m) {
    let start = m[1] ? parseInt(m[1], 10) : 0
    let end = m[2] ? parseInt(m[2], 10) : size - 1
    if (!m[1] && m[2]) {
      start = Math.max(0, size - parseInt(m[2], 10))
      end = size - 1
    }
    end = Math.min(end, size - 1)
    if (start > end || start >= size) {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` })
      res.end()
      return
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 })
    if (req.method === 'HEAD') return void res.end()
    createReadStream(path, { start, end }).on('error', () => res.destroy()).pipe(res)
    return
  }
  res.writeHead(200, { ...headers, 'Content-Length': size })
  if (req.method === 'HEAD') return void res.end()
  createReadStream(path).on('error', () => res.destroy()).pipe(res)
}

export function notFound(res: ServerResponse, status = 404, text = 'Not found'): void {
  if (res.headersSent) return void res.end()
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end(text)
}

// ─── Thumbnails (Windows shell thumbnails, cached as JPEG) ───────────────────

const THUMB_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.avif', '.mp4', '.webm', '.mov', '.mkv', '.m4v'])
const inflight = new Map<string, Promise<string | null>>()
let running = 0
const waiting: (() => void)[] = []

async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= 3) await new Promise<void>((r) => waiting.push(r))
  running++
  try {
    return await fn()
  } finally {
    running--
    waiting.shift()?.()
  }
}

/** Path of a cached JPEG thumbnail no wider/taller than `size`, or null (serve the original). */
export async function thumbnail(path: string, size: number): Promise<string | null> {
  const ext = extname(path).toLowerCase()
  if (!THUMB_EXT.has(ext) || ext === '.gif') return null
  let st: { mtimeMs: number; size: number }
  try {
    st = statSync(path)
  } catch {
    return null
  }
  // Small files aren't worth a thumbnail.
  if (!/\.(mp4|webm|mov|mkv|m4v)$/.test(ext) && st.size < 120_000) return null
  const key = createHash('sha1').update(`${path}|${st.mtimeMs}|${st.size}|${size}`).digest('hex')
  const out = join(cacheDir(), 'thumbs', key.slice(0, 2), `${key}.jpg`)
  if (existsSync(out)) return out
  const pending = inflight.get(key)
  if (pending) return pending
  const job = slot(async () => {
    try {
      // The Windows shell wants backslashes; fall back to decoding PNG/JPEG ourselves.
      let img = await nativeImage.createThumbnailFromPath(normalize(path), { width: size, height: size }).catch(() => nativeImage.createEmpty())
      if (img.isEmpty() && /\.(png|jpe?g)$/.test(ext)) img = nativeImage.createFromPath(normalize(path))
      if (img.isEmpty()) return null
      const { width, height } = img.getSize()
      if (Math.max(width, height) > size) img = img.resize(width >= height ? { width: size, quality: 'good' } : { height: size, quality: 'good' })
      mkdirSync(dirname(out), { recursive: true })
      writeFileSync(out, img.toJPEG(82))
      return out
    } catch {
      return null
    } finally {
      inflight.delete(key)
    }
  })
  inflight.set(key, job)
  return job
}

// ─── Wallpaper folders (web wallpapers load their own relative files) ────────

export function sendWallpaperFile(req: IncomingMessage, res: ServerResponse, id: string, rel: string): void {
  const root = wallpaperRoot(id)
  if (!root) return notFound(res)
  const full = resolve(join(root, normalize(rel || 'index.html')))
  if (full !== root && !full.startsWith(root + sep)) return notFound(res, 403, 'Forbidden')
  if (/\.html?$/i.test(full)) {
    try {
      let html = readFileSync(full, 'utf8')
      const shim = wallpaperShim(root)
      html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + shim) : shim + html
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' })
      res.end(html)
    } catch {
      notFound(res)
    }
    return
  }
  sendFile(req, res, full)
}

// ─── Uploads (phone → PC), then imported like any local file ─────────────────

const MAX_UPLOAD = 4 * 1024 ** 3

export async function receiveUpload(req: IncomingMessage, name: string): Promise<string> {
  const dir = join(uploadDir(), new Date().toISOString().slice(0, 10))
  mkdirSync(dir, { recursive: true })
  const clean = basename(name || 'upload').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(-120) || 'upload'
  const dest = join(dir, `${nanoid(6)}-${clean}`)
  let received = 0
  req.on('data', (chunk: Buffer) => {
    received += chunk.length
    if (received > MAX_UPLOAD) req.destroy(new Error('Upload too large'))
  })
  try {
    await pipeline(req, createWriteStream(dest))
  } catch (err) {
    try {
      unlinkSync(dest)
    } catch {
      /* ignore */
    }
    throw err
  }
  return dest
}

/** Drop uploads older than two days (they've been imported into the library by then). */
export function cleanUploads(): void {
  const root = uploadDir()
  if (!existsSync(root)) return
  const cutoff = Date.now() - 2 * 86_400_000
  for (const day of readdirSync(root)) {
    const dir = join(root, day)
    try {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f)
        if (statSync(p).mtimeMs < cutoff) unlinkSync(p)
      }
    } catch {
      /* ignore */
    }
  }
}
