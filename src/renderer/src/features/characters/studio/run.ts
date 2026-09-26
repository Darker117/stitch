// Runs Character Studio workflows. Values flow along edges (graph.ts); Portrait and Edit render
// through the normal job queue, Character saves to the cast, Sheet queues the character sheet.
// Runs live at module level, so they finish (and save their results) even if the Studio closes.
import { create } from 'zustand'
import type { Asset, Character, CharacterFlow, CharacterVoice, FlowNode, GenJob, ID, RecipeInfo } from '@shared/types'
import { errorText, invoke, parseJsonLoose } from '@/lib/api'
import { pickEditRecipe, pickTextImageRecipe, takesImages } from '@/lib/characters'
import { defaultLlm } from '@/lib/llm'
import { db } from '@/stores/db'
import { useGen, waitForJob } from '@/stores/gen'
import { createCharacter, generateSheet } from '../sheet'
import { inputsOf, signature, SPECS, topo, type Brief, type ModelValue } from './graph'

export interface NodeRun {
  status: 'running' | 'done' | 'error'
  error?: string
  jobIds?: ID[]
}

interface RunState {
  nodes: Record<string, NodeRun>
  /** Flows running end to end. */
  flows: Record<string, boolean>
}

export const useRuns = create<RunState>(() => ({ nodes: {}, flows: {} }))

const setRun = (nodeId: string, r: NodeRun | null): void =>
  useRuns.setState((s) => {
    const nodes = { ...s.nodes }
    if (r) nodes[nodeId] = r
    else delete nodes[nodeId]
    return { nodes }
  })

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

function getFlow(flowId: ID): CharacterFlow {
  const f = db.get('flows', flowId)
  if (!f) throw new Error('This workflow was deleted')
  return f
}

export function patchNode(flowId: ID, nodeId: string, patch: Record<string, unknown>): Promise<unknown> {
  return db.update('flows', flowId, (f) => ({
    ...f,
    nodes: f.nodes.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, ...patch } } : n)),
    updatedAt: Date.now()
  }))
}

function recipeById(id: string | undefined): RecipeInfo | undefined {
  return id ? useGen.getState().recipes.find((r) => r.id === id) : undefined
}

function ensureAvailable(r: RecipeInfo): void {
  if (!r.available) throw new Error(`${r.name} isn't ready${r.missing?.length ? ` — missing ${r.missing.join(', ')}` : ''}. Start ComfyUI or pick another model.`)
}

/** Model file + LoRAs from a Model/LoRA chain, applied only to the recipe they were picked for. */
function modelParams(mv: ModelValue | undefined, recipe: RecipeInfo): Record<string, unknown> {
  if (!mv) return {}
  if (mv.recipeId && mv.recipeId !== recipe.id) return {}
  return Object.fromEntries(Object.entries({ model: mv.recipeId ? mv.model : undefined, loras: mv.loras }).filter(([, v]) => v !== undefined && v !== '' && !(Array.isArray(v) && !v.length)))
}

const FRAMING: Record<string, string> = {
  head: 'Head-and-shoulders character portrait, facing the camera',
  half: 'Half-body character portrait, facing the camera',
  full: 'Full-body character design, standing, the whole outfit visible from head to shoes'
}

async function render(flowId: ID, node: FlowNode, recipe: RecipeInfo, params: Record<string, unknown>, count: number, label: string, sig: string): Promise<ID[]> {
  ensureAvailable(recipe)
  const jobs: GenJob[] = await useGen.getState().submit({
    recipeId: recipe.id,
    params,
    batch: Math.max(1, Math.min(4, count)),
    label,
    origin: { type: 'flow', id: flowId, sub: node.id }
  })
  const ids = jobs.map((j) => j.id)
  setRun(node.id, { status: 'running', jobIds: ids })
  await patchNode(flowId, node.id, { pending: ids, pendingSig: sig })
  return collect(ids)
}

async function collect(jobIds: ID[]): Promise<ID[]> {
  const done = await Promise.all(jobIds.map((id) => waitForJob(id)))
  const outputs = done.flatMap((j) => j.outputs)
  if (!outputs.length) {
    const err = done.find((j) => j.status === 'error')?.error
    throw new Error(done.every((j) => j.status === 'canceled') ? 'Canceled' : (err ?? 'Nothing came back from the render'))
  }
  return outputs
}

