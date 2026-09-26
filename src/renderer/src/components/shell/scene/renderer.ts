// WebGL2 renderer for compiled Wallpaper Engine scenes.
//
// The scene is drawn into an offscreen buffer at the display's real pixel
// density (the orthographic projection scaled to "cover" the window), then
// shown 1:1. Image layers with effects run their Wallpaper Engine shader
// passes in texture space (ping-pong buffers), compose layers apply effects to
// what's behind them, particles are simulated on the CPU.
import type { SceneData, SceneEffect, SceneLayer, ScenePass, SceneTexRef, SceneTexture } from '@shared/wallpaper'
import { fileUrl } from '@/lib/api'
import { ATTR_POSITION, ATTR_TEXCOORD, compileProgram, setUniform, type CompiledProgram } from './glsl'
import { apply, identity, invert, multiply, ortho, rotationX, rotationY, rotationZ, sampleAnimation, scaling, translation, type Mat4 } from './math'
import { ParticleSystem, type ParticleGl } from './particles'

interface Target {
  fbo: WebGLFramebuffer
  tex: WebGLTexture
  w: number
  h: number
}

interface Img {
  tex: WebGLTexture
  w: number
  h: number
  video?: HTMLVideoElement
  dirty?: boolean
}

interface Mesh {
  vao: WebGLVertexArrayObject
  count: number
  buffers: WebGLBuffer[]
}

interface LayerRuntime {
  a?: Target
  b?: Target
  fbos: Map<string, Target>
  particles?: ParticleSystem
  result?: WebGLTexture
  resultSize?: [number, number]
  disabled: Set<number>
}

export interface SceneRendererOptions {
  /** Longest side of any buffer we allocate. */
  maxSide: number
  /** Pixel budget of the scene buffer. */
  maxArea: number
  /** Longest side of layer/effect buffers. */
  maxLayerSide: number
  /** Longest side textures are uploaded at (bigger ones are downscaled). */
  maxTextureSide: number
  fps: number
}

/** How far (as a fraction of the scene) a depth-1 layer drifts at full parallax. */
const PARALLAX = 0.025
/** Effect passes draw a clip-space quad (some Wallpaper Engine shaders skip the MVP entirely). */
const FX_MVP = identity()
const layerKey = (blend: number): string => `__layer|${blend}`

const BLIT_VERT = `#version 300 es
layout(location = 0) in vec2 a_Position;
uniform vec4 u_Rect;
out vec2 v_Uv;
void main() {
  gl_Position = vec4(a_Position * 2.0, 0.0, 1.0);
  v_Uv = mix(u_Rect.xy, u_Rect.zw, a_Position + 0.5);
}`
const BLIT_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_Tex;
in vec2 v_Uv;
out vec4 o_Color;
void main() { o_Color = vec4(texture(u_Tex, v_Uv).rgb, 1.0); }`

const BRIGHT_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_Tex;
uniform float u_Threshold;
in vec2 v_Uv;
out vec4 o_Color;
void main() {
  vec3 c = texture(u_Tex, v_Uv).rgb;
  float l = max(c.r, max(c.g, c.b));
  o_Color = vec4(c * smoothstep(u_Threshold, u_Threshold + 0.25, l), 1.0);
}`
const BLUR_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_Tex;
uniform vec2 u_Step;
in vec2 v_Uv;
out vec4 o_Color;
void main() {
  vec3 c = texture(u_Tex, v_Uv).rgb * 0.227;
  c += texture(u_Tex, v_Uv + u_Step * 1.385).rgb * 0.316;
  c += texture(u_Tex, v_Uv - u_Step * 1.385).rgb * 0.316;
  c += texture(u_Tex, v_Uv + u_Step * 3.231).rgb * 0.070;
  c += texture(u_Tex, v_Uv - u_Step * 3.231).rgb * 0.070;
  o_Color = vec4(c, 1.0);
}`
const ADD_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_Tex;
uniform float u_Strength;
in vec2 v_Uv;
out vec4 o_Color;
void main() { o_Color = vec4(texture(u_Tex, v_Uv).rgb * u_Strength, 1.0); }`

interface Simple {
  program: WebGLProgram
  u: Record<string, WebGLUniformLocation | null>
}

