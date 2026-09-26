// Generation job queue: routes jobs to ComfyUI instances, tracks progress over
// the websocket, downloads outputs into the library and runs origin hooks.
import { existsSync, statSync } from 'node:fs'
import { extname, isAbsolute } from 'node:path'
import { nanoid } from 'nanoid'
import type { Asset, Character, ComfyConnector, GenJob, GenRequest, RecipeInfo } from '@shared/types'
import { emit } from '../../ipc'
import { db } from '../../store'
import { kindForPath, saveBytes } from '../assets'
import type { ComfyClient, OutputFile } from './client'
import { autoPickFlagged, recipeById, RECIPES, setFlaggedModels, type Models, type RecipeDef } from './recipes'
import { cachedLibrary, listLocal } from '../models/library'
import { scanModelsDir } from './process'
import { notifyFinished, updateTaskbar } from '../native'

export interface Instance {
  connector: ComfyConnector
  client: ComfyClient
  online: boolean
  models: Models
  modelsAt: number
  gpu?: string
  vramTotal?: number
  vramFree?: number
  queueRemaining: number
  version?: string
}

const MODEL_FOLDERS = ['diffusion_models', 'text_encoders', 'vae', 'loras', 'checkpoints']
const MAX_INFLIGHT = 2

const jobs = new Map<string, GenJob>()
const waiters = new Map<string, ((j: GenJob) => void)[]>()
const inflight = new Map<string, Set<string>>() // connectorId → job ids
const uploadCache = new Map<string, string>() // `${connector}|${path}|${mtime}` → comfy name
let getInstances: () => Instance[] = () => []

export function initJobs(instances: () => Instance[]): void {
  getInstances = instances
  // Jobs ComfyUI accepted before Stitch closed keep running there — reattach
  // to them. Jobs that never reached ComfyUI can't be recovered.
  for (const saved of db('jobs').list()) {
    let j = { ...saved, preview: undefined }
    if (j.status === 'queued' || j.status === 'running') {
      if (j.promptId && j.connectorId) orphans.add(j.id)
      else {
        j = { ...j, status: 'error', error: 'Interrupted — Stitch was closed' }
        db('jobs').put(j, true)
      }
    }
    if (Date.now() - j.createdAt < 3 * 24 * 3600 * 1000 || orphans.has(j.id)) jobs.set(j.id, j)
  }
  setInterval(() => void reconcile(), 3000)
}

/**
 * Safety net next to the websocket: poll ComfyUI for every job it has
 * accepted. Catches results that finished while Stitch was closed, missed
 * websocket events and dropped connections.
 */
const orphans = new Set<string>()
const misses = new Map<string, number>()
let reconciling = false
async function reconcile(): Promise<void> {
  if (reconciling) return
  reconciling = true
  try {
    const active = [...jobs.values()].filter((j) => j.promptId && (j.status === 'queued' || j.status === 'running'))
    for (const j of active) {
      const inst = getInstances().find((i) => i.connector.id === j.connectorId && i.online)
      if (!inst) continue
      try {
        const hist = await inst.client.history(j.promptId!)
        const entry = hist[j.promptId!]
        if (entry) {
          misses.delete(j.id)
          if (entry.status?.status_str === 'error') {
            finishInflight(j)
            orphans.delete(j.id)
            update(j.id, { status: 'error', error: 'Failed in ComfyUI — see its log', finishedAt: Date.now(), preview: undefined }, true)
            pump()
          } else if (entry.status?.completed !== false) await finalize(j, inst)
          continue
        }
        const q = await inst.client.queue()
        const running = q.queue_running.some((item) => Array.isArray(item) && item[1] === j.promptId)
        const pending = q.queue_pending.some((item) => Array.isArray(item) && item[1] === j.promptId)
        if (running || pending) {
          misses.delete(j.id)
          if (running && j.status === 'queued') update(j.id, { status: 'running', startedAt: j.startedAt ?? Date.now() }, true)
          if (orphans.has(j.id)) {
            const set = inflight.get(inst.connector.id) ?? new Set()
            set.add(j.id)
            inflight.set(inst.connector.id, set)
          }
          continue
        }
        // Between leaving the queue and appearing in history there's a short gap.
        const n = (misses.get(j.id) ?? 0) + 1
        misses.set(j.id, n)
        if (n >= 3) {
          misses.delete(j.id)
          orphans.delete(j.id)
          finishInflight(j)
          update(j.id, { status: 'error', error: 'ComfyUI lost this job (was it restarted?)', finishedAt: Date.now(), preview: undefined }, true)
          pump()
        }
      } catch {
        /* try again next tick */
      }
    }
  } finally {
    reconciling = false
  }
}

