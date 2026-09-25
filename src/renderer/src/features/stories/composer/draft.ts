// The scenario being composed: a flat, AI-friendly draft that turns into a
// real Scenario (+ scripts) when the user hits “Create scenario”.
import { nanoid } from 'nanoid'
import type { CreatorField, ID, Scenario, StoryCardType } from '@shared/types'
import { db } from '@/stores/db'
import { CARD_TYPES, DEFAULT_INSTRUCTIONS, emptyPlot, LIMITS, newCard, newScenario } from '../engine/defaults'
import { stripMarkdown } from './json'

export type SectionId = 'premise' | 'world' | 'cards' | 'opening' | 'rules' | 'scripts'
export type SectionState = 'empty' | 'proposed' | 'accepted'

export const SECTIONS: { id: SectionId; label: string; hint: string }[] = [
  { id: 'premise', label: 'Premise', hint: 'Title, pitch and tags' },
  { id: 'world', label: 'World', hint: 'Plot essentials and backstory' },
  { id: 'cards', label: 'Cast & places', hint: 'Story cards the AI remembers' },
  { id: 'opening', label: 'Opening', hint: 'How the adventure begins' },
  { id: 'rules', label: 'Rules', hint: "AI instructions and author's note" },
  { id: 'scripts', label: 'Scripts', hint: 'Mechanics that run every turn' }
]

export interface CardDraft {
  id: string
  type: StoryCardType
  customType?: string
  name: string
  entry: string
  triggers: string
  /** Player-facing blurb (character creator options). */
  notes?: string
}

export interface ScriptValidation {
  ok: boolean
  errors: string[]
  logs: string[]
}

export interface ScriptDraft {
  id: string
  /** What the user asked for, in their words. */
  request: string
  name: string
  description: string
  library: string
  input: string
  context: string
  output: string
  status: 'writing' | 'checking' | 'ready' | 'error'
  validation?: ScriptValidation
  /** Attach to the scenario on create. */
  attach: boolean
  reasoning?: string
  error?: string
}

export interface ScenarioDraft {
  title: string
  description: string
  tags: string[]
  plotEssentials: string
  storySummary: string
  /** Extra narrator rules, appended to the Stitch default instructions. */
  aiInstructions: string
  authorsNote: string
  openingType: 'story' | 'characterCreator'
  opening: string
  /** Character creator fields (label → story card type). */
  creatorFields: { label: string; cardType: StoryCardType }[]
  cards: CardDraft[]
  scripts: ScriptDraft[]
  sections: Record<SectionId, SectionState>
}

export function emptyDraft(): ScenarioDraft {
  return {
    title: '',
    description: '',
    tags: [],
    plotEssentials: '',
    storySummary: '',
    aiInstructions: '',
    authorsNote: '',
    openingType: 'story',
    opening: '',
    creatorFields: [],
    cards: [],
    scripts: [],
    sections: { premise: 'empty', world: 'empty', cards: 'empty', opening: 'empty', rules: 'empty', scripts: 'empty' }
  }
}

/** Which draft fields belong to which section. */
export const SECTION_FIELDS: Record<Exclude<SectionId, 'scripts'>, (keyof ScenarioDraft)[]> = {
  premise: ['title', 'description', 'tags'],
  world: ['plotEssentials', 'storySummary'],
  cards: ['cards'],
  opening: ['openingType', 'opening', 'creatorFields'],
  rules: ['aiInstructions', 'authorsNote']
}

export function sectionOf(field: keyof ScenarioDraft): SectionId | undefined {
  for (const [s, fields] of Object.entries(SECTION_FIELDS)) if (fields.includes(field)) return s as SectionId
  return undefined
}

export function sectionFilled(d: ScenarioDraft, s: SectionId): boolean {
  switch (s) {
    case 'premise':
      return !!(d.title.trim() || d.description.trim())
    case 'world':
      return !!(d.plotEssentials.trim() || d.storySummary.trim())
    case 'cards':
      return d.cards.length > 0
    case 'opening':
      return !!d.opening.trim()
    case 'rules':
      return !!(d.aiInstructions.trim() || d.authorsNote.trim())
    case 'scripts':
      return d.scripts.length > 0
  }
}

const CARD_TYPE_SET = new Set<string>(CARD_TYPES.map((t) => t.value))

const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

/** Coerce a model-written card into a CardDraft (or null if unusable). */
export function toCardDraft(raw: unknown): CardDraft | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const name = stripMarkdown(String(r.name ?? '')).trim()
  const entry = stripMarkdown(String(r.entry ?? r.description ?? '')).trim()
  if (!name || !entry) return null
  const t = String(r.type ?? 'character').trim().toLowerCase()
  const type = (CARD_TYPE_SET.has(t) ? t : 'custom') as StoryCardType
  const triggers = Array.isArray(r.triggers) ? r.triggers.map(String).join(', ') : String(r.triggers ?? '').trim()
  return {
    id: nanoid(8),
    type,
    customType: type === 'custom' ? capitalize(String(r.customType ?? (CARD_TYPE_SET.has(t) ? '' : t)).trim()) || 'Lore' : undefined,
    name: name.slice(0, 80),
    entry: entry.slice(0, LIMITS.entry),
    triggers: triggers || name,
    // Notes are the player-facing pitch of a character-creator option; elsewhere models fill them with noise.
    notes: r.notes && (type === 'class' || type === 'race' || type === 'location') ? stripMarkdown(String(r.notes)).trim().slice(0, 200) : undefined
  }
}

