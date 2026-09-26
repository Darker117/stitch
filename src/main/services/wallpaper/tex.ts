// Wallpaper Engine textures (.tex): three nested containers.
//
//   "TEXV0005\0" "TEXI0001\0"
//     i32 format   (0 RGBA8888, 4 DXT5, 6 DXT3, 7 DXT1, 8 RG88, 9 R8)
//     u32 flags    (1 no interpolation, 2 clamp UVs, 4 animated sprite sheet, 32 video)
//     i32 textureWidth, textureHeight   (padded, usually a power of two)
//     i32 imageWidth, imageHeight       (the real picture inside it)
//     u32 (unused here)
//   "TEXB000n\0"
//     i32 imageCount
//     n ≥ 3: i32 imageFormat   (FreeImage format id of an embedded PNG/JPG…, -1 = raw pixels)
//     n ≥ 4: i32 isVideo       (the payload is an MP4)
//     imageCount × { i32 mipCount, mipCount × { i32 w, i32 h, [n ≥ 2: i32 lz4, i32 rawSize], i32 size, bytes } }
//   flags & 4: "TEXS000n\0" i32 frameCount, [n ≥ 3: i32 w, i32 h], frames × { i32 image, f32 seconds, f32 x, y, xAxisX, xAxisY, yAxisX, yAxisY }
import { lz4Decompress } from './lz4'

export const TEX_RGBA8888 = 0
export const TEX_DXT5 = 4
export const TEX_DXT3 = 6
export const TEX_DXT1 = 7
export const TEX_RG88 = 8
export const TEX_R8 = 9

export const TEXF_NEAREST = 1
export const TEXF_CLAMP = 2
export const TEXF_SPRITESHEET = 4
export const TEXF_VIDEO = 32

interface Mip {
  width: number
  height: number
  lz4: boolean
  rawSize: number
  data: Buffer
}

export interface TexFrame {
  image: number
  seconds: number
  x: number
  y: number
  width: number
  height: number
}

export interface TexInfo {
  format: number
  flags: number
  textureWidth: number
  textureHeight: number
  width: number
  height: number
  imageFormat: number
  isVideo: boolean
  images: Mip[][]
  frames?: TexFrame[]
}

/** A decoded image: raw pixels (1–4 channels) or an embedded file to write as-is. */
export type TexImage =
  | { kind: 'pixels'; width: number; height: number; channels: 1 | 3 | 4; data: Uint8Array }
  | { kind: 'file'; width: number; height: number; ext: string; data: Uint8Array }

/** FreeImage format ids → file extensions a browser can decode. */
const FIF_EXT: Record<number, string> = { 0: 'bmp', 1: 'ico', 2: 'jpg', 13: 'png', 25: 'gif', 35: 'webp' }

class Reader {
  pos = 0
  constructor(readonly buf: Buffer) {}
  i32(): number {
    if (this.pos + 4 > this.buf.length) throw new Error('Truncated texture')
    const v = this.buf.readInt32LE(this.pos)
    this.pos += 4
    return v
  }
  f32(): number {
    if (this.pos + 4 > this.buf.length) throw new Error('Truncated texture')
    const v = this.buf.readFloatLE(this.pos)
    this.pos += 4
    return v
  }
  magic(): string {
    // 8 ASCII chars + NUL
    if (this.pos + 9 > this.buf.length) throw new Error('Truncated texture')
    const s = this.buf.toString('latin1', this.pos, this.pos + 8)
    this.pos += 9
    return s
  }
  bytes(n: number): Buffer {
    if (n < 0 || this.pos + n > this.buf.length) throw new Error('Truncated texture')
    const b = this.buf.subarray(this.pos, this.pos + n)
    this.pos += n
    return b
  }
}

