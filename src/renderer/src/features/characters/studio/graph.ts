// Character Studio node catalogue: what each node takes, what it gives, and how values flow along edges.
import type { CharacterFlow, CharacterVoice, FlowEdge, FlowNode, FlowNodeKind, ID, LoraRef } from '@shared/types'

export type PortType = 'text' | 'image' | 'model' | 'character' | 'voice'

export interface PortSpec {
  id: string
  type: PortType
  label: string
  required?: boolean
}

export interface NodeSpec {
  kind: FlowNodeKind
  title: string
  blurb: string
  group: 'Start' | 'Look' | 'Make' | 'Finish'
  inputs: PortSpec[]
  outputs: PortSpec[]
  /** Does work when the workflow runs (renders, saves) instead of only passing values along. */
  runs?: boolean
  defaults: () => Record<string, unknown>
}

/** Port colours come from the theme accents only. */
export const PORT_COLOR: Record<PortType, string> = {
  text: 'color-mix(in oklab, var(--fg) 78%, var(--accent-2))',
  image: 'var(--accent)',
  model: 'var(--accent-2)',
  character: 'color-mix(in oklab, var(--accent) 55%, var(--accent-2))',
  voice: 'color-mix(in oklab, var(--accent-2) 55%, white)'
}

/** What the flow carries between nodes. */
export interface Brief {
  name: string
  concept: string
  appearance: string
  personality: string
  voice: string
}

export interface ModelValue {
  recipeId?: string
  /** Model file for the recipe's model picker ('' = the recipe's automatic pick). */
  model?: string
  loras: LoraRef[]
  /** LoRA activation words to add to prompts. */
  words: string[]
}

export const SPECS: Record<FlowNodeKind, NodeSpec> = {
  idea: {
    kind: 'idea',
    title: 'Idea',
    blurb: 'Who they are, in a sentence. AI fills in the look and personality.',
    group: 'Start',
    inputs: [],
    outputs: [{ id: 'brief', type: 'text', label: 'Brief' }],
    defaults: () => ({ concept: '', name: '', appearance: '', personality: '', voice: '' })
  },
  reference: {
    kind: 'reference',
    title: 'Reference',
    blurb: 'Start from a photo or art you already have.',
    group: 'Start',
    inputs: [],
    outputs: [{ id: 'image', type: 'image', label: 'Image' }],
    defaults: () => ({})
  },
  model: {
    kind: 'model',
    title: 'Image model',
    blurb: 'The model family and checkpoint used to render.',
    group: 'Look',
    inputs: [],
    outputs: [{ id: 'model', type: 'model', label: 'Model' }],
    defaults: () => ({ recipeId: '', model: '' })
  },
  lora: {
    kind: 'lora',
    title: 'LoRA',
    blurb: 'A style or character LoRA. Chain as many as you like.',
    group: 'Look',
    inputs: [{ id: 'model', type: 'model', label: 'Model', required: true }],
    outputs: [{ id: 'model', type: 'model', label: 'Model' }],
    defaults: () => ({ name: '', strength: 0.8, useWords: true })
  },
  portrait: {
    kind: 'portrait',
    title: 'Portrait',
    blurb: 'Renders candidates from the brief. Pick your favourite.',
    group: 'Make',
    runs: true,
    inputs: [
      { id: 'brief', type: 'text', label: 'Brief', required: true },
      { id: 'model', type: 'model', label: 'Model' },
      { id: 'image', type: 'image', label: 'Reference' }
    ],
    outputs: [{ id: 'image', type: 'image', label: 'Pick' }],
    defaults: () => ({ framing: 'half', style: '', aspect: '3:4', count: 4 })
  },
  edit: {
    kind: 'edit',
    title: 'Edit',
    blurb: 'Change the outfit, hair or setting. The face stays.',
    group: 'Make',
    runs: true,
    inputs: [
      { id: 'image', type: 'image', label: 'Image', required: true },
      { id: 'model', type: 'model', label: 'Edit model' }
    ],
    outputs: [{ id: 'image', type: 'image', label: 'Pick' }],
    defaults: () => ({ instruction: '', count: 2 })
  },
  voice: {
    kind: 'voice',
    title: 'Voice',
    blurb: 'Clone, design or pick the voice they speak with.',
    group: 'Finish',
    inputs: [],
    outputs: [{ id: 'voice', type: 'voice', label: 'Voice' }],
    defaults: () => ({})
  },
  character: {
    kind: 'character',
    title: 'Character',
    blurb: 'Saves everything to your cast.',
    group: 'Finish',
    runs: true,
    inputs: [
      { id: 'brief', type: 'text', label: 'Brief' },
      { id: 'image', type: 'image', label: 'Reference', required: true },
      { id: 'voice', type: 'voice', label: 'Voice' }
    ],
    outputs: [{ id: 'character', type: 'character', label: 'Character' }],
    defaults: () => ({})
  },
  sheet: {
    kind: 'sheet',
    title: 'Character sheet',
    blurb: 'Every angle, expression and light from the reference.',
    group: 'Finish',
    runs: true,
    inputs: [
      { id: 'character', type: 'character', label: 'Character', required: true },
      { id: 'model', type: 'model', label: 'Edit model' }
    ],
    outputs: [{ id: 'character', type: 'character', label: 'Character' }],
    defaults: () => ({ detail: 'studio' })
  }
}

export const GROUPS: NodeSpec['group'][] = ['Start', 'Look', 'Make', 'Finish']

// ─── Graph helpers ───────────────────────────────────────────────────────────

