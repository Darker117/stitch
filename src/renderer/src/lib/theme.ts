// Runtime theming: writes accent tokens and derives them from backgrounds.
import type { BackgroundSettings, ThemeSettings } from '@shared/types'
import { hexToRgb, hslToRgb, onColor, pickAccents, rgbToHex, rgbToHsl, tintFrom, tuneAccent } from '@shared/theme'
import { fileUrl } from './api'

export function applyTheme(t: ThemeSettings): void {
  const root = document.documentElement.style
  root.setProperty('--accent', t.accent)
  root.setProperty('--accent-2', t.accent2)
  root.setProperty('--accent-fg', onColor(t.accent))
  root.setProperty('--tint', t.tint)
  const { r, g, b } = hexToRgb(t.tint)
  const pr = Math.round(r * 0.55 + 9)
  const pg = Math.round(g * 0.55 + 8)
  const pb = Math.round(b * 0.55 + 12)
  const glass = glassFor(t)
  // Surfaces lean towards the tint and let the backdrop through by `glass`.
  root.setProperty('--panel', `rgb(${pr} ${pg} ${pb} / ${glass})`)
  root.setProperty('--panel-strong', `rgb(${Math.round(pr * 0.8)} ${Math.round(pg * 0.8)} ${Math.round(pb * 0.8)} / ${Math.min(0.94, glass + 0.2)})`)
  root.setProperty('--panel-solid', rgbToHex({ r: pr, g: pg, b: pb }))
  root.setProperty('--glass-blur', `${blurFor(t)}px`)
  // Media backgrounds need a little extra help keeping text legible.
  const media = t.background.type === 'image' || t.background.type === 'video' || t.background.type === 'web'
  document.documentElement.dataset.bg = media ? 'media' : 'plain'
}

/**
 * Decorative art is drawn in the sunset palette. Map one of those colours onto
 * the live accents (warm → accent, cool → accent-2, dark → the tinted panel),
 * keeping its lightness, so art follows the theme and wallpaper accents.
 */
export function themedHue(hex: string): string {
  const { h, s, l } = rgbToHsl(hexToRgb(hex))
  if (l < 0.3 || s < 0.12) return 'color-mix(in oklab, var(--accent-2) 16%, var(--panel-solid))'
  const token = h < 50 || h > 290 ? 'var(--accent)' : 'var(--accent-2)'
  const dark = Math.round(Math.max(0, Math.min(55, (0.62 - l) * 120)))
  return `color-mix(in oklab, ${token}, black ${dark}%)`
}

/** Wallpapers get airier glass by default so they read through the UI. */
export function glassFor(t: ThemeSettings): number {
  if (typeof t.glass === 'number' && t.glass >= 0) return t.glass
  return t.background.wallpaperId || t.background.type === 'image' || t.background.type === 'video' ? 0.46 : 0.72
}

export function blurFor(t: ThemeSettings): number {
  if (typeof t.glassBlur === 'number' && t.glassBlur >= 0) return t.glassBlur
  return t.background.wallpaperId || t.background.type === 'image' || t.background.type === 'video' ? 16 : 22
}

function loadImage(url: string): Promise<CanvasImageSource> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('image failed to load'))
    img.src = url
  })
}

function loadVideoFrame(url: string): Promise<CanvasImageSource> {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video')
    v.crossOrigin = 'anonymous'
    v.muted = true
    v.preload = 'auto'
    v.src = url
    v.onloadeddata = () => {
      v.currentTime = Math.min(1.5, (v.duration || 2) / 3)
    }
    v.onseeked = () => resolve(v)
    v.onerror = () => reject(new Error('video failed to load'))
  })
}

