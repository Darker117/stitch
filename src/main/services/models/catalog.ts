// Curated model catalog: the exact Hugging Face files each built-in recipe
// needs (repo + path + size + sha256, verified against the Hub API on
// 2026-09-25), install plans (what's there, what's missing, how big) and
// installs into the default models path or a folder the user picks.
import { app } from 'electron'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import type { CatalogEntry, CatalogFile, DownloadState, InstallPlan, InstallPlanFile, InstallRequest } from '@shared/types'
import { getSettings, updateSettings } from '../../settings'
import { knownModels } from '../comfy/jobs'
import { scanModelsDir } from '../comfy/process'
import { recipeById, type Requirement } from '../comfy/recipes'
import { catalogDest, downloadFor, startHfDownload } from './downloads'
import { knownBase, modelsHome, normalizeBase } from './home'
import { hfToken } from './hf'

// ─── Files ───────────────────────────────────────────────────────────────────

const f = (folder: string, repo: string, path: string, size: number, sha256: string, name = basename(path)): CatalogFile => ({ folder, name, repo, path, size, sha256 })

const ACE = 'Comfy-Org/ace_step_1.5_ComfyUI_files'
const SA3 = 'Comfy-Org/stable-audio-3'
const H3 = 'Comfy-Org/MiniMax-H3'

