// Scripts that ship with Stitch. Both are LewdLeah's MIT-licensed AI Dungeon
// scripts, bundled unmodified from their GitHub repositories (Auto-Cards @
// c8a4e4d, Inner Self v1.0.2 @ 297a1a0); each folder keeps its LICENSE. The
// sources are large, so they load on first use rather than with the app.
import type { StoryScript } from '@shared/types'
import type { HookName } from './types'
import autoCardsLicense from './builtin/auto-cards/LICENSE?raw'
import innerSelfLicense from './builtin/inner-self/LICENSE?raw'

type Sources = Pick<StoryScript, 'library' | 'input' | 'context' | 'output'>

export interface BuiltinScript {
  id: string
  name: string
  author: string
  description: string
  license: string
  licenseText: string
  sourceUrl: string
  version: string
  hooks: HookName[]
  /** Built-ins that already contain this one (warn when both run). */
  includes?: string[]
  load: () => Promise<Sources>
}

async function sources(mods: Promise<{ default: string }>[]): Promise<Sources> {
  const [library, input, context, output] = await Promise.all(mods)
  return { library: library.default, input: input.default, context: context.default, output: output.default }
}

export const BUILTIN_SCRIPTS: BuiltinScript[] = [
  {
    id: 'builtin:auto-cards',
    name: 'Auto-Cards',
    author: 'LewdLeah',
    description:
      'Watches your story and automatically writes plot-relevant story cards for new characters, places and things, then keeps their memories up to date. It starts switched off: after your first turn, edit the "Edit to enable Auto-Cards" story card to true. Then tune it in the "Configure Auto-Cards" card, or type /ac Name to request a card.',
    license: 'MIT',
    licenseText: autoCardsLicense,
    sourceUrl: 'https://github.com/LewdLeah/Auto-Cards',
    version: '2025',
    hooks: ['input', 'context', 'output'],
    load: () =>
      sources([
        import('./builtin/auto-cards/library.js?raw'),
        import('./builtin/auto-cards/input.js?raw'),
        import('./builtin/auto-cards/context.js?raw'),
        import('./builtin/auto-cards/output.js?raw')
      ])
  },
  {
    id: 'builtin:inner-self',
    name: 'Inner Self',
    author: 'LewdLeah',
    description:
      'Gives the characters in your story minds of their own: private memories, goals, secrets and plans that they revise as the story unfolds. Brains live in "@Name" story cards (edit them in the notes); read the "Configure Inner Self" card to add NPCs. Includes Auto-Cards (off by default).',
    license: 'MIT',
    licenseText: innerSelfLicense,
    sourceUrl: 'https://github.com/LewdLeah/Inner-Self',
    version: 'v1.0.2',
    hooks: ['input', 'context', 'output'],
    includes: ['builtin:auto-cards'],
    load: () =>
      sources([
        import('./builtin/inner-self/library.js?raw'),
        import('./builtin/inner-self/input.js?raw'),
        import('./builtin/inner-self/context.js?raw'),
        import('./builtin/inner-self/output.js?raw')
      ])
  }
]

export function builtin(id: string): BuiltinScript | undefined {
  return BUILTIN_SCRIPTS.find((b) => b.id === id)
}

export function isBuiltinId(id: string): boolean {
  return id.startsWith('builtin:')
}

/** Catalog entry without code (sources are loaded with `loadBuiltin`). */
export function builtinStub(b: BuiltinScript): StoryScript {
  return {
    id: b.id,
    name: b.name,
    author: b.author,
    description: b.description,
    source: 'builtin',
    sourceUrl: b.sourceUrl,
    license: b.license,
    library: '',
    input: '',
    context: '',
    output: '',
    createdAt: 0,
    updatedAt: 0
  }
}

const loaded = new Map<string, Promise<StoryScript>>()

export function loadBuiltin(b: BuiltinScript): Promise<StoryScript> {
  let p = loaded.get(b.id)
  if (!p) {
    p = b.load().then((src) => ({ ...builtinStub(b), ...src }))
    p.catch(() => loaded.delete(b.id))
    loaded.set(b.id, p)
  }
  return p
}
