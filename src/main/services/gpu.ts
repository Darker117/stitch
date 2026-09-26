// GPU layout: which GPUs Stitch uses and which workload runs where — on this PC and on linked
// node PCs (Settings → Computers). A device is a local GPU index or { node, gpu }.
import type { GenKind, GpuTarget, GpuWorkload, NodeGpu } from '@shared/types'
import { getSettings } from '../settings'

export const COMFY_WORKLOADS: GenKind[] = ['image', 'video', 'audio']

export interface Device {
  /** Node PC id; unset = this PC. */
  node?: string
  gpu: number
}

export const deviceKey = (d: Device): string => (d.node ? `${d.node}:${d.gpu}` : `local:${d.gpu}`)

const isNodeGpu = (t: GpuTarget): t is NodeGpu => typeof t === 'object' && t !== null && typeof t.node === 'string'

function matches(t: GpuTarget, d: Device): boolean {
  if (typeof t === 'number') return !d.node && d.gpu === t
  if (isNodeGpu(t)) return d.node === t.node && d.gpu === t.gpu
  return false
}

/** Enabled GPU indices, falling back to the first GPU. */
export function enabledGpus(available: number[]): number[] {
  const s = getSettings().gpu
  const picked = s.enabled.filter((i) => available.includes(i))
  return picked.length ? [...picked].sort((a, b) => a - b) : available.slice(0, 1)
}

/** GPUs on linked nodes that joined the pool. */
export function remotePool(linked: (nodeId: string) => boolean): Device[] {
  const seen = new Set<string>()
  const out: Device[] = []
  for (const r of getSettings().gpu.remote ?? []) {
    if (!r || typeof r.node !== 'string' || !linked(r.node)) continue
    const d = { node: r.node, gpu: Number(r.gpu) }
    if (seen.has(deviceKey(d))) continue
    seen.add(deviceKey(d))
    out.push(d)
  }
  return out
}

/** A workload's device within the pool, or 'auto'. */
export function targetFor(work: GpuWorkload, pool: Device[]): Device | 'auto' {
  const a = getSettings().gpu.assign[work]
  return pool.find((d) => matches(a, d)) ?? 'auto'
}

/** Resolve a workload's assignment against this PC's enabled GPUs (the voice engine is local). */
export function gpuFor(work: GpuWorkload, enabled: number[]): number | 'auto' {
  const a = getSettings().gpu.assign[work]
  return typeof a === 'number' && enabled.includes(a) ? a : 'auto'
}

/**
 * ComfyUI roles per device. Empty array = accepts every generation kind.
 * Devices that only host the voice engine get no ComfyUI instance at all.
 */
export function comfyPlan(pool: Device[]): { device: Device; roles: GenKind[] }[] {
  const plan = pool.map((device) => ({ device, roles: [] as GenKind[] }))
  for (const work of COMFY_WORKLOADS) {
    const target = targetFor(work, pool)
    for (const p of plan) if (target === 'auto' || deviceKey(target) === deviceKey(p.device)) p.roles.push(work)
  }
  return plan
    .filter((p) => p.roles.length)
    .map((p) => ({ device: p.device, roles: p.roles.length === COMFY_WORKLOADS.length ? [] : p.roles }))
}

/** GPU for the local voice engine: explicit choice, else the least-busy enabled GPU. */
export function voiceGpu(available: number[]): number | undefined {
  const enabled = enabledGpus(available)
  if (!enabled.length) return undefined
  const target = gpuFor('voice', enabled)
  if (target !== 'auto') return target
  const plan = comfyPlan(enabled.map((gpu) => ({ gpu })))
  const load = (g: number): number => {
    const p = plan.find((x) => !x.device.node && x.device.gpu === g)
    return p ? (p.roles.length || COMFY_WORKLOADS.length) : 0
  }
  return [...enabled].sort((a, b) => load(a) - load(b))[0]
}