export function parseTex(buf: Buffer): TexInfo {
  const r = new Reader(buf)
  if (!r.magic().startsWith('TEXV')) throw new Error('Not a Wallpaper Engine texture')
  if (!r.magic().startsWith('TEXI')) throw new Error('Unsupported texture header')
  const format = r.i32()
  const flags = r.i32() >>> 0
  const textureWidth = r.i32()
  const textureHeight = r.i32()
  const width = r.i32()
  const height = r.i32()
  r.i32()
  const container = r.magic()
  if (!container.startsWith('TEXB')) throw new Error('Unsupported texture container')
  const version = Number(container.slice(4)) || 1
  const imageCount = r.i32()
  let imageFormat = -1
  let isVideo = false
  if (version >= 3) imageFormat = r.i32()
  if (version >= 4) isVideo = r.i32() === 1
  if (imageCount < 0 || imageCount > 4096) throw new Error('Corrupt texture')
  const images: Mip[][] = []
  for (let i = 0; i < imageCount; i++) {
    const mipCount = r.i32()
    if (mipCount < 0 || mipCount > 32) throw new Error('Corrupt texture')
    const mips: Mip[] = []
    for (let m = 0; m < mipCount; m++) {
      const w = r.i32()
      const h = r.i32()
      let lz4 = false
      let rawSize = 0
      if (version >= 2) {
        lz4 = r.i32() === 1
        rawSize = r.i32()
      }
      const size = r.i32()
      mips.push({ width: w, height: h, lz4, rawSize, data: r.bytes(size) })
    }
    images.push(mips)
  }
  const info: TexInfo = { format, flags, textureWidth, textureHeight, width, height, imageFormat, isVideo, images }
  if (flags & TEXF_SPRITESHEET && r.pos + 9 <= buf.length) {
    try {
      const sheet = r.magic()
      if (sheet.startsWith('TEXS')) {
        const sv = Number(sheet.slice(4)) || 1
        const count = r.i32()
        if (sv >= 3) {
          r.i32()
          r.i32()
        }
        const frames: TexFrame[] = []
        for (let i = 0; i < count && i < 100_000; i++) {
          const image = r.i32()
          const seconds = r.f32()
          const read = sv >= 2 ? (): number => r.f32() : (): number => r.i32()
          const x = read()
          const y = read()
          const xAxisX = read()
          const xAxisY = read()
          const yAxisX = read()
          const yAxisY = read()
          frames.push({ image, seconds, x, y, width: Math.hypot(xAxisX, xAxisY), height: Math.hypot(yAxisX, yAxisY) })
        }
        if (frames.length) info.frames = frames
      }
    } catch {
      /* no usable frame table — treat as a still */
    }
  }
  return info
}

function mipBytes(mip: Mip): Uint8Array {
  return mip.lz4 ? lz4Decompress(mip.data, mip.rawSize) : mip.data
}

// ─── Block compression ───────────────────────────────────────────────────────

function color565(c: number, out: Uint8Array, o: number): void {
  const r = (c >> 11) & 31
  const g = (c >> 5) & 63
  const b = c & 31
  out[o] = (r << 3) | (r >> 2)
  out[o + 1] = (g << 2) | (g >> 4)
  out[o + 2] = (b << 3) | (b >> 2)
  out[o + 3] = 255
}

const pal = new Uint8Array(16)

/** Decode the colour half of a DXT block straight into the output pixels. */
function decodeColorBlock(src: Uint8Array, o: number, out: Uint8Array, x0: number, y0: number, w: number, h: number, allowAlpha: boolean): void {
  const c0 = src[o] | (src[o + 1] << 8)
  const c1 = src[o + 2] | (src[o + 3] << 8)
  color565(c0, pal, 0)
  color565(c1, pal, 4)
  if (c0 > c1 || !allowAlpha) {
    for (let k = 0; k < 3; k++) {
      pal[8 + k] = (2 * pal[k] + pal[4 + k] + 1) / 3
      pal[12 + k] = (pal[k] + 2 * pal[4 + k] + 1) / 3
    }
    pal[11] = 255
    pal[15] = 255
  } else {
    for (let k = 0; k < 3; k++) pal[8 + k] = (pal[k] + pal[4 + k]) >> 1
    pal[11] = 255
    pal[12] = pal[13] = pal[14] = pal[15] = 0
  }
  const bits = (src[o + 4] | (src[o + 5] << 8) | (src[o + 6] << 16) | (src[o + 7] << 24)) >>> 0
  for (let py = 0; py < 4; py++) {
    const y = y0 + py
    if (y >= h) break
    for (let px = 0; px < 4; px++) {
      const x = x0 + px
      if (x >= w) continue
      const idx = (bits >>> (2 * (py * 4 + px))) & 3
      const d = (y * w + x) * 4
      out[d] = pal[idx * 4]
      out[d + 1] = pal[idx * 4 + 1]
      out[d + 2] = pal[idx * 4 + 2]
      out[d + 3] = pal[idx * 4 + 3]
    }
  }
}