export async function refreshModels(inst: Instance, force = false): Promise<void> {
  if (!force && Date.now() - inst.modelsAt < 60_000 && Object.keys(inst.models).length) return
  const models: Models = {}
  for (const f of MODEL_FOLDERS) {
    try {
      models[f] = await inst.client.models(f)
    } catch {
      models[f] = []
    }
  }
  inst.models = models
  inst.modelsAt = Date.now()
}

/** Union of models across online instances, or a disk scan when none are up. */
export function knownModels(): Models {
  const online = getInstances().filter((i) => i.online && Object.keys(i.models).length)
  const out: Models = {}
  if (online.length) {
    for (const f of MODEL_FOLDERS) out[f] = [...new Set(online.flatMap((i) => i.models[f] ?? []))].sort()
    return out
  }
  for (const f of MODEL_FOLDERS) out[f] = scanModelsDir(f)
  return out
}

/** A recipe's required files that `models` lacks. */
export function recipeUnmet(r: RecipeDef, models: Models): RecipeDef['requires'] {
  return r.requires.filter((req) => {
    if (req.optional) return false
    const files = models[req.folder] ?? []
    return !(req.name ? files.some((f) => f === req.name || f.endsWith('/' + req.name)) : files.some((f) => req.match!.test(f)))
  })
}

function checkRequirements(r: RecipeDef, models: Models): string[] {
  return recipeUnmet(r, models).map((q) => q.label)
}

/** Can this instance run the job's recipe with its own models? (Unknown model lists count as yes.) */
function capable(inst: Instance, job: GenJob): boolean {
  const r = recipeById(job.recipeId)
  if (!r || !Object.keys(inst.models).length) return true
  return recipeUnmet(r, inst.models).length === 0
}

let libraryScan: Promise<unknown> | null = null

export function listRecipes(): RecipeInfo[] {
  const models = knownModels()
  const library = cachedLibrary()
  if (library) setFlaggedModels(library.filter((m) => m.meta?.nsfw).map((m) => m.name))
  // First call: scan the library once so the flags are there next time.
  else libraryScan ??= listLocal().then(() => emit('models:changed', null)).catch(() => {})
  const builtins: RecipeInfo[] = RECIPES.map((r) => {
    const missing = checkRequirements(r, models)
    return {
      id: r.id, name: r.name, kind: r.kind, mode: r.mode, family: r.family, description: r.description,
      params: r.params, requires: r.requires.map((q) => ({ folder: q.folder, name: q.name ?? q.label })),
      estSeconds: r.estSeconds, builtin: true, available: missing.length === 0, missing, baseModelMatch: r.baseModelMatch,
      autoNsfw: missing.length === 0 && autoPickFlagged(r, models)
    }
  })
  const skills: RecipeInfo[] = db('skills').list().map((s) => ({
    id: `skill:${s.id}`, name: s.name, kind: s.kind, mode: 'skill', family: 'Skill', description: s.description,
    params: s.bindings.map((b) => ({ key: b.key, label: b.label, type: b.type, default: b.default, min: b.min, max: b.max, options: b.options })),
    requires: [], estSeconds: s.estSeconds, builtin: false, available: true, missing: []
  }))
  return [...builtins, ...skills]
}

// ─── queue ───────────────────────────────────────────────────────────────────

function publish(job: GenJob, persist: boolean): void {
  const prev = jobs.get(job.id)
  jobs.set(job.id, job)
  if (persist) db('jobs').put({ ...job, preview: undefined }, true)
  emit('gen:job', job)
  updateTaskbar([...jobs.values()])
  if (job.status === 'done' || job.status === 'error' || job.status === 'canceled') {
    for (const w of waiters.get(job.id) ?? []) w(job)
    waiters.delete(job.id)
    if (prev && prev.status !== job.status && job.status !== 'canceled') {
      notifyFinished(job, job.label ?? recipeById(job.recipeId)?.name ?? 'Generation')
    }
  }
}

function update(id: string, patch: Partial<GenJob>, persist = false): GenJob | undefined {
  const cur = jobs.get(id)
  if (!cur) return undefined
  const next = { ...cur, ...patch }
  publish(next, persist)
  return next
}