const F = {
  // ACE-Step 1.5 (Apache-2.0 repackage of ACE-Step/Ace-Step1.5, MIT)
  aceXlTurbo: f('diffusion_models', ACE, 'split_files/diffusion_models/acestep_v1.5_xl_turbo_bf16.safetensors', 9974719892, '86a1afb0a1f711f0e3304ff65d874df3ae6783db683dcf982513fb9b6d14ae71'),
  aceTurbo: f('diffusion_models', ACE, 'split_files/diffusion_models/acestep_v1.5_turbo.safetensors', 4787825604, '3f6e0797fad420a39bd33979eb6e840e30989e34a3794e843d23b60ec6e422d7'),
  ace06: f('text_encoders', ACE, 'split_files/text_encoders/qwen_0.6b_ace15.safetensors', 1191588248, 'fd4590c82153b8ddb67e15a2e7aaa8afa8b83a858c8a9b82a4831063156aa7a7'),
  ace4b: f('text_encoders', ACE, 'split_files/text_encoders/qwen_4b_ace15.safetensors', 8379154232, 'ffe5ffb855086c2ab55e467e9859fb01894781020a0376484dd19de166b79873'),
  aceVae: f('vae', ACE, 'split_files/vae/ace_1.5_vae.safetensors', 337431732, '6de92e3a862acd287e08b024ac90f0783a8635451b728721a33ff03565bcb2bb'),
  // YuE2 (m-a-p/YuE2-3B repackaged by Comfy-Org: model + lyrics encoder + audio VAE in one checkpoint; CC BY-NC 4.0)
  yue2Int8: f('checkpoints', 'Comfy-Org/YuE2', 'checkpoints/yue2_3b_int8_convrot.safetensors', 3960938800, '96fe199377309001ed8cd26a944baeee8cc31a20ba7c36d1d3c0a7e1f4149db6'),
  yue2Bf16: f('checkpoints', 'Comfy-Org/YuE2', 'checkpoints/yue2_3b_bf16.safetensors', 7799983228, '33765adbf9813c9a50318218760b2fd819a319862460a04884607581961c6fee'),
  // Stable Audio 3 (ungated Comfy-Org repackage; stabilityai/stable-audio-3-medium itself is gated)
  sa3Medium: f('checkpoints', SA3, 'checkpoints/stable_audio_3_medium.safetensors', 9222116660, '48d9c65e290e7bcd5194e0633bfc2424a59ee9683f5c2d58762d997b7d8ce0b5'),
  sa3SmallSfx: f('checkpoints', SA3, 'checkpoints/stable_audio_3_small_sfx.safetensors', 2270384940, 'ed9cf1b6172f1a8c2921a9560c21109ff3239524563ced9dce6dcdef41e2f515'),
  t5gemma: f('text_encoders', SA3, 'text_encoders/t5gemma_b_b_ul2.safetensors', 1187264003, '1e1eba25be8872edb0d3c6335c6658fd6388e7b14b60da6e454e404cfcd8150e'),
  // Krea 2
  krea2Turbo: f('diffusion_models', 'Comfy-Org/Krea-2', 'diffusion_models/krea2_turbo_int8_convrot.safetensors', 13492686496, '8e4eeda70dd5037ab1ba2bef6b417f9f901e26093117cf397f741fc1fdaaf3f1'),
  qwen3vl4b: f('text_encoders', 'Comfy-Org/Krea-2', 'text_encoders/qwen3vl_4b_fp8_scaled.safetensors', 5242467968, '54bd5144df0bbc25dd6ccadfcb826b521445a1b06ae5a42570bdd2974ca87094'),
  qwenImageVae: f('vae', 'Comfy-Org/Krea-2', 'vae/qwen_image_vae.safetensors', 253806246, 'a70580f0213e67967ee9c95f05bb400e8fb08307e017a924bf3441223e023d1f'),
  // Qwen Image 2.1
  qwen21: f('diffusion_models', 'Comfy-Org/Qwen-Image-2.1', 'diffusion_models/qwen_image_2.1_int8_convrot.safetensors', 7256783064, 'cb74113cb03faecd79611b01fd7fd642f0aa60d6f0b95086abee214d75eaa57d'),
  qwen3vl8b: f('text_encoders', 'Comfy-Org/Qwen-Image-2.1', 'text_encoders/qwen3vl_8b_int8_convrot.safetensors', 9350798360, '8bfd0f6e12abf2d2d697ecc888e5e90b0d6741d6708f05799f53afa560452e8f'),
  qwen21Vae: f('vae', 'Comfy-Org/Qwen-Image-2.1', 'vae/qwen_image_2.1_vae_bf16.safetensors', 675509688, 'bb21f7473051e1ac368515dd3f2e15cd44d7a11748ee8823e1ddca3e4876b7c9'),
  // Flux 2 Klein 4B
  klein4b: f('diffusion_models', 'Comfy-Org/vae-text-encorder-for-flux-klein-4b', 'split_files/diffusion_models/flux-2-klein-4b.safetensors', 7751105712, 'ec3d4e733a771f61c052fb4856c48b336c55eaf2c65487c2a1faeb9bbda7a343'),
  qwen3_4b: f('text_encoders', 'Comfy-Org/vae-text-encorder-for-flux-klein-4b', 'split_files/text_encoders/qwen_3_4b.safetensors', 8044982048, '6c671498573ac2f7a5501502ccce8d2b08ea6ca2f661c458e708f36b36edfc5a'),
  flux2Vae: f('vae', 'Comfy-Org/vae-text-encorder-for-flux-klein-4b', 'split_files/vae/flux2-vae.safetensors', 336211292, '868fe7b343cc8f3a19dbcfcafbc3d5f888802be3f89bd81b65b3621a066ce8f3'),
  // Flux.1 Kontext dev
  kontext: f('diffusion_models', 'Comfy-Org/flux1-kontext-dev_ComfyUI', 'split_files/diffusion_models/flux1-dev-kontext_fp8_scaled.safetensors', 11904640136, '630ba795ec64283b4230ea23cf79406c2c68b7c578229ed139f30043eadb30a2'),
  clipL: f('text_encoders', 'comfyanonymous/flux_text_encoders', 'clip_l.safetensors', 246144152, '660c6f5b1abae9dc498ac2d21e1347d2abdb0cf6c0c0c8576cd796491d9a6cdd'),
  t5xxlFp8: f('text_encoders', 'comfyanonymous/flux_text_encoders', 't5xxl_fp8_e4m3fn_scaled.safetensors', 5157348688, 'a498f0485dc9536735258018417c3fd7758dc3bccc0a645feaa472b34955557a'),
  fluxAe: f('vae', 'Comfy-Org/Lumina_Image_2.0_Repackaged', 'split_files/vae/ae.safetensors', 335304388, 'afc8e28272cd15db3919bacdb6918ce9c1ed22e96cb12c4d5ed0fba823529e38'),
  // Anima
  animaBase: f('diffusion_models', 'circlestone-labs/Anima', 'split_files/diffusion_models/anima-base-v1.0.safetensors', 4182218328, 'bd43b7cffe1ed1153d9c41e7beb2f18cb1273eafbaa3af3edd6a173dc90a006e'),
  qwen3_06b: f('text_encoders', 'circlestone-labs/Anima', 'split_files/text_encoders/qwen_3_06b_base.safetensors', 1192135096, 'cd2a512003e2f9f3cd3c32a9c3573f820bb28c940f73c57b1ddaa983d9223eba'),
  animaTurbo: f('loras', 'circlestone-labs/Anima-Official-LoRAs', 'anima-turbo-lora-v0.2.safetensors', 148902616, '1b55e40bdb1d0e5a78cb498f245fccfdaae97823265db957d2aabdcf4cd3caf1'),
  // MiniMax H3
  fastH3: f('diffusion_models', 'FastVideo/FastVideo-FastH3-Comfy', 'diffusion_models/fastvideo_fasth3_8step_v2_pruned_int8_convrot.safetensors', 22128378696, '0922785978dc9bfe1adf27d8b291b0ca763f9f165f882e6cb297c72fbb6deda8'),
  h3Ref2va: f('diffusion_models', H3, 'diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors', 20970379616, '9255f52b6677845ad238f20dfaafa94727053694127ab7f255c048f0f9365779'),
  h3Te: f('text_encoders', H3, 'text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors', 15687142551, '35a88d51044231fe332301d7a62aa81e3f2cba62febeb446e2c1e3e0ef76f2c6'),
  h3VideoVae: f('vae', H3, 'vae/minimax_h3_video_vae_fp16.safetensors', 5207808496, '7c1f131492e7eddacaac9069a61b81bdd39de5cc96561e677c5eab1cdce5e522'),
  h3AudioVae: f('vae', H3, 'vae/minimax_h3_audio_vae_fp32.safetensors', 605254808, '8e505d95dd1561d47abd43d4238fd40d9bb1ae9e147ed0a4cba778d76ae4db48'),
  h3RefTurbo: f('loras', H3, 'loras/minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors', 1956193000, '5b9ab5ade15d0775676d01a907268a69a1468dc6033b3b0d3ded5502f3ebb84c'),
  // SDXL / Illustrious
  illustrious2: f('checkpoints', 'OnomaAIResearch/Illustrious-XL-v2.0', 'Illustrious-XL-v2.0.safetensors', 6938040674, 'c2a1a3eaa13d4c107dc7e00c3fe830cab427aa026362740ea094745b3422a331')
}

