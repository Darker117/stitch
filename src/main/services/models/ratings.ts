// Content rating for previews Stability Matrix saved. Its sidecars only carry
// the model's NSFW flag, which Civitai often leaves false even when the
// preview is explicit. The version's public image list has a rating per image;
// SM saves an original image, so matching pixel size finds which one it is.
// Results live in Stitch's own cache — SM's sidecars are never rewritten.
import { app } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { open, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CivitaiError, civitaiGet } from './civitai'

/** Pixel size from a PNG/JPEG/WebP header (whatever the file extension says). */
export async function imageSize(path: string): Promise<{ w: number; h: number } | undefined> {
  let fh
  try {
    fh = await open(path, 'r')
    const head = Buffer.alloc(32)
    await fh.read(head, 0, 32, 0)
    if (head.readUInt32BE(0) === 0x89504e47) return { w: head.readUInt32BE(16), h: head.readUInt32BE(20) }
    if (head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP') {
      const chunk = head.toString('ascii', 12, 16)
      if (chunk === 'VP8X') return { w: 1 + head.readUIntLE(24, 3), h: 1 + head.readUIntLE(27, 3) }
      if (chunk === 'VP8 ') return { w: head.readUInt16LE(26) & 0x3fff, h: head.readUInt16LE(28) & 0x3fff }
      if (chunk === 'VP8L') {
        const b = head.readUInt32LE(21)
        return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 }
      }
      return undefined
    }
    if (head[0] === 0xff && head[1] === 0xd8) {
      const buf = Buffer.alloc(9)
      let pos = 2
      for (let i = 0; i < 2000; i++) {
        const { bytesRead } = await fh.read(buf, 0, 9, pos)
        if (bytesRead < 4) return undefined
        if (buf[0] !== 0xff) {
          pos++
          continue
        }
        const m = buf[1]
        if (m === 0xff) {
          pos++
          continue
        }
        if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
          pos += 2
          continue
        }
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: buf.readUInt16BE(5), w: buf.readUInt16BE(7) }
        pos += 2 + buf.readUInt16BE(2)
      }
    }
  } catch {
    /* unreadable */
  } finally {
    await fh?.close()
  }
  return undefined
}

interface Entry {
  level: number
  at: number
  /** Matching-rule version; older entries are re-rated. */
  v?: number
}

const RULES = 2

let cache: Record<string, Entry> | null = null
const file = (): string => join(app.getPath('userData'), 'model-preview-ratings.json')
const keyOf = (previewPath: string, size: number, mtimeMs: number): string => `${previewPath.toLowerCase()}|${size}|${Math.round(mtimeMs)}`

function load(): Record<string, Entry> {
  if (cache) return cache
  try {
    cache = existsSync(file()) ? (JSON.parse(readFileSync(file(), 'utf8')) as Record<string, Entry>) : {}
  } catch {
    cache = {}
  }
  return cache
}

/** Known rating for a preview: ≥1 is a Civitai nsfwLevel, 0 means "couldn't tell". */
export function cachedRating(previewPath: string, size: number, mtimeMs: number): number | undefined {
  const e = load()[keyOf(previewPath, size, mtimeMs)]
  return e?.v === RULES ? e.level : undefined
}

interface Job {
  previewPath: string
  versionId: number
  size: number
  mtimeMs: number
}

const queue: Job[] = []
const queued = new Set<string>()
let draining = false

export function queueRating(job: Job): void {
  const k = keyOf(job.previewPath, job.size, job.mtimeMs)
  if (queued.has(k)) return
  queued.add(k)
  queue.push(job)
}

export function hasPendingRatings(): boolean {
  return queue.length > 0
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function rate(job: Job): Promise<number> {
  const v = await civitaiGet<any>(`/model-versions/${job.versionId}`, { timeoutMs: 20_000 })
  const images: any[] = (v.images ?? []).filter((i: any) => i && i.type !== 'video')
  const dims = await imageSize(job.previewPath)
  const level = (i: any): number => Number(i?.nsfwLevel) || 0
  if (dims) {
    const same = images.filter((i) => i.width === dims.w && i.height === dims.h)
    // Stability Matrix saves the version's first image — trust it when the size fits.
    if (same.includes(images[0])) return level(images[0])
    // Otherwise (a preview chosen by hand) be conservative among look-alikes.
    if (same.length) return Math.max(...same.map(level))
  }
  return level(images[0])
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Rate queued previews one by one; `onRated` is called as results arrive. */
export async function drainRatings(onRated: (previewPath: string, level: number) => void, onBatch: () => void): Promise<void> {
  if (draining) return
  draining = true
  let n = 0
  try {
    while (queue.length) {
      const job = queue.shift()!
      const k = keyOf(job.previewPath, job.size, job.mtimeMs)
      let level: number | undefined
      try {
        level = await rate(job)
      } catch (err) {
        if (err instanceof CivitaiError && err.status === 404) level = 0
        else {
          // Offline or rate-limited: try again on the next scan.
          queued.delete(k)
          for (const j of queue.splice(0)) queued.delete(keyOf(j.previewPath, j.size, j.mtimeMs))
          break
        }
      }
      queued.delete(k)
      load()[k] = { level, at: Date.now(), v: RULES }
      onRated(job.previewPath, level)
      if (++n % 8 === 0) {
        onBatch()
        await writeFile(file(), JSON.stringify(cache)).catch(() => {})
      }
      await new Promise((r) => setTimeout(r, 120))
    }
  } finally {
    draining = false
    if (n) {
      await writeFile(file(), JSON.stringify(cache)).catch(() => {})
      onBatch()
    }
  }
}
