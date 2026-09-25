// Model-library rules shared by main and renderer: ComfyUI folders, model
// kinds, where Civitai downloads go, and a fallback list of base models.
import type { ModelKind } from './types'

/** ComfyUI model folders Stitch lists, with their kind and a friendly label. */
export const MODEL_FOLDERS: { key: string; kind: ModelKind; label: string }[] = [
  { key: 'checkpoints', kind: 'checkpoint', label: 'Checkpoints' },
  { key: 'diffusion_models', kind: 'unet', label: 'Diffusion models' },
  { key: 'loras', kind: 'lora', label: 'LoRAs' },
  { key: 'controlnet', kind: 'controlnet', label: 'ControlNet' },
  { key: 'vae', kind: 'vae', label: 'VAE' },
  { key: 'text_encoders', kind: 'textencoder', label: 'Text encoders' },
  { key: 'embeddings', kind: 'embedding', label: 'Embeddings' },
  { key: 'upscale_models', kind: 'upscaler', label: 'Upscalers' },
  { key: 'clip_vision', kind: 'clipvision', label: 'CLIP vision' },
  { key: 'model_patches', kind: 'other', label: 'Model patches' },
  { key: 'audio_encoders', kind: 'other', label: 'Audio encoders' }
]

export function folderLabel(key: string): string {
  return MODEL_FOLDERS.find((f) => f.key === key)?.label ?? key
}

export function kindForFolder(key: string): ModelKind {
  return MODEL_FOLDERS.find((f) => f.key === key)?.kind ?? 'other'
}

/** Civitai model type → the kind tag we show. */
export function kindForCivitaiType(type: string | undefined): ModelKind {
  switch ((type ?? '').toLowerCase()) {
    case 'checkpoint':
      return 'checkpoint'
    case 'lora':
    case 'locon':
    case 'dora':
    case 'lycoris':
      return 'lora'
    case 'controlnet':
      return 'controlnet'
    case 'vae':
      return 'vae'
    case 'textualinversion':
      return 'embedding'
    case 'upscaler':
      return 'upscaler'
    case 'textencoder':
    case 'clip':
      return 'textencoder'
    case 'unet':
      return 'unet'
    case 'clipvision':
      return 'clipvision'
    default:
      return 'other'
  }
}

/**
 * Families whose Civitai "checkpoints" are full SD-style checkpoints (model +
 * CLIP + VAE in one file) and load from `checkpoints`. Everything newer ships
 * the diffusion model on its own and belongs in `diffusion_models`.
 */
const FULL_CHECKPOINT = /^(sd 1|sd 2|sdxl|pony$|illustrious|noobai|sd 3|stable cascade|playground|kolors|pixart|svd|other$)/i

export function isDiffusionOnlyBase(baseModel: string | undefined): boolean {
  if (!baseModel) return false
  return !FULL_CHECKPOINT.test(baseModel.trim())
}

/** Where a Civitai file should land (ComfyUI folder key), or undefined if unknown. */
export function folderForCivitai(type: string | undefined, baseModel: string | undefined, fileType?: string): string | undefined {
  switch ((fileType ?? '').toLowerCase()) {
    case 'vae':
      return 'vae'
    case 'text encoder':
      return 'text_encoders'
    case 'diffusion model':
    case 'unet':
      return 'diffusion_models'
    case 'clipvision':
    case 'vision encoder':
      return 'clip_vision'
    case 'controlnet':
      return 'controlnet'
    case 'upscaler':
      return 'upscale_models'
    case 'enhancement lora':
      return 'loras'
  }
  switch ((type ?? '').toLowerCase()) {
    case 'lora':
    case 'locon':
    case 'dora':
    case 'lycoris':
      return 'loras'
    case 'checkpoint':
      return isDiffusionOnlyBase(baseModel) ? 'diffusion_models' : 'checkpoints'
    case 'controlnet':
      return 'controlnet'
    case 'vae':
      return 'vae'
    case 'textualinversion':
      return 'embeddings'
    case 'upscaler':
      return 'upscale_models'
    case 'textencoder':
    case 'clip':
      return 'text_encoders'
    case 'unet':
      return 'diffusion_models'
    case 'clipvision':
      return 'clip_vision'
    default:
      return undefined
  }
}

/** Civitai model types offered as filters, grouped the way the kind tags are. */
export const CIVITAI_TYPE_FILTERS: { label: string; kind: ModelKind; types: string[] }[] = [
  { label: 'Checkpoint', kind: 'checkpoint', types: ['Checkpoint'] },
  { label: 'LoRA', kind: 'lora', types: ['LORA', 'LoCon', 'DoRA'] },
  { label: 'UNet', kind: 'unet', types: ['UNet'] },
  { label: 'ControlNet', kind: 'controlnet', types: ['Controlnet'] },
  { label: 'VAE', kind: 'vae', types: ['VAE'] },
  { label: 'Text encoder', kind: 'textencoder', types: ['TextEncoder'] },
  { label: 'Embedding', kind: 'embedding', types: ['TextualInversion'] },
  { label: 'Upscaler', kind: 'upscaler', types: ['Upscaler'] }
]

