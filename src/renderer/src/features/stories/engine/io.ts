// Import / export of story cards, backups and plain-text transcripts.
// Scenario backups carry the sources of the scripts they use.
import { nanoid } from 'nanoid'
import type { Adventure, ID, Scenario, StoryCard, StoryCardType, StoryScript } from '@shared/types'
import { errorText, invoke } from '@/lib/api'
import { db, loadCollection } from '@/stores/db'
import { toast } from '@/stores/toast'
import { emptyPlot, newCard, newScenario } from './defaults'
import { isBuiltinId } from './scripts/builtin'
import { scriptsFromJson } from './scripts/importer'
import { loadScript } from './scripts/library'

const TYPES: StoryCardType[] = ['character', 'class', 'race', 'location', 'faction', 'custom']

function safeName(s: string): string {
  return (s || 'untitled').replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '').trim().slice(0, 80) || 'untitled'
}

export async function saveFile(defaultName: string, content: string, ext: 'json' | 'txt'): Promise<boolean> {
  try {
    const path = await invoke('sys:saveDialog', {
      defaultPath: `${safeName(defaultName)}.${ext}`,
      filters: [ext === 'json' ? { name: 'JSON', extensions: ['json'] } : { name: 'Text', extensions: ['txt'] }]
    })
    if (!path) return false
    await invoke('sys:writeText', path, content)
    toast.success('Exported', path)
    return true
  } catch (err) {
    toast.error('Export failed', errorText(err))
    return false
  }
}

export async function openJsonFile(title = 'Import JSON'): Promise<unknown | null> {
  const [path] = await invoke('sys:pickFiles', { filters: [{ name: 'JSON', extensions: ['json'] }], title })
  if (!path) return null
  try {
    return JSON.parse(await invoke('sys:readText', path))
  } catch (err) {
    toast.error('Could not read that file', errorText(err))
    return null
  }
}

/** Our card export, with AI Dungeon-style aliases for portability. */
export function cardsToJson(cards: StoryCard[]): string {
  return JSON.stringify(
    cards.map((c) => ({
      type: c.type === 'custom' ? (c.customType ?? 'custom') : c.type,
      title: c.name,
      keys: c.triggers,
      value: c.entry,
      description: c.notes,
      characterId: c.characterId
    })),
    null,
    2
  )
}

/** Accepts our export, AI Dungeon exports, or a backup with a `cards` array. */
export function cardsFromJson(data: unknown): StoryCard[] {
  const list = Array.isArray(data) ? data : data && typeof data === 'object' && Array.isArray((data as { cards?: unknown }).cards) ? (data as { cards: unknown[] }).cards : null
  if (!list) return []
  const out: StoryCard[] = []
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const str = (...keys: string[]): string => {
      for (const k of keys) if (typeof r[k] === 'string') return r[k] as string
      return ''
    }
    const t = String(r.type ?? 'character').toLowerCase()
    const type = (TYPES.includes(t as StoryCardType) ? t : 'custom') as StoryCardType
    const name = str('name', 'title')
    const entry = str('entry', 'value')
    if (!name && !entry) continue
    out.push(
      newCard({
        type,
        customType: type === 'custom' ? (typeof r.customType === 'string' ? r.customType : String(r.type ?? 'Custom')) : undefined,
        name,
        entry,
        triggers: typeof r.triggers === 'string' ? r.triggers : Array.isArray(r.keys) ? (r.keys as unknown[]).join(', ') : typeof r.keys === 'string' ? r.keys : name,
        notes: str('notes', 'description')
      })
    )
  }
  return out
}

export async function importCards(): Promise<StoryCard[]> {
  const data = await openJsonFile('Import story cards')
  if (data === null) return []
  const cards = cardsFromJson(data)
  if (!cards.length) toast.error('No story cards found in that file')
  else toast.success(`Imported ${cards.length} story card${cards.length === 1 ? '' : 's'}`)
  return cards
}

// ─── Scripts inside backups ─────────────────────────────────────────────────

/** Sources of every script the documents reference (built-ins travel by id only). */
async function bundledScripts(docs: { scripts?: { scriptId: ID }[] }[]): Promise<StoryScript[]> {
  const ids = [...new Set(docs.flatMap((d) => (d.scripts ?? []).map((r) => r.scriptId)))]
  const found = await Promise.all(ids.map((id) => loadScript(id).catch(() => undefined)))
  return found.filter((s): s is StoryScript => !!s).map((s) => (isBuiltinId(s.id) ? { ...s, library: '', input: '', context: '', output: '' } : s))
}

/** A scenario backup, including its scripts so the scenario keeps working elsewhere. */
export async function scenarioBackupJson(scenario: Scenario, children: Scenario[]): Promise<string> {
  const scripts = await bundledScripts([scenario, ...children])
  return JSON.stringify({ kind: 'stitch-scenario', version: 1, scenario, children, ...(scripts.length ? { scripts } : {}) }, null, 2)
}

export async function exportScenarioBackup(scenario: Scenario, children: Scenario[]): Promise<boolean> {
  return saveFile(scenario.title || 'scenario', await scenarioBackupJson(scenario, children), 'json')
}

export async function adventureBackupJson(adv: Adventure): Promise<string> {
  const scripts = await bundledScripts([adv])
  return JSON.stringify({ kind: 'stitch-adventure', version: 1, adventure: adv, ...(scripts.length ? { scripts } : {}) }, null, 2)
}

