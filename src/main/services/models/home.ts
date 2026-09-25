// Where models live. One place decides the default download folder ("models
// home") and every folder Stitch scans or hands to the ComfyUI instances it
// runs: the user's chosen folder, Stability Matrix's shared Models folder,
// ComfyUI's own models/ and extra_model_paths.yaml, Stitch's own
// <userData>/models and any folder the user installed into.
import { app } from 'electron'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { ModelsHome } from '@shared/types'
import { getSettings } from '../../settings'
import { comfyDir } from '../comfy/process'
import { detectStabilityMatrix } from '../system'

/** ComfyUI folder key → folder names on disk (Stability Matrix names first). */
export const LAYOUT: Record<string, string[]> = {
  checkpoints: ['StableDiffusion', 'checkpoints'],
  diffusion_models: ['DiffusionModels', 'diffusion_models', 'unet'],
  loras: ['Lora', 'LyCORIS', 'loras'],
  controlnet: ['ControlNet', 'controlnet'],
  vae: ['VAE', 'vae'],
  text_encoders: ['TextEncoders', 'text_encoders', 'clip'],
  embeddings: ['Embeddings', 'embeddings'],
  upscale_models: ['ESRGAN', 'RealESRGAN', 'SwinIR', 'upscale_models'],
  clip_vision: ['ClipVision', 'clip_vision'],
  model_patches: ['ModelPatches', 'model_patches'],
  audio_encoders: ['AudioEncoders', 'audio_encoders']
}

/** ComfyUI's own names inside `<ComfyUI>/models` (and in a ComfyUI-style folder). */
export const COMFY_LAYOUT: Record<string, string[]> = {
  checkpoints: ['checkpoints'],
  diffusion_models: ['diffusion_models', 'unet'],
  loras: ['loras'],
  controlnet: ['controlnet'],
  vae: ['vae'],
  text_encoders: ['text_encoders', 'clip'],
  embeddings: ['embeddings'],
  upscale_models: ['upscale_models'],
  clip_vision: ['clip_vision'],
  model_patches: ['model_patches'],
  audio_encoders: ['audio_encoders']
}

/** Folders whose presence marks a Stability Matrix-style layout. */
const SM_MARKERS = ['StableDiffusion', 'Lora', 'DiffusionModels', 'TextEncoders']
/** Old ComfyUI names that extra_model_paths.yaml may still use. */
const LEGACY_KEYS: Record<string, string> = { clip: 'text_encoders', unet: 'diffusion_models' }

export const MODEL_EXT = /\.(safetensors|gguf|ckpt|pt|pth|bin|sft)$/i

