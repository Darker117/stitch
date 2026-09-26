// Small column-major 4×4 matrix helpers and keyframe sampling for the scene renderer.
import type { SceneAnimation, SceneKeyframe } from '@shared/wallpaper'

export type Mat4 = Float32Array

export function identity(): Mat4 {
  const m = new Float32Array(16)
  m[0] = m[5] = m[10] = m[15] = 1
  return m
}

export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16)
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3]
    }
  }
  return out
}

export function translation(x: number, y: number, z = 0): Mat4 {
  const m = identity()
  m[12] = x
  m[13] = y
  m[14] = z
  return m
}

export function scaling(x: number, y: number, z = 1): Mat4 {
  const m = identity()
  m[0] = x
  m[5] = y
  m[10] = z
  return m
}

export function rotationX(a: number): Mat4 {
  const m = identity()
  const c = Math.cos(a)
  const s = Math.sin(a)
  m[5] = c
  m[6] = s
  m[9] = -s
  m[10] = c
  return m
}

export function rotationY(a: number): Mat4 {
  const m = identity()
  const c = Math.cos(a)
  const s = Math.sin(a)
  m[0] = c
  m[2] = -s
  m[8] = s
  m[10] = c
  return m
}

export function rotationZ(a: number): Mat4 {
  const m = identity()
  const c = Math.cos(a)
  const s = Math.sin(a)
  m[0] = c
  m[1] = s
  m[4] = -s
  m[5] = c
  return m
}

/** Scene units (0..w, 0..h, y up) → clip space, with depth flattened (ortho scenes ignore z). */
export function ortho(w: number, h: number): Mat4 {
  const m = identity()
  m[0] = 2 / w
  m[5] = 2 / h
  m[10] = 0
  m[12] = -1
  m[13] = -1
  return m
}

export function invert(m: Mat4): Mat4 {
  const inv = new Float32Array(16)
  inv[0] = m[5] * m[10] * m[15] - m[5] * m[11] * m[14] - m[9] * m[6] * m[15] + m[9] * m[7] * m[14] + m[13] * m[6] * m[11] - m[13] * m[7] * m[10]
  inv[4] = -m[4] * m[10] * m[15] + m[4] * m[11] * m[14] + m[8] * m[6] * m[15] - m[8] * m[7] * m[14] - m[12] * m[6] * m[11] + m[12] * m[7] * m[10]
  inv[8] = m[4] * m[9] * m[15] - m[4] * m[11] * m[13] - m[8] * m[5] * m[15] + m[8] * m[7] * m[13] + m[12] * m[5] * m[11] - m[12] * m[7] * m[9]
  inv[12] = -m[4] * m[9] * m[14] + m[4] * m[10] * m[13] + m[8] * m[5] * m[14] - m[8] * m[6] * m[13] - m[12] * m[5] * m[10] + m[12] * m[6] * m[9]
  inv[1] = -m[1] * m[10] * m[15] + m[1] * m[11] * m[14] + m[9] * m[2] * m[15] - m[9] * m[3] * m[14] - m[13] * m[2] * m[11] + m[13] * m[3] * m[10]
  inv[5] = m[0] * m[10] * m[15] - m[0] * m[11] * m[14] - m[8] * m[2] * m[15] + m[8] * m[3] * m[14] + m[12] * m[2] * m[11] - m[12] * m[3] * m[10]
  inv[9] = -m[0] * m[9] * m[15] + m[0] * m[11] * m[13] + m[8] * m[1] * m[15] - m[8] * m[3] * m[13] - m[12] * m[1] * m[11] + m[12] * m[3] * m[9]
  inv[13] = m[0] * m[9] * m[14] - m[0] * m[10] * m[13] - m[8] * m[1] * m[14] + m[8] * m[2] * m[13] + m[12] * m[1] * m[10] - m[12] * m[2] * m[9]
  inv[2] = m[1] * m[6] * m[15] - m[1] * m[7] * m[14] - m[5] * m[2] * m[15] + m[5] * m[3] * m[14] + m[13] * m[2] * m[7] - m[13] * m[3] * m[6]
  inv[6] = -m[0] * m[6] * m[15] + m[0] * m[7] * m[14] + m[4] * m[2] * m[15] - m[4] * m[3] * m[14] - m[12] * m[2] * m[7] + m[12] * m[3] * m[6]
  inv[10] = m[0] * m[5] * m[15] - m[0] * m[7] * m[13] - m[4] * m[1] * m[15] + m[4] * m[3] * m[13] + m[12] * m[1] * m[7] - m[12] * m[3] * m[5]
  inv[14] = -m[0] * m[5] * m[14] + m[0] * m[6] * m[13] + m[4] * m[1] * m[14] - m[4] * m[2] * m[13] - m[12] * m[1] * m[6] + m[12] * m[2] * m[5]
  inv[3] = -m[1] * m[6] * m[11] + m[1] * m[7] * m[10] + m[5] * m[2] * m[11] - m[5] * m[3] * m[10] - m[9] * m[2] * m[7] + m[9] * m[3] * m[6]
  inv[7] = m[0] * m[6] * m[11] - m[0] * m[7] * m[10] - m[4] * m[2] * m[11] + m[4] * m[3] * m[10] + m[8] * m[2] * m[7] - m[8] * m[3] * m[6]
  inv[11] = -m[0] * m[5] * m[11] + m[0] * m[7] * m[9] + m[4] * m[1] * m[11] - m[4] * m[3] * m[9] - m[8] * m[1] * m[7] + m[8] * m[3] * m[5]
  inv[15] = m[0] * m[5] * m[10] - m[0] * m[6] * m[9] - m[4] * m[1] * m[10] + m[4] * m[2] * m[9] + m[8] * m[1] * m[6] - m[8] * m[2] * m[5]
  let det = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12]
  if (Math.abs(det) < 1e-12) return identity()
  det = 1 / det
  for (let i = 0; i < 16; i++) inv[i] *= det
  return inv
}

