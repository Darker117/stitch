// Compiles a Wallpaper Engine scene (scene.json + models, materials, effects,
// shaders and textures from scene.pkg, loose files, or the user's installed
// Wallpaper Engine assets) into a SceneData the renderer can draw, extracting
// every texture it needs to PNG (or the embedded JPG/PNG/MP4) on disk.
//
// Written from the file formats themselves; nothing here is taken from other
// Wallpaper Engine re-implementations.
import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs'
import { join, posix, resolve as resolvePath, sep } from 'node:path'
import type {
  SceneAnimated,
  SceneAnimation,
  SceneData,
  SceneEffect,
  SceneKeyframe,
  SceneLayer,
  SceneParticles,
  ScenePass,
  SceneTexRef,
  SceneTexture,
  Vec2,
  Vec3
} from '@shared/wallpaper'
import { SCENE_FORMAT } from '@shared/wallpaper'
import { parseMdl } from './mdl'
import { Pkg } from './pkg'
import { encodePng } from './png'
import { parseAnnotations, preprocess } from './shader'
import { decodeTex, parseTex, TEXF_CLAMP, TEXF_NEAREST } from './tex'

export interface CompileInput {
  id: string
  /** The workshop item's folder. */
  dir: string
  /** scene.json path inside the package / folder. */
  file: string
  /** scene.pkg / gifscene.pkg, when the scene is packaged. */
  pkg?: string
  /** Wallpaper Engine's `assets` folder (shared materials, effects, shaders). */
  assets?: string
  /** Root of Stitch's wallpaper cache (`<userData>/wallpapers`). */
  cacheDir: string
  /** User property values (project.json defaults, or a preset's). */
  properties: Record<string, unknown>
}

type Json = Record<string, unknown>

// ─── Files: package → loose folder → effect folder → Wallpaper Engine assets ───

interface Found {
  buf: Buffer
  key: string
  origin: 'pkg' | 'dir' | 'assets'
  /** Absolute path for loose files (used to key the cache by mtime). */
  abs?: string
}

class Files {
  readonly pkg?: Pkg
  private readonly lower = new Map<string, string>()

  readonly dir: string
  readonly assets: string | undefined

  constructor(dir: string, pkgPath: string | undefined, assets: string | undefined) {
    this.dir = resolvePath(dir)
    this.assets = assets ? resolvePath(assets) : undefined
    if (pkgPath) {
      this.pkg = new Pkg(pkgPath)
      for (const name of this.pkg.entries.keys()) this.lower.set(name.toLowerCase(), name)
    }
  }

  private fromPkg(path: string): Buffer | null {
    if (!this.pkg) return null
    const name = this.pkg.has(path) ? path : this.lower.get(path.toLowerCase())
    return name ? this.pkg.get(name) : null
  }

  private fromDisk(root: string, path: string): { buf: Buffer; abs: string } | null {
    const abs = join(root, ...path.split('/'))
    if (!abs.startsWith(root + sep)) return null
    try {
      if (existsSync(abs) && statSync(abs).isFile()) return { buf: readFileSync(abs), abs }
    } catch {
      /* unreadable */
    }
    return null
  }

  find(path: string, roots: string[] = []): Found | null {
    const p = posix.normalize(path.replace(/\\/g, '/')).replace(/^\/+/, '')
    if (p.startsWith('..')) return null
    const inPkg = this.fromPkg(p)
    if (inPkg) return { buf: inPkg, key: `pkg:${p}`, origin: 'pkg' }
    const loose = this.fromDisk(this.dir, p)
    if (loose) return { buf: loose.buf, key: `dir:${p}`, origin: 'dir', abs: loose.abs }
    for (const r of roots) {
      const rp = posix.join(r, p)
      const b = this.fromPkg(rp)
      if (b) return { buf: b, key: `pkg:${rp}`, origin: 'pkg' }
      if (this.assets) {
        const a = this.fromDisk(this.assets, rp)
        if (a) return { buf: a.buf, key: `assets:${rp}`, origin: 'assets', abs: a.abs }
      }
    }
    if (this.assets) {
      const a = this.fromDisk(this.assets, p)
      if (a) return { buf: a.buf, key: `assets:${p}`, origin: 'assets', abs: a.abs }
    }
    return null
  }

  text(path: string, roots: string[] = []): string | null {
    const f = this.find(path, roots)
    return f ? f.buf.toString('utf8').replace(/^﻿/, '') : null
  }

