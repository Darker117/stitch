/// <reference types="electron-vite/node" />
// Scene cache: compiled scenes live in <userData>/wallpapers/<id>/ next to
// their extracted textures, keyed by the package's size/mtime, Wallpaper
// Engine's asset version and the property values, and are rebuilt in a
// worker thread when any of those change.
import { app } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SCENE_FORMAT, type SceneData } from '@shared/wallpaper'
import createCompileWorker from './compile.worker?nodeWorker'
import type { CompileInput } from './scene'

export const wallpaperCacheDir = (): string => join(app.getPath('userData'), 'wallpapers')

export interface SceneSource {
  id: string
  dir: string
  /** scene.json inside the package or folder. */
  file: string
  assets?: string
  properties: Record<string, unknown>
}

function stampOf(src: SceneSource, pkg: string | undefined): string {
  const parts = [String(SCENE_FORMAT)]
  const stat = (p: string): string => {
    try {
      const s = statSync(p)
      return `${s.size}:${Math.round(s.mtimeMs)}`
    } catch {
      return '-'
    }
  }
  parts.push(pkg ? stat(pkg) : stat(join(src.dir, src.file)))
  if (src.assets) parts.push(stat(join(src.assets, '..', 'version.json')))
  parts.push(createHash('sha1').update(JSON.stringify(src.properties)).digest('hex').slice(0, 12))
  return parts.join('|')
}

export function scenePackage(dir: string): string | undefined {
  return ['scene.pkg', 'gifscene.pkg'].map((f) => join(dir, f)).find((f) => existsSync(f))
}

const memory = new Map<string, { stamp: string; data: SceneData }>()
const running = new Map<string, Promise<SceneData>>()

function compileInWorker(input: CompileInput): Promise<SceneData> {
  return new Promise((resolve, reject) => {
    const worker = createCompileWorker({ workerData: input })
    worker.once('message', (m: { data?: SceneData; error?: string }) => {
      void worker.terminate()
      if (m.data) resolve(m.data)
      else reject(new Error(m.error ?? 'Could not read this scene'))
    })
    worker.once('error', reject)
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`Scene reader stopped (${code})`))
    })
  })
}

/** Compile (or load the cached) scene for a wallpaper. */
export function loadScene(src: SceneSource): Promise<SceneData> {
  const pkg = scenePackage(src.dir)
  const stamp = stampOf(src, pkg)
  const hit = memory.get(src.id)
  if (hit && hit.stamp === stamp) return Promise.resolve(hit.data)
  const key = `${src.id}|${stamp}`
  const pending = running.get(key)
  if (pending) return pending

  const job = (async (): Promise<SceneData> => {
    const root = wallpaperCacheDir()
    const dir = join(root, src.id)
    const file = join(dir, 'scene.json')
    if (existsSync(file)) {
      try {
        const cached = JSON.parse(readFileSync(file, 'utf8')) as { stamp: string; data: SceneData }
        const firstTex = Object.values(cached.data.textures)[0]?.paths[0]
        if (cached.stamp === stamp && (!firstTex || existsSync(firstTex))) {
          memory.set(src.id, { stamp, data: cached.data })
          return cached.data
        }
      } catch {
        /* rebuild */
      }
      // Stale: drop the old extraction before writing the new one.
      rmSync(dir, { recursive: true, force: true })
    }
    mkdirSync(dir, { recursive: true })
    const data = await compileInWorker({ id: src.id, dir: src.dir, file: src.file, pkg, assets: src.assets, cacheDir: root, properties: src.properties })
    writeFileSync(file, JSON.stringify({ stamp, data }))
    memory.set(src.id, { stamp, data })
    return data
  })()
  running.set(key, job)
  void job.finally(() => running.delete(key)).catch(() => {})
  return job
}
