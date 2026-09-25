// GPU layout: which GPUs Stitch uses and which workload runs where.
import type { GenKind, GpuWorkload } from '@shared/types'
import { getSettings } from '../settings'

export const COMFY_WORKLOADS: GenKind[] = ['image', 'video', 'audio']

/** Enabled GPU indices, falling back to the first GPU. */
export function enabledGpus(available: number[]): number[] {
  const s = getSettings().gpu
  const picked = s.enabled.filter((i) => available.includes(i))
  return picked.length ? [...picked].sort((a, b) => a - b) : available.slice(0, 1)
}

/** Resolve a workload's assignment against the enabled set. */
export function gpuFor(work: GpuWorkload, enabled: number[]): number | 'auto' {
  const a = getSettings().gpu.assign[work]
  return typeof a === 'number' && enabled.includes(a) ? a : 'auto'
}

/**
 * ComfyUI roles per GPU. Empty array = accepts every generation kind.
 * GPUs that only host the voice engine get no ComfyUI instance at all.
 */
export function comfyPlan(enabled: number[]): { gpu: number; roles: GenKind[] }[] {
  const plan = enabled.map((gpu) => ({ gpu, roles: [] as GenKind[] }))
  for (const work of COMFY_WORKLOADS) {
    const target = gpuFor(work, enabled)
    for (const p of plan) if (target === 'auto' || target === p.gpu) p.roles.push(work)
  }
  return plan
    .filter((p) => p.roles.length)
    .map((p) => ({ gpu: p.gpu, roles: p.roles.length === COMFY_WORKLOADS.length ? [] : p.roles }))
}

/** GPU for the local voice engine: explicit choice, else the least-busy enabled GPU. */
export function voiceGpu(available: number[]): number | undefined {
  const enabled = enabledGpus(available)
  if (!enabled.length) return undefined
  const target = gpuFor('voice', enabled)
  if (target !== 'auto') return target
  const plan = comfyPlan(enabled)
  const load = (g: number): number => {
    const p = plan.find((x) => x.gpu === g)
    return p ? (p.roles.length || COMFY_WORKLOADS.length) : 0
  }
  return [...enabled].sort((a, b) => load(a) - load(b))[0]
}