  json(path: string, roots: string[] = []): Json | null {
    const t = this.text(path, roots)
    if (t == null) return null
    try {
      return JSON.parse(t) as Json
    } catch {
      return null
    }
  }

  close(): void {
    this.pkg?.close()
  }
}

// ─── Values ──────────────────────────────────────────────────────────────────

function isObj(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Unwrap user-property bindings, scripts and animations down to a plain value. */
function resolve(v: unknown, props: Record<string, unknown>): unknown {
  if (!isObj(v)) return v
  if ('user' in v) {
    const u = v.user
    if (typeof u === 'string' && props[u] !== undefined && props[u] !== null) return props[u]
    if (isObj(u) && typeof u.name === 'string' && props[u.name] !== undefined) {
      return String(props[u.name]) === String(u.condition)
    }
  }
  if ('value' in v) return v.value
  return v
}

function num(v: unknown, props: Record<string, unknown>, fallback: number): number {
  const r = resolve(v, props)
  if (typeof r === 'number' && Number.isFinite(r)) return r
  if (typeof r === 'boolean') return r ? 1 : 0
  if (typeof r === 'string' && r.trim() !== '' && Number.isFinite(Number(r))) return Number(r)
  return fallback
}

function vec(v: unknown, props: Record<string, unknown>, fallback: number[]): number[] {
  const r = resolve(v, props)
  if (typeof r === 'number') return fallback.map(() => r)
  if (Array.isArray(r)) return fallback.map((f, i) => (typeof r[i] === 'number' ? (r[i] as number) : f))
  if (typeof r === 'string') {
    const parts = r.trim().split(/[\s,]+/).map(Number)
    if (parts.length && parts.every((n) => Number.isFinite(n))) {
      return fallback.map((f, i) => parts[i] ?? (parts.length === 1 ? parts[0] : f))
    }
  }
  return fallback
}

const v2 = (v: unknown, p: Record<string, unknown>, f: Vec2): Vec2 => vec(v, p, f) as Vec2
const v3 = (v: unknown, p: Record<string, unknown>, f: Vec3): Vec3 => vec(v, p, f) as Vec3

function bool(v: unknown, props: Record<string, unknown>, fallback: boolean): boolean {
  const r = resolve(v, props)
  if (typeof r === 'boolean') return r
  if (typeof r === 'number') return r !== 0
  if (typeof r === 'string') return r === 'true' || r === '1'
  return fallback
}

/** A shader constant: number, vector string, bool, or a binding to any of those. */
function shaderValue(v: unknown, props: Record<string, unknown>): number | number[] | undefined {
  const r = resolve(v, props)
  if (typeof r === 'number') return r
  if (typeof r === 'boolean') return r ? 1 : 0
  if (typeof r === 'string') {
    const parts = r.trim().split(/[\s,]+/).map(Number)
    if (parts.length && parts.every((n) => Number.isFinite(n))) return parts.length === 1 ? parts[0] : parts
  }
  if (Array.isArray(r) && r.every((n) => typeof n === 'number')) return r as number[]
  return undefined
}

/** Replace every `{user|value…}` wrapper inside a JSON tree (particle definitions). */
function deepResolve(v: unknown, props: Record<string, unknown>): unknown {
  if (Array.isArray(v)) return v.map((x) => deepResolve(x, props))
  if (!isObj(v)) return v
  if ('value' in v && ('user' in v || 'script' in v || 'animation' in v || Object.keys(v).length === 1)) return deepResolve(resolve(v, props), props)
  const out: Json = {}
  for (const [k, x] of Object.entries(v)) out[k] = deepResolve(x, props)
  return out
}

function animationOf(v: unknown): SceneAnimation | undefined {
  if (!isObj(v) || !isObj(v.animation)) return undefined
  const a = v.animation
  const opts = isObj(a.options) ? a.options : {}
  const channels: SceneKeyframe[][] = []
  for (let c = 0; c < 4; c++) {
    const keys = a[`c${c}`]
    if (!Array.isArray(keys)) break
    channels.push(
      keys
        .filter(isObj)
        .map((k) => {
          const key: SceneKeyframe = { frame: Number(k.frame) || 0, value: Number(k.value) || 0 }
          if (isObj(k.back) && k.back.enabled) key.back = [Number(k.back.x) || 0, Number(k.back.y) || 0]
          if (isObj(k.front) && k.front.enabled) key.front = [Number(k.front.x) || 0, Number(k.front.y) || 0]
          return key
        })
        .sort((x, y) => x.frame - y.frame)
    )
  }
  if (!channels.length || channels.every((c) => c.length < 2)) return undefined
  const mode = String(opts.mode ?? 'loop')
  return {
    channels,
    fps: Number(opts.fps) > 0 ? Number(opts.fps) : 30,
    length: Number(opts.length) > 0 ? Number(opts.length) : Math.max(1, ...channels.flat().map((k) => k.frame)),
    mode: mode === 'mirror' ? 'mirror' : mode === 'single' ? 'single' : 'loop',
    relative: !!a.relative
  }
}

// ─── Layer composite shader (our own, in Wallpaper Engine's dialect) ─────────

const LAYER_VERT = `
uniform mat4 g_ModelViewProjectionMatrix;
uniform vec4 g_Texture0Rotation;
uniform vec2 g_Texture0Translation;
attribute vec3 a_Position;
attribute vec2 a_TexCoord;
varying vec2 v_TexCoord;
#if BLENDMODE
varying vec3 v_ScreenCoord;
#endif
void main() {
	gl_Position = mul(vec4(a_Position, 1.0), g_ModelViewProjectionMatrix);
	v_TexCoord = g_Texture0Translation + a_TexCoord.x * g_Texture0Rotation.xy + a_TexCoord.y * g_Texture0Rotation.zw;
#if BLENDMODE
	v_ScreenCoord = gl_Position.xyw;
#endif
}
`

const LAYER_FRAG = `
#if BLENDMODE
#include "common_blending.h"
#endif
uniform sampler2D g_Texture0;
uniform vec4 g_Color4;
uniform float g_StitchFormat;
varying vec2 v_TexCoord;
#if BLENDMODE
uniform sampler2D g_Texture4;
varying vec3 v_ScreenCoord;
#endif
void main() {
	vec4 texel = texSample2D(g_Texture0, v_TexCoord);
	// RG88 is luminance + alpha, R8 is alpha only (as Wallpaper Engine samples them).
	if (g_StitchFormat > 7.5 && g_StitchFormat < 8.5) texel = texel.rrrg;
	else if (g_StitchFormat > 8.5 && g_StitchFormat < 9.5) texel = vec4(1.0, 1.0, 1.0, texel.r);
	vec4 color = texel * g_Color4;
#if BLENDMODE
	vec2 screenCoord = v_ScreenCoord.xy / v_ScreenCoord.z * vec2(0.5, 0.5) + 0.5;
	vec4 screen = texSample2D(g_Texture4, screenCoord);
	gl_FragColor = vec4(ApplyBlending(BLENDMODE, screen.rgb, color.rgb, color.a), screen.a);
#else
	gl_FragColor = color;
#endif
}
`

/** Key of the layer program for a colour blend mode (0 = plain alpha blending). */
export const layerProgramKey = (blendMode: number): string => `__layer|${blendMode}`

// ─── Compiler ────────────────────────────────────────────────────────────────

const hash = (s: string): string => createHash('sha1').update(s).digest('hex').slice(0, 20)

export function compileScene(input: CompileInput): SceneData {
  const files = new Files(input.dir, input.pkg, input.assets)
  try {
    return new Compiler(input, files).run()
  } finally {
    files.close()
  }
}

class Compiler {
  private readonly props: Record<string, unknown>
  private readonly textures: Record<string, SceneTexture> = {}
  private readonly programs: SceneData['programs'] = {}
  private readonly skipped = new Map<string, number>()
  private readonly sceneDir: string
  private readonly assetDir: string
  private width = 1920
  private height = 1080

  constructor(
    private readonly input: CompileInput,
    private readonly files: Files
  ) {
    this.props = input.properties
    this.sceneDir = join(input.cacheDir, input.id)
    this.assetDir = join(input.cacheDir, '_assets')
    mkdirSync(this.sceneDir, { recursive: true })
    mkdirSync(this.assetDir, { recursive: true })
  }

  private skip(what: string): void {
    this.skipped.set(what, (this.skipped.get(what) ?? 0) + 1)
  }

  run(): SceneData {
    const scene = this.files.json(this.input.file)
    if (!scene) throw new Error('scene.json is missing or unreadable')
    const general = isObj(scene.general) ? scene.general : {}
    const ortho = isObj(general.orthogonalprojection) ? general.orthogonalprojection : null
    if (ortho && Number(ortho.width) > 0 && Number(ortho.height) > 0) {
      this.width = Number(ortho.width)
      this.height = Number(ortho.height)
    } else if (!ortho) {
      this.skip('3D camera')
    }
    const p = this.props
    // The plain layer program also copies textures into effect buffers.
    this.layerProgram(0)
    const layers: SceneLayer[] = []
    for (const o of Array.isArray(scene.objects) ? scene.objects : []) {
      if (!isObj(o)) continue
      try {
        const layer = this.object(o)
        if (layer) layers.push(layer)
      } catch (err) {
        this.skip(`broken layer (${(err as Error).message})`)
      }
    }
    const data: SceneData = {
      format: SCENE_FORMAT,
      id: this.input.id,
      width: this.width,
      height: this.height,
      clearColor: v3(general.clearcolor, p, [0, 0, 0]),
      layers,
      textures: this.textures,
      programs: this.programs,
      skipped: [...this.skipped].map(([k, n]) => (n > 1 ? `${n} × ${k}` : k))
    }
    if (bool(general.cameraparallax, p, false)) {
      data.parallax = {
        amount: num(general.cameraparallaxamount, p, 0.5),
        delay: num(general.cameraparallaxdelay, p, 0.1),
        mouse: num(general.cameraparallaxmouseinfluence, p, 0.1)
      }
    }
    if (bool(general.camerashake, p, false)) {
      data.shake = {
        amplitude: num(general.camerashakeamplitude, p, 0.5),
        roughness: num(general.camerashakeroughness, p, 1),
        speed: num(general.camerashakespeed, p, 3)
      }
    }
    if (bool(general.bloom, p, false)) {
      data.bloom = { strength: num(general.bloomstrength, p, 2), threshold: num(general.bloomthreshold, p, 0.65) }
    }
    data.still = this.bestStill(layers)
    return data
  }

  /** The biggest real picture among the visible layers. */
  private bestStill(layers: SceneLayer[]): string | undefined {
    let best: { path: string; area: number } | undefined
    for (const l of layers) {
      if (l.kind !== 'image' || !l.texture || !l.visible) continue
      const t = this.textures[l.texture]
      if (!t || t.video || t.frames || !t.paths[0]) continue
      const area = t.width * t.height
      if (!best || area > best.area) best = { path: t.paths[0], area }
    }
    return best?.path
  }

  // ─── Objects ───────────────────────────────────────────────────────────────

  private base(o: Json): Omit<SceneLayer, 'kind' | 'size' | 'effects' | 'blending'> {
    const p = this.props
    const layer: Omit<SceneLayer, 'kind' | 'size' | 'effects' | 'blending'> = {
      id: Number(o.id) || 0,
      name: String(o.name ?? ''),
      origin: v3(o.origin, p, [this.width / 2, this.height / 2, 0]),
      scale: v3(o.scale, p, [1, 1, 1]),
      angles: v3(o.angles, p, [0, 0, 0]),
      alpha: num(o.alpha, p, 1),
      color: v3(o.color, p, [1, 1, 1]),
      brightness: num(o.brightness, p, 1),
      blendMode: num(o.colorBlendMode, p, 0),
      parallax: v2(o.parallaxDepth, p, [1, 1]),
      visible: bool(o.visible, p, true)
    }
    if (o.parent !== undefined && o.parent !== null) layer.parent = Number(o.parent)
    const anims: Partial<Record<SceneAnimated, SceneAnimation>> = {}
    for (const k of ['origin', 'scale', 'angles', 'alpha', 'color'] as SceneAnimated[]) {
      const a = animationOf(o[k])
      if (a) anims[k] = a
    }
    if (Object.keys(anims).length) layer.anims = anims
    if (isObj(o.origin) && 'script' in o.origin) this.skip('scripted layer properties')
    return layer
  }

  private object(o: Json): SceneLayer | null {
    if (o.image) return this.imageLayer(o)
    if (o.particle) return this.particleLayer(o)
    if (o.text) this.skip('text layer')
    else if (o.sound) return null
    else if (o.light) this.skip('light')
    else if (o.model) this.skip('3D model')
    // Anything else (groups, text, lights…) can still parent other layers.
    return { ...this.base(o), kind: 'group', size: [0, 0], effects: [], blending: 'translucent' }
  }

  private imageLayer(o: Json): SceneLayer | null {
    const p = this.props
    const model = this.files.json(String(o.image))
    if (!model) {
      this.skip('missing model')
      return null
    }
    if (model.puppet) this.skip('puppet animation (drawn in its rest pose)')
    const material = typeof model.material === 'string' ? this.files.json(model.material) : null
    const pass = isObj(material) && Array.isArray(material.passes) && isObj(material.passes[0]) ? (material.passes[0] as Json) : {}
    const texName = Array.isArray(pass.textures) && typeof pass.textures[0] === 'string' ? (pass.textures[0] as string) : undefined
    const base = this.base(o)
    const fullscreen = !!model.fullscreen
    const kind: SceneLayer['kind'] = model.solidlayer ? 'solid' : model.passthrough || texName?.startsWith('_rt_') || fullscreen ? 'compose' : 'image'
    let texture: string | undefined
    if (kind === 'image') {
      if (!texName) {
        this.skip('image without texture')
        return null
      }
      texture = this.texture(texName) ?? undefined
      if (!texture) {
        this.skip('missing texture')
        return null
      }
    }
    const tex = texture ? this.textures[texture] : undefined
    const frame = tex?.frames?.[0]
    const natural: Vec2 = frame ? [frame.width, frame.height] : tex ? [tex.width, tex.height] : [this.width, this.height]
    let size: Vec2 = o.size !== undefined ? v2(o.size, p, natural) : Number(model.width) > 0 && Number(model.height) > 0 ? [Number(model.width), Number(model.height)] : natural
    if (fullscreen) size = [this.width, this.height]
    // Zero-size or `solid: false` solid layers are just parents for other layers.
    if (kind === 'solid' && (size[0] <= 0 || size[1] <= 0 || o.solid === false)) {
      return { ...base, kind: 'group', size: [0, 0], effects: [], blending: 'translucent' }
    }
    if (size[0] <= 0 || size[1] <= 0) size = natural
    const layer: SceneLayer = {
      ...base,
      kind,
      texture,
      size,
      fullscreen: fullscreen || undefined,
      blending: String(pass.blending ?? 'translucent'),
      effects: []
    }
    if (fullscreen) layer.origin = [this.width / 2, this.height / 2, 0]
    // Puppet layers place their texture with a mesh, not the plain quad.
    if (kind === 'image' && typeof model.puppet === 'string') {
      const mdl = this.files.find(model.puppet)
      const mesh = mdl ? parseMdl(mdl.buf) : null
      if (mesh) layer.mesh = mesh
    }
    for (const e of Array.isArray(o.effects) ? o.effects : []) {
      if (!isObj(e)) continue
      try {
        const fx = this.effect(e)
        if (fx) layer.effects.push(fx)
      } catch (err) {
        this.skip(`effect ${String(e.file ?? '?')} (${(err as Error).message})`)
      }
    }
    // A pass-through layer without effects draws nothing.
    if (kind === 'compose' && !layer.effects.length) return { ...layer, kind: 'group' }
    // A pixel-sized placeholder blown up by a script (SceneScript visualisers): without the script it's just a block.
    const scripted = Object.values(o).some((v) => isObj(v) && 'script' in v)
    if (kind === 'image' && tex && tex.width * tex.height <= 4 && !layer.effects.length && (scripted || Math.max(Math.abs(layer.scale[0]), Math.abs(layer.scale[1])) >= 50)) {
      this.skip('script-driven layer')
      return { ...layer, kind: 'group' }
    }
    this.layerProgram(layer.blendMode)
    return layer
  }

  private layerProgram(blendMode: number): void {
    const key = layerProgramKey(blendMode)
    if (this.programs[key]) return
    const include = (name: string): string | null => this.files.text(`shaders/${name}`)
    const defines = { BLENDMODE: blendMode }
    this.programs[key] = { name: `layer (blend ${blendMode})`, vert: preprocess(LAYER_VERT, defines, include), frag: preprocess(LAYER_FRAG, defines, include) }
  }

  // ─── Effects ───────────────────────────────────────────────────────────────

  private effect(e: Json): SceneEffect | null {
    const p = this.props
    if (!bool(e.visible, p, true)) return null
    const file = String(e.file ?? '')
    const def = this.files.json(file)
    if (!def) {
      this.skip(`missing effect ${file}`)
      return null
    }
    const root = posix.dirname(file.replace(/\\/g, '/'))
    const overrides = Array.isArray(e.passes) ? e.passes : []
    const passes: ScenePass[] = []
    const defPasses = Array.isArray(def.passes) ? def.passes : []
    let materialIndex = 0
    for (const dp of defPasses) {
      if (!isObj(dp)) continue
      if (typeof dp.command === 'string') {
        passes.push({ command: dp.command === 'swap' ? 'swap' : 'copy', source: String(dp.source ?? ''), target: String(dp.target ?? ''), uniforms: {}, textures: [], blending: 'normal' })
        continue
      }
      const override = isObj(overrides[materialIndex]) ? (overrides[materialIndex] as Json) : {}
      materialIndex++
      const pass = this.effectPass(dp, override, root)
      if (!pass) return null
      passes.push(pass)
    }
    if (!passes.length) return null
    const fbos = (Array.isArray(def.fbos) ? def.fbos : []).filter(isObj).map((f) => ({ name: String(f.name), scale: Math.max(1, Number(f.scale) || 1) }))
    return { name: String(e.name || def.name || file), passes, fbos }
  }

  private effectPass(dp: Json, override: Json, root: string): ScenePass | null {
    const p = this.props
    const roots = [root]
    const material = typeof dp.material === 'string' ? this.files.json(dp.material, roots) : null
    const mp = isObj(material) && Array.isArray(material.passes) && isObj(material.passes[0]) ? (material.passes[0] as Json) : null
    if (!mp || typeof mp.shader !== 'string') {
      this.skip('effect without material')
      return null
    }
    const shader = mp.shader
    const vertSrc = this.files.text(`shaders/${shader}.vert`, roots)
    const fragSrc = this.files.text(`shaders/${shader}.frag`, roots)
    if (vertSrc == null || fragSrc == null) {
      this.skip(`missing shader ${shader}`)
      return null
    }
    const include = (name: string): string | null => this.files.text(`shaders/${name}`, roots)
    // Annotations may sit in included headers too.
    const headers: string[] = []
    for (const src of [vertSrc, fragSrc]) {
      for (const m of src.matchAll(/#include\s+"([^"]+)"/g)) {
        const t = include(m[1])
        if (t) headers.push(t)
      }
    }
    const ann = parseAnnotations(vertSrc, fragSrc, ...headers)

    // Textures by slot: scene override > material > shader default.
    const oTex = Array.isArray(override.textures) ? override.textures : []
    const mTex = Array.isArray(mp.textures) ? mp.textures : []
    const combos: Record<string, number> = { ...ann.combos }
    const textures: SceneTexRef[] = []
    for (const u of ann.uniforms.values()) {
      const m = /^g_Texture(\d+)$/.exec(u.name)
      if (!m || !u.type.startsWith('sampler')) continue
      const slot = Number(m[1])
      const chosen = (typeof oTex[slot] === 'string' && oTex[slot]) || (typeof mTex[slot] === 'string' && mTex[slot]) || undefined
      const name = chosen ?? (typeof u.default === 'string' && u.default ? u.default : undefined)
      if (!name) {
        textures[slot] = null
        continue
      }
      let ref: SceneTexRef = null
      if (name.startsWith('_rt_')) ref = { rt: name }
      else {
        const key = this.texture(String(name), roots)
        if (key) ref = { tex: key }
      }
      textures[slot] = ref
      if (chosen && ref && u.combo) combos[u.combo] = 1
      // The engine tells shaders each bound texture's pixel format.
      if (ref && 'tex' in ref) combos[`TEX${slot}FORMAT`] = this.textures[ref.tex]?.format ?? 0
    }
    for (const src of [mp.combos, override.combos]) {
      if (!isObj(src)) continue
      for (const [k, v] of Object.entries(src)) combos[k] = num(v, p, 0)
    }

    // Uniform values: scene override > material constants > shader default.
    const uniforms: Record<string, number | number[]> = {}
    const oVals = isObj(override.constantshadervalues) ? override.constantshadervalues : {}
    const mVals = isObj(mp.constantshadervalues) ? mp.constantshadervalues : {}
    const lookup = (vals: Json, u: { material?: string; label?: string }): unknown => {
      for (const k of [u.material, u.label]) {
        if (k && vals[k] !== undefined) return vals[k]
      }
      if (u.material) {
        const lower = u.material.toLowerCase()
        const hit = Object.keys(vals).find((k) => k.toLowerCase() === lower)
        if (hit) return vals[hit]
      }
      return undefined
    }
    for (const u of ann.uniforms.values()) {
      if (u.type.startsWith('sampler')) continue
      if (!u.material && u.default === undefined) continue
      const raw = lookup(oVals, u) ?? lookup(mVals, u) ?? u.default
      const value = raw === undefined ? undefined : shaderValue(raw, p)
      if (value !== undefined) uniforms[u.name] = value
    }

    const key = `${root}|${shader}|${Object.entries(combos)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join(',')}`
    const programKey = hash(key)
    if (!this.programs[programKey]) {
      this.programs[programKey] = { name: shader, vert: preprocess(vertSrc, combos, include), frag: preprocess(fragSrc, combos, include) }
    }
    const program = this.programs[programKey]
    const pass: ScenePass = { program: programKey, uniforms, textures, blending: String(mp.blending ?? 'normal') }
    if (typeof dp.target === 'string') pass.target = dp.target
    if (Array.isArray(dp.bind)) pass.binds = dp.bind.filter(isObj).map((b) => ({ name: String(b.name), index: Number(b.index) || 0 }))
    // Only when the audio code survived the combos.
    if (/g_AudioSpectrum/.test(program.vert + program.frag)) pass.audio = true
    return pass
  }

  // ─── Particles ─────────────────────────────────────────────────────────────

  private particleLayer(o: Json): SceneLayer | null {
    const system = this.particles(String(o.particle), isObj(o.instanceoverride) ? o.instanceoverride : {}, 0)
    if (!system) return null
    return { ...this.base(o), kind: 'particles', size: [0, 0], effects: [], blending: system.blending, particles: system }
  }

  private particles(path: string, overrideRaw: Json, depth: number): SceneParticles | null {
    const p = this.props
    const def = this.files.json(path)
    if (!def || depth > 3) {
      this.skip('missing particle system')
      return null
    }
    const j = deepResolve(def, p) as Json
    const material = typeof j.material === 'string' ? this.files.json(j.material) : null
    const mp = isObj(material) && Array.isArray(material.passes) && isObj(material.passes[0]) ? (material.passes[0] as Json) : {}
    const texName = Array.isArray(mp.textures) && typeof mp.textures[0] === 'string' ? (mp.textures[0] as string) : undefined
    const refract = isObj(mp.combos) && num(mp.combos.REFRACT, p, 0) > 0
    const normalName = Array.isArray(mp.textures) && typeof mp.textures[1] === 'string' ? (mp.textures[1] as string) : undefined
    const consts = isObj(mp.constantshadervalues) ? mp.constantshadervalues : {}
    const overbright = num(consts.ui_editor_properties_overbright ?? consts.overbright, p, 1)
    const renderers = (Array.isArray(j.renderer) ? j.renderer : []).filter(isObj)
    if (renderers.some((r) => /rope|trail/.test(String(r.name)))) this.skip('particle trails (drawn as sprites)')
    const override: Record<string, number | number[]> = {}
    for (const [k, v] of Object.entries(overrideRaw)) {
      const value = shaderValue(v, p)
      if (value !== undefined) override[k] = value
    }
    const children: SceneParticles['children'] = []
    for (const c of Array.isArray(j.children) ? j.children : []) {
      if (!isObj(c) || typeof c.name !== 'string') continue
      const child = this.particles(c.name, {}, depth + 1)
      if (!child) continue
      children.push({
        system: child,
        origin: c.origin !== undefined ? v3(c.origin, p, [0, 0, 0]) : undefined,
        scale: c.scale !== undefined ? v3(c.scale, p, [1, 1, 1]) : undefined,
        angles: c.angles !== undefined ? v3(c.angles, p, [0, 0, 0]) : undefined
      })
    }
    return {
      texture: texName ? (this.texture(texName) ?? undefined) : undefined,
      refract: refract ? { normal: normalName ? (this.texture(normalName) ?? undefined) : undefined } : undefined,
      overbright: overbright !== 1 ? overbright : undefined,
      blending: String(mp.blending ?? 'translucent'),
      animationMode: typeof j.animationmode === 'string' ? j.animationmode : undefined,
      sequenceMultiplier: Number(j.sequencemultiplier) || undefined,
      maxCount: Math.min(4000, Number(j.maxcount) || 100),
      startTime: Number(j.starttime) || 0,
      emitters: (Array.isArray(j.emitter) ? j.emitter : []).filter(isObj),
      initializers: (Array.isArray(j.initializer) ? j.initializer : []).filter(isObj),
      operators: (Array.isArray(j.operator) ? j.operator : []).filter(isObj),
      renderers,
      override,
      children
    }
  }

  // ─── Textures ──────────────────────────────────────────────────────────────

  /** Extract a material texture by name ("masks/foo", "util/white") and return its key. */
  private texture(name: string, roots: string[] = []): string | null {
    const clean = name.replace(/\\/g, '/').replace(/\.tex$/i, '')
    const found = this.files.find(`materials/${clean}.tex`, roots)
    if (found) return this.fromTex(found)
    // Plain images referenced directly.
    for (const ext of ['', '.png', '.jpg', '.jpeg', '.gif', '.webp']) {
      const f = this.files.find(`materials/${clean}${ext}`, roots) ?? (ext ? null : this.files.find(clean, roots))
      if (f && /\.(png|jpe?g|gif|webp)$/i.test(f.key)) return this.fromImage(f)
    }
    return null
  }

  private outFile(found: Found, suffix: string): string {
    // Wallpaper Engine's own assets are shared by every scene; key them by file version.
    let stamp = ''
    if (found.abs) {
      try {
        const st = statSync(found.abs)
        stamp = `${st.size}|${st.mtimeMs}`
      } catch {
        /* ignore */
      }
    }
    const dir = found.origin === 'assets' ? this.assetDir : this.sceneDir
    return join(dir, `${hash(found.key + stamp)}${suffix}`)
  }

  private fromImage(found: Found): string {
    if (this.textures[found.key]) return found.key
    const ext = /\.(\w+)$/.exec(found.key)?.[1]?.toLowerCase() ?? 'png'
    const out = this.outFile(found, `.${ext}`)
    if (!existsSync(out)) writeFileSync(out, found.buf)
    const size = imageSize(found.buf) ?? { width: 1, height: 1 }
    this.textures[found.key] = { paths: [out], width: size.width, height: size.height }
    return found.key
  }

  private fromTex(found: Found): string | null {
    if (this.textures[found.key]) return found.key
    let info
    try {
      info = parseTex(found.buf)
    } catch (err) {
      this.skip(`unreadable texture (${(err as Error).message})`)
      return null
    }
    const paths: string[] = []
    let width = info.width
    let height = info.height
    let video = false
    for (let i = 0; i < info.images.length; i++) {
      // Cheap existence check first: cached images skip decoding entirely.
      const guess = ['png', 'jpg', 'gif', 'webp', 'bmp', 'mp4'].map((e) => this.outFile(found, `_${i}.${e}`))
      const cached = guess.find((g) => existsSync(g))
      if (cached) {
        paths.push(cached)
        video ||= cached.endsWith('.mp4')
        const dims = cached.endsWith('.mp4') ? null : imageSize(readHead(cached))
        if (dims && i === 0) {
          width = dims.width
          height = dims.height
        }
        continue
      }
      try {
        const img = decodeTex(info, i)
        const out = this.outFile(found, `_${i}.${img.kind === 'file' ? img.ext : 'png'}`)
        writeFileSync(out, img.kind === 'file' ? img.data : encodePng(img.width, img.height, img.channels, img.data))
        paths.push(out)
        if (img.kind === 'file' && img.ext === 'mp4') video = true
        if (i === 0) {
          const dims = img.kind === 'file' && img.ext !== 'mp4' ? imageSize(Buffer.from(img.data.buffer, img.data.byteOffset, Math.min(img.data.length, 1 << 16))) : null
          width = dims?.width ?? img.width
          height = dims?.height ?? img.height
        }
      } catch (err) {
        this.skip(`undecodable texture (${(err as Error).message})`)
        return null
      }
    }
    if (!paths.length) return null
    const tex: SceneTexture = { paths, width: Math.max(1, width), height: Math.max(1, height), format: info.imageFormat >= 0 || video ? 0 : info.format }
    if (info.flags & TEXF_NEAREST) tex.nearest = true
    if (info.flags & TEXF_CLAMP) tex.clamp = true
    if (video) tex.video = true
    if (info.frames?.length && !video) tex.frames = info.frames
    this.textures[found.key] = tex
    return found.key
  }
}

function readHead(path: string): Buffer {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const b = Buffer.alloc(1 << 16)
    return b.subarray(0, readSync(fd, b, 0, b.length, 0))
  } catch {
    return Buffer.alloc(0)
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** Width/height of a PNG, JPEG, GIF, WebP or BMP from its header. */
export function imageSize(b: Buffer): { width: number; height: number } | null {
  if (b.length < 24) return null
  if (b[0] === 0x89 && b[1] === 0x50) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
  if (b[0] === 0x47 && b[1] === 0x49) return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) }
  if (b[0] === 0x42 && b[1] === 0x4d) return { width: b.readInt32LE(18), height: Math.abs(b.readInt32LE(22)) }
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    const kind = b.toString('latin1', 12, 16)
    if (kind === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) }
    if (kind === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff }
    if (kind === 'VP8L') {
      const bits = b.readUInt32LE(21)
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
    }
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let o = 2
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) {
        o++
        continue
      }
      const marker = b[o + 1]
      const len = b.readUInt16BE(o + 2)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: b.readUInt16BE(o + 7), height: b.readUInt16BE(o + 5) }
      }
      o += 2 + len
    }
  }
  return null
}
