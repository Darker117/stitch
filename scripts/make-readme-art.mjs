// README/GitHub art: logo lockups for light and dark GitHub themes and the
// 1280×640 social preview card. Run: node scripts/make-readme-art.mjs
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'docs')
mkdirSync(out, { recursive: true })

const full = readFileSync(join(root, 'resources', 'logo-full.svg'), 'utf8')
const withInk = (ink) => full.replace(/(id="wordmark"[^>]*fill=")#[0-9a-fA-F]{6}/, `$1${ink}`)

// Lockups: plum wordmark for GitHub's light theme, near-white for dark.
await sharp(Buffer.from(withInk('#3e2942')), { density: 300 }).resize({ width: 880 }).png().toFile(join(out, 'logo-light.png'))
await sharp(Buffer.from(withInk('#f4f0f7')), { density: 300 }).resize({ width: 880 }).png().toFile(join(out, 'logo-dark.png'))

// Social preview card.
const W = 1280
const H = 640
const bg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <defs>
    <radialGradient id="a" cx="12%" cy="110%" r="70%"><stop offset="0" stop-color="#f08a6c" stop-opacity=".55"/><stop offset="1" stop-color="#f08a6c" stop-opacity="0"/></radialGradient>
    <radialGradient id="b" cx="95%" cy="-10%" r="70%"><stop offset="0" stop-color="#8c84e6" stop-opacity=".45"/><stop offset="1" stop-color="#8c84e6" stop-opacity="0"/></radialGradient>
    <radialGradient id="c" cx="50%" cy="45%" r="45%"><stop offset="0" stop-color="#b58cd8" stop-opacity=".14"/><stop offset="1" stop-color="#b58cd8" stop-opacity="0"/></radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="#0e0c17"/>
  <rect width="${W}" height="${H}" fill="url(#c)"/>
  <rect width="${W}" height="${H}" fill="url(#a)"/>
  <rect width="${W}" height="${H}" fill="url(#b)"/>
  <text x="${W / 2}" y="500" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="30" fill="#c9c2dc">Your own AI studio and storyteller, running on your PC.</text>
</svg>`)
const lockup = await sharp(Buffer.from(withInk('#f4f0f7')), { density: 400 }).resize({ height: 250 }).png().toBuffer()
const lm = await sharp(lockup).metadata()
await sharp(bg)
  .composite([{ input: lockup, left: Math.round((W - (lm.width ?? 600)) / 2), top: 170 }])
  .png()
  .toFile(join(out, 'social-preview.png'))

console.log('README art written to', out)
