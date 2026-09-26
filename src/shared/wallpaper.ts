// Wallpaper Engine: extracted scene descriptions (main → renderer) and Steam
// Workshop browsing. Scenes are compiled in the main process from scene.pkg
// (or loose files) plus the user's own Wallpaper Engine assets; the renderer
// draws them with WebGL at the display's full resolution.

export type Vec2 = [number, number]
export type Vec3 = [number, number, number]

/** Bump when the scene compiler's output changes shape (invalidates caches). */
export const SCENE_FORMAT = 10

export interface SceneTexture {
  /** Extracted file(s): one per sheet for sprite-sheet animations, an .mp4 for video textures. */
  paths: string[]
  /** Pixel size of each image (sheets and stills alike). */
  width: number
  height: number
  /** Wallpaper Engine pixel format (0 RGBA, 4/6/7 DXT, 8 RG88 = luminance+alpha, 9 R8 = alpha). */
  format?: number
  /** Author asked for pixel-exact sampling (pixel art). */
  nearest?: boolean
  /** Clamp instead of repeat at the edges. */
  clamp?: boolean
  video?: boolean
  /** Sprite-sheet frames in image pixels. */
  frames?: { image: number; seconds: number; x: number; y: number; width: number; height: number }[]
}

/** A texture slot: an extracted texture, a render target (`_rt_*`), or unbound (slot 0 = the pass input). */
export type SceneTexRef = { tex: string } | { rt: string } | null

/** A Wallpaper Engine shader after includes and combos were resolved (still in WE's GLSL dialect). */
export interface SceneProgram {
  vert: string
  frag: string
  /** Where it came from, for diagnostics. */
  name: string
}

export interface ScenePass {
  /** Key into `SceneData.programs`; absent for `command` passes. */
  program?: string
  /** Material values by uniform name (numbers or vectors). */
  uniforms: Record<string, number | number[]>
  textures: SceneTexRef[]
  blending: string
  /** Named effect buffer to draw into (default: the layer's next ping-pong buffer). */
  target?: string
  /** Buffers bound to texture slots (`previous` = the layer so far). */
  binds?: { name: string; index: number }[]
  /** Buffer operations between passes. */
  command?: 'copy' | 'swap'
  source?: string
  /** Reads the audio spectrum uniforms. */
  audio?: boolean
}

export interface SceneEffect {
  name: string
  passes: ScenePass[]
  /** Extra buffers, `scale` = divisor of the layer buffer size. */
  fbos: { name: string; scale: number }[]
}

export interface SceneKeyframe {
  frame: number
  value: number
  /** Bezier handles relative to the key (frames, value) when enabled. */
  back?: Vec2
  front?: Vec2
}

/** A keyframe animation on a layer property (Wallpaper Engine timeline). */
export interface SceneAnimation {
  /** One channel per component (x, y, z) or a single channel for scalars. */
  channels: SceneKeyframe[][]
  fps: number
  /** Length in frames. */
  length: number
  mode: 'loop' | 'mirror' | 'single'
  /** Values are added to the base value instead of replacing it. */
  relative: boolean
}

export type SceneAnimated = 'origin' | 'scale' | 'angles' | 'alpha' | 'color'

/** One particle system (and its children), close to Wallpaper Engine's own JSON. */
export interface SceneParticles {
  texture?: string
  blending: string
  /** Frame selection for sprite-sheet particles. */
  animationMode?: string
  sequenceMultiplier?: number
  maxCount: number
  startTime: number
  emitters: Record<string, unknown>[]
  initializers: Record<string, unknown>[]
  operators: Record<string, unknown>[]
  renderers: Record<string, unknown>[]
  /** Per-instance multipliers set in the scene (count, rate, size, speed, lifetime, alpha, color…). */
  override: Record<string, number | number[]>
  children: { system: SceneParticles; origin?: Vec3; scale?: Vec3; angles?: Vec3 }[]
  /** Refracting particles (rain on glass): the background seen through a normal map. */
  refract?: { normal?: string }
  /** Colour multiplier from the material. */
  overbright?: number
}

export interface SceneLayer {
  id: number
  name: string
  /**
   * image    — a texture (with effects)
   * solid    — a flat colour rectangle (with effects)
   * compose  — applies its effects to whatever is behind it
   * particles — a particle system
   * group    — invisible; only moves its children
   */
  kind: 'image' | 'solid' | 'compose' | 'particles' | 'group'
  texture?: string
  origin: Vec3
  scale: Vec3
  angles: Vec3
  size: Vec2
  alpha: number
  color: Vec3
  brightness: number
  /** Photoshop-style colour blend mode (0 = normal). */
  blendMode: number
  /** GPU blending of the final draw: translucent, additive, normal… */
  blending: string
  parallax: Vec2
  parent?: number
  visible: boolean
  /** Covers the whole scene regardless of size/origin. */
  fullscreen?: boolean
  effects: SceneEffect[]
  anims?: Partial<Record<SceneAnimated, SceneAnimation>>
  particles?: SceneParticles
  /** Puppet mesh in its rest pose: x,y pairs (layer units, y up), u,v pairs, triangle indices. */
  mesh?: { positions: number[]; uvs: number[]; indices: number[] }
}

export interface SceneData {
  format: number
  id: string
  /** Orthographic projection size in scene units (bottom-left origin, y up). */
  width: number
  height: number
  clearColor: Vec3
  parallax?: { amount: number; delay: number; mouse: number }
  shake?: { amplitude: number; roughness: number; speed: number }
  bloom?: { strength: number; threshold: number }
  layers: SceneLayer[]
  textures: Record<string, SceneTexture>
  programs: Record<string, SceneProgram>
  /** Largest real still in the scene — accent colours and the fallback when WebGL can't draw it. */
  still?: string
  /** Features present in the scene that Stitch doesn't draw (yet), for diagnostics. */
  skipped: string[]
}

// ─── Steam Workshop ──────────────────────────────────────────────────────────

export type WorkshopSort = 'relevance' | 'trend' | 'popular' | 'recent'
export type WorkshopType = 'all' | 'scene' | 'video' | 'web'
/** everyone = hide Mature and Questionable; questionable = hide Mature; all = show everything. */
export type WorkshopRating = 'everyone' | 'questionable' | 'all'

export interface WorkshopQuery {
  text?: string
  sort: WorkshopSort
  type: WorkshopType
  rating: WorkshopRating
  page: number
}

export interface WorkshopItem {
  id: string
  title: string
  /** Full-size preview (an animated GIF for most animated wallpapers). */
  preview: string
  /** Small still for grids, when the CDN can resize the preview. */
  thumb?: string
  author?: string
  authorId?: string
  subscriptions: number
  favorited?: number
  type?: 'scene' | 'video' | 'web' | 'application'
  rating: 'Everyone' | 'Questionable' | 'Mature' | string
  tags: string[]
  fileSize?: number
  updated?: number
  description?: string
  /** Already downloaded into the local workshop folder. */
  installed: boolean
}

export interface WorkshopPage {
  items: WorkshopItem[]
  page: number
  totalPages: number
  total: number
}

export interface WorkshopEnvironment {
  steam: boolean
  wallpaperEngine: boolean
  workshopDir?: string
}

/** Progress of a Steam subscription we're waiting on. */
export interface WorkshopDownload {
  id: string
  state: 'waiting' | 'downloading' | 'ready'
  /** Title of the wallpaper once it's on disk. */
  title?: string
}