function decodeDxt(src: Uint8Array, w: number, h: number, format: number): Uint8Array {
  const out = new Uint8Array(w * h * 4)
  const bw = Math.max(1, Math.ceil(w / 4))
  const bh = Math.max(1, Math.ceil(h / 4))
  const blockSize = format === TEX_DXT1 ? 8 : 16
  if (src.length < bw * bh * blockSize) throw new Error('Texture data too short')
  const alpha = new Uint8Array(8)
  let o = 0
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++, o += blockSize) {
      const x0 = bx * 4
      const y0 = by * 4
      if (format === TEX_DXT1) {
        decodeColorBlock(src, o, out, x0, y0, w, h, true)
        continue
      }
      decodeColorBlock(src, o + 8, out, x0, y0, w, h, false)
      if (format === TEX_DXT3) {
        for (let py = 0; py < 4; py++) {
          const y = y0 + py
          if (y >= h) break
          const row = src[o + py * 2] | (src[o + py * 2 + 1] << 8)
          for (let px = 0; px < 4; px++) {
            const x = x0 + px
            if (x >= w) continue
            const a = (row >> (px * 4)) & 15
            out[(y * w + x) * 4 + 3] = a * 17
          }
        }
      } else {
        const a0 = src[o]
        const a1 = src[o + 1]
        alpha[0] = a0
        alpha[1] = a1
        if (a0 > a1) {
          for (let k = 1; k < 7; k++) alpha[k + 1] = ((7 - k) * a0 + k * a1 + 3) / 7
        } else {
          for (let k = 1; k < 5; k++) alpha[k + 1] = ((5 - k) * a0 + k * a1 + 2) / 5
          alpha[6] = 0
          alpha[7] = 255
        }
        // 48 bits of 3-bit indices, little endian.
        const lo = (src[o + 2] | (src[o + 3] << 8) | (src[o + 4] << 16)) >>> 0
        const hi = (src[o + 5] | (src[o + 6] << 8) | (src[o + 7] << 16)) >>> 0
        for (let p = 0; p < 16; p++) {
          const y = y0 + (p >> 2)
          const x = x0 + (p & 3)
          const idx = p < 8 ? (lo >>> (3 * p)) & 7 : (hi >>> (3 * (p - 8))) & 7
          if (x < w && y < h) out[(y * w + x) * 4 + 3] = alpha[idx]
        }
      }
    }
  }
  return out
}

// ─── Decoding ────────────────────────────────────────────────────────────────

/** Copy the top-left `cw × ch` pixels out of a `w`-wide buffer. */
function crop(data: Uint8Array, w: number, h: number, channels: number, cw: number, ch: number): Uint8Array {
  if (cw >= w && ch >= h) return data
  const out = new Uint8Array(cw * ch * channels)
  for (let y = 0; y < ch; y++) out.set(data.subarray(y * w * channels, (y * w + cw) * channels), y * cw * channels)
  return out
}

/**
 * Decode one image (sprite sheets can have several) at full resolution.
 * Padding beyond the real picture is cropped away unless the texture is a sprite sheet
 * (its frame rectangles are in padded-texture pixels).
 */
export function decodeTex(info: TexInfo, image = 0): TexImage {
  const mip = info.images[image]?.[0]
  if (!mip) throw new Error('Texture has no image data')
  const bytes = mipBytes(mip)
  const isMp4 = bytes.length > 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70
  if (info.isVideo || ((info.flags & TEXF_VIDEO) !== 0 && isMp4)) return { kind: 'file', width: info.width, height: info.height, ext: 'mp4', data: bytes }
  if (info.imageFormat >= 0) {
    const ext = FIF_EXT[info.imageFormat] ?? sniffExt(bytes)
    if (!ext) throw new Error(`Unsupported embedded image format ${info.imageFormat}`)
    return { kind: 'file', width: mip.width || info.width, height: mip.height || info.height, ext, data: bytes }
  }
  const w = mip.width
  const h = mip.height
  const keepAll = !!info.frames
  const cw = keepAll ? w : Math.max(1, Math.min(w, info.width || w))
  const ch = keepAll ? h : Math.max(1, Math.min(h, info.height || h))
  switch (info.format) {
    case TEX_RGBA8888: {
      if (bytes.length < w * h * 4) throw new Error('Texture data too short')
      return { kind: 'pixels', width: cw, height: ch, channels: 4, data: crop(bytes, w, h, 4, cw, ch) }
    }
    case TEX_DXT1:
    case TEX_DXT3:
    case TEX_DXT5: {
      const rgba = decodeDxt(bytes, w, h, info.format)
      return { kind: 'pixels', width: cw, height: ch, channels: 4, data: crop(rgba, w, h, 4, cw, ch) }
    }
    case TEX_R8: {
      if (bytes.length < w * h) throw new Error('Texture data too short')
      return { kind: 'pixels', width: cw, height: ch, channels: 1, data: crop(bytes, w, h, 1, cw, ch) }
    }
    case TEX_RG88: {
      if (bytes.length < w * h * 2) throw new Error('Texture data too short')
      // Flow maps and similar keep their two channels as red/green.
      const src = crop(bytes, w, h, 2, cw, ch)
      const out = new Uint8Array(cw * ch * 3)
      for (let i = 0, j = 0; i < src.length; i += 2, j += 3) {
        out[j] = src[i]
        out[j + 1] = src[i + 1]
      }
      return { kind: 'pixels', width: cw, height: ch, channels: 3, data: out }
    }
    default:
      throw new Error(`Unsupported texture format ${info.format}`)
  }
}

function sniffExt(b: Uint8Array): string | undefined {
  if (b[0] === 0x89 && b[1] === 0x50) return 'png'
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpg'
  if (b[0] === 0x47 && b[1] === 0x49) return 'gif'
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57) return 'webp'
  if (b[0] === 0x42 && b[1] === 0x4d) return 'bmp'
  return undefined
}