// ─── Entries ─────────────────────────────────────────────────────────────────

/** First entry listing a recipe is its default; later ones are alternatives. */
export const CATALOG: CatalogEntry[] = [
  {
    id: 'ace-step-1.5-xl-turbo',
    name: 'ACE-Step 1.5 XL Turbo',
    description: 'Best-quality ACE-Step 1.5 songs in 8 steps: XL turbo model, both ACE text encoders and the audio VAE.',
    recipes: ['ace-step-music'],
    files: [F.aceXlTurbo, F.ace06, F.ace4b, F.aceVae],
    license: 'MIT / Apache-2.0',
    url: `https://huggingface.co/${ACE}`
  },
  {
    id: 'ace-step-1.5-turbo',
    name: 'ACE-Step 1.5 Turbo (lighter)',
    description: 'The standard-size turbo model — about 5 GB smaller, a little less detailed.',
    recipes: ['ace-step-music'],
    files: [F.aceTurbo, F.ace06, F.ace4b, F.aceVae],
    license: 'MIT / Apache-2.0',
    url: `https://huggingface.co/${ACE}`
  },
  {
    id: 'yue2-3b-int8',
    name: 'YuE2 3B (int8)',
    description: 'YuE2 songs with vocals — the official ComfyUI checkpoint, int8 weights with an fp16 audio VAE. Fits a 16 GB GPU comfortably.',
    recipes: ['yue2-music'],
    files: [F.yue2Int8],
    license: 'CC BY-NC 4.0 (creators may monetise their songs; companies need a licence)',
    url: 'https://huggingface.co/Comfy-Org/YuE2'
  },
  {
    id: 'yue2-3b-bf16',
    name: 'YuE2 3B (bf16, full precision)',
    description: 'Full-precision YuE2 — twice the size, marginally cleaner audio.',
    recipes: ['yue2-music'],
    files: [F.yue2Bf16],
    license: 'CC BY-NC 4.0 (creators may monetise their songs; companies need a licence)',
    url: 'https://huggingface.co/Comfy-Org/YuE2'
  },
  {
    id: 'stable-audio-3-medium',
    name: 'Stable Audio 3 Medium',
    description: 'Sound effects, ambiences and short cues, plus the T5Gemma text encoder.',
    recipes: ['stable-audio-sfx'],
    files: [F.sa3Medium, F.t5gemma],
    license: 'Stability AI Community License',
    url: `https://huggingface.co/${SA3}`
  },
  {
    id: 'stable-audio-3-small-sfx',
    name: 'Stable Audio 3 Small SFX (lighter)',
    description: 'The small sound-effects model — a quarter of the size, tuned for SFX.',
    recipes: ['stable-audio-sfx'],
    files: [F.sa3SmallSfx, F.t5gemma],
    license: 'Stability AI Community License',
    url: `https://huggingface.co/${SA3}`
  },
  {
    id: 'krea-2-turbo',
    name: 'Krea 2 Turbo',
    description: 'Krea 2 Turbo (int8), the Qwen3-VL 4B encoder and the Qwen Image VAE.',
    recipes: ['krea2-t2i'],
    files: [F.krea2Turbo, F.qwen3vl4b, F.qwenImageVae],
    license: 'Krea 2 Community License',
    url: 'https://huggingface.co/Comfy-Org/Krea-2'
  },
  {
    id: 'qwen-image-2.1',
    name: 'Qwen Image 2.1',
    description: 'Qwen Image 2.1 (int8) for text-to-image and editing, with its encoder and VAE.',
    recipes: ['qwen21-t2i', 'qwen21-edit'],
    files: [F.qwen21, F.qwen3vl8b, F.qwen21Vae],
    license: 'Qwen Research License (non-commercial)',
    url: 'https://huggingface.co/Comfy-Org/Qwen-Image-2.1'
  },
  {
    id: 'flux-2-klein-4b',
    name: 'Flux 2 Klein 4B',
    description: 'Flux 2 Klein 4B with the Qwen3 4B encoder and the Flux 2 VAE.',
    recipes: ['flux2-klein'],
    files: [F.klein4b, F.qwen3_4b, F.flux2Vae],
    license: 'Apache-2.0',
    url: 'https://huggingface.co/Comfy-Org/vae-text-encorder-for-flux-klein-4b'
  },
  {
    id: 'flux-1-kontext-dev',
    name: 'Flux.1 Kontext dev',
    description: 'Kontext dev (fp8), CLIP-L + T5-XXL encoders and the Flux VAE.',
    recipes: ['flux-kontext'],
    files: [F.kontext, F.clipL, F.t5xxlFp8, F.fluxAe],
    license: 'FLUX.1 [dev] Non-Commercial License',
    url: 'https://huggingface.co/Comfy-Org/flux1-kontext-dev_ComfyUI'
  },
  {
    id: 'anima-base',
    name: 'Anima',
    description: 'Anima base model with its Qwen3 0.6B encoder and the Qwen Image VAE.',
    recipes: ['anima-t2i'],
    files: [F.animaBase, F.qwen3_06b, { ...F.qwenImageVae }],
    license: 'CircleStone Labs Non-Commercial License',
    url: 'https://huggingface.co/circlestone-labs/Anima'
  },
  {
    id: 'anima-turbo-lora',
    name: 'Anima Turbo LoRA',
    description: 'Optional 8-step turbo LoRA for Anima (the “Turbo LoRA” switch).',
    recipes: [],
    files: [F.animaTurbo],
    url: 'https://huggingface.co/circlestone-labs/Anima-Official-LoRAs'
  },
  {
    id: 'minimax-h3-fast',
    name: 'FastH3 (MiniMax H3)',
    description: 'FastH3 8-step video model plus the H3 text encoder and video/audio VAEs.',
    recipes: ['h3-fast'],
    files: [F.fastH3, F.h3Te, F.h3VideoVae, F.h3AudioVae],
    license: 'MiniMax H3 Community License',
    url: 'https://huggingface.co/FastVideo/FastVideo-FastH3-Comfy'
  },
  {
    id: 'minimax-h3-ref2va',
    name: 'MiniMax H3 Reference (ref2va)',
    description: 'The H3 reference-to-video model, its 4-step turbo LoRA, encoder and VAEs.',
    recipes: ['h3-reference'],
    files: [F.h3Ref2va, F.h3Te, F.h3VideoVae, F.h3AudioVae, F.h3RefTurbo],
    license: 'MiniMax H3 Community License',
    url: `https://huggingface.co/${H3}`
  },
  {
    id: 'illustrious-xl-2',
    name: 'Illustrious XL 2.0',
    description: 'A general SDXL-based anime/illustration checkpoint to start the SDXL recipe with.',
    recipes: ['sdxl-checkpoint'],
    files: [F.illustrious2],
    license: 'CreativeML Open RAIL-M',
    url: 'https://huggingface.co/OnomaAIResearch/Illustrious-XL-v2.0'
  }
]

