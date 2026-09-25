// Launch and supervise ComfyUI processes that Stitch owns (e.g. one per GPU).
import { app } from 'electron'
import { spawn, type ChildProcess, execFile } from 'node:child_process'
import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ComfyConnector } from '@shared/types'
import { getSettings } from '../../settings'
import { detectStabilityMatrix } from '../system'
import { comfySearches, comfyYamlFor, MODEL_EXT, modelBases, modelRoots } from '../models/home'

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

/**
 * Write an extra_model_paths.yaml pointing ComfyUI at every models folder
 * Stitch knows beyond the ones ComfyUI already reads from its own yaml: the
 * chosen folder, Stitch's default download folder (<userData>/models) and any
 * folder the user installed into. Folders that don't exist yet are listed
 * too — ComfyUI notices them once a download creates them, no restart needed.
 */
function extraModelPathsFile(): string | undefined {
  const bases = modelBases()
    .filter((b) => b.kind !== 'comfyui' && (b.kind === 'app' || existsSync(b.dir)) && !comfySearches(b.dir))
    .map((b) => b.dir)
  if (!bases.length) return undefined
  const file = join(app.getPath('userData'), 'comfy_extra_model_paths.yaml')
  writeFileSync(file, comfyYamlFor(bases))
  return file
}

/** Scan every models folder on disk (used when ComfyUI is offline). */
export function scanModelsDir(folder: string): string[] {
  const out = new Set<string>()
  const walk = (d: string, prefix: string, depth: number): void => {
    if (!existsSync(d) || depth > 3) return
    let entries
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.isDirectory()) walk(join(d, e.name), `${prefix}${e.name}/`, depth + 1)
      else if (MODEL_EXT.test(e.name)) out.add(prefix + e.name)
    }
  }
  for (const r of modelRoots()) if (r.folder === folder) walk(r.dir, '', 0)
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
  // shared Models folder); add Stitch's folders on top.
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