/** Used when Civitai's live enum list can't be fetched. */
export const FALLBACK_BASE_MODELS = [
  'SD 1.4', 'SD 1.5', 'SD 1.5 LCM', 'SD 1.5 Hyper', 'SD 2.0', 'SD 2.0 768', 'SD 2.1', 'SD 2.1 768', 'SD 2.1 Unclip',
  'SDXL 0.9', 'SDXL 1.0', 'SDXL 1.0 LCM', 'SDXL Lightning', 'SDXL Hyper', 'SDXL Turbo', 'SDXL Distilled',
  'Pony', 'Pony V7', 'Illustrious', 'NoobAI', 'Playground v2', 'Stable Cascade',
  'SD 3', 'SD 3.5', 'SD 3.5 Large', 'SD 3.5 Large Turbo', 'SD 3.5 Medium',
  'Flux.1 S', 'Flux.1 D', 'Flux.1 Krea', 'Flux.1 Kontext', 'Flux.2 D', 'Flux.2 Klein 9B', 'Flux.2 Klein 9B-base', 'Flux.2 Klein 4B', 'Flux.2 Klein 4B-base',
  'Krea 2', 'Qwen', 'Qwen 2', 'Qwen 2.1', 'Qwen 3', 'HiDream', 'HiDream-O1', 'Chroma', 'AuraFlow', 'Kolors', 'Lumina', 'PixArt a', 'PixArt E',
  'ZImageTurbo', 'ZImageBase', 'Anima', 'MiniMax H3', 'Ernie', 'MageFlow', 'Hunyuan 1', 'Hunyuan Video',
  'SVD', 'SVD XT', 'Wan Video', 'Wan Video 1.3B t2v', 'Wan Video 14B t2v', 'Wan Video 14B i2v 480p', 'Wan Video 14B i2v 720p',
  'Wan Video 2.2 TI2V-5B', 'Wan Video 2.2 I2V-A14B', 'Wan Video 2.2 T2V-A14B', 'Wan Video 2.5 T2V', 'Wan Video 2.5 I2V', 'Wan Image 2.7', 'Wan Video 2.7', 'Wan Video 3.0',
  'LTXV', 'LTXV2', 'LTXV 2.3', 'LTXV 2.5', 'Mochi', 'CogVideoX', 'ACE Audio', 'MiniMax Music 3', 'Upscaler', 'Other'
]

/** Display order for base-model families (most used first). */
export const FAMILY_ORDER = [
  'SDXL anime', 'SDXL', 'Flux', 'Krea', 'Qwen', 'Z-Image', 'Wan', 'LTX Video', 'Hunyuan', 'HiDream', 'MiniMax',
  'Stable Diffusion 1.x', 'Stable Diffusion 2.x', 'Stable Diffusion 3', 'Other image models', 'Video', 'Audio', 'Other'
]

/** Family a base model belongs to, for grouping pickers ("Flux", "SDXL", "Wan Video"…). */
export function baseFamily(base: string): string {
  const b = base.trim()
  const rules: [RegExp, string][] = [
    [/^sd ?1/i, 'Stable Diffusion 1.x'],
    [/^sd ?2/i, 'Stable Diffusion 2.x'],
    [/^sd ?3/i, 'Stable Diffusion 3'],
    [/^sdxl|^playground/i, 'SDXL'],
    [/^pony|^illustrious|^noobai/i, 'SDXL anime'],
    [/^flux/i, 'Flux'],
    [/^krea/i, 'Krea'],
    [/^qwen/i, 'Qwen'],
    [/^wan/i, 'Wan'],
    [/^hunyuan/i, 'Hunyuan'],
    [/^hidream/i, 'HiDream'],
    [/^ltxv/i, 'LTX Video'],
    [/^svd|^mochi|^cogvideo|^vidu|^kling|^seedance|^veo|^sora|^flux 3 video/i, 'Video'],
    [/^zimage/i, 'Z-Image'],
    [/^minimax/i, 'MiniMax'],
    [/^ace|^yue|audio|music/i, 'Audio'],
    [/^(chroma|auraflow|kolors|lumina|pixart|stable cascade|anima|ernie|mageflow|ming|lens|mai|boogu|happyhorse|muse)/i, 'Other image models']
  ]
  for (const [re, name] of rules) if (re.test(b)) return name
  return 'Other'
}

/**
 * Resized variant of a Civitai CDN image/video URL. `poster` turns a video
 * into a still JPEG; `optimized` asks for WebP (smaller, renderer only).
 */
export function civitaiImageVariant(url: string, opts: { width?: number; poster?: boolean; optimized?: boolean } = {}): string {
  const m = /^(https:\/\/image\.civitai\.com\/[^/]+\/[^/]+\/)(?:[^/]*=[^/]*\/)?([^/?#]+)$/.exec(url)
  if (!m) return url
  const width = opts.width ?? 450
  const file = opts.poster ? m[2].replace(/\.(mp4|webm|mov|gif)$/i, '.jpeg') : m[2]
  const parts = opts.poster ? ['anim=false', 'transcode=true', `width=${width}`, 'optimized=true'] : [`width=${width}`]
  if (opts.optimized && !opts.poster) parts.push('optimized=true')
  return `${m[1]}${parts.join(',')}/${file}`
}
