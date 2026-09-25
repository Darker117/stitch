// SHA-256 of multi-GB model files, streamed in a worker thread so neither the
// UI nor the main process stalls. Results are cached by path + size + mtime.
import { app } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'

const WORKER_SRC = `
const { parentPort, workerData } = require('node:worker_threads')
const { createHash } = require('node:crypto')
const { createReadStream } = require('node:fs')
const h = createHash('sha256')
const s = createReadStream(workerData.path, { highWaterMark: 8 * 1024 * 1024 })
s.on('data', (c) => h.update(c))
s.on('end', () => parentPort.postMessage({ hash: h.digest('hex').toUpperCase() }))
s.on('error', (e) => parentPort.postMessage({ error: String((e && e.message) || e) }))
`

interface CacheEntry {
  size: number
  mtimeMs: number
  sha256: string
}

let cache: Record<string, CacheEntry> | null = null
const cacheFile = (): string => join(app.getPath('userData'), 'model-hashes.json')

function loadCache(): Record<string, CacheEntry> {
  if (cache) return cache
  try {
    cache = existsSync(cacheFile()) ? (JSON.parse(readFileSync(cacheFile(), 'utf8')) as Record<string, CacheEntry>) : {}
  } catch {
    cache = {}
  }
  return cache
}

const running = new Map<string, Promise<string>>()

function hashInWorker(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const w = new Worker(WORKER_SRC, { eval: true, workerData: { path } })
    w.once('message', (m: { hash?: string; error?: string }) => {
      void w.terminate()
      if (m.hash) resolve(m.hash)
      else reject(new Error(m.error ?? 'Hashing failed'))
    })
    w.once('error', reject)
  })
}

/** Upper-case hex SHA-256 of a file (cached). */
export async function sha256File(path: string): Promise<string> {
  const st = await stat(path)
  const key = path.toLowerCase()
  const hit = loadCache()[key]
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.sha256
  const pending = running.get(key)
  if (pending) return pending
  const job = hashInWorker(path)
    .then(async (sha256) => {
      loadCache()[key] = { size: st.size, mtimeMs: st.mtimeMs, sha256 }
      await writeFile(cacheFile(), JSON.stringify(cache)).catch(() => {})
      return sha256
    })
    .finally(() => running.delete(key))
  running.set(key, job)
  return job
}

/** Remember a hash we already know (e.g. from Civitai after a download). */
export async function rememberHash(path: string, sha256: string): Promise<void> {
  try {
    const st = await stat(path)
    loadCache()[path.toLowerCase()] = { size: st.size, mtimeMs: st.mtimeMs, sha256: sha256.toUpperCase() }
    await writeFile(cacheFile(), JSON.stringify(cache))
  } catch {
    /* best effort */
  }
}