export function portOf(kind: FlowNodeKind, id: string, dir: 'in' | 'out'): PortSpec | undefined {
  return (dir === 'in' ? SPECS[kind].inputs : SPECS[kind].outputs).find((p) => p.id === id)
}

/** The edge feeding a node's input port, if any. */
export function edgeInto(flow: CharacterFlow, nodeId: string, port: string): FlowEdge | undefined {
  return flow.edges.find((e) => e.to === nodeId && e.toPort === port)
}

/** Nodes downstream of `id` (itself included) — never valid sources for it. */
export function descendants(flow: CharacterFlow, id: string): Set<string> {
  const out = new Set<string>([id])
  const stack = [id]
  while (stack.length) {
    const cur = stack.pop()!
    for (const e of flow.edges) {
      if (e.from === cur && !out.has(e.to)) {
        out.add(e.to)
        stack.push(e.to)
      }
    }
  }
  return out
}

/** Can `from.fromPort` feed `to.toPort`? Types must match and it may not close a loop. */
export function canConnect(flow: CharacterFlow, from: string, fromPort: string, to: string, toPort: string): boolean {
  const a = flow.nodes.find((n) => n.id === from)
  const b = flow.nodes.find((n) => n.id === to)
  if (!a || !b || from === to) return false
  const out = portOf(a.kind, fromPort, 'out')
  const inp = portOf(b.kind, toPort, 'in')
  if (!out || !inp || out.type !== inp.type) return false
  return !descendants(flow, to).has(from)
}

/** Add an edge, replacing whatever fed that input before. */
export function connect(flow: CharacterFlow, from: string, fromPort: string, to: string, toPort: string): FlowEdge[] {
  const rest = flow.edges.filter((e) => !(e.to === to && e.toPort === toPort))
  return [...rest, { id: `${from}.${fromPort}-${to}.${toPort}`, from, fromPort, to, toPort }]
}

/** Nodes in dependency order (upstream first); nodes stuck in a loop come last. */
export function topo(flow: CharacterFlow): FlowNode[] {
  const indeg = new Map(flow.nodes.map((n) => [n.id, 0]))
  for (const e of flow.edges) if (indeg.has(e.to) && indeg.has(e.from)) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1)
  // Left-to-right, top-to-bottom among peers, so the order matches the canvas.
  const byPos = [...flow.nodes].sort((a, b) => a.x - b.x || a.y - b.y)
  const out: FlowNode[] = []
  const done = new Set<string>()
  let progressed = true
  while (progressed) {
    progressed = false
    for (const n of byPos) {
      if (done.has(n.id) || (indeg.get(n.id) ?? 0) > 0) continue
      out.push(n)
      done.add(n.id)
      progressed = true
      for (const e of flow.edges) if (e.from === n.id) indeg.set(e.to, (indeg.get(e.to) ?? 1) - 1)
    }
  }
  for (const n of byPos) if (!done.has(n.id)) out.push(n)
  return out
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** The value a node puts on one of its output ports right now. */
export function valueOf(flow: CharacterFlow, nodeId: string, seen: Set<string> = new Set()): unknown {
  const node = flow.nodes.find((n) => n.id === nodeId)
  if (!node || seen.has(nodeId)) return undefined
  seen.add(nodeId)
  const d = node.data
  const input = (port: string): unknown => {
    const e = edgeInto(flow, nodeId, port)
    return e ? valueOf(flow, e.from, new Set(seen)) : undefined
  }
  switch (node.kind) {
    case 'idea':
      return { name: str(d.name), concept: str(d.concept), appearance: str(d.appearance), personality: str(d.personality), voice: str(d.voice) } satisfies Brief
    case 'reference':
      return str(d.assetId) || undefined
    case 'model':
      return { recipeId: str(d.recipeId) || undefined, model: str(d.model) || undefined, loras: [], words: [] } satisfies ModelValue
    case 'lora': {
      const up = input('model') as ModelValue | undefined
      const base: ModelValue = up ?? { loras: [], words: [] }
      if (!str(d.name)) return base
      const words = d.useWords !== false && Array.isArray(d.words) ? (d.words as string[]) : []
      return { ...base, loras: [...base.loras, { name: str(d.name), strength: typeof d.strength === 'number' ? d.strength : 0.8 }], words: [...base.words, ...words] }
    }
    case 'portrait':
    case 'edit': {
      const results = Array.isArray(d.results) ? (d.results as ID[]) : []
      return str(d.selected) && results.includes(str(d.selected)) ? str(d.selected) : results[0]
    }
    case 'voice':
      return (d.voice as CharacterVoice | undefined) ?? undefined
    case 'character':
      return str(d.characterId) || undefined
    case 'sheet':
      return input('character')
  }
}

/** Values arriving at each input port of a node. */
export function inputsOf(flow: CharacterFlow, node: FlowNode): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const p of SPECS[node.kind].inputs) {
    const e = edgeInto(flow, node.id, p.id)
    if (e) out[p.id] = valueOf(flow, e.from)
  }
  return out
}

/** Settings that decide a node's result (results and bookkeeping excluded). */
export function settingsOf(node: FlowNode): Record<string, unknown> {
  const { results: _r, selected: _s, pending: _p, pendingSig: _q, sig: _g, characterId: _c, ...rest } = node.data
  return rest
}

/** Fingerprint of what a node would produce — unchanged means its last result still stands. */
export function signature(flow: CharacterFlow, node: FlowNode): string {
  return JSON.stringify([settingsOf(node), inputsOf(flow, node)])
}