export function submit(req: GenRequest): GenJob[] {
  const known = req.recipeId.startsWith('skill:') || recipeById(req.recipeId)
  if (!known) throw new Error(`Unknown recipe ${req.recipeId}`)
  const kind = req.recipeId.startsWith('skill:')
    ? (db('skills').get(req.recipeId.slice(6))?.kind ?? 'image')
    : recipeById(req.recipeId)!.kind
  const count = Math.max(1, Math.min(8, req.batch ?? 1))
  const created: GenJob[] = []
  const baseSeed = typeof req.params.seed === 'number' && req.params.seed >= 0 ? req.params.seed : -1
  for (let i = 0; i < count; i++) {
    const params = { ...req.params }
    if (baseSeed >= 0) params.seed = baseSeed + i
    const job: GenJob = {
      id: nanoid(10), recipeId: req.recipeId, kind, params, status: 'queued', createdAt: Date.now(), outputs: [],
      label: req.label, projectId: req.projectId, origin: req.origin, characterIds: req.characterIds
    }
    publish(job, true)
    created.push(job)
  }
  pump()
  return created
}

export function listJobs(): GenJob[] {
  return [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 300)
}

export function clearFinished(): void {
  for (const j of [...jobs.values()]) {
    if (j.status === 'done' || j.status === 'error' || j.status === 'canceled') {
      jobs.delete(j.id)
      db('jobs').delete(j.id)
    }
  }
}

export function waitFor(id: string): Promise<GenJob> {
  const j = jobs.get(id)
  if (!j) return Promise.reject(new Error('Job not found'))
  if (j.status === 'done' || j.status === 'error' || j.status === 'canceled') return Promise.resolve(j)
  return new Promise((resolve) => waiters.set(id, [...(waiters.get(id) ?? []), resolve]))
}

export async function cancel(id: string): Promise<void> {
  const j = jobs.get(id)
  if (!j) return
  if (j.status === 'queued' && !j.promptId) {
    update(id, { status: 'canceled', finishedAt: Date.now() }, true)
    return
  }
  const inst = getInstances().find((i) => i.connector.id === j.connectorId)
  if (inst && j.promptId) {
    if (j.status === 'running') await inst.client.interrupt(j.promptId)
    else await inst.client.deleteQueued(j.promptId)
  }
  finishInflight(j)
  update(id, { status: 'canceled', finishedAt: Date.now(), preview: undefined }, true)
  pump()
}

function eligible(inst: Instance, job: GenJob): boolean {
  if (!inst.online || !inst.connector.enabled) return false
  const roles = inst.connector.roles
  return !roles.length || roles.includes(job.kind)
}

function finishInflight(job: GenJob): void {
  if (job.connectorId) inflight.get(job.connectorId)?.delete(job.id)
}

let pumping = false
export function pump(): void {
  if (pumping) return
  pumping = true
  try {
    const queued = [...jobs.values()].filter((j) => j.status === 'queued' && !j.promptId).sort((a, b) => a.createdAt - b.createdAt)
    for (const job of queued) {
      // Instances (e.g. a linked node) that lack the recipe's models only get the job when none has them —
      // then ComfyUI's own error explains what's missing.
      const eligibleNow = getInstances().filter((i) => eligible(i, job))
      const withModels = eligibleNow.filter((i) => capable(i, job))
      const candidates = (withModels.length ? withModels : eligibleNow)
        .map((i) => ({ i, load: inflight.get(i.connector.id)?.size ?? 0 }))
        .filter((c) => c.load < MAX_INFLIGHT)
        .sort((a, b) => a.load - b.load || (b.i.vramFree ?? 0) - (a.i.vramFree ?? 0))
      const target = candidates[0]?.i
      if (!target) continue
      const set = inflight.get(target.connector.id) ?? new Set()
      set.add(job.id)
      inflight.set(target.connector.id, set)
      job.connectorId = target.connector.id
      void dispatch(job, target)
    }
  } finally {
    pumping = false
  }
}

async function resolveMedia(inst: Instance, value: unknown): Promise<string | undefined> {
  if (typeof value !== 'string' || !value) return undefined
  let path = value
  if (!isAbsolute(value)) {
    const asset = db('assets').get(value)
    if (!asset) return value // already a ComfyUI input name
    path = asset.path
  }
  if (!existsSync(path)) throw new Error(`Input file missing: ${path}`)
  const key = `${inst.connector.id}|${path}|${statSync(path).mtimeMs}`
  const cached = uploadCache.get(key)
  if (cached) return cached
  const name = await inst.client.upload(path)
  uploadCache.set(key, name)
  return name
}

