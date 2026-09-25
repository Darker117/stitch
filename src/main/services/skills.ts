// Skills: user-imported ComfyUI workflows exposed as one-click generators.
import { nanoid } from 'nanoid'
import type { GenKind, ParamType, SkillDoc } from '@shared/types'
import { handle } from '../ipc'
import { allInstances } from './comfy'

type ApiGraph = SkillDoc['graph']
type Binding = SkillDoc['bindings'][number]

interface UiNode {
  id: number
  type: string
  mode?: number
  inputs?: { name: string; type: string; link: number | null; widget?: { name: string } }[]
  outputs?: { name: string; type: string; links?: number[] | null }[]
  widgets_values?: unknown[] | Record<string, unknown>
  title?: string
}

interface UiWorkflow {
  nodes: UiNode[]
  links: (number | string)[][] | { id: number; origin_id: number; origin_slot: number; target_id: number; target_slot: number; type: string }[]
  definitions?: { subgraphs?: unknown[] }
}

const LINK_TYPES = new Set(['MODEL', 'CLIP', 'VAE', 'CONDITIONING', 'LATENT', 'IMAGE', 'MASK', 'AUDIO', 'VIDEO', 'CONTROL_NET', 'SIGMAS', 'SAMPLER', 'GUIDER', 'NOISE', 'CLIP_VISION', 'CLIP_VISION_OUTPUT', 'STYLE_MODEL', 'UPSCALE_MODEL', 'GLIGEN', 'WEBCAM'])

type InputSpec = [unknown, Record<string, unknown>?]

function isWidget(spec: InputSpec): boolean {
  const t = spec[0]
  if (Array.isArray(t)) return true
  if (typeof t !== 'string') return false
  if (LINK_TYPES.has(t) || t === '*' || t.includes(',')) return false
  return ['INT', 'FLOAT', 'STRING', 'BOOLEAN', 'COMBO'].includes(t)
}

/** Best-effort conversion of a UI-format workflow (no subgraphs) to API format. */
function uiToApi(ui: UiWorkflow, objectInfo: Record<string, { input: { required?: Record<string, InputSpec>; optional?: Record<string, InputSpec> } }>): ApiGraph {
  if (ui.definitions?.subgraphs?.length) {
    throw new Error('This workflow uses subgraphs. In ComfyUI choose Workflow → Export (API) and import that file instead.')
  }
  const links = new Map<number, [number, number]>()
  for (const l of ui.links as unknown[]) {
    if (Array.isArray(l)) links.set(Number(l[0]), [Number(l[1]), Number(l[2])])
    else {
      const o = l as { id: number; origin_id: number; origin_slot: number }
      links.set(o.id, [o.origin_id, o.origin_slot])
    }
  }
  const byId = new Map(ui.nodes.map((n) => [n.id, n]))
  const resolve = (linkId: number | null | undefined, guard = 0): [string, number] | undefined => {
    if (linkId == null || guard > 20) return undefined
    const l = links.get(linkId)
    if (!l) return undefined
    const src = byId.get(l[0])
    if (!src) return undefined
    if (src.type === 'Reroute' || src.mode === 4) {
      const through = src.inputs?.find((i) => i.link != null)
      return resolve(through?.link, guard + 1)
    }
    return [String(src.id), l[1]]
  }
  const graph: ApiGraph = {}
  for (const n of ui.nodes) {
    if (n.mode === 2 || n.mode === 4) continue
    const info = objectInfo[n.type]
    if (!info) continue // notes, reroutes, frontend-only nodes
    const inputs: Record<string, unknown> = {}
    const specs: [string, InputSpec][] = [...Object.entries(info.input.required ?? {}), ...Object.entries(info.input.optional ?? {})]
    const wv = n.widgets_values
    if (wv && !Array.isArray(wv)) {
      for (const [k] of specs) if (k in wv) inputs[k] = wv[k]
    } else if (Array.isArray(wv)) {
      let i = 0
      for (const [name, spec] of specs) {
        if (!isWidget(spec)) continue
        if (i >= wv.length) break
        inputs[name] = wv[i++]
        const opts = spec[1] ?? {}
        if (opts.control_after_generate || ((name === 'seed' || name === 'noise_seed') && spec[0] === 'INT')) i++
        if (opts.image_upload || opts.audio_upload || opts.video_upload) i++
      }
    }
    for (const inp of n.inputs ?? []) {
      const src = resolve(inp.link)
      if (src) inputs[inp.widget?.name ?? inp.name] = src
    }
    graph[String(n.id)] = { class_type: n.type, inputs, ...(n.title ? { _meta: { title: n.title } } : {}) }
  }
  return graph
}