/** Store fresh results: a changed setup replaces old picks; re-running the same setup adds more to choose from. */
async function keepResults(flowId: ID, node: FlowNode, sig: string, fresh: ID[]): Promise<void> {
  const cur = getFlow(flowId).nodes.find((n) => n.id === node.id) ?? node
  const same = cur.data.sig === sig
  const old = same && Array.isArray(cur.data.results) ? (cur.data.results as ID[]) : []
  const results = [...fresh, ...old.filter((id) => !fresh.includes(id))].slice(0, 12)
  const selected = same && str(cur.data.selected) && results.includes(str(cur.data.selected)) ? str(cur.data.selected) : fresh[0]
  await patchNode(flowId, node.id, { results, selected, sig, pending: null, pendingSig: null })
}

async function runPortrait(flowId: ID, node: FlowNode, inputs: Record<string, unknown>, sig: string): Promise<void> {
  const brief = inputs.brief as Brief | undefined
  const look = brief?.appearance.trim() || brief?.concept.trim()
  if (!look) throw new Error('Describe the character in the Idea node first')
  const mv = inputs.model as ModelValue | undefined
  const ref = str(inputs.image) || undefined
  const recipes = useGen.getState().recipes
  let recipe = recipeById(mv?.recipeId)
  if (!recipe) recipe = ref ? (pickEditRecipe(recipes) ?? pickTextImageRecipe(recipes)) : pickTextImageRecipe(recipes)
  if (!recipe) throw new Error('No image model is available. Start ComfyUI and check Models.')
  const withRef = !!ref && takesImages(recipe)
  const d = node.data
  const keep = withRef ? (recipe.id === 'flux2-klein' ? 'Keep the exact same person from image 1: identical face, hair and skin tone' : 'Keep the exact same person from <image1>: identical face, hair and skin tone') : ''
  const prompt = [
    keep,
    FRAMING[str(d.framing)] ?? FRAMING.half,
    look,
    str(d.style) && `Style: ${str(d.style)}`,
    'Plain soft studio background, even lighting, sharp focus, highly detailed',
    mv?.words.length ? mv.words.join(', ') : ''
  ]
    .filter(Boolean)
    .join('. ')
  const params: Record<string, unknown> = { prompt, aspect: str(d.aspect) || '3:4', ...modelParams(mv, recipe) }
  if (withRef) params.images = [ref]
  const out = await render(flowId, node, recipe, params, Number(d.count ?? 4), `${brief?.name || 'Character'} · Portrait`, sig)
  await keepResults(flowId, node, sig, out)
}

async function runEdit(flowId: ID, node: FlowNode, inputs: Record<string, unknown>, sig: string): Promise<void> {
  const image = str(inputs.image)
  if (!image) throw new Error('Connect an image to edit')
  const instruction = str(node.data.instruction).trim()
  if (!instruction) throw new Error('Say what to change')
  const mv = inputs.model as ModelValue | undefined
  const recipes = useGen.getState().recipes
  let recipe = recipeById(mv?.recipeId)
  if (!takesImages(recipe)) recipe = pickEditRecipe(recipes) ?? recipes.find((r) => r.id === 'flux-kontext' && r.available)
  if (!recipe) throw new Error('Edits need Qwen Image 2.1 Edit, Flux 2 Klein or Flux Kontext. Start ComfyUI and check Models.')
  const keep = recipe.id === 'flux2-klein' ? 'Keep the same person from image 1 — identical face, hair and skin tone.' : 'Keep the same person from <image1> — identical face, hair and skin tone.'
  const words = mv?.words.length ? ` ${mv.words.join(', ')}` : ''
  const params = { prompt: `${instruction}. ${keep}${words}`, images: [image], sizeFrom: 'reference', aspect: '3:4', ...modelParams(mv, recipe) }
  const out = await render(flowId, node, recipe, params, Number(node.data.count ?? 2), 'Character · Edit', sig)
  await keepResults(flowId, node, sig, out)
}

