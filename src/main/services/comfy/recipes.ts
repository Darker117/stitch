// Built-in generation recipes. Each recipe turns a flat parameter object into a
// ComfyUI API graph. Media params arrive already uploaded (ComfyUI input names).
import type { GenKind, ParamSpec } from '@shared/types'
import { dims, Graph, h3Frames, out, randomSeed } from './graph'

export interface Requirement {
  folder: string
  label: string
  /** Exact file name… */
  name?: string
  /** …or any file matching this pattern. */
  match?: RegExp
  optional?: boolean
}

export type Models = Record<string, string[]>
export type Params = Record<string, unknown>

export interface RecipeDef {
  id: string
  name: string
  kind: GenKind
  mode: string
  family: string
  /** Regex (source) for compatible Civitai base models, used to filter model & LoRA pickers. */
  baseModelMatch?: string
  description: string
  estSeconds: number
  params: ParamSpec[]
  requires: Requirement[]
  build(p: Params, models: Models): Graph
}

// ─── helpers ─────────────────────────────────────────────────────────────────

const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d)
const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v)) ? Number(v) : d)
const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x) : typeof v === 'string' && v ? [v] : [])
const seedOf = (v: unknown): number => {
  const n = num(v, -1)
  return n < 0 ? randomSeed() : Math.floor(n)
}

/** Choose a model file: the explicit param, else the first file matching preferences. */
function pick(models: Models, folder: string, explicit: unknown, prefer: RegExp[], fallback: string): string {
  const available = models[folder] ?? []
  const e = str(explicit)
  if (e && (available.includes(e) || !available.length)) return e
  for (const re of prefer) {
    const hit = available.find((m) => re.test(m))
    if (hit) return hit
  }
  return fallback
}

const ASPECT_OPTIONS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9'].map((v) => ({ value: v, label: v }))

const P = {
  prompt: (help?: string): ParamSpec => ({ key: 'prompt', label: 'Prompt', type: 'prompt', required: true, help }),
  negative: (d = ''): ParamSpec => ({ key: 'negative', label: 'Negative prompt', type: 'text', default: d, advanced: true }),
  aspect: (d = '1:1'): ParamSpec => ({ key: 'aspect', label: 'Aspect ratio', type: 'aspect', default: d, options: ASPECT_OPTIONS }),
  quality: (d: number, opts: { value: string; label: string }[]): ParamSpec => ({ key: 'quality', label: 'Quality', type: 'select', default: String(d), options: opts }),
  seed: (): ParamSpec => ({ key: 'seed', label: 'Seed', type: 'seed', default: -1, advanced: true, help: '-1 picks a random seed' }),
  steps: (d: number, max = 80): ParamSpec => ({ key: 'steps', label: 'Steps', type: 'int', default: d, min: 1, max, advanced: true }),
  cfg: (d: number): ParamSpec => ({ key: 'cfg', label: 'Guidance (CFG)', type: 'number', default: d, min: 0, max: 20, step: 0.1, advanced: true }),
  model: (folder: string, label = 'Model', help?: string): ParamSpec => ({ key: 'model', label, type: 'model', folder, help }),
  loras: (): ParamSpec => ({ key: 'loras', label: 'LoRAs', type: 'loras', folder: 'loras', default: [], help: 'Stack as many as you like; activation words can be added to the prompt.' })
}

const IMAGE_QUALITY = [
  { value: '0.6', label: 'Draft · 0.6 MP' },
  { value: '1', label: 'Standard · 1 MP' },
  { value: '1.5', label: 'High · 1.5 MP' },
  { value: '2.2', label: 'Ultra · 2.2 MP' }
]

function saveImage(g: Graph, image: [string, number], prefix: string): void {
  g.add('SaveImage', { images: image, filename_prefix: `stitch/${prefix}` })
}

/** The LoRA stack from params (`loras: LoraRef[]`, or the older single `lora`). */
function loraStack(p: Params): { name: string; strength: number }[] {
  const out: { name: string; strength: number }[] = []
  if (Array.isArray(p.loras)) {
    for (const l of p.loras as { name?: unknown; strength?: unknown; enabled?: unknown }[]) {
      if (l && typeof l.name === 'string' && l.name && l.enabled !== false) out.push({ name: l.name, strength: num(l.strength, 0.8) })
    }
  }
  if (str(p.lora)) out.push({ name: str(p.lora), strength: num(p.loraStrength, 0.8) })
  return out
}

/** Chain every LoRA in the stack onto a MODEL link. */
function withLora(g: Graph, model: [string, number], p: Params): [string, number] {
  let m = model
  for (const l of loraStack(p)) {
    if (l.strength === 0) continue
    m = out(g.add('LoraLoaderModelOnly', { model: m, lora_name: l.name, strength_model: l.strength }))
  }
  return m
}

// ─── Image recipes ───────────────────────────────────────────────────────────