// Dev builds only: extra entries for download tests (STITCH_TEST_CATALOG=<json file of CatalogEntry[]>).
if (!app.isPackaged && process.env.STITCH_TEST_CATALOG) {
  try {
    CATALOG.push(...(JSON.parse(readFileSync(process.env.STITCH_TEST_CATALOG, 'utf8')) as CatalogEntry[]))
  } catch (err) {
    console.warn('[models] test catalog', err)
  }
}

export function catalogEntry(id: string): CatalogEntry | undefined {
  return CATALOG.find((e) => e.id === id)
}

/** Catalog entry that ships a given file (folder + name). */
export function catalogIdFor(folder: string, name: string): string | undefined {
  const n = name.toLowerCase()
  return CATALOG.find((e) => e.files.some((x) => x.folder === folder && x.name.toLowerCase() === n))?.id
}

// ─── Plans ───────────────────────────────────────────────────────────────────

const fileName = (name: string): string => name.split('/').pop() ?? name

function satisfies(req: Requirement, name: string): boolean {
  return req.name ? name === req.name || name.endsWith('/' + req.name) : !!req.match?.test(name)
}

/** Files per folder on disk (every Stitch root) and as ComfyUI lists them. */
function inventory(): { comfy: Record<string, string[]>; disk: (folder: string) => string[] } {
  const comfy = knownModels()
  const cache = new Map<string, string[]>()
  const disk = (folder: string): string[] => {
    if (!cache.has(folder)) cache.set(folder, scanModelsDir(folder))
    return cache.get(folder)!
  }
  return { comfy, disk }
}

