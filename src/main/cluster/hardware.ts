// What this PC has: GPUs (live from nvidia-smi), CPU, RAM, OS, Stitch/ComfyUI/llama.cpp. Nodes send
// this to their main every few seconds; the main shows its own the same way.
import { app } from 'electron'
import { execFile } from 'node:child_process'
import { cpus, freemem, release, totalmem, version as osVersion } from 'node:os'
import { promisify } from 'node:util'
import type { GpuLive, PcHardware } from '@shared/ipc'
import { comfyDir } from '../services/comfy/process'
import { installedLlama } from '../services/llama/install'

const run = promisify(execFile)
const MB = 1024 * 1024

let gpuCache: { at: number; gpus: GpuLive[] } | null = null

/** Live GPU stats (cached ~1.5 s so several callers share one nvidia-smi run). */
export async function gpuStats(): Promise<GpuLive[]> {
  if (gpuCache && Date.now() - gpuCache.at < 1500) return gpuCache.gpus
  let gpus: GpuLive[] = []
  try {
    const { stdout } = await run('nvidia-smi', ['--query-gpu=index,name,memory.total,memory.used,utilization.gpu,temperature.gpu,compute_cap', '--format=csv,noheader,nounits'], { windowsHide: true, timeout: 8000 })
    gpus = stdout
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .map((l) => {
        const [index, name, total, used, util, temp, cap] = l.split(',').map((s) => s.trim())
        const num = (v: string): number | undefined => (Number.isFinite(Number(v)) ? Number(v) : undefined)
        return { index: Number(index), name, memTotal: Number(total) * MB, memUsed: Number(used) * MB, util: num(util), temp: num(temp), computeCap: cap || undefined }
      })
  } catch {
    gpus = []
  }
  gpuCache = { at: Date.now(), gpus }
  return gpus
}

/** Newest CUDA version the driver supports (major), from nvidia-smi's header. */
export async function driverCuda(): Promise<number | undefined> {
  try {
    const { stdout } = await run('nvidia-smi', [], { windowsHide: true, timeout: 8000 })
    const m = /CUDA (?:UMD )?Version:\s*(\d+)\.(\d+)/.exec(stdout)
    return m ? Number(m[1]) + Number(m[2]) / 10 : undefined
  } catch {
    return undefined
  }
}

function osName(): string {
  if (process.platform !== 'win32') return `${osVersion()} ${release()}`
  const build = Number(release().split('.')[2] ?? 0)
  // Windows 11 still reports "Windows 10" in its product name.
  const name = osVersion().replace(/^Windows 10/, build >= 22000 ? 'Windows 11' : 'Windows 10')
  return `${name} (build ${build})`
}

export async function localHardware(share?: (index: number) => boolean): Promise<PcHardware> {
  const gpus = (await gpuStats()).map((g) => (share ? { ...g, shared: share(g.index) } : g))
  const c = cpus()
  const llama = installedLlama()
  return {
    gpus,
    cpu: { model: (c[0]?.model ?? 'CPU').replace(/\s+/g, ' ').trim(), cores: c.length },
    ram: { total: totalmem(), free: freemem() },
    os: osName(),
    version: app.getVersion(),
    comfy: !!comfyDir(),
    llama: llama ? { tag: llama.tag, flavor: llama.flavor } : undefined,
    at: Date.now()
  }
}