async function buildGraph(job: GenJob, inst: Instance): Promise<Record<string, { class_type: string; inputs: Record<string, unknown> }>> {
  if (job.recipeId.startsWith('skill:')) {
    const skill = db('skills').get(job.recipeId.slice(6))
    if (!skill) throw new Error('Skill not found')
    const graph = JSON.parse(JSON.stringify(skill.graph)) as typeof skill.graph
    for (const b of skill.bindings) {
      let v = job.params[b.key] ?? b.default
      if (v === undefined) continue
      if (b.type === 'image' || b.type === 'audio' || b.type === 'video') v = await resolveMedia(inst, v)
      if (b.type === 'seed' && (typeof v !== 'number' || v < 0)) v = Math.floor(Math.random() * 2 ** 48)
      if (graph[b.node]) graph[b.node].inputs[b.input] = v
    }
    return graph
  }
  const recipe = recipeById(job.recipeId)!
  const params: Record<string, unknown> = { ...job.params }
  for (const spec of recipe.params) {
    const v = params[spec.key]
    if (spec.type === 'image' || spec.type === 'audio' || spec.type === 'video') params[spec.key] = await resolveMedia(inst, v)
    if (spec.type === 'images' || spec.type === 'audios') {
      const arr = Array.isArray(v) ? v : v ? [v] : []
      const outArr: string[] = []
      for (const x of arr) {
        const r = await resolveMedia(inst, x)
        if (r) outArr.push(r)
      }
      params[spec.key] = outArr
    }
  }
  await refreshModels(inst)
  return recipe.build(params, inst.models).nodes
}

async function dispatch(job: GenJob, inst: Instance): Promise<void> {
  try {
    update(job.id, { connectorId: inst.connector.id })
    const graph = await buildGraph(job, inst)
    const promptId = await inst.client.queuePrompt(graph)
    update(job.id, { promptId }, true)
  } catch (err) {
    finishInflight(job)
    update(job.id, { status: 'error', error: err instanceof Error ? err.message : String(err), finishedAt: Date.now() }, true)
    pump()
  }
}

function jobByPrompt(promptId: string | undefined | null): GenJob | undefined {
  if (!promptId) return undefined
  for (const j of jobs.values()) if (j.promptId === promptId) return j
  return undefined
}

/** Wire an instance's websocket into the job tracker. */
export function attachInstance(inst: Instance): void {
  inst.client.on('message', (msg: { type: string; data: Record<string, unknown> }) => {
    const d = msg.data ?? {}
    const job = jobByPrompt(d.prompt_id as string | undefined)
    switch (msg.type) {
      case 'status': {
        const q = (d.status as { exec_info?: { queue_remaining?: number } } | undefined)?.exec_info?.queue_remaining
        if (typeof q === 'number') inst.queueRemaining = q
        break
      }
      case 'execution_start':
        if (job) update(job.id, { status: 'running', startedAt: Date.now() }, true)
        break
      case 'progress':
        if (job) update(job.id, { status: 'running', progress: { value: Number(d.value), max: Number(d.max), node: d.node as string | undefined } })
        break
      case 'execution_success':
        if (job) void finalize(job, inst)
        break
      case 'execution_error':
        if (job) {
          finishInflight(job)
          const msgText = `${d.node_type ?? 'Node'}: ${String(d.exception_message ?? 'failed').trim()}`
          update(job.id, { status: 'error', error: msgText, finishedAt: Date.now(), preview: undefined }, true)
          pump()
        }
        break
      case 'execution_interrupted':
        if (job) {
          finishInflight(job)
          update(job.id, { status: 'canceled', finishedAt: Date.now(), preview: undefined }, true)
          pump()
        }
        break
    }
  })
  inst.client.on('preview', (promptId: string | null, dataUrl: string) => {
    const job = jobByPrompt(promptId) ?? [...jobs.values()].find((j) => j.connectorId === inst.connector.id && j.status === 'running')
    if (job) update(job.id, { preview: dataUrl })
  })
  inst.client.on('open', () => {
    void refreshModels(inst, true)
    pump()
  })
}

