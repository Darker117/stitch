import type { ComfyStatus } from '@shared/ipc'
import type { ComfyConnector, GenKind } from '@shared/types'
import { emit, handle } from '../../ipc'
import { getSettings } from '../../settings'
import { db } from '../../store'
import { registerTester } from '../connectors'
import { comfyPlan, enabledGpus, remotePool, type Device } from '../gpu'
import { isLinked, nodeLink, setWantedRemoteComfy } from '../../cluster'
import { detectGpus } from '../system'
import { ComfyClient } from './client'
import { attachInstance, cancel, clearFinished, initJobs, instanceLost, knownModels, listJobs, listRecipes, pump, refreshModels, submit, waitFor, type Instance } from './jobs'
import { launchComfy, processLogs, processState, stopAllComfy, stopComfy } from './process'

const instances = new Map<string, Instance>()

function comfyConnectors(): ComfyConnector[] {
  return db('connectors').list().filter((c): c is ComfyConnector => c.category === 'comfy')
}

/** Keep the instance map in sync with the connectors collection. */
function sync(): void {
  const current = comfyConnectors()
  for (const c of current) {
    const inst = instances.get(c.id)
    if (!inst) {
      // Fresh clientId per session: ComfyUI drops a reused id when the old socket closes.
      const client = new ComfyClient(c.url)
      const created: Instance = { connector: c, client, online: false, models: {}, modelsAt: 0, queueRemaining: 0 }
      instances.set(c.id, created)
      attachInstance(created)
      if (c.enabled) client.connect()
    } else {
      if (inst.connector.url !== c.url) {
        inst.client.close()
        inst.client.url = c.url
        if (c.enabled) inst.client.connect()
      } else if (c.enabled && !inst.connector.enabled) inst.client.connect()
      else if (!c.enabled && inst.connector.enabled) inst.client.close()
      inst.connector = c
    }
  }
  for (const [id, inst] of instances) {
    if (!current.some((c) => c.id === id)) {
      inst.client.close()
      instanceLost(inst)
      instances.delete(id)
    }
  }
}

/** A node's ComfyUI as the job queue sees it: its state comes from the node over the link. */
function remoteState(c: ComfyConnector): ComfyStatus['processState'] {
  const l = c.node ? nodeLink(c.node.node) : undefined
  const svc = l?.online ? l.service('comfy', c.node!.gpu) : undefined
  if (!svc) return 'stopped'
  return svc.state === 'installing' ? 'starting' : svc.state === 'error' ? 'crashed' : svc.state
}

function statusOf(inst: Instance): ComfyStatus {
  const remote = inst.connector.node
  const managed = !!inst.connector.managed || !!remote
  const ps = remote ? remoteState(inst.connector) : processState(inst.connector.id)
  const link = remote ? nodeLink(remote.node) : undefined
  return {
    node: remote ? { id: remote.node, name: link?.rec.name ?? 'Linked PC', gpu: remote.gpu } : undefined,
    connectorId: inst.connector.id,
    name: inst.connector.name,
    url: inst.connector.url,
    online: inst.online,
    managed,
    processState: managed ? ps : 'external',
    gpu: inst.gpu,
    vramTotal: inst.vramTotal,
    vramFree: inst.vramFree,
    queueRemaining: inst.queueRemaining,
    version: inst.version
  }
}

export function comfyStatuses(): ComfyStatus[] {
  return [...instances.values()].map(statusOf)
}

let lastSig = ''
async function poll(): Promise<void> {
  sync()
  await Promise.all(
    [...instances.values()].map(async (inst) => {
      if (!inst.connector.enabled) {
        inst.online = false
        return
      }
      const was = inst.online
      try {
        const stats = await inst.client.systemStats()
        const dev = stats.devices?.[0]
        inst.online = true
        inst.gpu = dev?.name?.replace(/^cuda:\d+\s*/, '').replace(/\s*:\s*cudaMallocAsync$/, '')
        inst.vramTotal = dev?.vram_total
        inst.vramFree = dev?.vram_free
        inst.version = stats.system?.comfyui_version
        if (!inst.client.connected) inst.client.connect()
        if (!was) {
          await refreshModels(inst, true)
          pump()
        }
      } catch {
        inst.online = false
        if (was) instanceLost(inst)
      }
    })
  )
  wakeRemote()
  const statuses = comfyStatuses()
  const sig = JSON.stringify(statuses.map((s) => [s.connectorId, s.online, s.processState, s.queueRemaining, s.gpu, Math.round((s.vramFree ?? 0) / 2 ** 28)]))
  if (sig !== lastSig) {
    lastSig = sig
    emit('comfy:status', statuses)
  }
}

