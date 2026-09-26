// Wallpaper Engine particle systems, simulated on the CPU and drawn as
// instanced sprites. Covers the common building blocks (sphere/box emitters;
// lifetime, size, colour, alpha, velocity, rotation and turbulence
// initialisers; movement, fades, size/colour/alpha changes, oscillation and
// turbulence operators). Trails and ropes are drawn as plain sprites.
import type { SceneParticles, SceneTexture } from '@shared/wallpaper'
import type { Mat4 } from './math'

type Json = Record<string, unknown>

function n(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim()) {
    const first = Number(v.trim().split(/\s+/)[0])
    if (Number.isFinite(first)) return first
  }
  return fallback
}

function v3(v: unknown, fallback: [number, number, number]): [number, number, number] {
  if (typeof v === 'number') return [v, v, v]
  if (typeof v === 'string') {
    const p = v.trim().split(/\s+/).map(Number)
    if (p.every((x) => Number.isFinite(x))) return [p[0] ?? fallback[0], p[1] ?? (p.length === 1 ? p[0] : fallback[1]), p[2] ?? (p.length === 1 ? p[0] : fallback[2])]
  }
  if (Array.isArray(v)) return [n(v[0], fallback[0]), n(v[1], fallback[1]), n(v[2], fallback[2])]
  return fallback
}

const rand = (a: number, b: number): number => a + Math.random() * (b - a)

interface Particle {
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  rot: number
  av: number
  size: number
  life: number
  age: number
  r: number
  g: number
  b: number
  a: number
  frame: number
  phase: number
  freq: number
}

// Instance layout: x, y, size, rotation, r, g, b, a, u0, v0, u1, v1
const STRIDE = 12

const VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_Corner;
layout(location = 2) in vec4 i_PosSizeRot;
layout(location = 3) in vec4 i_Color;
layout(location = 4) in vec4 i_Uv;
uniform mat4 u_Mvp;
uniform vec2 u_Axis;
out vec2 v_Uv;
out vec4 v_Color;
out vec3 v_Screen;
out vec4 v_Tangents;
void main() {
  float c = cos(i_PosSizeRot.w);
  float s = sin(i_PosSizeRot.w);
  vec2 right = vec2(c, s) * i_PosSizeRot.z * u_Axis;
  vec2 up = vec2(-s, c) * i_PosSizeRot.z * u_Axis;
  // Keep sprites round even when the layer is scaled unevenly.
  vec2 p = i_PosSizeRot.xy + right * a_Corner.x + up * a_Corner.y;
  gl_Position = u_Mvp * vec4(p, 0.0, 1.0);
  v_Uv = mix(i_Uv.xy, i_Uv.zw, a_Corner * vec2(1.0, -1.0) + 0.5);
  v_Color = i_Color;
  // Screen position and the sprite's axes in screen UV, for refraction.
  v_Screen = gl_Position.xyw;
  vec4 center = u_Mvp * vec4(i_PosSizeRot.xy, 0.0, 1.0);
  vec4 r = u_Mvp * vec4(i_PosSizeRot.xy + right * 0.5, 0.0, 1.0);
  vec4 u = u_Mvp * vec4(i_PosSizeRot.xy + up * 0.5, 0.0, 1.0);
  v_Tangents = vec4((r.xy / r.w - center.xy / center.w) * 0.5, (u.xy / u.w - center.xy / center.w) * 0.5);
}`

const FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_Tex;
uniform sampler2D u_Normal;
uniform sampler2D u_Scene;
uniform float u_Format;
uniform float u_NormalFormat;
uniform float u_Refract;
uniform float u_Overbright;
in vec2 v_Uv;
in vec4 v_Color;
in vec3 v_Screen;
in vec4 v_Tangents;
out vec4 o_Color;
void main() {
  vec4 t = texture(u_Tex, v_Uv);
  // RG88 = luminance + alpha, R8 = alpha only.
  if (u_Format > 7.5 && u_Format < 8.5) t = t.rrrg;
  else if (u_Format > 8.5 && u_Format < 9.5) t = vec4(1.0, 1.0, 1.0, t.r);
  vec4 color = t * v_Color;
  if (u_Refract > 0.5) {
    vec4 n = texture(u_Normal, v_Uv);
    vec2 d;
    float mask;
    if (u_NormalFormat > 7.5 && u_NormalFormat < 8.5) { d = n.gr * 2.0 - 1.0; mask = 1.0; }
    else if (u_NormalFormat > 3.5 && u_NormalFormat < 7.5) { d = vec2(n.a, n.g) * 2.0 - vec2(0.965, 1.0); mask = n.r; }
    else { d = vec2(n.a, n.g) * 2.0 - 1.0; mask = n.r; }
    vec2 offset = (v_Tangents.xy * d.x + v_Tangents.zw * d.y) * mask * v_Color.a;
    offset.y = -offset.y;
    vec2 uv = v_Screen.xy / v_Screen.z * 0.5 + 0.5 + offset;
    color.rgb *= texture(u_Scene, uv).rgb;
  }
  color.rgb *= u_Overbright;
  o_Color = color;
}`