function detectKind(graph: ApiGraph): GenKind {
  const types = Object.values(graph).map((n) => n.class_type)
  if (types.some((t) => /SaveVideo|VideoCombine|SaveAnimated|SaveWEBM/i.test(t))) return 'video'
  if (types.some((t) => /SaveAudio/i.test(t))) return 'audio'
  return 'image'
}

function detectBindings(graph: ApiGraph): Binding[] {
  const out: Binding[] = []
  const used = new Set<string>()
  const add = (b: Omit<Binding, 'key'> & { key?: string }): void => {
    let key = b.key ?? b.label.toLowerCase().replace(/[^a-z0-9]+/g, '_')
    let n = 2
    while (used.has(key)) key = `${b.key ?? key}_${n++}`
    used.add(key)
    out.push({ ...b, key } as Binding)
  }
  // Which text encoders feed a sampler's negative input?
  const negatives = new Set<string>()
  for (const n of Object.values(graph)) {
    const neg = n.inputs.negative
    if (Array.isArray(neg)) negatives.add(String(neg[0]))
  }
  let prompts = 0
  let images = 0
  let audios = 0
  for (const [id, n] of Object.entries(graph)) {
    const title = n._meta?.title
    const textKey = ['text', 'prompt', 'value', 'tags'].find((k) => typeof n.inputs[k] === 'string')
    const isTextNode = /TextEncode|PrimitiveString|H3ImageToVideo|H3ReferenceToVideo|StringMultiline/i.test(n.class_type)
    if (textKey && isTextNode) {
      const neg = negatives.has(id) || /neg/i.test(title ?? '')
      if (neg) add({ key: 'negative', label: 'Negative prompt', type: 'text', node: id, input: textKey, default: n.inputs[textKey] })
      else add({ key: prompts++ ? undefined : 'prompt', label: prompts > 1 ? title ?? `Prompt ${prompts}` : 'Prompt', type: prompts > 1 ? 'text' : 'prompt', node: id, input: textKey, default: n.inputs[textKey] })
    }
    if (n.class_type === 'LoadImage') add({ key: images++ ? undefined : 'image', label: title && title !== 'Load Image' ? title : `Image ${images}`, type: 'image', node: id, input: 'image' })
    if (/LoadAudio/.test(n.class_type)) add({ key: audios++ ? undefined : 'audio', label: title ?? `Audio ${audios}`, type: 'audio', node: id, input: 'audio' })
    if (n.class_type === 'LoadVideo') add({ label: title ?? 'Video', type: 'video' as ParamType, node: id, input: 'file' })
    for (const seedKey of ['seed', 'noise_seed']) {
      if (typeof n.inputs[seedKey] === 'number' && !used.has('seed')) add({ key: 'seed', label: 'Seed', type: 'seed', node: id, input: seedKey, default: -1 })
    }
    if (/KSampler$|BasicScheduler/.test(n.class_type) && typeof n.inputs.steps === 'number' && !used.has('steps')) {
      add({ key: 'steps', label: 'Steps', type: 'int', node: id, input: 'steps', default: n.inputs.steps, min: 1, max: 150 })
    }
    if (/EmptyLatentImage|EmptyFlux2LatentImage|EmptySD3LatentImage/.test(n.class_type) && typeof n.inputs.width === 'number' && !used.has('width')) {
      add({ key: 'width', label: 'Width', type: 'int', node: id, input: 'width', default: n.inputs.width, min: 64, max: 4096 })
      add({ key: 'height', label: 'Height', type: 'int', node: id, input: 'height', default: n.inputs.height, min: 64, max: 4096 })
    }
  }
  return out
}

export async function analyzeWorkflow(json: string, name?: string): Promise<SkillDoc> {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new Error('That file is not valid JSON')
  }
  let graph: ApiGraph
  const obj = parsed as Record<string, unknown>
  if (Array.isArray(obj.nodes)) {
    const inst = allInstances().find((i) => i.online)
    if (!inst) throw new Error('Start ComfyUI first — converting a UI workflow needs its node definitions.')
    const info = (await inst.client.objectInfo()) as Parameters<typeof uiToApi>[1]
    graph = uiToApi(obj as unknown as UiWorkflow, info)
  } else if (Object.values(obj).every((n) => typeof n === 'object' && n !== null && 'class_type' in n)) {
    graph = obj as ApiGraph
  } else {
    throw new Error('Unrecognised workflow format')
  }
  const now = Date.now()
  return {
    id: nanoid(10),
    name: name ?? 'Imported skill',
    description: `Custom ComfyUI workflow · ${Object.keys(graph).length} nodes`,
    kind: detectKind(graph),
    graph,
    bindings: detectBindings(graph),
    createdAt: now,
    updatedAt: now
  }
}

export function registerSkills(): void {
  handle('skills:analyze', (json, name) => analyzeWorkflow(json, name))
}