export function allInstances(): Instance[] {
  return [...instances.values()]
}

/** Jobs are waiting: start a linked node's ComfyUI that is stopped (at most every 30 s per instance). */
const woken = new Map<string, number>()
function wakeRemote(): void {
  if (!listJobs().some((j) => j.status === 'queued' && !j.promptId)) return
  for (const inst of instances.values()) {
    const n = inst.connector.node
    if (!n || inst.online || !inst.connector.enabled) continue
    const l = nodeLink(n.node)
    if (!l?.online || remoteState(inst.connector) !== 'stopped' || Date.now() - (woken.get(inst.connector.id) ?? 0) < 30_000) continue
    woken.set(inst.connector.id, Date.now())
    void l.call('comfy.start', { gpu: n.gpu }).catch((err: Error) => console.warn('[comfy] could not start on', l.rec.name, err.message))
  }
}

function remoteComfy(id: string): { link: NonNullable<ReturnType<typeof nodeLink>>; gpu: number } | null {
  const c = db('connectors').get(id)
  if (c?.category !== 'comfy' || !c.node) return null
  const link = nodeLink(c.node.node)
  if (!link) throw new Error('That PC is no longer linked')
  return { link, gpu: c.node.gpu }
}

export function registerComfy(): void {
  initJobs(allInstances)
  sync()
  void poll()
  setInterval(() => void poll(), 2500)

  registerTester('comfy', async (c) => {
    const client = new ComfyClient((c as ComfyConnector).url)
    const stats = await client.systemStats()
    const dev = stats.devices?.[0]?.name ?? 'unknown device'
    return { ok: true, message: `ComfyUI ${stats.system?.comfyui_version ?? ''} on ${dev}` }
  })

  handle('comfy:status', () => comfyStatuses())
  handle('comfy:launch', async (id) => {
    const c = db('connectors').get(id)
    if (!c || c.category !== 'comfy') throw new Error('ComfyUI connector not found')
    const r = remoteComfy(id)
    if (r) await r.link.call('comfy.start', { gpu: r.gpu })
    else launchComfy(c, () => void poll())
  })
  handle('comfy:stop', async (id) => {
    const r = remoteComfy(id)
    if (r) await r.link.call('comfy.stop', { gpu: r.gpu })
    else stopComfy(id)
  })
  handle('comfy:logs', async (id) => {
    const r = remoteComfy(id)
    if (!r) return processLogs(id)
    return r.link.online ? r.link.call<string[]>('comfy.logs', { gpu: r.gpu }) : [`${r.link.rec.name} is offline.`]
  })
  handle('comfy:models', async (folder) => {
    const online = allInstances().filter((i) => i.online)
    for (const i of online) await refreshModels(i)
    return knownModels()[folder] ?? []
  })
  handle('gpu:list', () => detectGpus())
  handle('gpu:apply', () => applyGpuLayout())

  handle('gen:recipes', () => listRecipes())
  handle('gen:submit', (req) => submit(req))
  handle('gen:cancel', (id) => cancel(id))
  handle('gen:jobs', () => listJobs())
  handle('gen:clearFinished', () => clearFinished())
  handle('gen:wait', (id) => waitFor(id))
}

const MANAGED_BASE_PORT = 8190

/**
 * Rebuild the Stitch-managed ComfyUI instances from settings.gpu: one per
 * enabled GPU, each accepting only the workloads assigned to it.
 */