/** Transform a 2D point (z = 0, w = 1) and return x, y after the perspective divide. */
export function apply(m: Mat4, x: number, y: number): [number, number] {
  const w = m[3] * x + m[7] * y + m[15] || 1
  return [(m[0] * x + m[4] * y + m[12]) / w, (m[1] * x + m[5] * y + m[13]) / w]
}

// ─── Keyframes ───────────────────────────────────────────────────────────────

function bezier(a: SceneKeyframe, b: SceneKeyframe, f: number): number {
  const span = b.frame - a.frame || 1
  const p1x = a.frame + (a.front?.[0] ?? span / 3)
  const p1y = a.value + (a.front?.[1] ?? 0)
  const p2x = b.frame + (b.back?.[0] ?? -span / 3)
  const p2y = b.value + (b.back?.[1] ?? 0)
  const x = (u: number): number => {
    const v = 1 - u
    return v * v * v * a.frame + 3 * v * v * u * p1x + 3 * v * u * u * p2x + u * u * u * b.frame
  }
  let lo = 0
  let hi = 1
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2
    if (x(mid) < f) lo = mid
    else hi = mid
  }
  const u = (lo + hi) / 2
  const v = 1 - u
  return v * v * v * a.value + 3 * v * v * u * p1y + 3 * v * u * u * p2y + u * u * u * b.value
}

function channelAt(keys: SceneKeyframe[], f: number): number {
  if (!keys.length) return 0
  if (f <= keys[0].frame) return keys[0].value
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i]
    const b = keys[i + 1]
    if (f > b.frame) continue
    if (a.front || b.back) return bezier(a, b, f)
    const t = (f - a.frame) / (b.frame - a.frame || 1)
    return a.value + (b.value - a.value) * t
  }
  return keys[keys.length - 1].value
}

/** Sample every channel of an animation at `seconds`. */
export function sampleAnimation(a: SceneAnimation, seconds: number): number[] {
  const len = Math.max(a.length, 1e-6)
  let f = seconds * a.fps
  if (a.mode === 'loop') f = ((f % len) + len) % len
  else if (a.mode === 'mirror') {
    const p = ((f % (2 * len)) + 2 * len) % (2 * len)
    f = p > len ? 2 * len - p : p
  } else f = Math.min(f, len)
  return a.channels.map((c) => channelAt(c, f))
}