const sameCode = (a: StoryScript, b: Partial<StoryScript>): boolean => a.library === (b.library ?? '') && a.input === (b.input ?? '') && a.context === (b.context ?? '') && a.output === (b.output ?? '')

/** Add a backup's scripts to the library (reusing identical ones). Returns old id → local id. */
async function importBundledScripts(list: unknown): Promise<Map<ID, ID>> {
  const map = new Map<ID, ID>()
  if (!Array.isArray(list)) return map
  await loadCollection('scripts')
  const now = Date.now()
  for (const raw of list as Partial<StoryScript>[]) {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || isBuiltinId(raw.id)) continue
    const existing = db.get('scripts', raw.id)
    if (existing && sameCode(existing, raw)) {
      map.set(raw.id, raw.id)
      continue
    }
    const id = existing ? nanoid(10) : raw.id
    await db.put('scripts', {
      id,
      name: typeof raw.name === 'string' && raw.name.trim() ? raw.name : 'Imported script',
      author: raw.author,
      description: raw.description,
      source: raw.source === 'builtin' || raw.source === 'user' ? 'import' : (raw.source ?? 'import'),
      sourceUrl: raw.sourceUrl,
      license: raw.license,
      library: raw.library ?? '',
      input: raw.input ?? '',
      context: raw.context ?? '',
      output: raw.output ?? '',
      createdAt: now,
      updatedAt: now
    })
    map.set(raw.id, id)
  }
  return map
}

// ─── AI Dungeon scenario JSON ────────────────────────────────────────────────

/** Scenario data exported from AI Dungeon (its GraphQL shape), including gameCode scripts when present. */
async function scenarioFromAid(data: unknown): Promise<Scenario | null> {
  const pick = (d: unknown): Record<string, unknown> | null => {
    if (!d || typeof d !== 'object' || Array.isArray(d)) return null
    const o = d as Record<string, unknown>
    if (typeof o.prompt === 'string' || typeof o.memory === 'string' || Array.isArray(o.storyCards) || typeof o.gameCodeSharedLibrary === 'string') return o
    return pick(o.scenario) ?? pick((o.data as Record<string, unknown> | undefined)?.scenario)
  }
  const o = pick(data)
  if (!o) return null
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  const title = str(o.title) || 'Imported scenario'
  const instructions = str(o.instructions) || str((o.details as Record<string, unknown> | undefined)?.instructions)
  const scenario = newScenario({
    title,
    description: str(o.description),
    tags: Array.isArray(o.tags) ? (o.tags as unknown[]).filter((t): t is string => typeof t === 'string').slice(0, 10) : [],
    opening: str(o.prompt),
    plot: emptyPlot({ plotEssentials: str(o.memory), authorsNote: str(o.authorsNote), aiInstructions: instructions }),
    cards: cardsFromJson(o.storyCards ?? [])
  })
  const [draft] = scriptsFromJson({ gameCodeSharedLibrary: o.gameCodeSharedLibrary, gameCodeOnInput: o.gameCodeOnInput, gameCodeOnModelContext: o.gameCodeOnModelContext, gameCodeOnOutput: o.gameCodeOnOutput })
  if (draft) {
    await loadCollection('scripts')
    const now = Date.now()
    const script: StoryScript = { ...draft, id: nanoid(10), name: `${title} script`, source: 'import', library: draft.library ?? '', input: draft.input ?? '', context: draft.context ?? '', output: draft.output ?? '', createdAt: now, updatedAt: now }
    await db.put('scripts', script)
    scenario.scripts = [{ scriptId: script.id, enabled: true }]
    scenario.scriptsEnabled = true
  }
  return scenario
}

/** Import a scenario backup (with its multiple-choice children), remapping ids. */
export async function importScenarioBackup(): Promise<Scenario | null> {
  const data = await openJsonFile('Import scenario backup')
  return data ? importScenarioData(data) : null
}

/** Import parsed backup data: a Stitch scenario backup, or AI Dungeon scenario JSON. */
export async function importScenarioData(raw: unknown): Promise<Scenario | null> {
  const data = (raw && typeof raw === 'object' ? raw : {}) as { kind?: string; scenario?: Scenario; children?: Scenario[]; scripts?: unknown }
  if (!data.scenario || typeof data.scenario !== 'object' || !('plot' in data.scenario)) {
    const aid = await scenarioFromAid(data)
    if (aid) {
      await db.put('scenarios', aid)
      toast.success('AI Dungeon scenario imported', aid.scripts?.length ? `${aid.title} · with its scripts` : aid.title)
      return aid
    }
    toast.error('That file is not a Stitch scenario backup')
    return null
  }
  const all = [data.scenario, ...(data.children ?? [])]
  const ids = new Map(all.map((s) => [s.id, nanoid(10)]))
  const scriptIds = await importBundledScripts(data.scripts)
  const now = Date.now()
  const docs = all.map((s) => ({
    ...s,
    id: ids.get(s.id)!,
    parentId: s.parentId ? ids.get(s.parentId) : undefined,
    choices: (s.choices ?? []).map((c) => ids.get(c)).filter((c): c is string => !!c),
    cards: (s.cards ?? []).map((c) => ({ ...c, id: nanoid(10) })),
    scripts: s.scripts?.map((r) => ({ ...r, scriptId: scriptIds.get(r.scriptId) ?? r.scriptId })),
    createdAt: now,
    updatedAt: now
  }))
  for (const d of docs.slice(1)) await db.put('scenarios', d)
  await db.put('scenarios', docs[0])
  toast.success('Scenario imported', docs[0].title || 'Untitled')
  return docs[0]
}