const krea2: RecipeDef = {
  id: 'krea2-t2i',
  name: 'Krea 2 Turbo',
  kind: 'image',
  mode: 'text',
  family: 'Krea 2',
  baseModelMatch: 'krea',
  description: 'Fast, aesthetic text-to-image in 8 steps. Great default for scenes and portraits.',
  estSeconds: 12,
  params: [P.prompt(), P.aspect('3:4'), P.quality(1, IMAGE_QUALITY), P.model('diffusion_models'), P.loras(), P.steps(8), P.cfg(1), P.seed()],
  requires: [
    { folder: 'diffusion_models', label: 'Krea 2 model', match: /krea/i },
    { folder: 'text_encoders', label: 'Qwen3-VL 4B encoder', name: 'qwen3vl_4b_fp8_scaled.safetensors' },
    { folder: 'vae', label: 'Qwen Image VAE', name: 'qwen_image_vae.safetensors' }
  ],
  build(p, m) {
    const g = new Graph()
    const unet = g.add('UNETLoader', { unet_name: pick(m, 'diffusion_models', p.model, [/krea2.*turbo/i, /krea/i], 'krea2_turbo_int8_convrot.safetensors'), weight_dtype: 'default' })
    const model = withLora(g, out(unet), p)
    const clip = g.add('CLIPLoader', { clip_name: 'qwen3vl_4b_fp8_scaled.safetensors', type: 'krea2', device: 'default' })
    const vae = g.add('VAELoader', { vae_name: 'qwen_image_vae.safetensors' })
    const pos = g.add('CLIPTextEncode', { clip: out(clip), text: str(p.prompt) })
    const neg = g.add('ConditioningZeroOut', { conditioning: out(pos) })
    const { width, height } = dims(str(p.aspect, '1:1'), num(p.quality, 1), 16)
    const latent = g.add('EmptyLatentImage', { width, height, batch_size: 1 })
    const s = g.add('KSampler', {
      model, positive: out(pos), negative: out(neg), latent_image: out(latent),
      seed: seedOf(p.seed), steps: num(p.steps, 8), cfg: num(p.cfg, 1), sampler_name: 'euler', scheduler: 'simple', denoise: 1
    })
    const img = g.add('VAEDecode', { samples: out(s), vae: out(vae) })
    saveImage(g, out(img), 'krea2')
    return g
  }
}

const qwenT2i: RecipeDef = {
  id: 'qwen21-t2i',
  name: 'Qwen Image 2.1',
  kind: 'image',
  mode: 'text',
  family: 'Qwen Image',
  baseModelMatch: 'qwen',
  description: 'Precise prompt following and crisp text rendering, native up to 2K.',
  estSeconds: 45,
  params: [P.prompt(), P.negative(), P.aspect('1:1'), P.quality(1, IMAGE_QUALITY), P.model('diffusion_models'), P.loras(), P.steps(25), P.cfg(1), P.seed()],
  requires: [
    { folder: 'diffusion_models', label: 'Qwen Image 2.1', match: /qwen_image_2\.1/i },
    { folder: 'text_encoders', label: 'Qwen3-VL 8B encoder', name: 'qwen3vl_8b_int8_convrot.safetensors' },
    { folder: 'vae', label: 'Qwen Image 2.1 VAE', name: 'qwen_image_2.1_vae_bf16.safetensors' }
  ],
  build(p, m) {
    const g = new Graph()
    const unet = g.add('UNETLoader', { unet_name: pick(m, 'diffusion_models', p.model, [/qwen_image_2\.1/i], 'qwen_image_2.1_int8_convrot.safetensors'), weight_dtype: 'default' })
    const clip = g.add('CLIPLoader', { clip_name: 'qwen3vl_8b_int8_convrot.safetensors', type: 'qwen_image', device: 'default' })
    const vae = g.add('VAELoader', { vae_name: 'qwen_image_2.1_vae_bf16.safetensors' })
    const enc = g.add('TextEncodeQwenImage21', { clip: out(clip), prompt: str(p.prompt), negative_prompt: str(p.negative), resolution: 1024 })
    const { width, height } = dims(str(p.aspect, '1:1'), num(p.quality, 1), 32)
    const latent = g.add('EmptyLatentImage', { width, height, batch_size: 1 })
    const s = g.add('KSampler', {
      model: withLora(g, out(unet), p), positive: out(enc, 0), negative: out(enc, 1), latent_image: out(latent),
      seed: seedOf(p.seed), steps: num(p.steps, 25), cfg: num(p.cfg, 1), sampler_name: 'euler', scheduler: 'simple', denoise: 1
    })
    const img = g.add('VAEDecode', { samples: out(s), vae: out(vae) })
    saveImage(g, out(img), 'qwen21')
    return g
  }
}