async function runCharacter(flowId: ID, node: FlowNode, inputs: Record<string, unknown>, sig: string): Promise<void> {
  const image = str(inputs.image)
  if (!image) throw new Error('Connect a reference — a Portrait, Edit or Reference node')
  const brief = inputs.brief as Brief | undefined
  const voice: CharacterVoice | undefined = (inputs.voice as CharacterVoice | undefined) ?? (brief?.voice ? { design: brief.voice } : undefined)
  const name = brief?.name.trim() || 'New character'
  const existing = str(node.data.characterId) ? db.get('characters', str(node.data.characterId)) : undefined
  let c: Character
  if (existing) {
    const patch: Partial<Character> = { referenceAssetId: image, updatedAt: Date.now() }
    if (brief?.name.trim()) patch.name = name
    if (brief?.appearance.trim()) patch.appearance = brief.appearance.trim()
    if (brief?.personality.trim()) patch.description = brief.personality.trim()
    if (voice) patch.voice = voice
    await db.patch('characters', existing.id, patch)
    c = { ...existing, ...patch }
  } else {
    c = await createCharacter({ name, referenceAssetId: image, detail: 'studio', appearance: brief?.appearance.trim() })
    const extra: Partial<Character> = {}
    if (brief?.personality.trim()) extra.description = brief.personality.trim()
    if (voice) extra.voice = voice
    if (Object.keys(extra).length) await db.patch('characters', c.id, extra)
  }
  // The picked render belongs to this character now (it shows under their generations).
  const asset: Asset | undefined = db.get('assets', image)
  if (asset && !asset.characterIds?.includes(c.id)) await db.patch('assets', image, { characterIds: [...(asset.characterIds ?? []), c.id] })
  await patchNode(flowId, node.id, { characterId: c.id, sig })
}

async function runSheet(flowId: ID, node: FlowNode, inputs: Record<string, unknown>, sig: string): Promise<void> {
  const id = str(inputs.character)
  const c = id ? db.get('characters', id) : undefined
  if (!c) throw new Error('Run the Character node first')
  const detail = node.data.detail === 'compact' ? 'compact' : 'studio'
  if (c.sheetDetail !== detail) await db.patch('characters', c.id, { sheetDetail: detail })
  const mv = inputs.model as ModelValue | undefined
  let recipe = recipeById(mv?.recipeId)
  if (!takesImages(recipe)) recipe = pickEditRecipe()
  if (recipe) ensureAvailable(recipe)
  const params = recipe && mv?.recipeId === recipe.id ? { ...modelParams(mv, recipe), words: mv.words } : undefined
  await generateSheet({ ...c, sheetDetail: detail }, undefined, { recipe, params })
  await patchNode(flowId, node.id, { sig })
}

/** Is the node's last result still current? */
function upToDate(flow: CharacterFlow, node: FlowNode): boolean {
  const sig = signature(flow, node)
  if (node.data.sig !== sig) return false
  if (node.kind === 'portrait' || node.kind === 'edit') return Array.isArray(node.data.results) && node.data.results.length > 0
  if (node.kind === 'character') return !!db.get('characters', str(node.data.characterId))
  if (node.kind === 'sheet') {
    const c = db.get('characters', str(inputsOf(flow, node).character))
    return !!c && Object.keys(c.sheet).length > 0
  }
  return true
}

/** Run one node with whatever its inputs currently hold. */
export async function runNode(flowId: ID, nodeId: string): Promise<void> {
  if (useRuns.getState().nodes[nodeId]?.status === 'running') return
  const flow = getFlow(flowId)
  const node = flow.nodes.find((n) => n.id === nodeId)
  if (!node) return
  const inputs = inputsOf(flow, node)
  const sig = signature(flow, node)
  const missing = SPECS[node.kind].inputs.filter((p) => p.required && inputs[p.id] === undefined)
  setRun(nodeId, { status: 'running' })
  try {
    if (missing.length) throw new Error(`Connect ${missing.map((p) => p.label.toLowerCase()).join(' and ')} first${missing.some((p) => p.type === 'image') ? ' (and run it)' : ''}`)
    if (node.kind === 'portrait') await runPortrait(flowId, node, inputs, sig)
    else if (node.kind === 'edit') await runEdit(flowId, node, inputs, sig)
    else if (node.kind === 'character') await runCharacter(flowId, node, inputs, sig)
    else if (node.kind === 'sheet') await runSheet(flowId, node, inputs, sig)
    setRun(nodeId, { status: 'done' })
  } catch (err) {
    await patchNode(flowId, nodeId, { pending: null, pendingSig: null }).catch(() => {})
    setRun(nodeId, { status: 'error', error: errorText(err) })
    throw err
  }
}

