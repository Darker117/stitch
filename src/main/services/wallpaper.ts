// Wallpaper Engine import: lists workshop items and turns one into a background.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import type { BackgroundSettings, WallpaperItem } from '@shared/types'
import { schemeToHex } from '@shared/theme'
import { handle } from '../ipc'
import { registerWallpaperDir } from '../protocol'
import { detectWallpaperEngine } from './system'

const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov', '.m4v', '.mkv'])
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'])

function readItem(dir: string, id: string): WallpaperItem | null {
  const pj = join(dir, 'project.json')
  if (!existsSync(pj)) return null
  try {
    const raw = readFileSync(pj, 'utf8').replace(/^﻿/, '')
    const j = JSON.parse(raw) as {
      title?: string
      type?: string
      file?: string
      preview?: string
      contentrating?: string
      tags?: string[]
      general?: { properties?: { schemecolor?: { value?: string } } }
    }
    const preview = j.preview && existsSync(join(dir, j.preview)) ? join(dir, j.preview) : undefined
    return {
      id,
      title: j.title?.trim() || `Wallpaper ${id}`,
      type: (j.type ?? 'scene').toLowerCase(),
      dir,
      file: j.file ? join(dir, j.file) : undefined,
      preview,
      schemeColor: schemeToHex(j.general?.properties?.schemecolor?.value),
      contentRating: j.contentrating,
      tags: j.tags
    }
  } catch {
    return null
  }
}

export function listWallpapers(): WallpaperItem[] {
  const roots: string[] = []
  const we = detectWallpaperEngine()
  if (we) roots.push(we.workshopDir)
  // Local "myprojects" folder next to the workshop content.
  if (we) {
    const common = join(we.workshopDir, '..', '..', '..', 'common', 'wallpaper_engine', 'projects', 'myprojects')
    if (existsSync(common)) roots.push(common)
  }
  const out: WallpaperItem[] = []
  for (const root of roots) {
    let entries: string[] = []
    try {
      entries = readdirSync(root)
    } catch {
      continue
    }
    for (const id of entries) {
      const item = readItem(join(root, id), id)
      if (item) out.push(item)
    }
  }
  return out.sort((a, b) => a.title.localeCompare(b.title))
}

/** Pick the best way to show a wallpaper inside Stitch. */
export function wallpaperBackground(item: WallpaperItem): BackgroundSettings {
  // Light dim so the wallpaper reads through Stitch's glass panels.
  const base = { dim: 0.18, blur: 0, wallpaperId: item.id, preview: item.preview, scheme: item.schemeColor }
  if (item.type === 'video' && item.file && VIDEO_EXT.has(extname(item.file).toLowerCase())) {
    return { ...base, type: 'video', path: item.file }
  }
  if (item.type === 'web' && item.file && existsSync(item.file)) {
    registerWallpaperDir(item.id, item.dir)
    return { ...base, type: 'web', path: item.file }
  }
  // Scenes use a proprietary package; their animated preview is the best stand-in.
  if (item.preview) return { ...base, type: 'image', path: item.preview }
  if (item.file && IMAGE_EXT.has(extname(item.file).toLowerCase())) return { ...base, type: 'image', path: item.file }
  return { ...base, type: 'gradient' }
}

export function registerWallpaper(): void {
  handle('wallpaper:list', () => listWallpapers())
  handle('wallpaper:apply', (id) => {
    const item = listWallpapers().find((w) => w.id === id)
    if (!item) throw new Error('Wallpaper not found')
    return { background: wallpaperBackground(item), schemeColor: item.schemeColor }
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
}

/** Re-register the sandbox root for an active web wallpaper after restart. */
export function restoreWallpaperRoot(bg: BackgroundSettings): void {
  if (bg.type === 'web' && bg.wallpaperId && bg.path) {
    const item = listWallpapers().find((w) => w.id === bg.wallpaperId)
    if (item) registerWallpaperDir(item.id, item.dir)
  }
}