export async function applyGpuLayout(): Promise<void> {
  const s = getSettings().gpu
  const col = db('connectors')
  const managed = comfyConnectors().filter((c) => c.managed)
  const gpus = s.managed ? await detectGpus() : []
  const fullPlan = await layoutPlan(gpus.map((g) => g.index))
  await applyRemoteLayout(fullPlan.filter((p) => p.device.node), true)

  if (!s.managed) {
    for (const c of managed) {
      stopComfy(c.id)
      col.delete(c.id)
    }
    if (!comfyConnectors().some((c) => !c.node)) {
      col.put({ id: 'comfy-local', name: 'ComfyUI', category: 'comfy', url: 'http://127.0.0.1:8188', roles: [], enabled: true, createdAt: Date.now() })
    }
    sync()
    return
  }

  const names = new Map(gpus.map((g) => [g.index, g.name.replace(/NVIDIA GeForce /i, '')]))
  const plan = fullPlan.filter((p) => !p.device.node).map((p) => ({ gpu: p.device.gpu, roles: p.roles }))
  const wanted = new Set(plan.map((p) => `comfy-gpu${p.gpu}`))

  for (const c of managed) {
    if (!wanted.has(c.id)) {
      stopComfy(c.id)
      col.delete(c.id)
    }
  }
  plan.forEach((p, i) => {
    const id = `comfy-gpu${p.gpu}`
    const port = MANAGED_BASE_PORT + i
    const prev = col.get(id)
    const changed = !prev || prev.category !== 'comfy' || prev.managed?.port !== port || JSON.stringify(prev.roles) !== JSON.stringify(p.roles)
    col.put({
      id,
      name: `ComfyUI · ${names.get(p.gpu) ?? `GPU ${p.gpu}`}`,
      category: 'comfy',
      url: `http://127.0.0.1:${port}`,
      roles: p.roles,
      enabled: true,
      createdAt: prev?.createdAt ?? Date.now(),
      managed: { cudaDevice: p.gpu, port }
    })
    if (changed && processState(id) !== 'stopped') stopComfy(id)
  })
  // External instances would compete for the same work; switch them off.
  for (const c of comfyConnectors()) if (!c.managed && !c.node && c.enabled) col.put({ ...c, enabled: false })
  sync()
  setTimeout(() => {
    for (const c of comfyConnectors()) {
      if (c.managed && processState(c.id) === 'stopped') {
        try {
          launchComfy(c, () => void poll())
        } catch (err) {
          console.error('[comfy] launch failed', err)
        }
      }
    }
  }, 1500)
}

/** Every device in the layout: this PC's enabled GPUs (when Stitch runs ComfyUI) plus linked nodes' pooled GPUs. */
async function layoutPlan(localGpus?: number[]): Promise<{ device: Device; roles: GenKind[] }[]> {
  const s = getSettings().gpu
  const available = s.managed ? (localGpus ?? (await detectGpus()).map((g) => g.index)) : []
  const local: Device[] = s.managed ? enabledGpus(available).map((gpu) => ({ gpu })) : []
  return comfyPlan([...local, ...remotePool(isLinked)])
}

/**
 * ComfyUI on linked nodes: one connector per node GPU in the plan (`node-<id>-gpu<n>`), reached
 * through a local tunnel (its port changes per session). The node starts its ComfyUI when asked —
 * right away after "Apply layout", else when it comes online (with auto-launch) or a job waits.
 */
async function applyRemoteLayout(plan: { device: Device; roles: GenKind[] }[], startNow: boolean): Promise<void> {
  const col = db('connectors')
  const wanted = new Set<string>()
  for (const p of plan) {
    const node = p.device.node!
    const gpu = p.device.gpu
    const link = nodeLink(node)
    if (!link) continue
    const id = `node-${node}-gpu${gpu}`
    wanted.add(id)
    const url = `http://127.0.0.1:${await link.tunnel('comfy', gpu)}`
    const prev = col.get(id)
    const gpuName = link.hw?.gpus.find((g) => g.index === gpu)?.name.replace(/NVIDIA GeForce /i, '') ?? `GPU ${gpu}`
    const next: ComfyConnector = {
      id,
      name: `ComfyUI · ${link.rec.name} · ${gpuName}`,
      category: 'comfy',
      url,
      roles: p.roles,
      enabled: true,
      createdAt: prev?.createdAt ?? Date.now(),
      node: { node, gpu }
    }
    if (JSON.stringify(prev) !== JSON.stringify(next)) col.put(next)
  }
  for (const c of comfyConnectors()) if (c.node && !wanted.has(c.id)) col.delete(c.id)
  setWantedRemoteComfy(
    plan.map((p) => ({ node: p.device.node!, gpu: p.device.gpu })),
    startNow
  )
  sync()
}

/** Nodes came online or went away: refresh their tunnels and connectors. */
export async function refreshRemoteComfy(): Promise<void> {
  const plan = await layoutPlan()
  await applyRemoteLayout(plan.filter((p) => p.device.node), false)
}

export function autoLaunchComfy(): void {
  if (!getSettings().comfyAutoLaunch) return
  for (const c of comfyConnectors()) if (c.managed && c.enabled) {
    try {
      launchComfy(c, () => void poll())
    } catch (err) {
      console.error('[comfy] auto-launch failed', err)
    }
  }
}

export function shutdownComfy(): void {
  for (const inst of instances.values()) inst.client.close()
  stopAllComfy()
}
