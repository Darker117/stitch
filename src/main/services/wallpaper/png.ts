// Minimal PNG encoder (zlib from Node) — enough to cache decoded textures
// losslessly without a native image library in the packaged app.
import { crc32, deflateSync } from 'node:zlib'

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'latin1')
  out.set(data, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)) >>> 0, 8 + data.length)
  return out
}

/**
 * Encode 8-bit pixels. `channels`: 1 = grey, 3 = RGB, 4 = RGBA. Fully opaque
 * RGBA images are stored as RGB to keep the cache small.
 */
export function encodePng(width: number, height: number, channels: 1 | 3 | 4, pixels: Uint8Array, level = 3): Buffer {
  let src = pixels
  let ch: number = channels
  if (channels === 4) {
    let opaque = true
    for (let i = 3; i < pixels.length; i += 4) {
      if (pixels[i] !== 255) {
        opaque = false
        break
      }
    }
    if (opaque) {
      src = new Uint8Array(width * height * 3)
      for (let i = 0, j = 0; i < pixels.length; i += 4, j += 3) {
        src[j] = pixels[i]
        src[j + 1] = pixels[i + 1]
        src[j + 2] = pixels[i + 2]
      }
      ch = 3
    }
  }
  const stride = width * ch
  // "Sub" filter on every row: cheap and compresses photos and flat art alike.
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    const row = y * stride
    const o = y * (stride + 1)
    raw[o] = 1
    for (let x = 0; x < stride; x++) {
      const left = x >= ch ? src[row + x - ch] : 0
      raw[o + 1 + x] = (src[row + x] - left) & 255
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = ch === 1 ? 0 : ch === 3 ? 2 : 6
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level })), chunk('IEND', new Uint8Array(0))])
}