export interface ParticleGl {
  gl: WebGL2RenderingContext
  quad: WebGLBuffer
  texture: (key: string | undefined, image: number) => WebGLTexture | null
  setBlend: (mode: string) => void
  /** The scene as drawn so far (refracting particles look through it). */
  scene: () => WebGLTexture
  /** Pixel format of a texture key. */
  format: (key: string | undefined) => number
}

type Loc = WebGLUniformLocation | null
let shared: { program: WebGLProgram; u: Record<'mvp' | 'axis' | 'tex' | 'normal' | 'scene' | 'format' | 'normalFormat' | 'refract' | 'overbright', Loc> } | null = null
let sharedGl: WebGL2RenderingContext | null = null

function programFor(gl: WebGL2RenderingContext): typeof shared {
  if (shared && sharedGl === gl) return shared
  const make = (type: number, src: string): WebGLShader => {
    const s = gl.createShader(type)!
    gl.shaderSource(s, src)
    gl.compileShader(s)
    return s
  }
  const p = gl.createProgram()!
  gl.attachShader(p, make(gl.VERTEX_SHADER, VERT))
  gl.attachShader(p, make(gl.FRAGMENT_SHADER, FRAG))
  gl.linkProgram(p)
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) return null
  const at = (n: string): Loc => gl.getUniformLocation(p, n)
  shared = {
    program: p,
    u: {
      mvp: at('u_Mvp'),
      axis: at('u_Axis'),
      tex: at('u_Tex'),
      normal: at('u_Normal'),
      scene: at('u_Scene'),
      format: at('u_Format'),
      normalFormat: at('u_NormalFormat'),
      refract: at('u_Refract'),
      overbright: at('u_Overbright')
    }
  }
  sharedGl = gl
  return shared
}


export class ParticleSystem {
  private readonly particles: Particle[] = []
  private readonly children: { system: ParticleSystem; offset: [number, number, number] }[]
  private readonly frames: { u0: number; v0: number; u1: number; v1: number }[]
  private readonly max: number
  private readonly format: number
  private readonly o: Record<string, number | number[]>
  private spawnDebt = 0
  private elapsed = 0
  private burstDone = false
  private instances: Float32Array
  private vao: WebGLVertexArrayObject | null = null
  private buffer: WebGLBuffer | null = null

  constructor(
    private readonly def: SceneParticles,
    textures: (key: string | undefined) => SceneTexture | undefined
  ) {
    const tex = textures(def.texture)
    this.format = tex?.format ?? 0
    this.o = def.override
    const count = n(this.o.count, 1)
    this.max = Math.max(1, Math.min(6000, Math.round(def.maxCount * count)))
    this.instances = new Float32Array(this.max * STRIDE)
    this.frames = (tex?.frames ?? [])
      .filter((f) => f.image === 0)
      .map((f) => ({ u0: f.x / tex!.width, v0: f.y / tex!.height, u1: (f.x + f.width) / tex!.width, v1: (f.y + f.height) / tex!.height }))
    this.children = def.children.map((c) => ({ system: new ParticleSystem(c.system, textures), offset: c.origin ?? [0, 0, 0] }))
    // Pre-roll so the scene starts "full".
    const warm = Math.min(Math.max(def.startTime, 0), 12)
    for (let t = 0; t < warm; t += 1 / 20) this.update(1 / 20)
  }

  private override(name: string, fallback = 1): number {
    return n(this.o[name], fallback)
  }