/** Plan for a catalog entry on its own (Model manager → Catalog). */
function entryPlan(entryId: string): InstallPlan {
  const entry = catalogEntry(entryId)
  if (!entry) throw new Error(`Unknown catalog entry ${entryId}`)
  const { comfy, disk } = inventory()
  const files: InstallPlanFile[] = entry.files.map((x) => {
    const n = fileName(x.name).toLowerCase()
    const inComfy = (comfy[x.folder] ?? []).some((m) => fileName(m).toLowerCase() === n)
    const onDisk = disk(x.folder).some((m) => fileName(m).toLowerCase() === n)
    let dest: string | undefined
    try {
      dest = catalogDest(x)
    } catch {
      dest = undefined
    }
    const dl = dest ? downloadFor(dest) : undefined
    const status: InstallPlanFile['status'] = inComfy ? 'installed' : onDisk ? 'hidden' : dl ? (dl.status === 'queued' ? 'queued' : 'downloading') : 'missing'
    return { ...x, label: '', status, dest, downloadId: dl?.id }
  })
  return {
    recipeId: '',
    entryId,
    alternatives: [{ id: entry.id, name: entry.name, description: entry.description, bytes: entry.files.reduce((n, x) => n + x.size, 0) }],
    files,
    bytes: files.filter((x) => x.status === 'missing').reduce((n, x) => n + x.size, 0),
    unknown: [],
    gated: files.some((x) => x.gated && x.status === 'missing'),
    hasHfToken: !!hfToken(),
    home: modelsHome()
  }
}