const qwenEdit: RecipeDef = {
  id: 'qwen21-edit',
  name: 'Qwen Image 2.1 Edit',
  kind: 'image',
  mode: 'reference',
  family: 'Qwen Image',
  baseModelMatch: 'qwen',
  description: 'Edit or re-stage images with up to 10 references. Refer to them as <image1>, <image2>… Best for character-consistent shots.',
  estSeconds: 55,
  params: [
    P.prompt('Refer to references as <image1>, <image2>, …'),
    { key: 'images', label: 'Reference images', type: 'images', maxItems: 10, required: true },
    P.negative(),
    { key: 'sizeFrom', label: 'Output size', type: 'select', default: 'aspect', options: [{ value: 'aspect', label: 'Use aspect ratio' }, { value: 'reference', label: 'Match first reference' }] },
    P.aspect('3:4'),
    P.quality(1, IMAGE_QUALITY),
    P.model('diffusion_models'),
    P.loras(),
    P.steps(25),
    P.cfg(1),
    P.seed()
  ],
  requires: qwenT2i.requires,
  build(p, m) {
    const g = new Graph()
    const unet = g.add('UNETLoader', { unet_name: pick(m, 'diffusion_models', p.model, [/qwen_image_2\.1/i], 'qwen_image_2.1_int8_convrot.safetensors'), weight_dtype: 'default' })
    const cached = g.add('QwenImage21Cache', { model: withLora(g, out(unet), p), device: 'auto', dtype: 'default' })
    const clip = g.add('CLIPLoader', { clip_name: 'qwen3vl_8b_int8_convrot.safetensors', type: 'qwen_image', device: 'default' })
    const vae = g.add('VAELoader', { vae_name: 'qwen_image_2.1_vae_bf16.safetensors' })
    const inputs: Record<string, unknown> = { clip: out(clip), vae: out(vae), prompt: str(p.prompt), negative_prompt: str(p.negative), resolution: 1024 }
    list(p.images).slice(0, 10).forEach((name, i) => {
      inputs[`images.image_${i + 1}`] = out(g.add('LoadImage', { image: name }))
    })
    const enc = g.add('TextEncodeQwenImage21', inputs)
    let latent: [string, number]
    if (str(p.sizeFrom) === 'reference') latent = out(enc, 2)
    else {
      const { width, height } = dims(str(p.aspect, '1:1'), num(p.quality, 1), 32)
      latent = out(g.add('EmptyLatentImage', { width, height, batch_size: 1 }))
    }
    const s = g.add('KSampler', {
      model: out(cached), positive: out(enc, 0), negative: out(enc, 1), latent_image: latent,
      seed: seedOf(p.seed), steps: num(p.steps, 25), cfg: num(p.cfg, 1), sampler_name: 'euler', scheduler: 'simple', denoise: 1
    })
    const img = g.add('VAEDecode', { samples: out(s), vae: out(vae) })
    saveImage(g, out(img), 'qwen21-edit')
    return g
  }
}

const klein: RecipeDef = {
  id: 'flux2-klein',
  name: 'Flux 2 Klein',
  kind: 'image',
  mode: 'reference',
  family: 'Flux 2',
  baseModelMatch: 'flux\.2|klein',
  description: 'Sub-10-second generation and editing in 4 steps. Add references to edit or keep a character on-model.',
  estSeconds: 8,
  params: [
    P.prompt('With references: “put image1 character in a rainy alley at night”'),
    { key: 'images', label: 'References (optional)', type: 'images', maxItems: 4 },
    P.aspect('3:4'),
    P.quality(1, IMAGE_QUALITY),
    P.model('diffusion_models'),
    P.loras(),
    P.steps(4, 40),
    P.seed()
  ],
  requires: [
    { folder: 'diffusion_models', label: 'Flux 2 Klein', match: /klein/i },
    { folder: 'text_encoders', label: 'Qwen3 4B encoder', name: 'qwen_3_4b.safetensors' },
    { folder: 'vae', label: 'Flux 2 VAE', name: 'flux2-vae.safetensors' }
  ],
  build(p, m) {
    const g = new Graph()
    const unet = g.add('UNETLoader', { unet_name: pick(m, 'diffusion_models', p.model, [/klein/i], 'flux-2-klein-4b.safetensors'), weight_dtype: 'default' })
    const model = withLora(g, out(unet), p)
    const clip = g.add('CLIPLoader', { clip_name: 'qwen_3_4b.safetensors', type: 'flux2', device: 'default' })
    const vae = g.add('VAELoader', { vae_name: 'flux2-vae.safetensors' })
    const text = g.add('CLIPTextEncode', { clip: out(clip), text: str(p.prompt) })
    let pos: [string, number] = out(text)
    let neg: [string, number] = out(g.add('ConditioningZeroOut', { conditioning: out(text) }))
    for (const name of list(p.images).slice(0, 4)) {
      const img = g.add('LoadImage', { image: name })
      const scaled = g.add('ImageScaleToTotalPixels', { image: out(img), upscale_method: 'nearest-exact', megapixels: 1, resolution_steps: 1 })
      const lat = g.add('VAEEncode', { pixels: out(scaled), vae: out(vae) })
      pos = out(g.add('ReferenceLatent', { conditioning: pos, latent: out(lat) }))
      neg = out(g.add('ReferenceLatent', { conditioning: neg, latent: out(lat) }))
    }
    const { width, height } = dims(str(p.aspect, '1:1'), num(p.quality, 1), 16)
    const latent = g.add('EmptyFlux2LatentImage', { width, height, batch_size: 1 })
    const sigmas = g.add('Flux2Scheduler', { steps: num(p.steps, 4), width, height })
    const guider = g.add('CFGGuider', { model, positive: pos, negative: neg, cfg: 1 })
    const sampler = g.add('KSamplerSelect', { sampler_name: 'euler' })
    const noise = g.add('RandomNoise', { noise_seed: seedOf(p.seed) })
    const s = g.add('SamplerCustomAdvanced', { noise: out(noise), guider: out(guider), sampler: out(sampler), sigmas: out(sigmas), latent_image: out(latent) })
    const img = g.add('VAEDecode', { samples: out(s), vae: out(vae) })
    saveImage(g, out(img), 'flux2-klein')
    return g
  }
}