/** An instance went away: fail its in-flight jobs so the UI doesn't hang. */
export function instanceLost(inst: Instance): void {
  for (const id of inflight.get(inst.connector.id) ?? []) {
    const j = jobs.get(id)
    if (j && (j.status === 'queued' || j.status === 'running')) {
      update(id, { status: 'error', error: `${inst.connector.name} disconnected`, finishedAt: Date.now(), preview: undefined }, true)
    }
  }
  inflight.delete(inst.connector.id)
}

const finalizing = new Set<string>()

async function finalize(job: GenJob, inst: Instance): Promise<void> {
  // Websocket success and the orphan poller can both land here.
  if (finalizing.has(job.id) || jobs.get(job.id)?.status === 'done') return
  finalizing.add(job.id)
  orphans.delete(job.id)
  try {
    const hist = await inst.client.history(job.promptId!)
    const entry = hist[job.promptId!]
    const files: OutputFile[] = []
    for (const nodeOut of Object.values(entry?.outputs ?? {})) {
      for (const key of ['images', 'gifs', 'videos', 'audio', 'video']) {
        const arr = nodeOut[key]
        if (Array.isArray(arr)) for (const f of arr as OutputFile[]) if (f?.filename && f.type === 'output') files.push(f)
      }
    }
    const recipe = recipeById(job.recipeId)
    const skill = job.recipeId.startsWith('skill:') ? db('skills').get(job.recipeId.slice(6)) : undefined
    const assets: Asset[] = []
    for (const f of files) {
      const kind = kindForPath(f.filename)
      if (!kind) continue
      const bytes = await inst.client.download(f)
      const prompt = typeof job.params.prompt === 'string' ? job.params.prompt : undefined
      const cleanParams = Object.fromEntries(Object.entries(job.params).filter(([, v]) => typeof v !== 'string' || v.length < 2000))
      assets.push(
        await saveBytes(bytes, kind, extname(f.filename), {
          name: job.label ?? recipe?.name ?? skill?.name ?? 'generation',
          source: 'generated', prompt, recipeId: job.recipeId, params: cleanParams,
          projectId: job.projectId, origin: job.origin, characterIds: job.characterIds
        })
      )
    }
    finishInflight(job)
    if (!assets.length) throw new Error('ComfyUI finished but produced no files')
    const done = update(job.id, { status: 'done', outputs: assets.map((a) => a.id), finishedAt: Date.now(), preview: undefined, progress: undefined }, true)
    if (done) runHooks(done, assets)
  } catch (err) {
    finishInflight(job)
    update(job.id, { status: 'error', error: err instanceof Error ? err.message : String(err), finishedAt: Date.now(), preview: undefined }, true)
  } finally {
    finalizing.delete(job.id)
  }
  pump()
}

/** Attach results to whatever asked for them, even if that screen is closed. */
function runHooks(job: GenJob, assets: Asset[]): void {
  const o = job.origin
  if (!o || !assets.length) return
  if (o.type === 'character' && o.sub) {
    const c = db('characters').get(o.id)
    if (c) {
      const sheet = { ...c.sheet, [o.sub]: assets[0].id } as Character['sheet']
      db('characters').put({ ...c, sheet, updatedAt: Date.now() })
    }
  }
  // Story covers (scenario or adventure): the first image becomes the cover.
  if ((o.type === 'scenario' || o.type === 'adventure') && o.sub === 'cover') {
    const cover = assets.find((x) => x.kind === 'image') ?? assets[0]
    if (o.type === 'scenario') {
      const s = db('scenarios').get(o.id)
      if (s) db('scenarios').put({ ...s, coverAssetId: cover.id, updatedAt: Date.now() })
    } else {
      const adv = db('adventures').get(o.id)
      if (adv) db('adventures').put({ ...adv, coverAssetId: cover.id, updatedAt: Date.now() })
    }
    return
  }
  if (o.type === 'adventure' && o.sub) {
    const adv = db('adventures').get(o.id)
    if (adv) {
      const actions = adv.actions.map((a) =>
        a.id === o.sub
          ? { ...a, media: [...(a.media ?? []), ...assets.map((x) => ({ assetId: x.id, kind: x.kind, role: (x.kind === 'video' ? 'animate' : 'see') as 'animate' | 'see' }))] }
          : a
      )
      db('adventures').put({ ...adv, actions, updatedAt: Date.now() })
    }
  }
}
