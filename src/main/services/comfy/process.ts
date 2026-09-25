// Launch and supervise ComfyUI processes that Stitch owns (e.g. one per GPU).
import { app } from 'electron'
import { spawn, type ChildProcess, execFile } from 'node:child_process'
import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ComfyConnector } from '@shared/types'
import { getSettings } from '../../settings'
import { detectStabilityMatrix } from '../system'

export type ProcState = 'stopped' | 'starting' | 'running' | 'crashed'

interface Proc {
  child: ChildProcess
  state: ProcState
  logs: string[]
}

const procs = new Map<string, Proc>()
const MAX_LOG = 600

export function processState(id: string): ProcState {
  return procs.get(id)?.state ?? 'stopped'
}

export function processLogs(id: string): string[] {
  return procs.get(id)?.logs ?? []
}

export function comfyDir(): string | undefined {
  const s = getSettings()
  if (s.comfyDir && existsSync(join(s.comfyDir, 'main.py'))) return s.comfyDir
  return detectStabilityMatrix()?.comfyDir
}

function pythonFor(dir: string): string {
  for (const p of [join(dir, 'venv', 'Scripts', 'python.exe'), join(dir, 'venv', 'bin', 'python'), join(dir, '..', 'python_embeded', 'python.exe')]) {
    if (existsSync(p)) return p
  }
  return 'python'
}

/** Folder-name mapping for a user-chosen models directory. */
const SM_LAYOUT: Record<string, string[]> = {
  checkpoints: ['StableDiffusion', 'checkpoints'],
  diffusion_models: ['DiffusionModels', 'diffusion_models', 'unet'],
  loras: ['Lora', 'LyCORIS', 'loras'],
  text_encoders: ['TextEncoders', 'text_encoders', 'clip'],
  clip_vision: ['ClipVision', 'clip_vision'],
  vae: ['VAE', 'vae'],
  embeddings: ['Embeddings', 'embeddings'],
  controlnet: ['ControlNet', 'controlnet'],
  upscale_models: ['ESRGAN', 'RealESRGAN', 'upscale_models'],
  audio_encoders: ['AudioEncoders', 'audio_encoders'],
  model_patches: ['ModelPatches', 'model_patches']
}

/**
 * Write an extra_model_paths.yaml pointing ComfyUI at the user's chosen models
 * folder. Works for both Stability-Matrix-style and ComfyUI-style layouts.
 */
function extraModelPathsFile(): string | undefined {
  const dir = getSettings().modelsDir
  if (!dir || !existsSync(dir)) return undefined
  const lines = ['stitch_models:', `  base_path: ${JSON.stringify(dir.replace(/\\/g, '/'))}`]
  for (const [key, candidates] of Object.entries(SM_LAYOUT)) {
    const found = candidates.filter((c) => {
      const p = join(dir, c)
      return existsSync(p) && statSync(p).isDirectory()
    })
    if (found.length) lines.push(`  ${key}: |`, ...found.map((f) => `    ${f}`))
  }
  const file = join(app.getPath('userData'), 'comfy_extra_model_paths.yaml')
  writeFileSync(file, lines.join('\n') + '\n')
  return file
}

/** Scan the chosen models folder on disk (used when ComfyUI is offline). */
export function scanModelsDir(folder: string): string[] {
  const roots: string[] = []
  const sm = detectStabilityMatrix()
  const custom = getSettings().modelsDir
  for (const base of [custom, sm?.modelsDir]) {
    if (!base) continue
    for (const c of SM_LAYOUT[folder] ?? [folder]) roots.push(join(base, c))
  }
  const cdir = comfyDir()
  if (cdir) roots.push(join(cdir, 'models', folder))
  const out = new Set<string>()
  const walk = (d: string, prefix: string, depth: number): void => {
    if (!existsSync(d) || depth > 3) return
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name), `${prefix}${e.name}/`, depth + 1)
      else if (/\.(safetensors|gguf|ckpt|pt|pth|bin|sft)$/i.test(e.name)) out.add(prefix + e.name)
    }
  }
  for (const r of roots) walk(r, '', 0)
  return [...out].sort()
}

export function launchComfy(c: ComfyConnector, onState: () => void): void {
  const existing = procs.get(c.id)
  if (existing && (existing.state === 'running' || existing.state === 'starting')) return
  const dir = comfyDir()
  if (!dir) throw new Error('No ComfyUI install found. Set the ComfyUI folder in Settings or install it with Stability Matrix.')
  const port = c.managed?.port ?? Number(new URL(c.url).port || 8188)
  const sm = detectStabilityMatrix()
  const args = ['main.py', '--listen', '127.0.0.1', '--port', String(port), '--disable-auto-launch']
  const smArgs = (sm?.launchArgs ?? ['--preview-method', 'auto', '--use-pytorch-cross-attention']).filter((a) => a !== '--enable-manager')
  args.push(...smArgs)
  if (!args.includes('--preview-method')) args.push('--preview-method', 'auto')
  if (c.managed?.cudaDevice !== undefined) args.push('--cuda-device', String(c.managed.cudaDevice))
  // ComfyUI already reads its own extra_model_paths.yaml (Stability Matrix's
  // shared Models folder); add the user's chosen folder on top.
  const extra = extraModelPathsFile()
  if (extra) args.push('--extra-model-paths-config', extra)

  const child = spawn(pythonFor(dir), args, {
    cwd: dir,
    env: { ...process.env, PYTHONUNBUFFERED: '1', CUDA_DEVICE_ORDER: 'PCI_BUS_ID' },
    windowsHide: true
  })
  const proc: Proc = { child, state: 'starting', logs: [] }
  procs.set(c.id, proc)
  const log = (chunk: Buffer): void => {
    for (const line of chunk.toString('utf8').split(/\r?\n/)) {
      if (!line.trim()) continue
      proc.logs.push(line)
      if (/To see the GUI go to|Starting server/i.test(line) && proc.state === 'starting') {
        proc.state = 'running'
        onState()
      }
    }
    if (proc.logs.length > MAX_LOG) proc.logs.splice(0, proc.logs.length - MAX_LOG)
  }
  child.stdout?.on('data', log)
  child.stderr?.on('data', log)
  child.on('exit', (code) => {
    proc.state = code === 0 || proc.state === 'stopped' ? 'stopped' : 'crashed'
    proc.logs.push(`[stitch] ComfyUI exited with code ${code}`)
    onState()
  })
  onState()
}

export function stopComfy(id: string): void {
  const p = procs.get(id)
  if (!p || p.child.exitCode !== null) return
  p.state = 'stopped'
  if (process.platform === 'win32' && p.child.pid) execFile('taskkill', ['/pid', String(p.child.pid), '/T', '/F'], () => {})
  else p.child.kill('SIGTERM')
}

export function stopAllComfy(): void {
  for (const id of procs.keys()) stopComfy(id)
}
