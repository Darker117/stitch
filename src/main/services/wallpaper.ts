// Wallpaper Engine import: lists workshop items (and presets), turns one into a
// background — video, sandboxed web page, or a scene compiled for Stitch's
// WebGL renderer — and browses/downloads new ones from the Steam Workshop.
import { app, desktopCapturer, session } from 'electron'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import type { BackgroundSettings, WallpaperItem } from '@shared/types'
import { schemeToHex } from '@shared/theme'
import { handle } from '../ipc'
import { registerWallpaperDir } from '../protocol'
import { loadScene } from './wallpaper/scenes'
import { details, downloads, environment, search, steamInfo, subscribe, weAssetsDir } from './wallpaper/workshop'

const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov', '.m4v', '.mkv'])
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'])

interface Project {
  title?: string
  type?: string
  file?: string
  preview?: string
  contentrating?: string
  tags?: string[]
  dependency?: string
  preset?: Record<string, unknown>
  general?: { properties?: Record<string, { value?: unknown; type?: string }> }
}

function readProject(dir: string): Project | null {
  try {
    return JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8').replace(/^﻿/, '')) as Project
  } catch {
    return null
  }
}

/** Presets point at another wallpaper and override some of its properties. */
const presets = new Map<string, { dir: string; values: Record<string, unknown> }>()

function readItem(dir: string, id: string, roots: string[]): WallpaperItem | null {
  const j = readProject(dir)
  if (!j) return null
  let base = j
  let baseDir = dir
  if (j.dependency && !j.type) {
    const depDir = roots.map((r) => join(r, String(j.dependency))).find((d) => existsSync(join(d, 'project.json')))
    const dep = depDir ? readProject(depDir) : null
    if (!dep || !depDir) return null
    base = dep
    baseDir = depDir
    presets.set(id, { dir, values: j.preset ?? {} })
  }
  const ownPreview = j.preview && existsSync(join(dir, j.preview)) ? join(dir, j.preview) : undefined
  const basePreview = base.preview && existsSync(join(baseDir, base.preview)) ? join(baseDir, base.preview) : undefined
  const scheme = (j.preset?.schemecolor as string | undefined) ?? base.general?.properties?.schemecolor?.value
  return {
    id,
    title: j.title?.trim() || base.title?.trim() || `Wallpaper ${id}`,
    type: (base.type ?? 'scene').toLowerCase(),
    dir: baseDir,
    file: base.file ? join(baseDir, base.file) : undefined,
    preview: ownPreview ?? basePreview,
    schemeColor: schemeToHex(typeof scheme === 'string' ? scheme : undefined),
    contentRating: j.contentrating ?? base.contentrating,
    tags: j.tags ?? base.tags
  }
}

function roots(): string[] {
  const out: string[] = []
  const workshop = steamInfo().workshopDir
  if (workshop && existsSync(workshop)) {
    out.push(workshop)
    // Local "myprojects" folder next to the workshop content.
    const mine = join(workshop, '..', '..', '..', 'common', 'wallpaper_engine', 'projects', 'myprojects')
    if (existsSync(mine)) out.push(mine)
  }
  return out
}

export function listWallpapers(): WallpaperItem[] {
  const rs = roots()
  const out: WallpaperItem[] = []
  for (const root of rs) {
    let entries: string[] = []
    try {
      entries = readdirSync(root)
    } catch {
      continue
    }
    for (const id of entries) {
      const item = readItem(join(root, id), id, rs)
      if (item) out.push(item)
    }
  }
  return out.sort((a, b) => a.title.localeCompare(b.title))
}

/** User property values: project.json defaults, overridden by a preset's. */
function propertiesOf(item: WallpaperItem): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(readProject(item.dir)?.general?.properties ?? {})) out[k] = v?.value
  return { ...out, ...(presets.get(item.id)?.values ?? {}) }
}

function sceneSource(item: WallpaperItem): Parameters<typeof loadScene>[0] {
  const project = readProject(item.dir)
  const file = project?.file && /\.json$/i.test(project.file) ? project.file.replace(/\\/g, '/') : 'scene.json'
  return { id: item.id, dir: item.dir, file, assets: weAssetsDir(), properties: propertiesOf(item) }
}

function registerWeb(item: WallpaperItem): void {
  const preset = presets.get(item.id)
  registerWallpaperDir(item.id, item.dir, preset ? { fallback: preset.dir, properties: preset.values } : undefined)
}

