// On-device image generation as ordinary recipes: they appear in Create → Image under "On this phone",
// run through the same job tray (live previews, cancel), and the results land in the PC library.
import { Capacitor } from '@capacitor/core'
import type { PluginListenerHandle } from '@capacitor/core'
import { nanoid } from 'nanoid'
import type { GenJob, GenRequest, ParamSpec, RecipeInfo } from '@shared/types'
import { emitLocal, merge, override, PASS } from '@mobile/bridge/router'
import type { CatalogModel } from './catalog'
import { sendToPc } from './outbox'
import { StitchDevice, type DeviceBackend } from './plugin'
import { backendAvailable, BACKEND_LABEL, catalogFor, isReady, modelById, resolveBackend, useDevice } from './store'

export const PHONE_RECIPE = 'phone:'

const ASPECTS = ['1:1', '3:4', '4:3', '9:16', '16:9', '2:3', '3:2']

function backendParam(m: CatalogModel): ParamSpec {
  const options = [{ value: 'auto', label: 'Auto (fastest available)' }]
  for (const b of ['npu', 'gpu', 'cpu'] as DeviceBackend[]) {
    if (!m.backends.includes(b)) continue
    // Runtimes differ per format (e.g. stable-diffusion.cpp's GPU path isn't the ONNX one): prefer the per-format list.
    const rt = useDevice.getState().info?.runtimes?.[m.format]
    const ok = rt ? !!rt.find((x) => x.id === b)?.available : backendAvailable('image', b)
    options.push({ value: b, label: `${BACKEND_LABEL[b]}${ok ? '' : ' — not on this phone'}` })
  }
  return { key: 'backend', label: 'Run on', type: 'select', default: 'auto', options, help: 'NPU uses Qualcomm QNN on Snapdragon chips.' }
}

function recipeFor(m: CatalogModel): RecipeInfo {
  const ready = isReady(m)
  const fixed = m.config?.fixedResolution === true
  const params: ParamSpec[] = [
    { key: 'prompt', label: 'Prompt', type: 'prompt', default: '', required: true },
    { key: 'negative', label: 'Negative prompt', type: 'text', default: m.guidance && m.guidance > 1 ? 'blurry, low quality, deformed' : '', advanced: true },
    ...(fixed ? [] : [{ key: 'aspect', label: 'Aspect ratio', type: 'aspect', default: '1:1', options: ASPECTS.map((a) => ({ value: a, label: a })) } as ParamSpec]),
    backendParam(m),
    { key: 'steps', label: 'Steps', type: 'int', default: m.steps ?? 4, min: 1, max: 50, step: 1, advanced: true },
    { key: 'cfg', label: 'Guidance', type: 'number', default: m.guidance ?? 1, min: 0, max: 12, step: 0.5, advanced: true },
    { key: 'seed', label: 'Seed', type: 'seed', default: -1, advanced: true, help: '-1 picks a random seed' }
  ]
  const b = resolveBackend('image', m)
  return {
    id: PHONE_RECIPE + m.id,
    name: m.name,
    kind: 'image',
    mode: 'text',
    family: 'On this phone',
    description: `${m.description} Runs on this phone (${BACKEND_LABEL[b]}); results are saved to your PC.`,
    params,
    requires: [],
    available: ready,
    missing: ready ? [] : [`Download ${m.name} in More → This phone`],
    // Per-step seconds at 512 px (Pixel 8a CPU: ONNX ≈6 s, stable-diffusion.cpp ≈10–20 s), scaled by the model's area.
    estSeconds: Math.round((m.steps ?? 4) * (b === 'npu' ? 0.6 : b === 'gpu' ? 1.8 : m.format === 'sd-cpp' ? 16 : 6) * ((m.resolution ?? 512) / 512) ** 2),
    builtin: true
  }
}

export function phoneRecipes(): RecipeInfo[] {
  if (!useDevice.getState().native) return []
  return catalogFor('image').map(recipeFor)
}

/** Output size near the model's native area, snapped to multiples of 64. */
function dims(m: CatalogModel, aspect: string): { width: number; height: number } {
  const base = m.resolution ?? 512
  if (m.config?.fixedResolution) return { width: base, height: base }
  const [a, b] = aspect.split(':').map(Number)
  const ar = a && b ? a / b : 1
  const area = base * base
  const snap = (v: number): number => Math.max(256, Math.round(v / 64) * 64)
  return { width: snap(Math.sqrt(area * ar)), height: snap(Math.sqrt(area / ar)) }
}

// ─── Local job queue ─────────────────────────────────────────────────────────

const jobs = new Map<string, GenJob>()
const waiters = new Map<string, ((j: GenJob) => void)[]>()
let active: string | null = null

function put(job: GenJob): void {
  jobs.set(job.id, job)
  emitLocal('gen:job', job)
  if (job.status === 'done' || job.status === 'error' || job.status === 'canceled') {
    for (const w of waiters.get(job.id) ?? []) w(job)
    waiters.delete(job.id)
  }
}

function patch(id: string, p: Partial<GenJob>): GenJob | undefined {
  const cur = jobs.get(id)
  if (!cur) return undefined
  const next = { ...cur, ...p }
  put(next)
  return next
}

function slug(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, 48) || 'Phone image'
}