export function isDir(p: string | undefined): p is string {
  if (!p) return false
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

const same = (a: string, b: string): boolean => resolve(a).toLowerCase() === resolve(b).toLowerCase()

/** Stitch's own models folder, used when there's no chosen folder and no Stability Matrix. */
export function appModelsDir(): string {
  return join(app.getPath('userData'), 'models')
}

export function extraDirs(): string[] {
  return (getSettings().extraModelDirs ?? []).filter((d) => typeof d === 'string' && d.trim())
}

export function layoutOf(base: string): ModelsHome['layout'] {
  return SM_MARKERS.some((n) => isDir(join(base, n))) ? 'stability-matrix' : 'comfyui'
}

// ─── ComfyUI's own extra_model_paths.yaml ────────────────────────────────────

export interface Root {
  folder: string
  dir: string
}

let yamlCache: { file: string; mtime: number; roots: Root[] } | null = null

/**
 * Model folders listed in `<ComfyUI>/extra_model_paths.yaml` (Stability
 * Matrix writes one pointing at its shared Models folder). Handles the
 * `key: |` block and `key: path` forms plus `base_path`.
 */
export function comfyYamlRoots(): Root[] {
  const cdir = comfyDir()
  if (!cdir) return []
  const file = join(cdir, 'extra_model_paths.yaml')
  let mtime = 0
  try {
    mtime = statSync(file).mtimeMs
  } catch {
    return []
  }
  if (yamlCache?.file === file && yamlCache.mtime === mtime) return yamlCache.roots
  const roots: Root[] = []
  try {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/)
    let base: string | undefined
    let key: string | undefined
    let keyIndent = 0
    const push = (k: string, raw: string): void => {
      const v = raw.trim().replace(/^["']|["']$/g, '')
      if (!v || v.startsWith('#')) return
      const folder = LEGACY_KEYS[k] ?? k
      if (!(folder in LAYOUT)) return
      const dir = isAbsolute(v) ? v : join(base ?? cdir, v)
      roots.push({ folder, dir: resolve(dir) })
    }
    for (const line of lines) {
      if (!line.trim() || line.trim().startsWith('#')) continue
      const indent = line.length - line.trimStart().length
      if (indent === 0) {
        base = undefined
        key = undefined
        continue
      }
      // Lines of a `key: |` block are indented deeper than the key.
      if (key && indent > keyIndent) {
        push(key, line)
        continue
      }
      key = undefined
      const m = /^\s+([A-Za-z0-9_]+):(?:\s+(.*))?$/.exec(line)
      if (!m) continue
      const k = m[1]
      const rest = (m[2] ?? '').trim()
      if (k === 'base_path') base = rest.replace(/^["']|["']$/g, '')
      else if (k === 'is_default') continue
      else if (!rest || /^\|[-+]?$/.test(rest)) {
        key = k
        keyIndent = indent
      } else push(k, rest)
    }
  } catch {
    /* unreadable yaml: no extra roots */
  }
  yamlCache = { file, mtime, roots }
  return roots
}

// ─── Home ────────────────────────────────────────────────────────────────────

/** Does a ComfyUI the user runs themselves already search `base`? */
export function comfySearches(base: string): boolean {
  const cdir = comfyDir()
  if (cdir && same(base, join(cdir, 'models'))) return true
  // Covered when the ComfyUI yaml lists the diffusion/checkpoint folders under it.
  return comfyYamlRoots().some((r) => {
    const rel = relative(resolve(base), r.dir)
    return !!rel && !rel.startsWith('..') && !isAbsolute(rel)
  })
}

/**
 * Default base folder for new models: the folder chosen in Settings, else
 * Stability Matrix's shared Models folder, else <userData>/models (ComfyUI layout).
 */
export function modelsHome(): ModelsHome {
  const custom = getSettings().modelsDir
  if (isDir(custom)) return { path: resolve(custom), layout: layoutOf(custom), source: 'settings', externalComfySees: comfySearches(custom) }
  const sm = detectStabilityMatrix()
  if (isDir(sm?.modelsDir)) return { path: resolve(sm.modelsDir), layout: 'stability-matrix', source: 'stability-matrix', externalComfySees: comfySearches(sm.modelsDir) }
  const dir = appModelsDir()
  return { path: dir, layout: 'comfyui', source: 'app', externalComfySees: comfySearches(dir) }
}

/** Every base folder (a folder holding DiffusionModels/, vae/…) Stitch knows. */
export function modelBases(): { dir: string; kind: 'settings' | 'stability-matrix' | 'comfyui' | 'app' | 'extra' }[] {
  const out: { dir: string; kind: 'settings' | 'stability-matrix' | 'comfyui' | 'app' | 'extra' }[] = []
  const add = (dir: string | undefined, kind: (typeof out)[number]['kind']): void => {
    if (!dir) return
    const full = resolve(dir)
    if (out.some((b) => same(b.dir, full))) return
    out.push({ dir: full, kind })
  }
  add(getSettings().modelsDir || undefined, 'settings')
  add(detectStabilityMatrix()?.modelsDir, 'stability-matrix')
  const cdir = comfyDir()
  if (cdir) add(join(cdir, 'models'), 'comfyui')
  add(appModelsDir(), 'app')
  for (const d of extraDirs()) add(d, 'extra')
  return out
}

/** Folder inside `base` for a ComfyUI folder key: an existing one, else per the base's layout. */
export function folderDir(base: string, folder: string): string {
  const names = LAYOUT[folder] ?? [folder]
  const existing = names.find((n) => isDir(join(base, n)))
  if (existing) return join(base, existing)
  const sm = layoutOf(base) === 'stability-matrix'
  return join(base, sm ? names[0] : (COMFY_LAYOUT[folder]?.[0] ?? folder))
}

/** Folder on disk where new files for a folder key should go (default: the models home). */
export function destinationDir(folder: string, base?: string): string {
  return folderDir(base ? resolve(base) : modelsHome().path, folder)
}

/**
 * Turn a folder the user picked into a models base: a picked leaf
 * (`…\Models\VAE`) means its parent, a ComfyUI install means its models/.
 */
export function normalizeBase(picked: string): string {
  const full = resolve(picked)
  if (existsSync(join(full, 'main.py')) && isDir(join(full, 'models'))) return join(full, 'models')
  const leaf = basename(full).toLowerCase()
  const leaves = new Set(Object.values(LAYOUT).flat().map((n) => n.toLowerCase()))
  if (leaves.has(leaf) && dirname(full) !== full) return dirname(full)
  return full
}

/** Is `dir` one of the bases Stitch already knows (so it needn't be remembered)? */
export function knownBase(dir: string): boolean {
  return modelBases().some((b) => same(b.dir, dir)) || comfySearches(dir)
}

// ─── Roots ───────────────────────────────────────────────────────────────────

/** Every folder that may hold model files, deduplicated (Windows paths are case-insensitive). */
export function modelRoots(): Root[] {
  const out: Root[] = []
  const seen = new Set<string>()
  const add = (folder: string, dir: string): void => {
    const full = resolve(dir)
    const key = full.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    out.push({ folder, dir: full })
  }
  for (const b of modelBases()) {
    const table = b.kind === 'comfyui' ? COMFY_LAYOUT : LAYOUT
    for (const [folder, names] of Object.entries(table)) for (const n of names) add(folder, join(b.dir, n))
  }
  for (const r of comfyYamlRoots()) add(r.folder, r.dir)
  return out
}

export function inside(parent: string, p: string): boolean {
  const rel = relative(resolve(parent), resolve(p))
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel)
}

/** Is `p` inside one of the model roots? */
export function insideRoots(p: string): boolean {
  return modelRoots().some((r) => inside(r.dir, p))
}

/**
 * extra_model_paths.yaml entries that make a ComfyUI see every Stitch base
 * (folders that don't exist yet are fine — ComfyUI picks them up once created).
 */
export function comfyYamlFor(bases: string[]): string {
  const lines: string[] = []
  bases.forEach((dir, i) => {
    lines.push(`stitch_models_${i + 1}:`, `  base_path: ${JSON.stringify(dir.replace(/\\/g, '/'))}`)
    for (const [key, names] of Object.entries(LAYOUT)) {
      // Windows paths ignore case: keep the first spelling of each name.
      const uniq = names.filter((n, i) => names.findIndex((x) => x.toLowerCase() === n.toLowerCase()) === i)
      lines.push(`  ${key}: |`, ...uniq.map((n) => `    ${n}`))
    }
  })
  return lines.join('\n') + '\n'
}