/** What a recipe (or, with an empty recipe id, a catalog entry) still needs. */
export function installPlan(recipeId: string, entryId?: string): InstallPlan {
  if (!recipeId && entryId) return entryPlan(entryId)
  const recipe = recipeById(recipeId)
  if (!recipe) throw new Error(`Unknown recipe ${recipeId}`)
  const entries = CATALOG.filter((e) => e.recipes.includes(recipeId))
  const entry = (entryId ? entries.find((e) => e.id === entryId) : undefined) ?? entries[0]
  const { comfy, disk } = inventory()
  const home = modelsHome()
  const files: InstallPlanFile[] = []
  const unknown: string[] = []
  const seen = new Set<string>()
  for (const req of recipe.requires) {
    if (req.optional) continue
    const listed = comfy[req.folder] ?? []
    const have = listed.find((n) => satisfies(req, n))
    const src = entry?.files.find((x) => x.folder === req.folder && satisfies(req, x.name))
    if (have) {
      const key = `${req.folder}|${have}`
      if (seen.has(key)) continue
      seen.add(key)
      files.push({ ...(src ?? { folder: req.folder, repo: '', path: '', size: 0 }), name: have, label: req.label, status: 'installed' })
      continue
    }
    if (!src) {
      unknown.push(req.label)
      continue
    }
    const key = `${src.folder}|${src.name}`
    if (seen.has(key)) continue
    seen.add(key)
    const onDisk = disk(req.folder).find((n) => satisfies(req, n))
    if (onDisk) {
      files.push({ ...src, name: onDisk, label: req.label, status: 'hidden' })
      continue
    }
    let dest: string | undefined
    try {
      dest = catalogDest(src)
    } catch {
      dest = undefined
    }
    const dl = dest ? downloadFor(dest) : undefined
    files.push({ ...src, label: req.label, status: dl ? (dl.status === 'queued' ? 'queued' : 'downloading') : 'missing', dest, downloadId: dl?.id })
  }
  // Extra files an entry ships beyond the requirements (e.g. H3's turbo LoRA).
  for (const x of entry?.files ?? []) {
    const key = `${x.folder}|${x.name}`
    if (seen.has(key) || files.some((p) => p.folder === x.folder && p.name === x.name)) continue
    if (recipe.requires.some((r) => r.folder === x.folder && satisfies(r, x.name))) continue
    seen.add(key)
    const present = (comfy[x.folder] ?? []).some((n) => fileName(n) === fileName(x.name)) || disk(x.folder).some((n) => fileName(n) === fileName(x.name))
    let dest: string | undefined
    try {
      dest = catalogDest(x)
    } catch {
      dest = undefined
    }
    const dl = dest ? downloadFor(dest) : undefined
    files.push({ ...x, label: 'Recommended extra', status: present ? 'installed' : dl ? (dl.status === 'queued' ? 'queued' : 'downloading') : 'missing', dest, downloadId: dl?.id })
  }
  const bytes = files.filter((x) => x.status === 'missing').reduce((n, x) => n + x.size, 0)
  const alternatives = entries.map((e) => ({
    id: e.id,
    name: e.name,
    description: e.description,
    bytes: e.files.reduce((n, x) => n + x.size, 0)
  }))
  return { recipeId, entryId: entry?.id, files, bytes, unknown, gated: files.some((x) => x.gated && x.status === 'missing'), hasHfToken: !!hfToken(), home, alternatives }
}

// ─── Installs ────────────────────────────────────────────────────────────────

/** Resolve (and remember) the base folder an install goes to. */
function installBase(dest: string | undefined): string | undefined {
  if (!dest?.trim()) return undefined
  const base = normalizeBase(dest)
  if (!knownBase(base)) {
    const extras = getSettings().extraModelDirs ?? []
    if (!extras.some((d) => d.toLowerCase() === base.toLowerCase())) updateSettings({ extraModelDirs: [...extras, base] })
  }
  return base
}

export function install(req: InstallRequest, onDone: () => void): DownloadState[] {
  const base = installBase(req.dest)
  let targets: { file: CatalogFile; label: string }[] = []
  let group: string
  if (req.recipeId) {
    const plan = installPlan(req.recipeId, req.entryId)
    if (plan.unknown.length && !plan.files.some((x) => x.status === 'missing')) {
      throw new Error(`Stitch has no download source for: ${plan.unknown.join(', ')}. Get these from Civitai or the model's page.`)
    }
    targets = plan.files.filter((x) => x.status === 'missing').map((x) => ({ file: x, label: x.name }))
    group = `recipe:${req.recipeId}`
  } else if (req.entryId) {
    targets = entryPlan(req.entryId)
      .files.filter((x) => x.status === 'missing')
      .map((x) => ({ file: x, label: x.name }))
    group = `entry:${req.entryId}`
  } else throw new Error('Nothing to install.')
  if (!targets.length) return []
  const out: DownloadState[] = []
  for (const t of targets) {
    try {
      out.push(startHfDownload(t.file, { base, group, label: fileName(t.label) }, onDone))
    } catch (err) {
      // Already there / already queued: skip, the rest still downloads.
      console.warn('[models] skip', t.file.name, err instanceof Error ? err.message : err)
    }
  }
  return out
}