export class SceneRenderer {
  readonly gl: WebGL2RenderingContext
  readonly diagnostics: string[] = []
  readonly needsAudio: boolean
  private readonly quad: WebGLBuffer
  private readonly vao: WebGLVertexArrayObject
  private readonly vaoFx: WebGLVertexArrayObject
  private readonly programs = new Map<string, CompiledProgram | null>()
  private readonly images = new Map<string, Img[]>()
  private readonly runtimes = new Map<number, LayerRuntime>()
  private readonly byId = new Map<number, SceneLayer>()
  private readonly referenced = new Set<number>()
  private readonly meshes = new Map<number, Mesh>()
  private pointerSeen = false
  private readonly white: WebGLTexture
  private readonly simple: Record<'blit' | 'bright' | 'blur' | 'add', Simple>
  private readonly aniso: EXT_texture_filter_anisotropic | null
  private scene?: Target
  private copy?: Target
  private bloomA?: Target
  private bloomB?: Target
  private copyFresh = false
  private raf = 0
  private running = false
  private readonly t0 = performance.now()
  private last = 0
  private pointer: [number, number] = [0.5, 0.5]
  private pointerLast: [number, number] = [0.5, 0.5]
  private smooth: [number, number] = [0.5, 0.5]
  private readonly audioL = new Float32Array(64)
  private readonly audioR = new Float32Array(64)
  private css = { w: 1, h: 1, dpr: 1 }
  private proj: Mat4
  private view = { x0: 0, y0: 0, w: 1, h: 1 }
  private worlds = new Map<number, Mat4>()
  private frameTime = 0
  private disposed = false
  /** Frames drawn, for diagnostics. */
  frames = 0

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly data: SceneData,
    private readonly opts: SceneRendererOptions
  ) {
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' })
    if (!gl) throw new Error('WebGL2 is not available')
    this.gl = gl
    this.aniso = gl.getExtension('EXT_texture_filter_anisotropic')
    this.proj = ortho(data.width, data.height)
    for (const l of data.layers) this.byId.set(l.id, l)
    this.needsAudio = data.layers.some((l) => l.effects.some((e) => e.passes.some((p) => p.audio)))
    // Layers other layers' effects read (they're drawn even when hidden, just not shown).
    for (const l of data.layers)
      for (const e of l.effects)
        for (const p of e.passes)
          for (const name of [...p.textures.map((t) => (t && 'rt' in t ? t.rt : '')), ...(p.binds ?? []).map((b) => b.name)]) {
            const m = /^_rt_imageLayerComposite_(\d+)_[ab]$/.exec(name)
            if (m && Number(m[1]) !== l.id) this.referenced.add(Number(m[1]))
          }

    // Unit quad, top-left first: x, y in [-0.5, 0.5] (y up), u, v in [0, 1] (v down).
    this.quad = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.5, 0.5, 0, 0, -0.5, -0.5, 0, 1, 0.5, 0.5, 1, 0, 0.5, -0.5, 1, 1]), gl.STATIC_DRAW)
    this.vao = gl.createVertexArray()!
    gl.bindVertexArray(this.vao)
    gl.enableVertexAttribArray(ATTR_POSITION)
    gl.vertexAttribPointer(ATTR_POSITION, 2, gl.FLOAT, false, 16, 0)
    gl.enableVertexAttribArray(ATTR_TEXCOORD)
    gl.vertexAttribPointer(ATTR_TEXCOORD, 2, gl.FLOAT, false, 16, 8)
    gl.bindVertexArray(null)
    // Effect/buffer passes: x, y in clip space, v = 0 on the buffer's first row (like the images' first row).
    const quadFx = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, quadFx)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 0, 0, -1, 1, 0, 1, 1, -1, 1, 0, 1, 1, 1, 1]), gl.STATIC_DRAW)
    this.vaoFx = gl.createVertexArray()!
    gl.bindVertexArray(this.vaoFx)
    gl.enableVertexAttribArray(ATTR_POSITION)
    gl.vertexAttribPointer(ATTR_POSITION, 2, gl.FLOAT, false, 16, 0)
    gl.enableVertexAttribArray(ATTR_TEXCOORD)
    gl.vertexAttribPointer(ATTR_TEXCOORD, 2, gl.FLOAT, false, 16, 8)
    gl.bindVertexArray(null)

    this.white = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, this.white)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]))

    const simple = (frag: string, names: string[]): Simple => {
      const make = (type: number, src: string): WebGLShader => {
        const s = gl.createShader(type)!
        gl.shaderSource(s, src)
        gl.compileShader(s)
        return s
      }
      const program = gl.createProgram()!
      gl.attachShader(program, make(gl.VERTEX_SHADER, BLIT_VERT))
      gl.attachShader(program, make(gl.FRAGMENT_SHADER, frag))
      gl.linkProgram(program)
      const u: Simple['u'] = {}
      for (const n of ['u_Tex', 'u_Rect', ...names]) u[n] = gl.getUniformLocation(program, n)
      return { program, u }
    }
    this.simple = { blit: simple(BLIT_FRAG, []), bright: simple(BRIGHT_FRAG, ['u_Threshold']), blur: simple(BLUR_FRAG, ['u_Step']), add: simple(ADD_FRAG, ['u_Strength']) }
  }

  // ─── Loading ───────────────────────────────────────────────────────────────

  /** Upload every texture and compile every program the scene uses. */
  async load(): Promise<void> {
    const keys = new Set<string>()
    const addRef = (r: SceneTexRef | undefined): void => {
      if (r && 'tex' in r) keys.add(r.tex)
    }
    const walkParticles = (p: SceneLayer['particles']): void => {
      if (!p) return
      if (p.texture) keys.add(p.texture)
      if (p.refract?.normal) keys.add(p.refract.normal)
      for (const c of p.children) walkParticles(c.system)
    }
    for (const l of this.data.layers) {
      if (l.texture) keys.add(l.texture)
      for (const e of l.effects) for (const p of e.passes) p.textures.forEach(addRef)
      walkParticles(l.particles)
    }
    await Promise.all([...keys].map((k) => this.loadTexture(k)))
    if (this.disposed) return
    const programKeys = new Set<string>()
    programKeys.add(layerKey(0))
    for (const l of this.data.layers) {
      if (l.kind === 'image' || l.kind === 'solid' || l.kind === 'compose') programKeys.add(layerKey(l.blendMode))
      for (const e of l.effects) for (const p of e.passes) if (p.program) programKeys.add(p.program)
    }
    for (const k of programKeys) {
      this.program(k)
      // Let the UI breathe between compiles.
      await new Promise((r) => setTimeout(r, 0))
      if (this.disposed) return
    }
  }

  private async loadTexture(key: string): Promise<void> {
    const t = this.data.textures[key]
    if (!t) return
    const out: Img[] = []
    for (const path of t.paths) {
      try {
        out.push(t.video || /\.mp4$/i.test(path) ? await this.loadVideo(path) : await this.loadImage(path, t))
      } catch (err) {
        this.diagnostics.push(`texture ${key}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    if (out.length) this.images.set(key, out)
  }

  private async loadImage(path: string, t: SceneTexture): Promise<Img> {
    const res = await fetch(fileUrl(path))
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const blob = await res.blob()
    let bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' })
    const max = Math.min(this.opts.maxTextureSide, this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE) as number)
    if (bitmap.width > max || bitmap.height > max) {
      const k = max / Math.max(bitmap.width, bitmap.height)
      const smaller = await createImageBitmap(bitmap, { resizeWidth: Math.max(1, Math.round(bitmap.width * k)), resizeHeight: Math.max(1, Math.round(bitmap.height * k)), resizeQuality: 'high', premultiplyAlpha: 'none', colorSpaceConversion: 'none' })
      bitmap.close()
      bitmap = smaller
    }
    const gl = this.gl
    const tex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap)
    const wrap = t.clamp ? gl.CLAMP_TO_EDGE : gl.REPEAT
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap)
    if (t.nearest) {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    } else {
      // Mipmaps keep big textures crisp (not shimmering) when drawn smaller.
      gl.generateMipmap(gl.TEXTURE_2D)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      if (this.aniso) gl.texParameterf(gl.TEXTURE_2D, this.aniso.TEXTURE_MAX_ANISOTROPY_EXT, 8)
    }
    const img = { tex, w: t.width, h: t.height }
    bitmap.close()
    return img
  }

  private loadVideo(path: string): Promise<Img> {
    return new Promise((resolve, reject) => {
      const v = document.createElement('video')
      v.crossOrigin = 'anonymous'
      v.muted = true
      v.loop = true
      v.playsInline = true
      v.preload = 'auto'
      v.src = fileUrl(path)
      const done = (): void => {
        const gl = this.gl
        const tex = gl.createTexture()!
        gl.bindTexture(gl.TEXTURE_2D, tex)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]))
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
        const img: Img = { tex, w: v.videoWidth || 1, h: v.videoHeight || 1, video: v, dirty: true }
        const onFrame = (): void => {
          img.dirty = true
          if (!this.disposed) v.requestVideoFrameCallback(onFrame)
        }
        if ('requestVideoFrameCallback' in v) v.requestVideoFrameCallback(onFrame)
        void v.play().catch(() => {})
        resolve(img)
      }
      v.addEventListener('loadeddata', done, { once: true })
      v.addEventListener('error', () => reject(new Error('video failed to load')), { once: true })
      setTimeout(() => reject(new Error('video timed out')), 15_000)
    })
  }

  private program(key: string): CompiledProgram | null {
    if (this.programs.has(key)) return this.programs.get(key)!
    const src = this.data.programs[key]
    if (!src) return null
    let compiled: CompiledProgram | null = null
    {
      const r = compileProgram(this.gl, src.vert, src.frag)
      if (typeof r === 'string') this.diagnostics.push(`${src.name}: ${r}`)
      else compiled = r
    }
    this.programs.set(key, compiled)
    return compiled
  }

  // ─── Sizing & input ────────────────────────────────────────────────────────

  resize(cssW: number, cssH: number, dpr: number): void {
    this.css = { w: Math.max(1, cssW), h: Math.max(1, cssH), dpr }
    const cw = Math.max(1, Math.round(cssW * dpr))
    const ch = Math.max(1, Math.round(cssH * dpr))
    this.canvas.width = cw
    this.canvas.height = ch
    const { width: W, height: H } = this.data
    const p = this.data.parallax
    const depth = Math.max(0, ...this.data.layers.map((l) => Math.max(Math.abs(l.parallax[0]), Math.abs(l.parallax[1]))))
    // Parallax needs a little headroom so layers never slide past the edge.
    const zoom = p ? Math.min(1.2, 1 + 2 * PARALLAX * Math.abs(p.amount) * depth) : 1
    const S = Math.max(cw / W, ch / H) * zoom
    this.view = { w: cw / S, h: ch / S, x0: (W - cw / S) / 2, y0: (H - ch / S) / 2 }
    // The scene buffer matches screen pixels unless that would be enormous.
    const gl = this.gl
    const maxSide = Math.min(this.opts.maxSide, gl.getParameter(gl.MAX_TEXTURE_SIZE) as number, gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number)
    let k = S
    k = Math.min(k, maxSide / W, maxSide / H, Math.sqrt(this.opts.maxArea / (W * H)))
    const sw = Math.max(1, Math.round(W * k))
    const sh = Math.max(1, Math.round(H * k))
    if (!this.scene || this.scene.w !== sw || this.scene.h !== sh) {
      this.scene = this.target(sw, sh, this.scene)
      this.copy = this.target(sw, sh, this.copy)
      if (this.data.bloom) {
        this.bloomA = this.target(Math.ceil(sw / 4), Math.ceil(sh / 4), this.bloomA)
        this.bloomB = this.target(Math.ceil(sw / 4), Math.ceil(sh / 4), this.bloomB)
      }
      // Compose buffers depend on the scene resolution.
      for (const [id, rt] of this.runtimes) {
        const l = this.byId.get(id)
        if (l && l.kind !== 'image') this.releaseLayer(rt)
      }
    }
  }

  /** Pointer position over the canvas, 0..1 with y down. */
  setPointer(x: number, y: number): void {
    this.pointerSeen = true
    this.pointer = [Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))]
  }

  /** 64 left + 64 right bands (Wallpaper Engine's layout). */
  setAudio(bands: ArrayLike<number>): void {
    for (let i = 0; i < 64; i++) {
      this.audioL[i] = bands[i] ?? 0
      this.audioR[i] = bands[64 + i] ?? bands[i] ?? 0
    }
  }

  start(): void {
    if (this.running || this.disposed) return
    this.running = true
    this.last = 0
    const tick = (now: number): void => {
      if (!this.running) return
      this.raf = requestAnimationFrame(tick)
      if (this.last && now - this.last < 1000 / this.opts.fps - 2) return
      const dt = this.last ? Math.min(0.1, (now - this.last) / 1000) : 1 / 60
      this.last = now
      this.render(dt)
    }
    this.raf = requestAnimationFrame(tick)
  }

  stop(): void {
    this.running = false
    cancelAnimationFrame(this.raf)
  }

  // ─── Resources ─────────────────────────────────────────────────────────────

  private target(w: number, h: number, reuse?: Target): Target {
    const gl = this.gl
    if (reuse && reuse.w === w && reuse.h === h) return reuse
    if (reuse) {
      gl.deleteFramebuffer(reuse.fbo)
      gl.deleteTexture(reuse.tex)
    }
    const tex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    const fbo = gl.createFramebuffer()!
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    return { fbo, tex, w, h }
  }

  private freeTarget(t?: Target): void {
    if (!t) return
    this.gl.deleteFramebuffer(t.fbo)
    this.gl.deleteTexture(t.tex)
  }

  private releaseLayer(rt: LayerRuntime): void {
    this.freeTarget(rt.a)
    this.freeTarget(rt.b)
    for (const t of rt.fbos.values()) this.freeTarget(t)
    rt.a = rt.b = undefined
    rt.fbos.clear()
  }

  private runtime(l: SceneLayer): LayerRuntime {
    let rt = this.runtimes.get(l.id)
    if (!rt) {
      rt = { fbos: new Map(), disabled: new Set() }
      this.runtimes.set(l.id, rt)
    }
    return rt
  }

  private setBlend(mode: string): void {
    const gl = this.gl
    switch (mode) {
      case 'translucent':
        gl.enable(gl.BLEND)
        gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
        break
      case 'additive':
        gl.enable(gl.BLEND)
        gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE, gl.ZERO, gl.ONE)
        break
      case 'multiply':
        gl.enable(gl.BLEND)
        gl.blendFuncSeparate(gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE)
        break
      case 'premultiplied':
        gl.enable(gl.BLEND)
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
        break
      default:
        gl.disable(gl.BLEND)
    }
  }

  private imageFor(key: string | undefined, image = 0): Img | undefined {
    if (!key) return undefined
    const list = this.images.get(key)
    const img = list?.[Math.min(image, (list?.length ?? 1) - 1)]
    if (img?.video && img.dirty && img.video.readyState >= 2) {
      const gl = this.gl
      gl.bindTexture(gl.TEXTURE_2D, img.tex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img.video)
      img.w = img.video.videoWidth
      img.h = img.video.videoHeight
      img.dirty = false
    }
    return img
  }

  /** Make sure `copy` holds the scene as drawn so far. */
  private ensureCopy(): WebGLTexture {
    const gl = this.gl
    if (!this.copyFresh && this.scene && this.copy) {
      const prevDraw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.scene.fbo)
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.copy.fbo)
      gl.blitFramebuffer(0, 0, this.scene.w, this.scene.h, 0, 0, this.copy.w, this.copy.h, gl.COLOR_BUFFER_BIT, gl.NEAREST)
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null)
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, prevDraw)
      this.copyFresh = true
    }
    return this.copy?.tex ?? this.white
  }

  // ─── Frame ─────────────────────────────────────────────────────────────────

  private animated(l: SceneLayer, key: 'origin' | 'scale' | 'angles' | 'color', base: number[]): number[] {
    const a = l.anims?.[key]
    if (!a) return base
    const v = sampleAnimation(a, this.frameTime)
    return base.map((b, i) => (i < v.length ? (a.relative ? b + v[i] : v[i]) : b))
  }

  private worldOf(l: SceneLayer, depth = 0): Mat4 {
    const hit = this.worlds.get(l.id)
    if (hit) return hit
    const origin = this.animated(l, 'origin', l.origin)
    const scale = this.animated(l, 'scale', l.scale)
    const angles = this.animated(l, 'angles', l.angles)
    let ox = origin[0]
    let oy = origin[1]
    const p = this.data.parallax
    if (p && l.parent === undefined) {
      const px = (this.smooth[0] - 0.5) * 2
      const py = (this.smooth[1] - 0.5) * 2
      ox -= px * p.amount * l.parallax[0] * PARALLAX * this.data.width
      oy += py * p.amount * l.parallax[1] * PARALLAX * this.data.height
    }
    let m = multiply(translation(ox, oy, 0), multiply(rotationZ(angles[2]), multiply(rotationY(angles[1]), multiply(rotationX(angles[0]), scaling(scale[0], scale[1], scale[2] || 1)))))
    if (l.parent !== undefined && depth < 16) {
      const parent = this.byId.get(l.parent)
      if (parent) m = multiply(this.worldOf(parent, depth + 1), m)
    }
    this.worlds.set(l.id, m)
    return m
  }

  private render(dt: number): void {
    const gl = this.gl
    if (!this.scene || gl.isContextLost()) return
    this.frameTime = (performance.now() - this.t0) / 1000
    const p = this.data.parallax
    const k = p ? 1 - Math.exp(-dt / Math.max(0.03, p.delay || 0.1)) : 1
    this.smooth[0] += (this.pointer[0] - this.smooth[0]) * k
    this.smooth[1] += (this.pointer[1] - this.smooth[1]) * k
    this.worlds.clear()

    gl.bindVertexArray(this.vao)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scene.fbo)
    gl.viewport(0, 0, this.scene.w, this.scene.h)
    const c = this.data.clearColor
    gl.clearColor(c[0], c[1], c[2], 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
    this.copyFresh = false

    for (const l of this.data.layers) {
      try {
        this.drawLayer(l, dt)
      } catch (err) {
        this.diagnostics.push(`layer ${l.name}: ${err instanceof Error ? err.message : String(err)}`)
        l.visible = false
      }
    }
    if (this.data.bloom) this.bloom()
    this.present()
    this.pointerLast = [this.pointer[0], this.pointer[1]]
    this.frames++
  }

  private present(): void {
    const gl = this.gl
    const { x0, y0, w, h } = this.view
    let sx = 0
    let sy = 0
    const shake = this.data.shake
    if (shake) {
      const t = this.frameTime * shake.speed
      const amp = shake.amplitude * 0.004
      sx = (Math.sin(t * 1.3) + Math.sin(t * 2.9 * shake.roughness) * 0.5) * amp * this.data.width
      sy = (Math.cos(t * 1.7) + Math.sin(t * 3.7 * shake.roughness) * 0.5) * amp * this.data.height
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    gl.disable(gl.BLEND)
    const b = this.simple.blit
    gl.useProgram(b.program)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.scene!.tex)
    gl.uniform1i(b.u.u_Tex, 0)
    const W = this.data.width
    const H = this.data.height
    gl.uniform4f(b.u.u_Rect, (x0 + sx) / W, (y0 + sy) / H, (x0 + sx + w) / W, (y0 + sy + h) / H)
    gl.bindVertexArray(this.vao)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }

  private bloom(): void {
    const gl = this.gl
    const bl = this.data.bloom!
    if (!this.bloomA || !this.bloomB || !this.scene) return
    const pass = (s: Simple, src: WebGLTexture, dst: Target, set: () => void): void => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo)
      gl.viewport(0, 0, dst.w, dst.h)
      gl.useProgram(s.program)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, src)
      gl.uniform1i(s.u.u_Tex, 0)
      gl.uniform4f(s.u.u_Rect, 0, 0, 1, 1)
      set()
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    }
    gl.disable(gl.BLEND)
    pass(this.simple.bright, this.ensureCopy(), this.bloomA, () => gl.uniform1f(this.simple.bright.u.u_Threshold, bl.threshold))
    for (let i = 0; i < 2; i++) {
      pass(this.simple.blur, this.bloomA.tex, this.bloomB, () => gl.uniform2f(this.simple.blur.u.u_Step, (1.5 + i) / this.bloomA!.w, 0))
      pass(this.simple.blur, this.bloomB.tex, this.bloomA, () => gl.uniform2f(this.simple.blur.u.u_Step, 0, (1.5 + i) / this.bloomA!.h))
    }
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE)
    pass(this.simple.add, this.bloomA.tex, this.scene, () => gl.uniform1f(this.simple.add.u.u_Strength, Math.min(2, bl.strength * 0.35)))
    gl.disable(gl.BLEND)
    this.copyFresh = false
  }

  /** Current sprite-sheet frame of a texture: image index and UV transform. */
  private frameOf(key: string | undefined): { image: number; tr: [number, number]; rot: [number, number, number, number]; w: number; h: number } {
    const t = key ? this.data.textures[key] : undefined
    if (!t?.frames?.length) return { image: 0, tr: [0, 0], rot: [1, 0, 0, 1], w: t?.width ?? 1, h: t?.height ?? 1 }
    const total = t.frames.reduce((s, f) => s + Math.max(f.seconds, 0.001), 0)
    let at = this.frameTime % total
    let f = t.frames[0]
    for (const fr of t.frames) {
      f = fr
      at -= Math.max(fr.seconds, 0.001)
      if (at < 0) break
    }
    return { image: f.image, tr: [f.x / t.width, f.y / t.height], rot: [f.width / t.width, 0, 0, f.height / t.height], w: f.width, h: f.height }
  }

  private layerColor(l: SceneLayer): { color: number[]; alpha: number } {
    const color = this.animated(l, 'color', l.color)
    let alpha = l.alpha
    const a = l.anims?.alpha
    if (a) {
      const v = sampleAnimation(a, this.frameTime)[0] ?? 0
      alpha = a.relative ? alpha + v : v
    }
    return { color, alpha: Math.max(0, Math.min(1, alpha)) }
  }

  private drawQuad(prog: CompiledProgram, values: Record<string, number | ArrayLike<number>>, textures: (WebGLTexture | null)[], fx: boolean | Mesh = false): void {
    const gl = this.gl
    gl.bindVertexArray(typeof fx === 'object' ? fx.vao : fx ? this.vaoFx : this.vao)
    gl.useProgram(prog.program)
    for (const [name, v] of Object.entries(values)) {
      const u = prog.uniforms.get(name)
      if (u) setUniform(gl, u, v)
    }
    for (const [name, unit] of prog.samplers) {
      const m = /^g_Texture(\d+)$/.exec(name)
      const tex = m ? textures[Number(m[1])] : null
      gl.activeTexture(gl.TEXTURE0 + unit)
      gl.bindTexture(gl.TEXTURE_2D, tex ?? this.white)
    }
    if (typeof fx === 'object') gl.drawElements(gl.TRIANGLES, fx.count, gl.UNSIGNED_SHORT, 0)
    else gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }

  /** GPU buffers for a puppet layer's rest-pose mesh. */
  private meshFor(l: SceneLayer): Mesh | null {
    if (!l.mesh) return null
    const hit = this.meshes.get(l.id)
    if (hit) return hit
    const gl = this.gl
    const { positions, uvs, indices } = l.mesh
    const data = new Float32Array((positions.length / 2) * 4)
    for (let i = 0; i < positions.length / 2; i++) data.set([positions[i * 2], positions[i * 2 + 1], uvs[i * 2], uvs[i * 2 + 1]], i * 4)
    const vao = gl.createVertexArray()!
    gl.bindVertexArray(vao)
    const vbo = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW)
    gl.enableVertexAttribArray(ATTR_POSITION)
    gl.vertexAttribPointer(ATTR_POSITION, 2, gl.FLOAT, false, 16, 0)
    gl.enableVertexAttribArray(ATTR_TEXCOORD)
    gl.vertexAttribPointer(ATTR_TEXCOORD, 2, gl.FLOAT, false, 16, 8)
    const ibo = gl.createBuffer()!
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo)
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), gl.STATIC_DRAW)
    gl.bindVertexArray(null)
    const mesh: Mesh = { vao, count: indices.length, buffers: [vbo, ibo] }
    this.meshes.set(l.id, mesh)
    return mesh
  }

  private drawLayer(l: SceneLayer, dt: number): void {
    const referenced = this.referenced.has(l.id)
    if (l.kind === 'group' || (!l.visible && !referenced) || (!l.visible && l.kind === 'particles')) return
    // A solid layer's effects *are* its content (bars, gradients…); if one can't run, a bare block would be wrong.
    if (l.kind === 'solid' && l.effects.some((fx) => fx.passes.some((p) => p.program && this.programs.get(p.program) === null))) return
    const gl = this.gl
    const rt = this.runtime(l)
    const world = this.worldOf(l)
    const { color, alpha } = this.layerColor(l)
    const W = this.data.width
    const H = this.data.height

    if (l.kind === 'particles' && l.particles) {
      if (!rt.particles) rt.particles = new ParticleSystem(l.particles, (key) => (key ? this.data.textures[key] : undefined))
      rt.particles.update(dt)
      const sx = Math.hypot(world[0], world[1]) || 1
      const sy = Math.hypot(world[4], world[5]) || 1
      const avg = (sx + sy) / 2
      const ctx: ParticleGl = {
        gl,
        quad: this.quad,
        texture: (key, image) => this.imageFor(key, image)?.tex ?? null,
        setBlend: (m) => this.setBlend(m),
        scene: () => this.ensureCopy(),
        format: (key) => this.formatOf(key)
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.scene!.fbo)
      gl.viewport(0, 0, this.scene!.w, this.scene!.h)
      rt.particles.draw(ctx, multiply(this.proj, world), [avg / sx, avg / sy], alpha, color as [number, number, number])
      gl.bindVertexArray(this.vao)
      this.copyFresh = false
      return
    }
    if (alpha <= 0.001 && l.kind !== 'compose' && !referenced) return

    const model = multiply(world, scaling(l.size[0], l.size[1], 1))
    const mvp = multiply(this.proj, model)
    const effects = l.effects.filter((_, i) => !rt.disabled.has(i))
    const frame = this.frameOf(l.texture)
    const base = l.kind === 'image' ? this.imageFor(l.texture, frame.image) : undefined
    if (l.kind === 'image' && !base) return
    const brightness = l.brightness
    const color4 = [color[0] * brightness, color[1] * brightness, color[2] * brightness, alpha]

    // Fast path: a plain image.
    if (!effects.length && l.kind !== 'compose') {
      if (referenced) {
        rt.result = l.kind === 'image' ? base!.tex : this.white
        rt.resultSize = [frame.w, frame.h]
      }
      if (l.visible) this.composite(l, mvp, l.kind === 'image' ? base!.tex : this.white, frame.tr, frame.rot, color4, l.kind === 'image' ? this.formatOf(l.texture) : 0)
      return
    }

    // Layer buffer: texture resolution for images, screen resolution for compose/solid layers.
    const pxPerUnit = this.scene!.w / W
    let bw: number
    let bh: number
    if (l.kind === 'image') {
      bw = frame.w
      bh = frame.h
    } else {
      bw = Math.abs(l.size[0] * (l.scale[0] || 1)) * pxPerUnit
      bh = Math.abs(l.size[1] * (l.scale[1] || 1)) * pxPerUnit
    }
    const cap = Math.min(1, this.opts.maxLayerSide / Math.max(bw, bh, 1))
    bw = Math.max(1, Math.round(bw * cap))
    bh = Math.max(1, Math.round(bh * cap))
    rt.a = this.target(bw, bh, rt.a)
    rt.b = this.target(bw, bh, rt.b)

    const layerProg = this.program(layerKey(0))
    if (!layerProg) return
    gl.bindFramebuffer(gl.FRAMEBUFFER, rt.a.fbo)
    gl.viewport(0, 0, bw, bh)
    gl.disable(gl.BLEND)
    if (l.kind === 'image') {
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      this.drawQuad(layerProg, { g_ModelViewProjectionMatrix: FX_MVP, g_Texture0Translation: frame.tr, g_Texture0Rotation: frame.rot, g_Color4: [1, 1, 1, 1], g_StitchFormat: this.formatOf(l.texture) }, [base!.tex], true)
    } else if (l.kind === 'solid') {
      gl.clearColor(1, 1, 1, 1)
      gl.clear(gl.COLOR_BUFFER_BIT)
    } else {
      // Compose: grab what's behind the layer, in the layer's own orientation.
      const copy = this.ensureCopy()
      const corner = (x: number, y: number): [number, number] => {
        const [sx, sy] = apply(model, x, y)
        return [sx / W, sy / H]
      }
      const tl = corner(-0.5, 0.5)
      const tr = corner(0.5, 0.5)
      const bl = corner(-0.5, -0.5)
      gl.bindFramebuffer(gl.FRAMEBUFFER, rt.a.fbo)
      gl.viewport(0, 0, bw, bh)
      this.drawQuad(layerProg, { g_ModelViewProjectionMatrix: FX_MVP, g_Texture0Translation: tl, g_Texture0Rotation: [tr[0] - tl[0], tr[1] - tl[1], bl[0] - tl[0], bl[1] - tl[1]], g_Color4: [1, 1, 1, 1], g_StitchFormat: 0 }, [copy], true)
    }

    let cur = rt.a
    let other = rt.b
    const etp = multiply(mvp, scaling(0.5, 0.5, 1))
    const engine: Record<string, number | ArrayLike<number>> = {
      g_ModelViewProjectionMatrix: FX_MVP,
      g_ModelViewProjectionMatrixInverse: FX_MVP,
      g_EffectTextureProjectionMatrix: etp,
      g_EffectTextureProjectionMatrixInverse: invert(etp),
      g_EffectModelViewProjectionMatrix: mvp,
      g_EffectModelViewProjectionMatrixInverse: invert(mvp),
      g_EffectModelMatrix: model,
      g_ModelMatrix: model,
      g_ModelMatrixInverse: invert(model),
      g_ViewProjectionMatrix: this.proj,
      g_Time: this.frameTime,
      g_Daytime: dayFraction(),
      g_PointerPosition: this.scenePointer(this.pointer),
      g_PointerPositionLast: this.scenePointer(this.pointerLast),
      g_ParallaxPosition: this.smooth,
      g_Screen: [this.canvas.width, this.canvas.height, this.canvas.width / this.canvas.height],
      g_TexelSize: [1 / bw, 1 / bh],
      g_TexelSizeHalf: [0.5 / bw, 0.5 / bh],
      g_Alpha: alpha,
      g_UserAlpha: alpha,
      g_Brightness: brightness,
      g_Color: color,
      g_Color4: color4,
      g_EyePosition: [W / 2, H / 2, 1000],
      g_LightAmbientColor: [0.3, 0.3, 0.3],
      g_LightSkylightColor: [0.3, 0.3, 0.3]
    }
    if (this.needsAudio) Object.assign(engine, this.audioUniforms())

    effects: for (const [ei, fx] of l.effects.entries()) {
      if (rt.disabled.has(ei)) continue
      for (const f of fx.fbos) {
        const w = Math.max(1, Math.ceil(bw / f.scale))
        const h = Math.max(1, Math.ceil(bh / f.scale))
        rt.fbos.set(f.name, this.target(w, h, rt.fbos.get(f.name)))
      }
      for (const pass of fx.passes) {
        if (pass.command) {
          this.command(pass, rt, cur)
          continue
        }
        const prog = pass.program ? this.program(pass.program) : null
        if (!prog) {
          rt.disabled.add(ei)
          continue effects
        }
        const out = pass.target ? rt.fbos.get(pass.target) : other
        if (!out) {
          rt.disabled.add(ei)
          continue effects
        }
        const textures = this.passTextures(pass, l.id, rt, cur)
        // A pass can't read the buffer it draws into: read a copy instead.
        for (let i = 0; i < textures.length; i++) {
          const t = textures[i]
          if (t && t.tex === out.tex) textures[i] = this.snapshot(out)
        }
        const values: Record<string, number | ArrayLike<number>> = { ...engine, g_TexelSize: [1 / cur.w, 1 / cur.h], g_TexelSizeHalf: [0.5 / cur.w, 0.5 / cur.h] }
        textures.forEach((t, i) => {
          if (!t) return
          values[`g_Texture${i}Resolution`] = [t.w, t.h, t.w, t.h]
          values[`g_Texture${i}Rotation`] = [1, 0, 0, 1]
          values[`g_Texture${i}Translation`] = [0, 0]
          values[`g_Texture${i}MipMapInfo`] = Math.log2(Math.max(t.w, t.h, 1))
        })
        Object.assign(values, pass.uniforms)
        const opaque = pass.blending === 'normal' || pass.blending === 'disabled'
        if (!opaque && out !== cur && out.w === cur.w && out.h === cur.h) {
          // Blended passes draw over the layer so far.
          gl.bindFramebuffer(gl.READ_FRAMEBUFFER, cur.fbo)
          gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, out.fbo)
          gl.blitFramebuffer(0, 0, cur.w, cur.h, 0, 0, out.w, out.h, gl.COLOR_BUFFER_BIT, gl.NEAREST)
          gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null)
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, out.fbo)
        gl.viewport(0, 0, out.w, out.h)
        if (opaque || out.w !== cur.w || out.h !== cur.h) {
          gl.clearColor(0, 0, 0, 0)
          gl.clear(gl.COLOR_BUFFER_BIT)
        }
        this.setBlend(opaque ? 'none' : pass.blending)
        this.drawQuad(
          prog,
          values,
          textures.map((t) => t?.tex ?? null),
          true
        )
        if (!pass.target) {
          const t = cur
          cur = out
          other = t
        }
      }
    }

    rt.result = cur.tex
    rt.resultSize = [cur.w, cur.h]
    if (!l.visible) return
    if (l.kind === 'compose') {
      this.composite({ ...l, blending: 'translucent' }, mvp, cur.tex, [0, 0], [1, 0, 0, 1], [1, 1, 1, alpha])
    } else {
      this.composite(l, mvp, cur.tex, [0, 0], [1, 0, 0, 1], color4)
    }
  }

  /** Draw a finished layer into the scene. */
  private formatOf(key: string | undefined): number {
    return (key ? this.data.textures[key]?.format : 0) ?? 0
  }

  private composite(l: SceneLayer, mvp: Mat4, tex: WebGLTexture, tr: number[], rot: number[], color4: number[], format = 0): void {
    const gl = this.gl
    // Puppets draw their mesh (layer units) instead of the size-scaled quad.
    const mesh = this.meshFor(l)
    if (mesh) mvp = multiply(this.proj, this.worldOf(l))
    const own = this.program(layerKey(l.blendMode))
    // Generated content (compose layers) in a blend mode we can't do would just cover the scene.
    if (!own && l.blendMode && l.kind === 'compose') return
    const prog = own ?? this.program(layerKey(0))
    if (!prog) return
    const blendMode = this.programs.get(layerKey(l.blendMode)) ? l.blendMode : 0
    const textures: (WebGLTexture | null)[] = [tex]
    if (blendMode) textures[4] = this.ensureCopy()
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scene!.fbo)
    gl.viewport(0, 0, this.scene!.w, this.scene!.h)
    this.setBlend(blendMode ? 'none' : l.blending === 'normal' || l.blending === 'disabled' ? 'translucent' : l.blending)
    this.drawQuad(prog, { g_ModelViewProjectionMatrix: mvp, g_Texture0Translation: tr, g_Texture0Rotation: rot, g_Color4: color4, g_StitchFormat: format }, textures, mesh ?? false)
    this.copyFresh = false
  }

  private readonly scratch = new Map<string, Target>()

  /** A copy of a buffer, for passes that read and write the same one. */
  private snapshot(src: Target): Target {
    const gl = this.gl
    const key = `${src.w}x${src.h}`
    const dst = this.target(src.w, src.h, this.scratch.get(key))
    this.scratch.set(key, dst)
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, src.fbo)
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dst.fbo)
    gl.blitFramebuffer(0, 0, src.w, src.h, 0, 0, dst.w, dst.h, gl.COLOR_BUFFER_BIT, gl.NEAREST)
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null)
    gl.bindFramebuffer(gl.FRAMEBUFFER, src.fbo)
    return dst
  }

  private command(pass: ScenePass, rt: LayerRuntime, cur: Target): void {
    const gl = this.gl
    const get = (name?: string): Target | undefined => (name === 'previous' ? cur : name ? rt.fbos.get(name) : undefined)
    if (pass.command === 'swap') {
      const a = pass.source ? rt.fbos.get(pass.source) : undefined
      const b = pass.target ? rt.fbos.get(pass.target) : undefined
      if (a && b && pass.source && pass.target) {
        rt.fbos.set(pass.source, b)
        rt.fbos.set(pass.target, a)
      }
      return
    }
    const src = get(pass.source)
    const dst = get(pass.target)
    if (!src || !dst) return
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, src.fbo)
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dst.fbo)
    gl.blitFramebuffer(0, 0, src.w, src.h, 0, 0, dst.w, dst.h, gl.COLOR_BUFFER_BIT, gl.LINEAR)
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null)
  }

  private rtTexture(name: string, rt: LayerRuntime, cur: Target, self: number): { tex: WebGLTexture; w: number; h: number } | null {
    if (name === 'previous') return cur
    const own = rt.fbos.get(name)
    if (own) return own
    if (/^_rt_(FullFrameBuffer|MipMappedFrameBuffer|Default)/.test(name)) {
      return { tex: this.ensureCopy(), w: this.copy?.w ?? 1, h: this.copy?.h ?? 1 }
    }
    const m = /^_rt_imageLayerComposite_(\d+)_[ab]$/.exec(name)
    if (m) {
      // A layer's own composite is the layer as drawn so far.
      if (Number(m[1]) === self) return cur
      const other = this.runtimes.get(Number(m[1]))
      if (other?.result) return { tex: other.result, w: other.resultSize?.[0] ?? 1, h: other.resultSize?.[1] ?? 1 }
    }
    return null
  }

  private passTextures(pass: ScenePass, self: number, rt: LayerRuntime, cur: Target): ({ tex: WebGLTexture; w: number; h: number } | null)[] {
    const out: ({ tex: WebGLTexture; w: number; h: number } | null)[] = []
    const count = Math.max(pass.textures.length, 1, ...(pass.binds ?? []).map((b) => b.index + 1))
    for (let i = 0; i < count; i++) {
      const ref = pass.textures[i]
      if (!ref) out[i] = i === 0 ? cur : null
      else if ('tex' in ref) {
        const f = this.frameOf(ref.tex)
        const img = this.imageFor(ref.tex, f.image)
        out[i] = img ? { tex: img.tex, w: img.w, h: img.h } : null
      } else out[i] = this.rtTexture(ref.rt, rt, cur, self)
    }
    for (const b of pass.binds ?? []) out[b.index] = this.rtTexture(b.name, rt, cur, self) ?? out[b.index]
    return out
  }

  private scenePointer(p: [number, number]): [number, number] {
    // Before the mouse has moved, cursor effects (x-ray, ripples) stay out of sight.
    if (!this.pointerSeen) return [-10, -10]
    const px = this.view.x0 + p[0] * this.view.w
    const py = this.view.y0 + (1 - p[1]) * this.view.h
    return [px / this.data.width, 1 - py / this.data.height]
  }

  private audioUniforms(): Record<string, Float32Array> {
    const bands = (src: Float32Array, n: number): Float32Array => {
      const out = new Float32Array(n)
      const per = 64 / n
      for (let i = 0; i < n; i++) {
        let s = 0
        for (let j = 0; j < per; j++) s += src[i * per + j]
        out[i] = s / per
      }
      return out
    }
    return {
      g_AudioSpectrum16Left: bands(this.audioL, 16),
      g_AudioSpectrum16Right: bands(this.audioR, 16),
      g_AudioSpectrum32Left: bands(this.audioL, 32),
      g_AudioSpectrum32Right: bands(this.audioR, 32),
      g_AudioSpectrum64Left: this.audioL,
      g_AudioSpectrum64Right: this.audioR
    }
  }

  /** Stats for diagnostics / tests. */
  stats(): { frames: number; programs: number; failed: number; diagnostics: string[]; buffer: [number, number]; canvas: [number, number] } {
    return {
      frames: this.frames,
      programs: [...this.programs.values()].filter(Boolean).length,
      failed: [...this.programs.values()].filter((p) => !p).length,
      diagnostics: this.diagnostics.slice(0, 20),
      buffer: [this.scene?.w ?? 0, this.scene?.h ?? 0],
      canvas: [this.canvas.width, this.canvas.height]
    }
  }

  dispose(): void {
    this.disposed = true
    this.stop()
    const gl = this.gl
    for (const rt of this.runtimes.values()) {
      this.releaseLayer(rt)
      rt.particles?.dispose(gl)
    }
    for (const list of this.images.values()) {
      for (const img of list) {
        gl.deleteTexture(img.tex)
        if (img.video) {
          img.video.pause()
          img.video.removeAttribute('src')
          img.video.load()
        }
      }
    }
    for (const p of this.programs.values()) if (p) gl.deleteProgram(p.program)
    for (const m of this.meshes.values()) {
      gl.deleteVertexArray(m.vao)
      for (const b of m.buffers) gl.deleteBuffer(b)
    }
    for (const t of [this.scene, this.copy, this.bloomA, this.bloomB, ...this.scratch.values()]) this.freeTarget(t)
    gl.getExtension('WEBGL_lose_context')?.loseContext()
  }
}

function dayFraction(): number {
  const d = new Date()
  return (d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()) / 86400
}

