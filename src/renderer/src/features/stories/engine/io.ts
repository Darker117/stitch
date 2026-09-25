// Import / export of story cards, backups and plain-text transcripts.
import { nanoid } from 'nanoid'
import type { Scenario, StoryCard, StoryCardType } from '@shared/types'
import { errorText, invoke } from '@/lib/api'
import { db } from '@/stores/db'
import { toast } from '@/stores/toast'
import { newCard } from './defaults'

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

/** Import a scenario backup (with its multiple-choice children), remapping ids. */
export async function importScenarioBackup(): Promise<Scenario | null> {
  const data = (await openJsonFile('Import scenario backup')) as { kind?: string; scenario?: Scenario; children?: Scenario[] } | null
  if (!data) return null
  if (!data.scenario || typeof data.scenario !== 'object') {
    toast.error('That file is not a Stitch scenario backup')
    return null
  }
  const all = [data.scenario, ...(data.children ?? [])]
  const ids = new Map(all.map((s) => [s.id, nanoid(10)]))
  const now = Date.now()
  const docs = all.map((s) => ({
    ...s,
    id: ids.get(s.id)!,
    parentId: s.parentId ? ids.get(s.parentId) : undefined,
    choices: (s.choices ?? []).map((c) => ids.get(c)).filter((c): c is string => !!c),
    cards: (s.cards ?? []).map((c) => ({ ...c, id: nanoid(10) })),
    createdAt: now,
    updatedAt: now
  }))
  for (const d of docs.slice(1)) await db.put('scenarios', d)
  await db.put('scenarios', docs[0])
  toast.success('Scenario imported', docs[0].title || 'Untitled')
  return docs[0]
}
