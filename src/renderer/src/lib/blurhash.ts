// Tiny blurhash decoder (https://blurha.sh). Civitai ships a blurhash with
// every image; we paint it instead of loading images hidden as NSFW.

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~'

function decode83(s: string): number {
  let v = 0
  for (const c of s) {
    const d = DIGITS.indexOf(c)
    if (d < 0) throw new Error('bad blurhash')
    v = v * 83 + d
  }
  return v
}

const toLinear = (v: number): number => {
  const x = v / 255
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)
}
const toSrgb = (v: number): number => {
  const x = Math.max(0, Math.min(1, v))
  return x <= 0.0031308 ? Math.round(x * 12.92 * 255 + 0.5) : Math.round((1.055 * Math.pow(x, 1 / 2.4) - 0.055) * 255 + 0.5)
}
const signPow = (v: number, e: number): number => Math.sign(v) * Math.pow(Math.abs(v), e)

function decodePixels(hash: string, w: number, h: number): Uint8ClampedArray<ArrayBuffer> {
  const size = decode83(hash[0])
  const ny = Math.floor(size / 9) + 1
  const nx = (size % 9) + 1
  if (hash.length !== 4 + 2 * nx * ny) throw new Error('bad blurhash length')
  const maxAc = (decode83(hash[1]) + 1) / 166
  const colors: [number, number, number][] = []
  for (let i = 0; i < nx * ny; i++) {
    if (i === 0) {
      const v = decode83(hash.substring(2, 6))
      colors.push([toLinear(v >> 16), toLinear((v >> 8) & 255), toLinear(v & 255)])
    } else {
      const v = decode83(hash.substring(4 + i * 2, 6 + i * 2))
      const r = Math.floor(v / 361)
      const g = Math.floor(v / 19) % 19
      const b = v % 19
      colors.push([signPow((r - 9) / 9, 2) * maxAc, signPow((g - 9) / 9, 2) * maxAc, signPow((b - 9) / 9, 2) * maxAc])
    }
  }
  const px = new Uint8ClampedArray(new ArrayBuffer(w * h * 4))
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0
      let g = 0
      let b = 0
      for (let j = 0; j < ny; j++) {
        const cy = Math.cos((Math.PI * y * j) / h)
        for (let i = 0; i < nx; i++) {
          const basis = Math.cos((Math.PI * x * i) / w) * cy
          const c = colors[i + j * nx]
          r += c[0] * basis
          g += c[1] * basis
          b += c[2] * basis
        }
      }
      const o = 4 * (x + y * w)
      px[o] = toSrgb(r)
      px[o + 1] = toSrgb(g)
      px[o + 2] = toSrgb(b)
      px[o + 3] = 255
    }
  }
  return px
}

const cache = new Map<string, string>()

/** Data URL for a blurhash (32×32, scaled up by CSS), or undefined if invalid. */
export function blurhashUrl(hash: string | undefined): string | undefined {
  if (!hash || hash.length < 6) return undefined
  const hit = cache.get(hash)
  if (hit) return hit
  try {
    const size = 32
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')
    if (!ctx) return undefined
    ctx.putImageData(new ImageData(decodePixels(hash, size, size), size, size), 0, 0)
    const url = canvas.toDataURL('image/png')
    if (cache.size > 800) cache.clear()
    cache.set(hash, url)
    return url
  } catch {
    return undefined
  }
}
