import type { ApiGraph } from './client'

export type Link = [string, number]

/** Small helper for assembling ComfyUI API-format graphs. */
export class Graph {
  readonly nodes: ApiGraph = {}
  private next = 1

  add(classType: string, inputs: Record<string, unknown>, title?: string): string {
    const id = String(this.next++)
    const clean: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(inputs)) if (v !== undefined) clean[k] = v
    this.nodes[id] = { class_type: classType, inputs: clean, ...(title ? { _meta: { title } } : {}) }
    return id
  }

  /** Output slot reference. */
  static out(id: string, slot = 0): Link {
    return [id, slot]
  }
}

export const out = Graph.out

export const ASPECTS: Record<string, number> = {
  '1:1': 1,
  '16:9': 16 / 9,
  '9:16': 9 / 16,
  '4:3': 4 / 3,
  '3:4': 3 / 4,
  '3:2': 3 / 2,
  '2:3': 2 / 3,
  '21:9': 21 / 9
}

/** Width/height for an aspect ratio at a total pixel budget (1 MP = 1024²). */
export function dims(aspect: string, megapixels: number, multiple = 16): { width: number; height: number } {
  const ar = ASPECTS[aspect] ?? 1
  const total = megapixels * 1024 * 1024
  const w = Math.sqrt(total * ar)
  const h = w / ar
  const r = (v: number): number => Math.max(multiple, Math.round(v / multiple) * multiple)
  return { width: r(w), height: r(h) }
}

/** H3 frame count for a duration: 24 fps snapped up to the 17k+5 grid. */
export function h3Frames(seconds: number): number {
  const f = Math.max(5, Math.round(seconds * 24))
  return f + ((((5 - (f % 17)) % 17) + 17) % 17)
}

export function randomSeed(): number {
  return Math.floor(Math.random() * 2 ** 48)
}
