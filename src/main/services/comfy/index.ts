import type { ComfyStatus } from '@shared/ipc'
import type { ComfyConnector } from '@shared/types'
import { emit, handle } from '../../ipc'
import { getSettings } from '../../settings'
import { db } from '../../store'
import { registerTester } from '../connectors'
import { comfyPlan, enabledGpus } from '../gpu'
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

function statusOf(inst: Instance): ComfyStatus {
  const managed = !!inst.connector.managed
  const ps = processState(inst.connector.id)
  return {
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
  handle('comfy:launch', (id) => {
    const c = db('connectors').get(id)
    if (!c || c.category !== 'comfy') throw new Error('ComfyUI connector not found')
    launchComfy(c, () => void poll())
  })
  handle('comfy:stop', (id) => stopComfy(id))
  handle('comfy:logs', (id) => processLogs(id))
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

  if (!s.managed) {
    for (const c of managed) {
      stopComfy(c.id)
      col.delete(c.id)
    }
    if (!comfyConnectors().length) {
      col.put({ id: 'comfy-local', name: 'ComfyUI', category: 'comfy', url: 'http://127.0.0.1:8188', roles: [], enabled: true, createdAt: Date.now() })
    }
    sync()
    return
  }

  const gpus = await detectGpus()
  const names = new Map(gpus.map((g) => [g.index, g.name.replace(/NVIDIA GeForce /i, '')]))
  const plan = comfyPlan(enabledGpus(gpus.map((g) => g.index)))
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
  for (const c of comfyConnectors()) if (!c.managed && c.enabled) col.put({ ...c, enabled: false })
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