  private spawn(): void {
    if (this.particles.length >= this.max) return
    const d = this.def
    const p: Particle = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, rot: 0, av: 0, size: 20, life: 1, age: 0, r: 1, g: 1, b: 1, a: 1, frame: 0, phase: Math.random() * Math.PI * 2, freq: 0 }
    const e = (d.emitters[Math.floor(Math.random() * d.emitters.length)] ?? {}) as Json
    const origin = v3(e.origin, [0, 0, 0])
    const name = String(e.name ?? 'sphererandom')
    if (name.startsWith('box')) {
      const max = v3(e.distancemax, [0, 0, 0])
      const min = v3(e.distancemin, [0, 0, 0])
      const pick = (lo: number, hi: number): number => {
        const v = rand(lo, hi)
        return Math.random() < 0.5 ? -v : v
      }
      p.x = pick(min[0], max[0])
      p.y = pick(min[1], max[1])
      p.z = pick(min[2], max[2])
    } else {
      const dir = v3(e.directions, [1, 1, 0])
      const rmin = n(e.distancemin, 0)
      const rmax = n(e.distancemax, 0)
      const a = Math.random() * Math.PI * 2
      // Uniform over the disc (a uniform radius would crowd the centre).
      const r = Math.sqrt(rand((rmin * rmin) / Math.max(rmax * rmax, 1e-6), 1)) * rmax
      p.x = Math.cos(a) * r * dir[0]
      p.y = Math.sin(a) * r * dir[1]
    }
    p.x += origin[0]
    p.y += origin[1]
    p.z += origin[2]
    const speed = this.override('speed')
    for (const init of d.initializers) {
      const i = init as Json
      switch (String(i.name)) {
        case 'lifetimerandom':
          p.life = rand(n(i.min, 1), n(i.max, n(i.min, 1)))
          break
        case 'sizerandom': {
          const exp = n(i.exponent, 1)
          const t = Math.pow(Math.random(), exp)
          p.size = n(i.min, 20) + (n(i.max, n(i.min, 20)) - n(i.min, 20)) * t
          break
        }
        case 'velocityrandom': {
          const lo = v3(i.min, [0, 0, 0])
          const hi = v3(i.max, lo)
          p.vx += rand(lo[0], hi[0]) * speed
          p.vy += rand(lo[1], hi[1]) * speed
          p.vz += rand(lo[2], hi[2]) * speed
          break
        }
        case 'turbulentvelocityrandom': {
          const s = rand(n(i.speedmin, 0), n(i.speedmax, 100)) * speed
          const a = Math.random() * Math.PI * 2
          p.vx += Math.cos(a) * s
          p.vy += Math.sin(a) * s
          break
        }
        case 'colorrandom': {
          const lo = v3(i.min, [255, 255, 255])
          const hi = v3(i.max, lo)
          const t = Math.random()
          p.r = (lo[0] + (hi[0] - lo[0]) * t) / 255
          p.g = (lo[1] + (hi[1] - lo[1]) * t) / 255
          p.b = (lo[2] + (hi[2] - lo[2]) * t) / 255
          break
        }
        case 'alpharandom':
          p.a = rand(n(i.min, 1), n(i.max, 1))
          break
        case 'rotationrandom': {
          const hi = v3(i.max, [0, 0, Math.PI * 2])
          const lo = v3(i.min, [0, 0, 0])
          p.rot = rand(lo[2], hi[2])
          break
        }
        case 'angularvelocityrandom': {
          const hi = v3(i.max, [0, 0, 0])
          const lo = v3(i.min, [0, 0, 0])
          p.av = rand(lo[2], hi[2])
          break
        }
      }
    }
    p.life *= this.override('lifetime')
    p.size *= this.override('size')
    p.a *= this.override('alpha')
    const tint = this.o.colorn ?? this.o.color
    if (Array.isArray(tint)) {
      const k = Math.max(...tint) > 1 ? 255 : 1
      p.r *= tint[0] / k
      p.g *= (tint[1] ?? tint[0]) / k
      p.b *= (tint[2] ?? tint[0]) / k
    }
    if (this.frames.length) p.frame = d.animationMode === 'randomframe' ? Math.floor(Math.random() * this.frames.length) : 0
    p.freq = Math.random()
    this.particles.push(p)
  }

  update(dt: number): void {
    this.elapsed += dt
    const d = this.def
    let rate = 0
    for (const e of d.emitters) rate += n((e as Json).rate, 5)
    rate *= this.override('rate') * this.override('count')
    const burst = d.emitters.reduce((s, e) => s + n((e as Json).instantaneous, 0), 0)
    if (burst > 0 && !this.burstDone) {
      this.burstDone = true
      for (let i = 0; i < burst; i++) this.spawn()
    }
    const duration = Math.max(0, ...d.emitters.map((e) => n((e as Json).duration, 0)))
    if (!duration || this.elapsed < duration) {
      this.spawnDebt += rate * dt
      while (this.spawnDebt >= 1) {
        this.spawnDebt -= 1
        this.spawn()
      }
    }
    const ops = d.operators as Json[]
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i]
      p.age += dt
      if (p.age >= p.life) {
        this.particles[i] = this.particles[this.particles.length - 1]
        this.particles.pop()
        continue
      }
      for (const op of ops) {
        const name = String(op.name)
        if (name === 'movement') {
          const g = v3(op.gravity, [0, 0, 0])
          const drag = n(op.drag, 0)
          p.vx += g[0] * dt
          p.vy += g[1] * dt
          p.vz += g[2] * dt
          if (drag) {
            const k = Math.max(0, 1 - drag * dt)
            p.vx *= k
            p.vy *= k
            p.vz *= k
          }
        } else if (name === 'angularmovement') {
          const f = v3(op.force, [0, 0, 0])
          p.av += f[2] * dt
          const drag = n(op.drag, 0)
          if (drag) p.av *= Math.max(0, 1 - drag * dt)
        } else if (name === 'turbulence') {
          const s = n(op.speedmax, n(op.speedmin, 50)) * dt
          const sc = n(op.scale, 0.01)
          const ts = n(op.timescale, 1)
          p.vx += Math.sin(p.y * sc * 0.02 + this.elapsed * ts + p.phase) * s
          p.vy += Math.cos(p.x * sc * 0.02 + this.elapsed * ts * 0.8 + p.phase) * s
        } else if (name === 'vortex') {
          const s = n(op.speedinner, n(op.speed, 50)) * dt * 0.01
          const x = p.x
          p.x += -p.y * s
          p.y += x * s
        }
      }
      p.x += p.vx * dt
      p.y += p.vy * dt
      p.z += p.vz * dt
      p.rot += p.av * dt
    }
    for (const c of this.children) c.system.update(dt)
  }

  /** Life-dependent multipliers (fades, size/colour changes, oscillation). */
  private shade(p: Particle): { size: number; r: number; g: number; b: number; a: number; dx: number; dy: number } {
    const t = Math.min(1, p.age / Math.max(p.life, 1e-4))
    let size = 1
    let a = 1
    let r = 1
    let g = 1
    let b = 1
    let dx = 0
    let dy = 0
    const ramp = (op: Json, sv: number, ev: number): number => {
      const st = n(op.starttime, 0)
      const et = n(op.endtime, 1)
      if (t <= st) return sv
      if (t >= et) return ev
      return sv + (ev - sv) * ((t - st) / Math.max(et - st, 1e-4))
    }
    for (const op of this.def.operators as Json[]) {
      switch (String(op.name)) {
        case 'alphafade': {
          const fin = n(op.fadeintime, 0.1)
          const fout = n(op.fadeouttime, 0.5)
          if (fin > 0 && t < fin) a *= t / fin
          if (t > fout && fout < 1) a *= 1 - (t - fout) / (1 - fout)
          break
        }
        case 'sizechange':
          size *= ramp(op, n(op.startvalue, 1), n(op.endvalue, 0))
          break
        case 'alphachange':
          a *= ramp(op, n(op.startvalue, 1), n(op.endvalue, 0))
          break
        case 'colorchange': {
          const s = v3(op.startvalue, [1, 1, 1])
          const e = v3(op.endvalue, [1, 1, 1])
          r *= ramp(op, s[0], e[0])
          g *= ramp(op, s[1], e[1])
          b *= ramp(op, s[2], e[2])
          break
        }
        case 'oscillatealpha': {
          const f = n(op.frequencymin, 1) + (n(op.frequencymax, 2) - n(op.frequencymin, 1)) * p.freq
          const lo = n(op.scalemin, 0)
          const hi = n(op.scalemax, 1)
          a *= lo + (hi - lo) * (0.5 + 0.5 * Math.sin(p.age * f * Math.PI * 2 + p.phase))
          break
        }
        case 'oscillatesize': {
          const f = n(op.frequencymin, 1) + (n(op.frequencymax, 2) - n(op.frequencymin, 1)) * p.freq
          const lo = n(op.scalemin, 0.8)
          const hi = n(op.scalemax, 1.2)
          size *= lo + (hi - lo) * (0.5 + 0.5 * Math.sin(p.age * f * Math.PI * 2 + p.phase))
          break
        }
        case 'oscillateposition': {
          const f = n(op.frequencymin, 0.5) + (n(op.frequencymax, 1) - n(op.frequencymin, 0.5)) * p.freq
          const s = n(op.scalemax, n(op.scale, 10))
          const mask = v3(op.mask, [1, 1, 0])
          dx += Math.sin(p.age * f * Math.PI * 2 + p.phase) * s * mask[0]
          dy += Math.cos(p.age * f * Math.PI * 2 + p.phase * 1.3) * s * mask[1]
          break
        }
      }
    }
    return { size, r, g, b, a: Math.max(0, Math.min(1, a)), dx, dy }
  }

  draw(ctx: ParticleGl, mvp: Mat4, axis: [number, number], alpha: number, color: [number, number, number]): void {
    for (const c of this.children) c.system.draw(ctx, mvp, axis, alpha, color)
    if (!this.particles.length) return
    const { gl } = ctx
    const prog = programFor(gl)
    const texture = ctx.texture(this.def.texture, 0)
    if (!prog || !texture) return
    if (!this.vao) {
      this.vao = gl.createVertexArray()
      this.buffer = gl.createBuffer()
      gl.bindVertexArray(this.vao)
      gl.bindBuffer(gl.ARRAY_BUFFER, ctx.quad)
      gl.enableVertexAttribArray(0)
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0)
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer)
      gl.bufferData(gl.ARRAY_BUFFER, this.instances.byteLength, gl.DYNAMIC_DRAW)
      for (const [loc, off] of [
        [2, 0],
        [3, 16],
        [4, 32]
      ]) {
        gl.enableVertexAttribArray(loc)
        gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, STRIDE * 4, off)
        gl.vertexAttribDivisor(loc, 1)
      }
      gl.bindVertexArray(null)
    }
    const seq = this.frames.length && this.def.animationMode !== 'randomframe'
    let count = 0
    const data = this.instances
    for (const p of this.particles) {
      const s = this.shade(p)
      const a = p.a * s.a * alpha
      if (a <= 0.002) continue
      const o = count * STRIDE
      data[o] = p.x + s.dx
      data[o + 1] = p.y + s.dy
      data[o + 2] = p.size * s.size
      data[o + 3] = p.rot
      data[o + 4] = p.r * s.r * color[0]
      data[o + 5] = p.g * s.g * color[1]
      data[o + 6] = p.b * s.b * color[2]
      data[o + 7] = a
      let f = { u0: 0, v0: 0, u1: 1, v1: 1 }
      if (this.frames.length) {
        const idx = seq ? Math.floor((p.age / Math.max(p.life, 1e-4)) * this.frames.length * (this.def.sequenceMultiplier || 1)) % this.frames.length : p.frame
        f = this.frames[idx] ?? f
      }
      data[o + 8] = f.u0
      data[o + 9] = f.v0
      data[o + 10] = f.u1
      data[o + 11] = f.v1
      count++
    }
    if (!count) return
    const refract = this.def.refract
    // Grab the scene before binding the program (the copy may blit framebuffers).
    const scene = refract ? ctx.scene() : null
    const u = prog.u
    gl.useProgram(prog.program)
    gl.uniformMatrix4fv(u.mvp, false, mvp)
    gl.uniform2f(u.axis, axis[0], axis[1])
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.uniform1i(u.tex, 0)
    gl.uniform1f(u.format, this.format)
    gl.uniform1f(u.overbright, this.def.overbright ?? 1)
    gl.uniform1f(u.refract, refract ? 1 : 0)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, (refract?.normal && ctx.texture(refract.normal, 0)) || texture)
    gl.uniform1i(u.normal, 1)
    gl.uniform1f(u.normalFormat, ctx.format(refract?.normal))
    gl.activeTexture(gl.TEXTURE2)
    gl.bindTexture(gl.TEXTURE_2D, scene ?? texture)
    gl.uniform1i(u.scene, 2)
    ctx.setBlend(this.def.blending === 'normal' ? 'translucent' : this.def.blending)
    gl.bindVertexArray(this.vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer)
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, count * STRIDE)
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count)
    gl.bindVertexArray(null)
  }

  dispose(gl: WebGL2RenderingContext): void {
    for (const c of this.children) c.system.dispose(gl)
    if (this.vao) gl.deleteVertexArray(this.vao)
    if (this.buffer) gl.deleteBuffer(this.buffer)
    this.vao = null
    this.buffer = null
  }
}
