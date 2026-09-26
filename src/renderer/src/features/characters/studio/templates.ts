// Starter workflows for the Character Studio. Opening one saves an editable copy.
import { nanoid } from 'nanoid'
import type { CharacterFlow, FlowEdge, FlowNode, FlowNodeKind } from '@shared/types'
import { db } from '@/stores/db'
import { SPECS } from './graph'

export interface FlowTemplate {
  id: string
  name: string
  blurb: string
  build: () => { nodes: FlowNode[]; edges: FlowEdge[] }
}

function graph(spec: [key: string, kind: FlowNodeKind, x: number, y: number, data?: Record<string, unknown>][], links: [from: string, fromPort: string, to: string, toPort: string][]): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const ids = new Map(spec.map(([k]) => [k, nanoid(8)]))
  const nodes = spec.map(([k, kind, x, y, data]) => ({ id: ids.get(k)!, kind, x, y, data: { ...SPECS[kind].defaults(), ...data } }))
  const edges = links.map(([a, ap, b, bp]) => {
    const from = ids.get(a)!
    const to = ids.get(b)!
    return { id: `${from}.${ap}-${to}.${bp}`, from, fromPort: ap, to, toPort: bp }
  })
  return { nodes, edges }
}

export const TEMPLATES: FlowTemplate[] = [
  {
    id: 'idea',
    name: 'From an idea',
    blurb: 'Describe them, render portraits, save the favourite with a voice and a full sheet.',
    build: () =>
      graph(
        [
          ['idea', 'idea', 0, 0],
          ['model', 'model', 0, 580],
          ['portrait', 'portrait', 380, 40],
          ['char', 'character', 760, 40],
          ['voice', 'voice', 760, 340],
          ['sheet', 'sheet', 1140, 40]
        ],
        [
          ['idea', 'brief', 'portrait', 'brief'],
          ['model', 'model', 'portrait', 'model'],
          ['idea', 'brief', 'char', 'brief'],
          ['portrait', 'image', 'char', 'image'],
          ['voice', 'voice', 'char', 'voice'],
          ['char', 'character', 'sheet', 'character']
        ]
      )
  },
  {
    id: 'loras',
    name: 'Styled with LoRAs',
    blurb: 'A checkpoint plus a stack of LoRAs for a signature look.',
    build: () =>
      graph(
        [
          ['idea', 'idea', 0, 0],
          ['model', 'model', 0, 580],
          ['lora1', 'lora', 0, 820],
          ['lora2', 'lora', 0, 1060],
          ['portrait', 'portrait', 380, 40],
          ['char', 'character', 760, 40],
          ['sheet', 'sheet', 1140, 40]
        ],
        [
          ['model', 'model', 'lora1', 'model'],
          ['lora1', 'model', 'lora2', 'model'],
          ['idea', 'brief', 'portrait', 'brief'],
          ['lora2', 'model', 'portrait', 'model'],
          ['idea', 'brief', 'char', 'brief'],
          ['portrait', 'image', 'char', 'image'],
          ['char', 'character', 'sheet', 'character']
        ]
      )
  },
  {
    id: 'photo',
    name: 'From a photo',
    blurb: 'Lock a character straight from an image you already have.',
    build: () =>
      graph(
        [
          ['ref', 'reference', 0, 0],
          ['idea', 'idea', 0, 480],
          ['char', 'character', 380, 120],
          ['sheet', 'sheet', 760, 120]
        ],
        [
          ['ref', 'image', 'char', 'image'],
          ['idea', 'brief', 'char', 'brief'],
          ['char', 'character', 'sheet', 'character']
        ]
      )
  },
  {
    id: 'outfits',
    name: 'New outfit',
    blurb: 'Restyle a reference — clothes, hair, era — and keep the face.',
    build: () =>
      graph(
        [
          ['ref', 'reference', 0, 0],
          ['edit', 'edit', 380, 0, { instruction: 'Change their outfit to a long charcoal wool coat over a dark turtleneck' }],
          ['char', 'character', 760, 0]
        ],
        [
          ['ref', 'image', 'edit', 'image'],
          ['edit', 'image', 'char', 'image']
        ]
      )
  },
  { id: 'blank', name: 'Blank canvas', blurb: 'Build your own from scratch.', build: () => ({ nodes: [], edges: [] }) }
]

/** Save a fresh copy of a template and return it. */
export async function createFlow(templateId: string, name?: string): Promise<CharacterFlow> {
  const t = TEMPLATES.find((x) => x.id === templateId) ?? TEMPLATES[0]
  const now = Date.now()
  const flow: CharacterFlow = { id: nanoid(10), name: name ?? t.name, template: t.id, ...t.build(), createdAt: now, updatedAt: now }
  await db.put('flows', flow)
  return flow
}
