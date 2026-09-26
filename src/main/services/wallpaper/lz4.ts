// LZ4 block decompression (the raw block format, no frame header) — Wallpaper
// Engine compresses texture mipmaps with it.

/** Decompress one LZ4 block into a buffer of exactly `size` bytes. */
export function lz4Decompress(src: Uint8Array, size: number): Uint8Array {
  const dst = new Uint8Array(size)
  let s = 0
  let d = 0
  const end = src.length
  while (s < end) {
    const token = src[s++]
    // Literals
    let lit = token >>> 4
    if (lit === 15) {
      let b = 255
      while (b === 255 && s < end) {
        b = src[s++]
        lit += b
      }
    }
    if (lit > 0) {
      if (d + lit > size || s + lit > end) throw new Error('LZ4: literal run out of bounds')
      dst.set(src.subarray(s, s + lit), d)
      s += lit
      d += lit
    }
    // The last sequence carries literals only.
    if (s >= end) break
    const offset = src[s] | (src[s + 1] << 8)
    s += 2
    if (offset === 0 || offset > d) throw new Error('LZ4: bad match offset')
    let len = token & 15
    if (len === 15) {
      let b = 255
      while (b === 255 && s < end) {
        b = src[s++]
        len += b
      }
    }
    len += 4
    if (d + len > size) throw new Error('LZ4: match out of bounds')
    let m = d - offset
    // Overlapping copies must go byte by byte.
    if (offset >= len) {
      dst.copyWithin(d, m, m + len)
      d += len
    } else {
      for (let i = 0; i < len; i++) dst[d++] = dst[m++]
    }
  }
  if (d !== size) throw new Error(`LZ4: expected ${size} bytes, got ${d}`)
  return dst
}
