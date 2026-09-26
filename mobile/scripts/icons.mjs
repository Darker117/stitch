// Android launcher icons + splash art from the Stitch brand mark (rendered with the desktop repo's sharp).
//   node scripts/icons.mjs
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const desktop = resolve(process.env.STITCH_DESKTOP ?? join(here, '../..'))
const sharp = createRequire(join(desktop, 'package.json'))('sharp')
const res = join(here, '../android/app/src/main/res')
const mark = readFileSync(join(desktop, 'resources/logo-mark.svg'))

const BG = '#0b0a12'
const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 }

function background(size, round) {
  const r = round ? size / 2 : size * 0.22
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
  <defs>
    <radialGradient id="a" cx="20%" cy="105%" r="85%"><stop offset="0" stop-color="#f08a6c" stop-opacity=".55"/><stop offset="1" stop-color="#f08a6c" stop-opacity="0"/></radialGradient>
    <radialGradient id="b" cx="95%" cy="10%" r="70%"><stop offset="0" stop-color="#8c84e6" stop-opacity=".45"/><stop offset="1" stop-color="#8c84e6" stop-opacity="0"/></radialGradient>
    <clipPath id="c"><rect width="${size}" height="${size}" rx="${r}" ry="${r}"/></clipPath>
  </defs>
  <g clip-path="url(#c)">
    <rect width="${size}" height="${size}" fill="${BG}"/>
    <rect width="${size}" height="${size}" fill="url(#a)"/>
    <rect width="${size}" height="${size}" fill="url(#b)"/>
  </g>
</svg>`)
}

async function markPng(height, white = false) {
  let img = sharp(mark, { density: 900 }).resize({ height })
  if (white) img = img.ensureAlpha().linear([0, 0, 0, 1], [255, 255, 255, 0])
  return img.png().toBuffer()
}

async function centered(size, markHeight, opts = {}) {
  const m = await markPng(markHeight, opts.white)
  const { width = markHeight } = await sharp(m).metadata()
  const base = opts.bg ? sharp(opts.bg) : sharp({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
  // Optical centring: the unicorn's mass sits left/low, nudge it.
  return base
    .composite([{ input: m, left: Math.round((size - width) / 2 + size * 0.015), top: Math.round((size - markHeight) / 2 - size * 0.01) }])
    .png()
    .toBuffer()
}

for (const [name, d] of Object.entries(DENSITIES)) {
  const dir = join(res, `mipmap-${name}`)
  mkdirSync(dir, { recursive: true })
  const legacy = Math.round(48 * d)
  writeFileSync(join(dir, 'ic_launcher.png'), await centered(legacy, Math.round(legacy * 0.66), { bg: background(legacy, false) }))
  writeFileSync(join(dir, 'ic_launcher_round.png'), await centered(legacy, Math.round(legacy * 0.62), { bg: background(legacy, true) }))
  const adaptive = Math.round(108 * d)
  // Adaptive icons: 108dp canvas, the inner 66dp circle is always visible.
  writeFileSync(join(dir, 'ic_launcher_foreground.png'), await centered(adaptive, Math.round(adaptive * 0.5)))
  writeFileSync(join(dir, 'ic_launcher_monochrome.png'), await centered(adaptive, Math.round(adaptive * 0.5), { white: true }))
  writeFileSync(join(dir, 'ic_launcher_background.png'), await sharp(background(adaptive, false)).png().toBuffer().then((b) => sharp(b).flatten({ background: BG }).png().toBuffer()))
}

const adaptiveXml = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@mipmap/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
    <monochrome android:drawable="@mipmap/ic_launcher_monochrome"/>
</adaptive-icon>
`
mkdirSync(join(res, 'mipmap-anydpi-v26'), { recursive: true })
writeFileSync(join(res, 'mipmap-anydpi-v26/ic_launcher.xml'), adaptiveXml)
writeFileSync(join(res, 'mipmap-anydpi-v26/ic_launcher_round.xml'), adaptiveXml)

// Android 12+ splash icon (240dp canvas, 160dp visible circle) and the legacy full-screen splash.
mkdirSync(join(res, 'drawable-nodpi'), { recursive: true })
writeFileSync(join(res, 'drawable-nodpi/splash_icon.png'), await centered(960, 400))
for (const [dir, w, h] of [
  ['drawable', 480, 800],
  ['drawable-port-xxhdpi', 1080, 1920],
  ['drawable-land-xxhdpi', 1920, 1080]
]) {
  mkdirSync(join(res, dir), { recursive: true })
  const bg = await sharp({ create: { width: w, height: h, channels: 4, background: BG } }).png().toBuffer()
  const mh = Math.round(Math.min(w, h) * 0.22)
  const m = await markPng(mh)
  const { width = mh } = await sharp(m).metadata()
  writeFileSync(join(res, dir, 'splash.png'), await sharp(bg).composite([{ input: m, left: Math.round((w - width) / 2), top: Math.round((h - mh) / 2) }]).png().toBuffer())
}
console.log('icons written to', res)