/** Pick the best way to show a wallpaper inside Stitch. */
export async function wallpaperBackground(item: WallpaperItem): Promise<BackgroundSettings> {
  // Light dim so the wallpaper reads through Stitch's glass panels.
  const base = { dim: 0.18, blur: 0, wallpaperId: item.id, preview: item.preview, scheme: item.schemeColor }
  if (item.type === 'video' && item.file && VIDEO_EXT.has(extname(item.file).toLowerCase())) {
    return { ...base, type: 'video', path: item.file }
  }
  if (item.type === 'web' && item.file && existsSync(item.file)) {
    registerWeb(item)
    return { ...base, type: 'web', path: item.file }
  }
  if (item.type === 'scene') {
    try {
      const scene = await loadScene(sceneSource(item))
      // 3D-camera scenes (models, perspective) are beyond the 2D renderer: their animated preview is the honest stand-in.
      const drawable = scene.layers.some((l) => l.visible && (l.kind === 'image' || l.kind === 'solid' || l.kind === 'particles'))
      if (drawable && !scene.skipped.some((s) => s.includes('3D camera'))) {
        // The full-resolution still stands in for accents and while the scene loads.
        const still = scene.still ?? item.preview
        return { ...base, type: 'scene', path: still, preview: still }
      }
    } catch (err) {
      console.warn(`[wallpaper] scene ${item.id} could not be read:`, err instanceof Error ? err.message : err)
    }
  }
  if (item.file && IMAGE_EXT.has(extname(item.file).toLowerCase())) return { ...base, type: 'image', path: item.file }
  if (item.preview) return { ...base, type: 'image', path: item.preview }
  return { ...base, type: 'gradient' }
}

function findItem(id: string): WallpaperItem {
  const item = listWallpapers().find((w) => w.id === id)
  if (!item) throw new Error('Wallpaper not found')
  return item
}

/**
 * Loopback audio for audio-reactive wallpapers: Stitch's own window asks via
 * getDisplayMedia; we answer with the system audio. The renderer drops the
 * (required) video track immediately and only runs a frequency analyser.
 */
function allowWallpaperAudio(): void {
  const own = (url: string | undefined): boolean => {
    if (!url) return false
    const dev = process.env.ELECTRON_RENDERER_URL
    return url.startsWith('file://') || (!app.isPackaged && !!dev && url.startsWith(dev))
  }
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    if (!request.audioRequested || !own(request.frame?.url ?? request.securityOrigin)) return callback({})
    desktopCapturer
      .getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
      .then((sources) => (sources[0] ? callback({ video: sources[0], audio: 'loopback' }) : callback({})))
      .catch(() => callback({}))
  })
}

export function registerWallpaper(): void {
  handle('wallpaper:list', () => listWallpapers())
  handle('wallpaper:apply', async (id) => {
    const item = findItem(id)
    return { background: await wallpaperBackground(item), schemeColor: item.schemeColor }
  })
  handle('wallpaper:scene', async (id) => {
    const item = findItem(id)
    if (item.type !== 'scene') throw new Error('Not a scene wallpaper')
    return await loadScene(sceneSource(item))
  })
  handle('wallpaper:pickCustom', async () => {
    const { dialog, BrowserWindow } = await import('electron')
    const res = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow()!, {
      title: 'Choose a background',
      properties: ['openFile'],
      filters: [{ name: 'Images & video', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'mp4', 'webm', 'mov'] }]
    })
    if (res.canceled || !res.filePaths[0]) return null
    const p = res.filePaths[0]
    const type: BackgroundSettings['type'] = VIDEO_EXT.has(extname(p).toLowerCase()) ? 'video' : 'image'
    return { background: { type, path: p, dim: 0.4, blur: 0 } }
  })
  handle('wallpaper:search', (query) => search(query))
  handle('wallpaper:details', async (id) => (await details([id]))[0] ?? null)
  handle('wallpaper:subscribe', (id) => subscribe(id))
  handle('wallpaper:environment', () => ({ ...environment(), downloads: downloads() }))
  allowWallpaperAudio()
}

/** Re-register the sandbox root for an active web wallpaper after restart. */
export function restoreWallpaperRoot(bg: BackgroundSettings): void {
  if (bg.type === 'web' && bg.wallpaperId && bg.path) {
    const item = listWallpapers().find((w) => w.id === bg.wallpaperId)
    if (item) registerWeb(item)
  }
}
