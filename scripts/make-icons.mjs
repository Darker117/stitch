// Render resources/icon.svg into the PNG/ICO files the app and installer use.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import pngToIco from 'png-to-ico'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const svg = readFileSync(join(root, 'resources', 'icon.svg'))
const out = join(root, 'resources')
mkdirSync(join(out, 'icons'), { recursive: true })

const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256, 512, 1024]
const pngs = {}
for (const size of sizes) {
  const buf = await sharp(svg).resize(size, size, { kernel: "lanczos3" }).png().toBuffer()
  pngs[size] = buf
  writeFileSync(join(out, 'icons', `${size}x${size}.png`), buf)
}
writeFileSync(join(out, 'icon.png'), pngs[1024])
writeFileSync(join(out, 'icon.ico'), await pngToIco([16, 20, 24, 32, 40, 48, 64, 128, 256].map((s) => pngs[s])))

// ── Installer art (NSIS wants 24-bit BMPs) ─────────────────────────────────
// Background matches MUI_BGCOLOR in resources/installer.nsh so the art melts
// into the dark wizard.
const BG = '#0e0c17'
const markSvg = readFileSync(join(root, 'resources', 'logo-mark.svg'))
const lockupSvg = readFileSync(join(root, 'resources', 'logo-full.svg'), 'utf8').replace(/(id="wordmark"[^>]*fill=")#[0-9a-fA-F]{6}/, '$1#f4f0f7')
const wordmarkSvg = lockupSvg.replace(/<path fill="url\(#f\)"[^>]*\/>/, '')

async function renderMark(height) {
  const img = await sharp(markSvg, { density: 600 }).resize({ height }).png().toBuffer()
  const { width = height } = await sharp(img).metadata()
  return { img, width, height }
}

/** A soft coloured bloom of `img` placed at (left, top), on a canvas-sized layer. */
async function bloom(img, left, top, W, H, blur) {
  const layer = await sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite([{ input: img, left, top }]).png().toBuffer()
  return sharp(layer).blur(blur).modulate({ brightness: 1.2 }).png().toBuffer()
}

async function sidebarArt(tagline, file) {
  const W = 164
  const H = 314
  const bg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <defs>
    <radialGradient id="a" cx="18%" cy="104%" r="78%"><stop offset="0" stop-color="#f08a6c" stop-opacity=".55"/><stop offset="1" stop-color="#f08a6c" stop-opacity="0"/></radialGradient>
    <radialGradient id="b" cx="92%" cy="88%" r="62%"><stop offset="0" stop-color="#8c84e6" stop-opacity=".42"/><stop offset="1" stop-color="#8c84e6" stop-opacity="0"/></radialGradient>
    <radialGradient id="c" cx="50%" cy="30%" r="42%"><stop offset="0" stop-color="#b58cd8" stop-opacity=".16"/><stop offset="1" stop-color="#b58cd8" stop-opacity="0"/></radialGradient>
    <linearGradient id="e" x1="0" x2="1"><stop offset="0" stop-color="${BG}" stop-opacity="0"/><stop offset="1" stop-color="${BG}"/></linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="${BG}"/>
  <rect width="${W}" height="${H}" fill="url(#c)"/>
  <rect width="${W}" height="${H}" fill="url(#a)"/>
  <rect width="${W}" height="${H}" fill="url(#b)"/>
  <g fill="#fff">
    <circle cx="24" cy="30" r=".8" opacity=".5"/><circle cx="131" cy="22" r=".6" opacity=".4"/><circle cx="146" cy="58" r=".9" opacity=".35"/>
    <circle cx="16" cy="118" r=".6" opacity=".3"/><circle cx="140" cy="140" r=".7" opacity=".3"/><circle cx="36" cy="198" r=".5" opacity=".3"/>
  </g>
  <rect x="${W - 18}" width="18" height="${H}" fill="url(#e)"/>
  <text x="${W / 2}" y="206" text-anchor="middle" font-family="Segoe UI Semibold, Segoe UI, Arial, sans-serif" font-size="7.4" letter-spacing="1.9" fill="#a69fbd">${tagline}</text>
</svg>`)
  const mark = await renderMark(96)
  const words = await sharp(Buffer.from(wordmarkSvg), { density: 600 }).trim().resize({ height: 22 }).png().toBuffer()
  const wm = await sharp(words).metadata()
  const mx = Math.round((W - mark.width) / 2)
  const my = 54
  const raw = await sharp(bg)
    .composite([
      { input: await bloom(mark.img, mx, my, W, H, 10), blend: 'screen' },
      { input: mark.img, left: mx, top: my },
      { input: words, left: Math.round((W - (wm.width ?? 80)) / 2), top: 166 }
    ])
    .flatten({ background: BG })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  writeFileSync(join(out, file), toBmp(raw.data, raw.info.width, raw.info.height))
}

async function headerArt(file) {
  const W = 150
  const H = 57
  const bg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <defs>
    <radialGradient id="a" cx="84%" cy="60%" r="62%"><stop offset="0" stop-color="#f08a6c" stop-opacity=".28"/><stop offset=".55" stop-color="#8c84e6" stop-opacity=".12"/><stop offset="1" stop-color="#8c84e6" stop-opacity="0"/></radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="${BG}"/>
  <rect width="${W}" height="${H}" fill="url(#a)"/>
</svg>`)
  const mark = await renderMark(40)
  const x = W - mark.width - 14
  const y = Math.round((H - mark.height) / 2)
  const raw = await sharp(bg)
    .composite([
      { input: await bloom(mark.img, x, y, W, H, 6), blend: 'screen' },
      { input: mark.img, left: x, top: y }
    ])
    .flatten({ background: BG })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  writeFileSync(join(out, file), toBmp(raw.data, raw.info.width, raw.info.height))
}

await sidebarArt('LOCAL AI STUDIO', 'installer-sidebar.bmp')
await sidebarArt('SEE YOU AGAIN SOON', 'uninstaller-sidebar.bmp')
await headerArt('installer-header.bmp')
console.log('icons written to', out)

/** Minimal 24-bit BMP encoder (NSIS wants BMP for installer art). */
function toBmp(rgb, width, height) {
  const rowSize = Math.ceil((width * 3) / 4) * 4
  const size = 54 + rowSize * height
  const b = Buffer.alloc(size)
  b.write('BM', 0)
  b.writeUInt32LE(size, 2)
  b.writeUInt32LE(54, 10)
  b.writeUInt32LE(40, 14)
  b.writeInt32LE(width, 18)
  b.writeInt32LE(height, 22)
  b.writeUInt16LE(1, 26)
  b.writeUInt16LE(24, 28)
  b.writeUInt32LE(rowSize * height, 34)
  for (let y = 0; y < height; y++) {
    const dst = 54 + (height - 1 - y) * rowSize
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 3
      b[dst + x * 3] = rgb[s + 2]
      b[dst + x * 3 + 1] = rgb[s + 1]
      b[dst + x * 3 + 2] = rgb[s]
    }
  }
  return b
}