const kontext: RecipeDef = {
  id: 'flux-kontext',
  name: 'Flux Kontext',
  kind: 'image',
  mode: 'image-edit',
  family: 'Flux 1',
  baseModelMatch: 'kontext|flux\.1',
  description: 'Instruction-based editing that keeps characters and style intact. One or two input images.',
  estSeconds: 40,
  params: [
    P.prompt('“Change the jacket to red leather, keep everything else”'),
    { key: 'images', label: 'Input images', type: 'images', maxItems: 2, required: true },
    P.model('diffusion_models'),
    P.loras(),
    { key: 'guidance', label: 'Guidance', type: 'number', default: 2.5, min: 1, max: 6, step: 0.1, advanced: true },
    P.steps(20),
    P.seed()
  ],
  requires: [
    { folder: 'diffusion_models', label: 'Flux Kontext dev', match: /kontext/i },
    { folder: 'text_encoders', label: 'CLIP-L', name: 'clip_l.safetensors' },
    { folder: 'text_encoders', label: 'T5-XXL', match: /t5xxl/i },
    { folder: 'vae', label: 'Flux VAE (ae)', name: 'ae.safetensors' }
  ],
  build(p, m) {
    const g = new Graph()
    const unet = g.add('UNETLoader', { unet_name: pick(m, 'diffusion_models', p.model, [/kontext/i], 'flux1-dev-kontext_fp8_scaled.safetensors'), weight_dtype: 'default' })
    const clip = g.add('DualCLIPLoader', { clip_name1: 'clip_l.safetensors', clip_name2: pick(m, 'text_encoders', undefined, [/t5xxl/i], 't5xxl_fp8_e4m3fn_scaled.safetensors'), type: 'flux', device: 'default' })
    const vae = g.add('VAELoader', { vae_name: 'ae.safetensors' })
    const imgs = list(p.images)
    const a = g.add('LoadImage', { image: imgs[0] })
    let src: [string, number] = out(a)
    if (imgs[1]) {
      const b = g.add('LoadImage', { image: imgs[1] })
      src = out(g.add('ImageStitch', { image1: out(a), image2: out(b), direction: 'right', match_image_size: true, spacing_width: 0, spacing_color: 'white' }))
    }
    const scaled = g.add('FluxKontextImageScale', { image: src })
    const lat = g.add('VAEEncode', { pixels: out(scaled), vae: out(vae) })
    const text = g.add('CLIPTextEncode', { clip: out(clip), text: str(p.prompt) })
    const ref = g.add('ReferenceLatent', { conditioning: out(text), latent: out(lat) })
    const pos = g.add('FluxGuidance', { conditioning: out(ref), guidance: num(p.guidance, 2.5) })
    const neg = g.add('ConditioningZeroOut', { conditioning: out(text) })
    const s = g.add('KSampler', {
      model: withLora(g, out(unet), p), positive: out(pos), negative: out(neg), latent_image: out(lat),
      seed: seedOf(p.seed), steps: num(p.steps, 20), cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1
    })
    const img = g.add('VAEDecode', { samples: out(s), vae: out(vae) })
    saveImage(g, out(img), 'kontext')
    return g
  }
}

const anima: RecipeDef = {
  id: 'anima-t2i',
  name: 'Anima',
  kind: 'image',
  mode: 'text',
  family: 'Anima',
  baseModelMatch: 'anima',
  description: 'Anime and illustration specialist. Tag-style or natural prompts both work.',
  estSeconds: 25,
  params: [
    P.prompt(),
    P.negative('worst quality, low quality, score_1, score_2, score_3, blurry, jpeg artifacts, sepia'),
    P.aspect('3:4'),
    P.quality(1, IMAGE_QUALITY),
    P.model('diffusion_models'),
    { key: 'turbo', label: 'Turbo LoRA (8 steps)', type: 'bool', default: false, advanced: true },
    P.loras(),
    P.steps(30),
    P.cfg(4),
    P.seed()
  ],
  requires: [
    { folder: 'diffusion_models', label: 'Anima model', match: /anima/i },
    { folder: 'text_encoders', label: 'Qwen3 0.6B encoder', name: 'qwen_3_06b_base.safetensors' },
    { folder: 'vae', label: 'Qwen Image VAE', name: 'qwen_image_vae.safetensors' }
  ],
  build(p, m) {
    const g = new Graph()
    const unetName = pick(m, 'diffusion_models', p.model, [/^anima-base/i, /anima/i], 'anima-base-v1.0.safetensors')
    const unet = g.add('UNETLoader', { unet_name: unetName, weight_dtype: 'default' })
    let model: [string, number] = out(unet)
    const turbo = p.turbo === true && (m.loras ?? []).some((l) => /anima-turbo/i.test(l))
    if (turbo) {
      const tl = (m.loras ?? []).find((l) => /anima-turbo/i.test(l))!
      model = out(g.add('LoraLoaderModelOnly', { model, lora_name: tl, strength_model: 1 }))
    }
    model = withLora(g, model, p)
    // Fine-tunes that ship their own text encoder (e.g. waiANIMA) pair with it.
    const pairedTe = (m.text_encoders ?? []).find((t) => t.replace(/_txt\.safetensors$/, '') === unetName.replace(/\.safetensors$/, ''))
    const clip = g.add('CLIPLoader', { clip_name: pairedTe ?? 'qwen_3_06b_base.safetensors', type: 'stable_diffusion', device: 'default' })
    const vae = g.add('VAELoader', { vae_name: 'qwen_image_vae.safetensors' })
    const pos = g.add('CLIPTextEncode', { clip: out(clip), text: str(p.prompt) })
    const neg = g.add('CLIPTextEncode', { clip: out(clip), text: str(p.negative) })
    const { width, height } = dims(str(p.aspect, '1:1'), num(p.quality, 1), 16)
    const latent = g.add('EmptyLatentImage', { width, height, batch_size: 1 })
    const s = g.add('KSampler', {
      model, positive: out(pos), negative: out(neg), latent_image: out(latent),
      seed: seedOf(p.seed), steps: turbo ? 8 : num(p.steps, 30), cfg: turbo ? 1 : num(p.cfg, 4), sampler_name: 'euler', scheduler: 'simple', denoise: 1
    })
    const img = g.add('VAEDecode', { samples: out(s), vae: out(vae) })
    saveImage(g, out(img), 'anima')
    return g
  }
}