/** Merge cards by name: same name updates, new names append. */
export function mergeCards(cur: CardDraft[], next: CardDraft[]): CardDraft[] {
  const out = [...cur]
  for (const c of next) {
    const i = out.findIndex((x) => x.name.toLowerCase() === c.name.toLowerCase())
    if (i >= 0) out[i] = { ...out[i], ...c, id: out[i].id }
    else out.push(c)
  }
  return out
}

/** Default creator fields from the option cards that exist. */
export function creatorFieldsFor(d: ScenarioDraft): { label: string; cardType: StoryCardType }[] {
  if (d.creatorFields.length) return d.creatorFields
  const has = (t: StoryCardType): boolean => d.cards.some((c) => c.type === t)
  // Locations and factions are usually world lore; they become choices only when written as options (with a pitch).
  const offered = (t: StoryCardType): boolean => d.cards.some((c) => c.type === t && !!c.notes)
  const out: { label: string; cardType: StoryCardType }[] = []
  if (has('class')) out.push({ label: 'Class', cardType: 'class' })
  if (has('race')) out.push({ label: 'Race', cardType: 'race' })
  if (offered('location') || (!out.length && has('location'))) out.push({ label: 'Location', cardType: 'location' })
  if (offered('faction')) out.push({ label: 'Faction', cardType: 'faction' })
  return out
}

/** The creator placeholders an opening should use, e.g. ["${character.name}", "${character.class}"]. */
export function creatorPlaceholders(d: ScenarioDraft): string[] {
  // Same key scheme as the character creator (engine/placeholders characterKey).
  return ['${character.name}', ...creatorFieldsFor(d).map((f) => `\${character.${f.label.trim().toLowerCase().replace(/\s+/g, '_')}}`)]
}

/** Plain-language digest of the draft for prompts. */
export function draftDigest(d: ScenarioDraft, opts: { cards?: boolean; clip?: number } = {}): string {
  const clip = (s: string, n = opts.clip ?? 900): string => (s.length > n ? `${s.slice(0, n)}…` : s)
  const lines = [
    d.title && `Title: ${d.title}`,
    d.description && `Pitch: ${clip(d.description)}`,
    d.tags.length && `Tags: ${d.tags.join(', ')}`,
    d.plotEssentials && `Plot essentials: ${clip(d.plotEssentials, 1400)}`,
    d.storySummary && `Backstory summary: ${clip(d.storySummary)}`,
    d.aiInstructions && `Narrator rules: ${clip(d.aiInstructions, 600)}`,
    d.authorsNote && `Author's note: ${clip(d.authorsNote, 300)}`,
    d.opening && `Opening (${d.openingType === 'characterCreator' ? 'character creator' : 'story'}): ${clip(d.opening, 900)}`,
    d.cards.length &&
      (opts.cards === false
        ? `Story cards: ${d.cards.map((c) => `${c.name} (${c.type === 'custom' ? c.customType || 'custom' : c.type})`).join(', ')}`
        : `Story cards:\n${d.cards.map((c) => `- ${c.name} (${c.type === 'custom' ? c.customType || 'custom' : c.type}): ${clip(c.entry, 260)}`).join('\n')}`),
    d.scripts.length && `Scripts: ${d.scripts.map((s) => `${s.name} — ${s.description || s.request}`).join('; ')}`
  ]
  return lines.filter(Boolean).join('\n') || '(nothing yet)'
}

/** Build the Scenario document for a draft (not saved). */
export function draftToScenario(d: ScenarioDraft, extra?: Partial<Scenario>): Scenario {
  const extraRules = d.aiInstructions.trim()
  const bullets = extraRules
    .split('\n')
    .map((l) => l.trim().replace(/^[-*•]\s*/, ''))
    .filter(Boolean)
    .map((l) => `- ${l}`)
    .join('\n')
  const instructions = extraRules ? (extraRules.startsWith(DEFAULT_INSTRUCTIONS.slice(0, 40)) ? extraRules : `${DEFAULT_INSTRUCTIONS}\n${bullets}`) : ''
  const creator = d.openingType === 'characterCreator'
  const fields: CreatorField[] = creator ? creatorFieldsFor(d).map((f) => ({ ...f, id: nanoid(8) })) : []
  return newScenario({
    title: d.title.trim().slice(0, LIMITS.title) || 'Untitled scenario',
    description: d.description.trim(),
    tags: d.tags.map((t) => t.trim().replace(/^#/, '').toLowerCase()).filter(Boolean).slice(0, LIMITS.tags),
    openingType: creator ? 'characterCreator' : 'story',
    opening: d.opening.trim().slice(0, LIMITS.opening),
    creatorFields: fields,
    plot: emptyPlot({
      aiInstructions: instructions,
      plotEssentials: d.plotEssentials.trim().slice(0, LIMITS.plot),
      authorsNote: d.authorsNote.trim().slice(0, LIMITS.authorsNote),
      storySummary: d.storySummary.trim(),
      enabled: { storySummary: !!d.storySummary.trim(), thirdPerson: false }
    }),
    cards: d.cards.map((c) => newCard({ type: c.type, customType: c.customType, name: c.name, entry: c.entry, triggers: c.triggers, notes: c.notes ?? '' })),
    ...extra
  })
}

/** Save the draft as a new scenario. Returns it. */
export async function saveDraft(d: ScenarioDraft): Promise<Scenario> {
  const s = draftToScenario(d)
  await db.put('scenarios', s)
  return s
}

export type { ID }