async function run(job: GenJob): Promise<void> {
  const m = modelById(job.recipeId.slice(PHONE_RECIPE.length))
  const st = m ? useDevice.getState().status[m.id] : undefined
  if (!m || !st?.ready) {
    patch(job.id, { status: 'error', error: `${m?.name ?? 'That model'} isn't downloaded — get it in More → This phone.`, finishedAt: Date.now() })
    return
  }
  const p = job.params
  const backend = resolveBackend('image', m, (p.backend as DeviceBackend | 'auto') ?? 'auto')
  const steps = Math.max(1, Math.round(Number(p.steps ?? m.steps ?? 4)))
  const seed = typeof p.seed === 'number' && p.seed >= 0 ? p.seed : Math.floor(Math.random() * 2 ** 31)
  const { width, height } = dims(m, String(p.aspect ?? '1:1'))
  patch(job.id, { status: 'running', startedAt: Date.now(), progress: { value: 0, max: steps, node: 'loading' } })

  let off: Promise<PluginListenerHandle> | null = null
  try {
    off = StitchDevice.addListener('image', (e) => {
      if (e.jobId !== job.id) return
      patch(job.id, { progress: { value: e.step, max: e.steps, node: e.phase }, ...(e.preview ? { preview: e.preview } : {}) })
    })
    const res = await StitchDevice.imageGenerate({
      jobId: job.id,
      modelId: m.id,
      backend,
      dir: st.dir,
      format: m.format,
      file: m.entry,
      prompt: String(p.prompt ?? ''),
      negativePrompt: p.negative ? String(p.negative) : undefined,
      steps,
      guidance: Number(p.cfg ?? m.guidance ?? 1),
      seed,
      width,
      height,
      scheduler: m.scheduler ?? 'euler',
      config: m.config
    })
    if (jobs.get(job.id)?.status === 'canceled') return
    patch(job.id, { progress: { value: steps, max: steps, node: 'saving' } })
    const asset = await sendToPc(res.path, 'image', 'png', {
      source: 'generated',
      name: slug(String(p.prompt ?? '')),
      prompt: String(p.prompt ?? ''),
      recipeId: job.recipeId,
      params: { ...p, seed: res.seed, backend: res.backend, device: useDevice.getState().info?.model, seconds: Math.round(res.seconds * 10) / 10 },
      projectId: job.projectId,
      origin: job.origin,
      characterIds: job.characterIds,
      width: res.width,
      height: res.height
    })
    patch(job.id, {
      status: 'done',
      finishedAt: Date.now(),
      outputs: asset ? [asset.id] : [],
      // Not uploaded yet: keep showing the phone copy.
      preview: asset ? undefined : Capacitor.convertFileSrc(res.path),
      error: asset ? undefined : 'Saved on the phone — it will upload to your PC when connected.'
    })
  } catch (err) {
    if (jobs.get(job.id)?.status === 'canceled') return
    const msg = err instanceof Error ? err.message : String(err)
    patch(job.id, { status: 'error', error: backend !== 'cpu' && !/cancel/i.test(msg) ? `${msg} — try "Run on: CPU"` : msg, finishedAt: Date.now(), preview: undefined })
  } finally {
    void off?.then((h) => h.remove())
  }
}

async function pump(): Promise<void> {
  if (active) return
  const next = [...jobs.values()].filter((j) => j.status === 'queued').sort((a, b) => a.createdAt - b.createdAt)[0]
  if (!next) return
  active = next.id
  try {
    await run(next)
  } finally {
    active = null
    void pump()
  }
}

function submit(req: GenRequest): GenJob[] {
  const n = Math.max(1, Math.min(8, req.batch ?? 1))
  const baseSeed = typeof req.params.seed === 'number' && req.params.seed >= 0 ? req.params.seed : -1
  const created: GenJob[] = []
  for (let i = 0; i < n; i++) {
    const params = { ...req.params }
    if (baseSeed >= 0) params.seed = baseSeed + i
    const job: GenJob = {
      id: `phone-${nanoid(10)}`,
      recipeId: req.recipeId,
      kind: 'image',
      params,
      status: 'queued',
      createdAt: Date.now() + i,
      outputs: [],
      connectorId: 'phone',
      label: req.label,
      projectId: req.projectId,
      origin: req.origin,
      characterIds: req.characterIds
    }
    put(job)
    created.push(job)
  }
  void pump()
  return created
}

export function installImage(): void {
  merge('gen:recipes', (list) => [...(list as RecipeInfo[]), ...phoneRecipes()])
  merge('gen:jobs', (list) => [...(list as GenJob[]), ...jobs.values()])

  override('gen:submit', ([r]) => {
    const req = r as GenRequest
    return req.recipeId.startsWith(PHONE_RECIPE) ? submit(req) : PASS
  })
  override('gen:cancel', async ([id]) => {
    const job = jobs.get(String(id))
    if (!job) return PASS
    if (job.status === 'running') await StitchDevice.imageCancel({ jobId: job.id }).catch(() => {})
    if (job.status === 'queued' || job.status === 'running') patch(job.id, { status: 'canceled', finishedAt: Date.now(), preview: undefined })
    return undefined
  })
  override('gen:wait', ([id]) => {
    const job = jobs.get(String(id))
    if (!job) return PASS
    if (job.status !== 'queued' && job.status !== 'running') return job
    return new Promise<GenJob>((resolve) => waiters.set(job.id, [...(waiters.get(job.id) ?? []), resolve]))
  })
  merge('gen:clearFinished', (res) => {
    for (const [id, j] of jobs) if (j.status !== 'queued' && j.status !== 'running') jobs.delete(id)
    return res
  })
}