const sdxl: RecipeDef = {
  id: 'sdxl-checkpoint',
  name: 'SDXL / Illustrious',
  kind: 'image',
  mode: 'text',
  family: 'SDXL',
  baseModelMatch: 'sdxl|pony|illustrious|noob',
  description: 'Classic checkpoint pipeline for SDXL, Pony and Illustrious models with LoRA support.',
  estSeconds: 15,
  params: [
    P.prompt(),
    P.negative('lowres, bad anatomy, bad hands, worst quality, low quality, jpeg artifacts, watermark'),
    P.aspect('3:4'),
    P.quality(1, IMAGE_QUALITY.slice(0, 3)),
    { key: 'model', label: 'Checkpoint', type: 'model', folder: 'checkpoints' },
    P.loras(),
    P.steps(28),
    P.cfg(5.5),
    { key: 'sampler', label: 'Sampler', type: 'select', default: 'euler_ancestral', advanced: true, options: ['euler_ancestral', 'euler', 'dpmpp_2m', 'dpmpp_2m_sde', 'dpmpp_sde'].map((v) => ({ value: v, label: v })) },
    P.seed()
  ],
  requires: [{ folder: 'checkpoints', label: 'SDXL checkpoint', match: /./ }],
  build(p, m) {
    const g = new Graph()
    const ck = g.add('CheckpointLoaderSimple', { ckpt_name: pick(m, 'checkpoints', p.model, [/illustrious/i, /./], '') })
    let model: [string, number] = out(ck, 0)
    let clip: [string, number] = out(ck, 1)
    // SDXL LoRAs patch the text encoder too.
    for (const lr of loraStack(p)) {
      if (lr.strength === 0) continue
      const l = g.add('LoraLoader', { model, clip, lora_name: lr.name, strength_model: lr.strength, strength_clip: lr.strength })
      model = out(l, 0)
      clip = out(l, 1)
    }
    const pos = g.add('CLIPTextEncode', { clip, text: str(p.prompt) })
    const neg = g.add('CLIPTextEncode', { clip, text: str(p.negative) })
    const { width, height } = dims(str(p.aspect, '1:1'), num(p.quality, 1), 8)
    const latent = g.add('EmptyLatentImage', { width, height, batch_size: 1 })
    const s = g.add('KSampler', {
      model, positive: out(pos), negative: out(neg), latent_image: out(latent),
      seed: seedOf(p.seed), steps: num(p.steps, 28), cfg: num(p.cfg, 5.5), sampler_name: str(p.sampler, 'euler_ancestral'), scheduler: 'normal', denoise: 1
    })
    const img = g.add('VAEDecode', { samples: out(s), vae: out(ck, 2) })
    saveImage(g, out(img), 'sdxl')
    return g
  }
}

// ─── Video recipes (MiniMax H3) ──────────────────────────────────────────────

const H3_QUALITY = [
  { value: '0.3', label: '416p · fastest' },
  { value: '0.4', label: '480p · fast' },
  { value: '0.6', label: '608p · balanced' },
  { value: '0.98', label: '768p · native' }
]

const H3_COMMON_REQ: Requirement[] = [
  { folder: 'text_encoders', label: 'Qwen3-VL 32B H3 encoder', match: /qwen3vl_32b.*h3/i },
  { folder: 'vae', label: 'H3 video VAE', name: 'minimax_h3_video_vae_fp16.safetensors' },
  { folder: 'vae', label: 'H3 audio VAE', name: 'minimax_h3_audio_vae_fp32.safetensors' }
]

const H3_PROMPT_HELP =
  'Describe shots, camera motion and sound in one block. Dialogue in quotes is spoken with native audio. e.g. “[Shot 1] … She whispers, ‘We’re not alone.’ Ambient sound: rain on tin.”'

function h3Size(g: Graph, p: Params, firstFrame?: [string, number]): { width: number | [string, number]; height: number | [string, number] } {
  const mp = num(p.quality, 0.4)
  if (firstFrame && str(p.sizeFrom, 'image') === 'image') {
    const scaled = g.add('ImageScaleToTotalPixels', { image: firstFrame, upscale_method: 'nearest-exact', megapixels: mp, resolution_steps: 32 })
    const size = g.add('GetImageSize', { image: out(scaled) })
    return { width: out(size, 0), height: out(size, 1) }
  }
  return dims(str(p.aspect, '16:9'), mp, 32)
}