/** Run the whole workflow in order, skipping steps whose results are still current. */
export async function runFlow(flowId: ID, opts: { force?: boolean } = {}): Promise<void> {
  if (useRuns.getState().flows[flowId]) return
  useRuns.setState((s) => ({ flows: { ...s.flows, [flowId]: true } }))
  try {
    for (const n of topo(getFlow(flowId))) {
      if (!SPECS[n.kind].runs) continue
      const flow = getFlow(flowId)
      const node = flow.nodes.find((x) => x.id === n.id)
      if (!node || (!opts.force && upToDate(flow, node))) continue
      await runNode(flowId, node.id)
    }
  } finally {
    useRuns.setState((s) => {
      const flows = { ...s.flows }
      delete flows[flowId]
      return { flows }
    })
  }
}

/** Renders still queued from an earlier visit (or before a restart): pick their results up. */
export function resumePending(flow: CharacterFlow): void {
  for (const node of flow.nodes) {
    const pending = Array.isArray(node.data.pending) ? (node.data.pending as ID[]) : []
    if (!pending.length || useRuns.getState().nodes[node.id]) continue
    const sig = str(node.data.pendingSig) || signature(flow, node)
    setRun(node.id, { status: 'running', jobIds: pending })
    collect(pending)
      .then((out) => keepResults(flow.id, node, sig, out))
      .then(() => setRun(node.id, { status: 'done' }))
      .catch(async (err) => {
        await patchNode(flow.id, node.id, { pending: null, pendingSig: null }).catch(() => {})
        setRun(node.id, { status: 'error', error: errorText(err) })
      })
  }
}

/** Idea node: let the default text model invent the name, look, personality and voice. */
export async function expandIdea(flowId: ID, nodeId: string): Promise<void> {
  const llm = defaultLlm()
  if (!llm) throw new Error('Add a text model under Connectors first')
  const node = getFlow(flowId).nodes.find((n) => n.id === nodeId)
  if (!node) return
  const concept = str(node.data.concept).trim()
  const name = str(node.data.name).trim()
  if (!concept && !name) throw new Error('Write the idea first')
  const r = await invoke('llm:complete', {
    connectorId: llm.connectorId,
    model: llm.model,
    system:
      'You design characters for stories and image generation. Reply with one JSON object only: {"name": string, "appearance": string, "personality": string, "voice": string}. appearance: 40–70 words for image prompts — apparent age, build, face, eyes, hair, skin, outfit, accessories, distinctive marks; no name, no story. personality: 2–3 sentences on temperament, history and what they want. voice: one short line describing how they sound (pitch, pace, accent, texture).',
    messages: [{ role: 'user', content: `Character idea: ${concept || '(none)'}${name ? `\nTheir name is ${name} — keep it.` : ''}` }],
    maxTokens: 700,
    temperature: 0.85,
    json: true
  })
  const j = parseJsonLoose<Partial<Record<'name' | 'appearance' | 'personality' | 'voice', unknown>>>(r.text)
  if (!j) throw new Error("The model's answer wasn't usable — try again or pick another model")
  const pick = (k: 'name' | 'appearance' | 'personality' | 'voice'): string | undefined => (typeof j[k] === 'string' && (j[k] as string).trim() ? (j[k] as string).trim() : undefined)
  const patch: Record<string, unknown> = {}
  if (!name && pick('name')) patch.name = pick('name')
  for (const k of ['appearance', 'personality', 'voice'] as const) if (pick(k)) patch[k] = pick(k)
  await patchNode(flowId, nodeId, patch)
}
