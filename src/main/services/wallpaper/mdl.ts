// Puppet-warp models (.mdl, "MDLV00xx"): an image layer's mesh plus a
// skeleton and animations. We read the mesh in its rest pose so the layer's
// texture lands where the author placed it (the animation itself isn't played).
//
//   "MDLV00xx\0" u32 flags, u32, u32, material path (NUL-terminated), padding
//   u32 vertex format, u32 vertex bytes, vertices…
//     80-byte vertices: position 3f, normal 3f, tangent 4f, bone indices 4×u32, weights 4f, uv 2f
//     52-byte vertices: position 3f, bone indices 4×u32, weights 4f, uv 2f
//   u32 index bytes, u16 triangle list
//   "MDLS…" skeleton, "MDLA…" animations (not read)

export interface PuppetMesh {
  /** x, y pairs in layer units (y up, centred on the layer origin). */
  positions: number[]
  /** u, v pairs over the layer's image (v down). */
  uvs: number[]
  indices: number[]
}

export function parseMdl(b: Buffer): PuppetMesh | null {
  if (b.length < 64 || b.toString('latin1', 0, 4) !== 'MDLV') return null
  const nul = b.indexOf(0, 21)
  if (nul < 0) return null
  // The vertex block follows the material path after some padding; find it by consistency.
  for (let o = nul + 1; o < Math.min(nul + 128, b.length - 12); o++) {
    const bytes = b.readUInt32LE(o + 4)
    for (const stride of [80, 52]) {
      if (!bytes || bytes % stride) continue
      const end = o + 8 + bytes
      if (end + 4 > b.length) continue
      const indexBytes = b.readUInt32LE(end)
      if (!indexBytes || indexBytes % 6 || end + 4 + indexBytes > b.length) continue
      const count = bytes / stride
      if (count > 65535) continue
      const indices: number[] = []
      let ok = true
      for (let i = 0; i < indexBytes / 2; i++) {
        const v = b.readUInt16LE(end + 4 + i * 2)
        if (v >= count) {
          ok = false
          break
        }
        indices.push(v)
      }
      if (!ok) continue
      const uvAt = stride === 80 ? 72 : 44
      const positions: number[] = []
      const uvs: number[] = []
      for (let i = 0; i < count; i++) {
        const v = o + 8 + i * stride
        const x = b.readFloatLE(v)
        const y = b.readFloatLE(v + 4)
        const u = b.readFloatLE(v + uvAt)
        const w = b.readFloatLE(v + uvAt + 4)
        if (![x, y, u, w].every(Number.isFinite)) {
          ok = false
          break
        }
        positions.push(Math.round(x * 100) / 100, Math.round(y * 100) / 100)
        uvs.push(Math.round(u * 1e5) / 1e5, Math.round(w * 1e5) / 1e5)
      }
      if (ok) return { positions, uvs, indices }
    }
  }
  return null
}