/** Weighted colour swatches from a drawable source. */
function swatchesFrom(src: CanvasImageSource): { hex: string; weight: number }[] {
  const size = 72
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(src, 0, 0, size, size)
  const { data } = ctx.getImageData(0, 0, size, size)
  const buckets = new Map<number, { r: number; g: number; b: number; n: number }>()
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]
    const g = data[i + 1]
    const b = data[i + 2]
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)
    const cur = buckets.get(key) ?? { r: 0, g: 0, b: 0, n: 0 }
    cur.r += r
    cur.g += g
    cur.b += b
    cur.n++
    buckets.set(key, cur)
  }
  const total = size * size
  return [...buckets.values()]
    .map((c) => ({ hex: rgbToHex({ r: c.r / c.n, g: c.g / c.n, b: c.b / c.n }), weight: c.n / total }))
    .filter((s) => {
      const { l } = rgbToHsl(hexToRgb(s.hex))
      return l > 0.08 && l < 0.94
    })
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 48)
}

export type Accents = Pick<ThemeSettings, 'accent' | 'accent2' | 'tint'>

function hueGap(a: number, b: number): number {
  const d = Math.abs(a - b) % 360
  return d > 180 ? 360 - d : d
}

/**
 * Accents from swatches. A vivid Wallpaper Engine scheme colour (the author's
 * chosen accent) leads; the secondary comes from the image itself.
 */
function accentsFrom(swatches: { hex: string; weight: number }[], scheme?: string): Accents | null {
  if (scheme) {
    const sh = rgbToHsl(hexToRgb(scheme))
    if (sh.s > 0.25 && sh.l > 0.15 && sh.l < 0.9) {
      const base = swatches.length ? pickAccents(swatches) : null
      const second = swatches
        .map((s) => ({ ...s, hsl: rgbToHsl(hexToRgb(s.hex)) }))
        .filter((s) => s.hsl.s > 0.2 && hueGap(s.hsl.h, sh.h) > 30)
        .sort((a, b) => b.hsl.s * Math.sqrt(b.weight) - a.hsl.s * Math.sqrt(a.weight))[0]
      return {
        accent: tuneAccent(scheme),
        accent2: second ? tuneAccent(second.hex) : base?.accent2 ?? tuneAccent(rgbToHex(hslToRgb({ ...sh, h: sh.h + 40 }))),
        tint: base?.tint ?? tintFrom(scheme)
      }
    }
  }
  return swatches.length ? pickAccents(swatches) : null
}

/** Accents from something already drawable (e.g. the playing background video). */
export function accentsFromSource(src: CanvasImageSource, scheme?: string): Accents | null {
  try {
    return accentsFrom(swatchesFrom(src), scheme)
  } catch {
    return null
  }
}

/** Choose accents that suit a background. */
export async function accentsForBackground(bg: BackgroundSettings, previewPath?: string, schemeColor?: string): Promise<Accents | null> {
  try {
    let src: CanvasImageSource | null = null
    // Web wallpapers can't be sampled directly; use their preview image.
    const path = previewPath ?? bg.preview ?? (bg.type === 'web' ? undefined : bg.path)
    if (path) {
      const isVideo = /\.(mp4|webm|mov|m4v|mkv)$/i.test(path)
      src = isVideo ? await loadVideoFrame(fileUrl(path)) : await loadImage(fileUrl(path))
    }
    return accentsFrom(src ? swatchesFrom(src) : [], schemeColor ?? bg.scheme)
  } catch {
    return null
  }
}

/** Temporarily override the accents without saving (live video sampling). */
export function applyAccentsLive(a: Accents): void {
  const root = document.documentElement.style
  root.setProperty('--accent', a.accent)
  root.setProperty('--accent-2', a.accent2)
  root.setProperty('--accent-fg', onColor(a.accent))
  root.setProperty('--tint', a.tint)
}

/** Perceptual-ish distance between two accent sets, 0 = identical. */
export function accentDistance(a: Accents, b: Accents): number {
  const d = (x: string, y: string): number => {
    const p = rgbToHsl(hexToRgb(x))
    const q = rgbToHsl(hexToRgb(y))
    return hueGap(p.h, q.h) / 180 + Math.abs(p.s - q.s) + Math.abs(p.l - q.l)
  }
  return d(a.accent, b.accent) + d(a.accent2, b.accent2) * 0.6
}
