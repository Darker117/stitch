// Colour palette and colour maths shared by main and renderer.

/** Stops sampled top→bottom from the reference sunset photo. */
export const SUNSET_STOPS = [
  '#6d65b8', // periwinkle
  '#8070b6',
  '#8f78b2', // lavender
  '#ad849d', // mauve
  '#b58889',
  '#cc7b62', // peach
  '#c85d56', // coral
  '#aa3b51', // rose
  '#8e3452', // wine
  '#312b47' // dusk
] as const

export const SUNSET = {
  accent: '#f08a6c', // lifted peach for contrast on dark surfaces
  accent2: '#8c84e6', // lifted periwinkle
  tint: '#1b1830' // dusk
}

export interface RGB {
  r: number
  g: number
  b: number
}
export interface HSL {
  h: number
  s: number
  l: number
}

export function hexToRgb(hex: string): RGB {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.padEnd(6, '0')
  const n = parseInt(full.slice(0, 6), 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

export function rgbToHex({ r, g, b }: RGB): string {
  const c = (v: number): string => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')
  return `#${c(r)}${c(g)}${c(b)}`
}

export function rgbToHsl({ r, g, b }: RGB): HSL {
  r /= 255
  g /= 255
  b /= 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  let h = 0
  let s = 0
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0)
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h /= 6
  }
  return { h: h * 360, s, l }
}

export function hslToRgb({ h, s, l }: HSL): RGB {
  h = (((h % 360) + 360) % 360) / 360
  if (s === 0) return { r: l * 255, g: l * 255, b: l * 255 }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const f = (t: number): number => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  return { r: f(h + 1 / 3) * 255, g: f(h) * 255, b: f(h - 1 / 3) * 255 }
}

export function luminance({ r, g, b }: RGB): number {
  const ch = (v: number): number => {
    v /= 255
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b)
}

export function contrast(a: string, b: string): number {
  const la = luminance(hexToRgb(a))
  const lb = luminance(hexToRgb(b))
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** Nudge a colour until it reads well as an accent on dark UI. */
export function tuneAccent(hex: string): string {
  const hsl = rgbToHsl(hexToRgb(hex))
  // Greys make poor accents; give them a little life.
  const s = hsl.s < 0.25 ? Math.max(hsl.s, 0.35) : Math.min(1, Math.max(hsl.s, 0.55))
  const l = Math.min(0.74, Math.max(0.6, hsl.l))
  return rgbToHex(hslToRgb({ h: hsl.h, s, l }))
}

/** Very dark, desaturated version of a colour used to tint surfaces. */
export function tintFrom(hex: string): string {
  const hsl = rgbToHsl(hexToRgb(hex))
  return rgbToHex(hslToRgb({ h: hsl.h, s: Math.min(0.35, hsl.s * 0.6), l: 0.11 }))
}

/** Readable foreground (near-black or white) for text on top of `hex`. */
export function onColor(hex: string): string {
  return luminance(hexToRgb(hex)) > 0.36 ? '#140f1c' : '#ffffff'
}

/**
 * Pick a primary and secondary accent from a set of weighted swatches.
 * Favours saturated, mid-light colours; the secondary is the best-scoring
 * swatch whose hue sits far enough away from the primary.
 */
export function pickAccents(swatches: { hex: string; weight: number }[]): { accent: string; accent2: string; tint: string } {
  if (!swatches.length) return { ...SUNSET }
  const scored = swatches.map((s) => {
    const hsl = rgbToHsl(hexToRgb(s.hex))
    const vivid = hsl.s * (1 - Math.abs(hsl.l - 0.55) * 1.6)
    return { ...s, hsl, score: vivid * 0.75 + Math.sqrt(s.weight) * 0.25 }
  })
  scored.sort((a, b) => b.score - a.score)
  const primary = scored[0]
  const hueGap = (a: number, b: number): number => {
    const d = Math.abs(a - b) % 360
    return d > 180 ? 360 - d : d
  }
  const secondary =
    scored.find((s) => hueGap(s.hsl.h, primary.hsl.h) > 35 && s.hsl.s > 0.2) ??
    { hex: rgbToHex(hslToRgb({ ...primary.hsl, h: primary.hsl.h + 40 })) }
  const dominant = [...swatches].sort((a, b) => b.weight - a.weight)[0]
  return { accent: tuneAccent(primary.hex), accent2: tuneAccent(secondary.hex), tint: tintFrom(dominant.hex) }
}

/** "0.5 0.25 1" (Wallpaper Engine scheme colour) → #rrggbb. */
export function schemeToHex(scheme: string | undefined): string | undefined {
  if (!scheme) return undefined
  const parts = scheme.trim().split(/\s+/).map(Number)
  if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return undefined
  return rgbToHex({ r: parts[0] * 255, g: parts[1] * 255, b: parts[2] * 255 })
}