function h3Finish(g: Graph, sampled: [string, number], videoVae: string, audioVae: string, prefix: string): void {
  const frames = g.add('VAEDecode', { samples: sampled, vae: out(videoVae) })
  const audio = g.add('VAEDecodeAudio', { samples: sampled, vae: out(audioVae) })
  const video = g.add('CreateVideo', { images: out(frames), audio: out(audio), fps: 24 })
  g.add('SaveVideo', { video: out(video), filename_prefix: `stitch/${prefix}`, format: 'auto', 'format.codec': 'auto' })
}

const h3Fast: RecipeDef = {
  id: 'h3-fast',
  name: 'FastH3',
  kind: 'video',
  mode: 'first-frame',
  family: 'MiniMax H3',
  baseModelMatch: 'h3|minimax',
  description: 'Video with native voice, sound effects and music in 8 steps. Optional first/last frame to animate a shot — use a locked character keyframe for consistency.',
  estSeconds: 150,
  params: [
    P.prompt(H3_PROMPT_HELP),
    { key: 'firstFrame', label: 'First frame', type: 'image', help: 'Animate this image. Use a character-consistent keyframe.' },
    { key: 'lastFrame', label: 'Last frame', type: 'image', advanced: true },
    { key: 'voiceGuide', label: 'Voice line (audio guide)', type: 'audio', advanced: true, help: 'Anchor a pre-recorded line (e.g. a cloned voice) so the character says it.' },
    { key: 'duration', label: 'Duration (s)', type: 'number', default: 5, min: 2, max: 15, step: 0.5 },
    P.aspect('16:9'),
    { key: 'sizeFrom', label: 'Frame size', type: 'select', default: 'image', advanced: true, options: [{ value: 'image', label: 'Follow first frame' }, { value: 'aspect', label: 'Use aspect ratio' }] },
    P.quality(0.4, H3_QUALITY),
    P.model('diffusion_models', 'H3 model'),
    P.loras(),
    { key: 'sparse', label: 'Sparse attention (faster)', type: 'bool', default: true, advanced: true },
    P.steps(8, 50),
    P.seed()
  ],
  requires: [{ folder: 'diffusion_models', label: 'FastH3 / H3 model', match: /h3/i }, ...H3_COMMON_REQ],
  build(p, m) {
    const g = new Graph()
    const unetName = pick(m, 'diffusion_models', p.model, [/fasth3/i, /h3(?!.*ref2va)/i], 'fastvideo_fasth3_8step_v2_pruned_int8_convrot.safetensors')
    const unet = g.add('UNETLoader', { unet_name: unetName, weight_dtype: 'default' })
    let model: [string, number] = withLora(g, out(unet), p)
    model = out(g.add('MiniMaxH3SigmaShift', { model, shift_video: 10, shift_audio: 3 }))
    model = out(g.add('ModelAttentionBackend', { model, attention: 'comfy kitchen attention' }))
    if (p.sparse !== false && /fasth3/i.test(unetName)) {
      model = out(g.add('BlockSparseAttention', {
        model, selection: 'vsa', 'selection.keep_percent': 10, start_percent: 0.2, end_percent: 1,
        dense_blocks: '', min_tokens: 12288, extra_tokens: 256, sink_conditioning: 'exact_kv_and_rows', verbose: false
      }))
    }
    const clip = g.add('CLIPLoader', { clip_name: pick(m, 'text_encoders', undefined, [/qwen3vl_32b.*h3/i], 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors'), type: 'minimax', device: 'default' })
    const vvae = g.add('VAELoader', { vae_name: 'minimax_h3_video_vae_fp16.safetensors' })
    const avae = g.add('VAELoader', { vae_name: 'minimax_h3_audio_vae_fp32.safetensors' })
    const first = str(p.firstFrame) ? out(g.add('LoadImage', { image: str(p.firstFrame) })) : undefined
    const last = str(p.lastFrame) ? out(g.add('LoadImage', { image: str(p.lastFrame) })) : undefined
    const { width, height } = h3Size(g, p, first)
    const cond = g.add('MiniMaxH3ImageToVideo', {
      clip: out(clip), vae: out(vvae), prompt: str(p.prompt), width, height,
      length: h3Frames(num(p.duration, 5)), first_frame: first, last_frame: last
    })
    let positive: [string, number] = out(cond, 0)
    if (str(p.voiceGuide)) {
      const audio = g.add('LoadAudio', { audio: str(p.voiceGuide) })
      positive = out(g.add('MiniMaxH3AddGuide', { positive, latent: out(cond, 1), frame_idx: 0, audio_vae: out(avae), audio: out(audio) }))
    }
    const guider = g.add('BasicGuider', { model, conditioning: positive })
    const sched = g.add('BasicScheduler', { model, scheduler: 'simple', steps: num(p.steps, 8), denoise: 1 })
    const sampler = g.add('KSamplerSelect', { sampler_name: 'res_multistep' })
    const noise = g.add('RandomNoise', { noise_seed: seedOf(p.seed) })
    const s = g.add('SamplerCustomAdvanced', { noise: out(noise), guider: out(guider), sampler: out(sampler), sigmas: out(sched), latent_image: out(cond, 1) })
    h3Finish(g, out(s), vvae, avae, 'h3')
    return g
  }
}

const h3Ref: RecipeDef = {
  id: 'h3-reference',
  name: 'H3 Reference',
  kind: 'video',
  mode: 'reference',
  family: 'MiniMax H3',
  baseModelMatch: 'h3|minimax',
  description: 'Lock identity and voice: up to 9 reference images and 3 voice clips, referenced in the prompt as <Picture 1>, <Audio 1>…',
  estSeconds: 240,
  params: [
    P.prompt('e.g. “<Picture 1> walks into the tavern and says, in the voice of <Audio 1>: ‘Evening.’”'),
    { key: 'images', label: 'Reference images', type: 'images', maxItems: 9, required: true },
    { key: 'audios', label: 'Voice references', type: 'audios', maxItems: 3 },
    { key: 'duration', label: 'Duration (s)', type: 'number', default: 5, min: 2, max: 15, step: 0.5 },
    P.aspect('16:9'),
    P.quality(0.4, H3_QUALITY),
    { key: 'refSize', label: 'Identity fidelity', type: 'select', default: 'match', advanced: true, options: [{ value: 'match', label: 'Fast (match output)' }, { value: 'max', label: 'Max (slower)' }] },
    P.model('diffusion_models', 'H3 model', 'Needs the MiniMax H3 ref2va model for best results.'),
    { key: 'turbo', label: 'Turbo LoRA (4 steps)', type: 'bool', default: true, advanced: true },
    P.loras(),
    P.steps(20, 60),
    { key: 'scheduler', label: 'Scheduler', type: 'select', default: 'beta', advanced: true, options: ['beta', 'normal', 'simple'].map((v) => ({ value: v, label: v })) },
    P.seed()
  ],
  requires: [{ folder: 'diffusion_models', label: 'H3 ref2va model (or FastH3)', match: /h3/i }, ...H3_COMMON_REQ],
  build(p, m) {
    const g = new Graph()
    const unetName = pick(m, 'diffusion_models', p.model, [/ref2va/i, /h3/i], 'minimax_h3_ref2va_pruned_int8_convrot.safetensors')
    const unet = g.add('UNETLoader', { unet_name: unetName, weight_dtype: 'default' })
    let model: [string, number] = out(unet)
    const turboLora = (m.loras ?? []).find((l) => /h3_ref2v_turbo/i.test(l))
    const turbo = p.turbo !== false && !!turboLora
    if (turbo) model = out(g.add('LoraLoaderModelOnly', { model, lora_name: turboLora!, strength_model: 1 }))
    model = withLora(g, model, p)
    const clip = g.add('CLIPLoader', { clip_name: pick(m, 'text_encoders', undefined, [/qwen3vl_32b.*h3/i], 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors'), type: 'minimax', device: 'default' })
    const vvae = g.add('VAELoader', { vae_name: 'minimax_h3_video_vae_fp16.safetensors' })
    const avae = g.add('VAELoader', { vae_name: 'minimax_h3_audio_vae_fp32.safetensors' })
    const { width, height } = dims(str(p.aspect, '16:9'), num(p.quality, 0.4), 32)
    const inputs: Record<string, unknown> = {
      clip: out(clip), vae: out(vvae), audio_vae: out(avae), prompt: str(p.prompt), width, height,
      length: h3Frames(num(p.duration, 5)), ref_image_size: str(p.refSize, 'match')
    }
    list(p.images).slice(0, 9).forEach((name, i) => {
      inputs[`ref_images.ref_image_${i}`] = out(g.add('LoadImage', { image: name }))
    })
    list(p.audios).slice(0, 3).forEach((name, i) => {
      inputs[`ref_audios.ref_audio_${i}`] = out(g.add('LoadAudio', { audio: name }))
    })
    const cond = g.add('MiniMaxH3ReferenceToVideo', inputs)
    const guider = g.add('BasicGuider', { model, conditioning: out(cond, 0) })
    const sched = g.add('BasicScheduler', { model, scheduler: str(p.scheduler, 'beta'), steps: turbo ? 4 : num(p.steps, 20), denoise: 1 })
    const sampler = g.add('KSamplerSelect', { sampler_name: 'res_multistep' })
    const noise = g.add('RandomNoise', { noise_seed: seedOf(p.seed) })
    const s = g.add('SamplerCustomAdvanced', { noise: out(noise), guider: out(guider), sampler: out(sampler), sigmas: out(sched), latent_image: out(cond, 1) })
    h3Finish(g, out(s), vvae, avae, 'h3-ref')
    return g
  }
}

// ─── Audio recipes ───────────────────────────────────────────────────────────

const aceStep: RecipeDef = {
  id: 'ace-step-music',
  name: 'ACE-Step 1.5 Music',
  kind: 'audio',
  mode: 'text',
  family: 'ACE-Step',
  baseModelMatch: 'ace',
  description: 'Full songs or instrumentals from genre tags and optional lyrics.',
  estSeconds: 40,
  params: [
    { key: 'prompt', label: 'Style tags', type: 'prompt', required: true, help: 'e.g. “dark fantasy orchestral, war drums, choir, 90 BPM”' },
    { key: 'lyrics', label: 'Lyrics', type: 'text', default: '[instrumental]', help: 'Use [verse], [chorus] markers, or [instrumental].' },
    { key: 'duration', label: 'Duration (s)', type: 'number', default: 60, min: 10, max: 300, step: 5 },
    { key: 'bpm', label: 'BPM', type: 'int', default: 110, min: 40, max: 220, advanced: true },
    P.seed()
  ],
  requires: [
    { folder: 'diffusion_models', label: 'ACE-Step 1.5 model', match: /acestep|ace_step/i },
    { folder: 'text_encoders', label: 'ACE 0.6B encoder', match: /qwen_0\.6b_ace/i },
    { folder: 'text_encoders', label: 'ACE 4B encoder', match: /qwen_4b_ace/i },
    { folder: 'vae', label: 'ACE 1.5 VAE', match: /ace_1\.5_vae/i }
  ],
  build(p, m) {
    const g = new Graph()
    const unet = g.add('UNETLoader', { unet_name: pick(m, 'diffusion_models', p.model, [/acestep.*turbo/i, /acestep/i], 'acestep_v1.5_xl_turbo_bf16.safetensors'), weight_dtype: 'default' })
    const model = g.add('ModelSamplingAuraFlow', { model: out(unet), shift: 3 })
    const clip = g.add('DualCLIPLoader', {
      clip_name1: pick(m, 'text_encoders', undefined, [/qwen_0\.6b_ace/i], 'qwen_0.6b_ace15.safetensors'),
      clip_name2: pick(m, 'text_encoders', undefined, [/qwen_4b_ace/i], 'qwen_4b_ace15.safetensors'),
      type: 'ace', device: 'default'
    })
    const vae = g.add('VAELoader', { vae_name: pick(m, 'vae', undefined, [/ace_1\.5_vae/i], 'ace_1.5_vae.safetensors') })
    const seed = seedOf(p.seed)
    const duration = num(p.duration, 60)
    const enc = g.add('TextEncodeAceStepAudio1.5', {
      clip: out(clip), tags: str(p.prompt), lyrics: str(p.lyrics, '[instrumental]'), seed, bpm: num(p.bpm, 110), duration,
      timesignature: '4', language: 'en', keyscale: 'C major', generate_audio_codes: true, cfg_scale: 2, temperature: 0.85, top_p: 0.9, top_k: 0, min_p: 0
    })
    const neg = g.add('ConditioningZeroOut', { conditioning: out(enc) })
    const latent = g.add('EmptyAceStep1.5LatentAudio', { seconds: duration, batch_size: 1 })
    const s = g.add('KSampler', { model: out(model), positive: out(enc), negative: out(neg), latent_image: out(latent), seed, steps: 8, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1 })
    const audio = g.add('VAEDecodeAudio', { samples: out(s), vae: out(vae) })
    g.add('SaveAudioMP3', { audio: out(audio), filename_prefix: 'stitch/music', quality: 'V0' })
    return g
  }
}

const stableAudio: RecipeDef = {
  id: 'stable-audio-sfx',
  name: 'Stable Audio 3',
  kind: 'audio',
  mode: 'text',
  family: 'Stable Audio',
  baseModelMatch: 'stable audio',
  description: 'Sound effects, ambiences and short cues from a text description.',
  estSeconds: 20,
  params: [
    { key: 'prompt', label: 'Sound description', type: 'prompt', required: true, help: 'e.g. “heavy wooden door creaks open in a stone hall, echo”' },
    { key: 'duration', label: 'Duration (s)', type: 'number', default: 10, min: 1, max: 190, step: 1 },
    P.seed()
  ],
  requires: [
    { folder: 'checkpoints', label: 'Stable Audio 3 checkpoint', match: /stable_audio/i },
    { folder: 'text_encoders', label: 'T5Gemma encoder', match: /t5gemma/i }
  ],
  build(p, m) {
    const g = new Graph()
    const ck = g.add('CheckpointLoaderSimple', { ckpt_name: pick(m, 'checkpoints', undefined, [/stable_audio_3/i, /stable_audio/i], 'stable_audio_3_medium.safetensors') })
    const clip = g.add('CLIPLoader', { clip_name: pick(m, 'text_encoders', undefined, [/t5gemma/i], 't5gemma_b_b_ul2.safetensors'), type: 'stable_audio', device: 'default' })
    const pos = g.add('CLIPTextEncode', { clip: out(clip), text: str(p.prompt) })
    const neg = g.add('CLIPTextEncode', { clip: out(clip), text: '' })
    const latent = g.add('EmptyLatentAudio', { seconds: num(p.duration, 10), batch_size: 1 })
    const s = g.add('KSampler', { model: out(ck, 0), positive: out(pos), negative: out(neg), latent_image: out(latent), seed: seedOf(p.seed), steps: 8, cfg: 1, sampler_name: 'lcm', scheduler: 'simple', denoise: 1 })
    const audio = g.add('VAEDecodeAudio', { samples: out(s), vae: out(ck, 2) })
    g.add('SaveAudioMP3', { audio: out(audio), filename_prefix: 'stitch/sfx', quality: 'V0' })
    return g
  }
}

export const RECIPES: RecipeDef[] = [krea2, klein, qwenT2i, qwenEdit, kontext, anima, sdxl, h3Fast, h3Ref, aceStep, stableAudio]

export function recipeById(id: string): RecipeDef | undefined {
  return RECIPES.find((r) => r.id === id)
}
