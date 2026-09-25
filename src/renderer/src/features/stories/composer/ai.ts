// LLM work for creating scenarios: one-shot generation from a brief, section
// regeneration and the composer's conversational turns. Everything streams so
// the UI can show progress and (collapsed) model thinking.
import type { LlmMessage } from '@shared/ipc'
import type { LlmConnector } from '@shared/types'
import { streamLlm } from '@/lib/api'
import { defaultLlm, type LlmChoice } from '@/lib/llm'
import { db } from '@/stores/db'
import { NoModelError } from '../engine/llm'
import { stripThinking } from '../engine/text'
import { creatorPlaceholders, draftDigest, emptyDraft, mergeCards, toCardDraft, type CardDraft, type ScenarioDraft, type SectionId } from './draft'
import { looseJson, partialString, str, strList, stripMarkdown } from './json'

export interface RunOpts {
  llm?: LlmChoice
  signal?: AbortSignal
  /** Accumulated visible text while streaming. */
  onText?: (full: string) => void
  /** Accumulated model thinking while streaming (never part of the text). */
  onReasoning?: (full: string) => void
}

export class AbortedError extends Error {
  constructor() {
    super('Stopped')
  }
}

export function isAborted(err: unknown): boolean {
  return err instanceof AbortedError || (err instanceof Error && /abort/i.test(err.message))
}

function supportsJsonMode(connectorId: string): boolean {
  const c = db.get('connectors', connectorId) as LlmConnector | undefined
  return !!c && (c.kind === 'openai' || c.kind === 'ollama' || c.kind === 'anthropic' || c.kind === 'openrouter')
}

interface RunReq {
  system: string
  prompt?: string
  messages?: LlmMessage[]
  maxTokens?: number
  temperature?: number
  json?: boolean
}

/** Stream one completion. Resolves with the visible text and any thinking. */
export async function run(req: RunReq, opts: RunOpts = {}): Promise<{ text: string; reasoning?: string }> {
  const llm = opts.llm ?? defaultLlm()
  if (!llm) throw new NoModelError()
  if (opts.signal?.aborted) throw new AbortedError()
  const messages: LlmMessage[] = req.messages ?? [{ role: 'user', content: req.prompt ?? '' }]
  const once = async (json: boolean, maxTokens: number): Promise<{ text: string; reasoning?: string }> => {
    const h = streamLlm(
      { connectorId: llm.connectorId, model: llm.model, system: req.system, messages, maxTokens, temperature: req.temperature ?? 0.85, json },
      (full) => opts.onText?.(stripThinking(full)),
      (r) => opts.onReasoning?.(r)
    )
    const abort = (): void => h.abort()
    opts.signal?.addEventListener('abort', abort)
    try {
      const res = await h.done
      if (opts.signal?.aborted) throw new AbortedError()
      return { text: stripThinking(res.text).trim(), reasoning: res.reasoning }
    } finally {
      opts.signal?.removeEventListener('abort', abort)
    }
  }
  const json = !!req.json && supportsJsonMode(llm.connectorId)
  const max = req.maxTokens ?? 1200
  let res: { text: string; reasoning?: string }
  try {
    res = await once(json, max)
  } catch (err) {
    if (!json || isAborted(err)) throw err
    res = await once(false, max)
  }
  // Reasoning models can spend the whole budget thinking — give them room once.
  if (!res.text && res.reasoning) {
    const more = await once(json, max + 3072)
    res = { text: more.text, reasoning: [res.reasoning, more.reasoning].filter(Boolean).join('\n\n') }
  }
  return res
}

/** Ask for a JSON object; retries once with a stricter nudge if it can't be parsed. */
export async function runJson<T = Record<string, unknown>>(req: RunReq, opts: RunOpts = {}): Promise<{ data: T; reasoning?: string }> {
  const system = `${req.system}\n\nReply with ONE JSON object only — no prose, no markdown, no code fences. Use \\n for line breaks inside strings.`
  const first = await run({ ...req, system, json: true }, opts)
  const data = looseJson<T>(first.text)
  if (data) return { data, reasoning: first.reasoning }
  const retry = await run(
    {
      ...req,
      system,
      json: true,
      temperature: Math.min(req.temperature ?? 0.85, 0.6),
      messages: [...(req.messages ?? [{ role: 'user' as const, content: req.prompt ?? '' }]), { role: 'assistant', content: first.text.slice(0, 1500) }, { role: 'user', content: 'That was not valid JSON. Reply again with only the JSON object.' }]
    },
    opts
  )
  const again = looseJson<T>(retry.text)
  if (!again) throw new Error('The model did not return usable JSON. Try again, or pick a larger model.')
  return { data: again, reasoning: [first.reasoning, retry.reasoning].filter(Boolean).join('\n\n') || undefined }
}

// ─── Prompts ────────────────────────────────────────────────────────────────

const DESIGNER = `You are a brilliant scenario designer for an AI Dungeon-style interactive fiction engine. A scenario is the setup a narrator AI uses to run an open-ended adventure for one player. Write vivid, specific, playable material: concrete names, places, motives, secrets and tensions — never generic filler. Everything must be consistent with itself.`

const CORE_FIELDS = `{
  "title": "evocative title, under 60 characters",
  "description": "2-4 sentence pitch shown on the story card; hooks the player",
  "tags": ["3-6 lowercase genre/theme tags"],
  "openingType": "story" or "characterCreator" (characterCreator only if the player should pick a class/race/origin),
  "plotEssentials": "what the narrator must always remember: the setting, who the player is, the central conflict, key factions and the rules of this world (4-8 dense sentences)",
  "storySummary": "2-4 sentences of backstory: what happened right before the adventure begins",
  "aiInstructions": ["3-5 short narrator rules specific to this story: tone, genre conventions, pacing, what to emphasise"],
  "authorsNote": "one line of style guidance under 200 characters, like 'Tone: ... Style: ...'"
}`

type CoreFields = Pick<ScenarioDraft, 'title' | 'description' | 'tags' | 'plotEssentials' | 'storySummary' | 'aiInstructions' | 'authorsNote' | 'openingType'>

function coreFrom(raw: Record<string, unknown>, fallbackType: ScenarioDraft['openingType']): Partial<CoreFields> {
  const out: Partial<CoreFields> = {}
  if (raw.title) out.title = str(raw.title, 70).replace(/^["“]|["”]$/g, '')
  if (raw.description) out.description = stripMarkdown(str(raw.description, 1500))
  if (raw.tags) out.tags = strList(raw.tags, 8).map((t) => t.toLowerCase().replace(/^#/, ''))
  if (raw.plotEssentials) out.plotEssentials = stripMarkdown(str(raw.plotEssentials, 3500))
  if (raw.storySummary) out.storySummary = stripMarkdown(str(raw.storySummary, 1500))
  if (raw.aiInstructions) out.aiInstructions = stripMarkdown(strList(raw.aiInstructions, 8).join('\n') || str(raw.aiInstructions, 1200))
  if (raw.authorsNote) out.authorsNote = stripMarkdown(str(raw.authorsNote, 400))
  const t = str(raw.openingType).toLowerCase()
  out.openingType = t.includes('creator') ? 'characterCreator' : t ? 'story' : fallbackType
  return out
}

export type OpeningPref = 'auto' | 'story' | 'characterCreator'

/** Step 1: premise, world and rules from a brief. */
export async function generateCore(brief: string, pref: OpeningPref, opts: RunOpts = {}): Promise<{ core: Partial<CoreFields>; reasoning?: string }> {
  const openingAsk =
    pref === 'auto' ? 'Choose the opening type that suits it best.' : pref === 'characterCreator' ? 'openingType must be "characterCreator".' : 'openingType must be "story".'
  const { data, reasoning } = await runJson<Record<string, unknown>>(
    {
      system: DESIGNER,
      prompt: `The player wants a scenario like this:\n"""\n${brief.trim().slice(0, 3000)}\n"""\n\n${openingAsk}\nReturn JSON with these fields:\n${CORE_FIELDS}`,
      maxTokens: 1600,
      temperature: 0.9
    },
    opts
  )
  const core = coreFrom(data, pref === 'characterCreator' ? 'characterCreator' : 'story')
  if (pref !== 'auto') core.openingType = pref
  if (!core.title && !core.description && !core.plotEssentials) throw new Error('The model returned an empty scenario. Try again or pick another model.')
  return { core, reasoning }
}

/** Step 2: story cards for the draft. */
export async function generateCards(d: ScenarioDraft, opts: RunOpts & { count?: number; steer?: string } = {}): Promise<{ cards: CardDraft[]; reasoning?: string }> {
  const n = opts.count ?? 7
  const creator = d.openingType === 'characterCreator'
  const creatorAsk = creator
    ? `\nThe adventure opens with a character creator, so ALSO include the options the player picks from: 3 "class" cards, 3 "race" cards (only if the setting has distinct peoples) and 2-3 starting "location" cards. Give each option a "notes" field: one enticing sentence shown to the player.`
    : ''
  const { data, reasoning } = await runJson<{ cards?: unknown[] }>(
    {
      system: `${DESIGNER}\n\nStory cards are compact reference entries the narrator reads when a card's trigger words appear. Entries are present-tense prose, 2-4 sentences, under 600 characters, dense with usable detail: appearance, personality, motives, secrets, relationships, sensory detail. No markdown.`,
      prompt: `Scenario so far:\n${draftDigest(d, { cards: false })}\n\nWrite ${n} story cards for the most important characters, locations, factions and lore (items, creatures, customs…) of this scenario.${creatorAsk}${opts.steer?.trim() ? `\nThe author asks: ${opts.steer.trim()}` : ''}${d.cards.length ? `\nReplace the existing cards with a fresh, better set.` : ''}\n\nReturn JSON: {"cards": [{"type": "character" | "location" | "faction" | "class" | "race" | "custom", "customType": "only for custom, e.g. Item, Creature, Lore", "name": "...", "entry": "...", "triggers": "comma separated trigger words (name variants, nicknames, key nouns)", "notes": "only for class/race/location options"}]}`,
      maxTokens: Math.min(4000, 420 * (n + (creator ? 8 : 0)) + 300),
      temperature: 0.9
    },
    opts
  )
  const list = Array.isArray(data.cards) ? data.cards : Array.isArray(data) ? (data as unknown[]) : []
  let cards = mergeCards([], list.map(toCardDraft).filter((c): c is CardDraft => !!c))
  if (!cards.length) throw new Error('The model did not write any usable story cards. Try again or pick another model.')
  let thoughts = reasoning
  // Small models often skip the creator options in a big card list — ask for them on their own.
  if (creator && !cards.some((c) => c.type === 'class' || c.type === 'race')) {
    const extra = await creatorOptions({ ...d, cards }, opts).catch(() => null)
    if (extra) {
      cards = mergeCards(cards, extra.cards)
      thoughts = [thoughts, extra.reasoning].filter(Boolean).join('\n\n') || undefined
    }
  }
  return { cards, reasoning: thoughts }
}

/** The character-creator choices: classes, races (if the world has peoples) and starting locations. */
async function creatorOptions(d: ScenarioDraft, opts: RunOpts): Promise<{ cards: CardDraft[]; reasoning?: string }> {
  const { data, reasoning } = await runJson<{ options?: unknown[]; cards?: unknown[] }>(
    {
      system: `${DESIGNER}\n\nYou write the options a player picks from in a character creator before the adventure starts.`,
      prompt: `Scenario:\n${draftDigest(d, { cards: false })}\n\nWrite the character creator options for this scenario:\n- 3 "class" options: roles, archetypes or backgrounds that fit this world\n- 3 "race" options, ONLY if the world has distinct peoples or species (otherwise none)\n- 2-3 starting "location" options\nEach option: {"type": "class" | "race" | "location", "name": "...", "entry": "2-3 sentences the narrator uses", "triggers": "comma separated words", "notes": "one enticing sentence shown to the player"}\nReturn JSON: {"options": [...]}`,
      maxTokens: 2600,
      temperature: 0.85
    },
    opts
  )
  const list = Array.isArray(data.options) ? data.options : Array.isArray(data.cards) ? data.cards : []
  const cards = list
    .map(toCardDraft)
    .filter((c): c is CardDraft => !!c && (c.type === 'class' || c.type === 'race' || c.type === 'location'))
    .map((c) => ({ ...c, notes: c.notes || c.entry.split(/(?<=[.!?])\s/)[0] }))
  return { cards, reasoning }
}

/** "You are ${character.name}, a ${character.race} ${character.class}." for the creator's fields. */
function creatorIntro(d: ScenarioDraft): string {
  const keys = creatorPlaceholders(d)
  const race = keys.find((k) => k.includes('.race'))
  const cls = keys.find((k) => k.includes('.class'))
  const loc = keys.find((k) => k.includes('.location'))
  const who = [race, cls].filter(Boolean).join(' ')
  return `You are \${character.name}${who ? `, a ${who}` : ''}${loc ? `, newly arrived in ${loc}` : ''}.`
}

/** Step 3: the opening passage (plain prose, streamed). */
export async function generateOpening(d: ScenarioDraft, opts: RunOpts & { steer?: string } = {}): Promise<{ opening: string; reasoning?: string }> {
  const creator = d.openingType === 'characterCreator'
  const fields = creator ? creatorPlaceholders(d) : []
  const how = creator
    ? `This opening follows a character creator, so the player's name and choices are NOT known yet. Never invent a name for the player. Write these placeholders literally, exactly where the choices go: ${fields.join(', ')}. For example: "${creatorIntro(d)}" First sketch the world in a few lines, then place the player in a vivid first scene.`
    : 'Place the player straight into a vivid first scene.'
  const system = `${DESIGNER}\n\nYou write the opening passage of an interactive story. Second person, present tense ("You …"). 120-220 words in 2-3 short paragraphs. Concrete sensory detail, a hook, and end at a moment where the player must decide what to do. Never act for the player. Plain prose only — no title, no heading, no options list.`
  const prompt = `${draftDigest(d)}\n\n${how}${opts.steer?.trim() ? `\nThe author asks: ${opts.steer.trim()}` : ''}${d.opening ? '\nWrite a fresh version that is better than the current opening.' : ''}\n\nWrite the opening now.`
  const clean = (t: string): string =>
    stripMarkdown(t)
      .replace(/^#+\s.*\n+/, '')
      .replace(/^(opening|here is[^:\n]*):\s*/i, '')
      .replace(/^["“]|["”]$/g, '')
      .trim()
  const res = await run({ system, prompt, maxTokens: 700, temperature: 0.9 }, opts)
  let opening = clean(res.text)
  let reasoning = res.reasoning
  if (!opening) throw new Error('The model did not write an opening. Try again or pick another model.')
  if (creator && !opening.includes('${character.name}')) {
    // One stricter retry; failing that, lead with the placeholders so the creator's choices still land.
    const again = await run({ system, prompt: `${prompt}\n\nIMPORTANT: the text MUST contain ${fields.join(' and ')} written literally.`, maxTokens: 700, temperature: 0.7 }, opts).catch(() => null)
    const text = again ? clean(again.text) : ''
    // "You are Kaelen Rost, …" → "You are ${character.name}, …"
    const named = (t: string): string => t.replace(/\bYou are ((?:[A-Z][\w'’-]+)(?: [A-Z][\w'’-]+){0,2})(?=[,.;—])/, 'You are ${character.name}')
    if (text.includes('${character.name}')) {
      opening = text
      reasoning = [reasoning, again?.reasoning].filter(Boolean).join('\n\n') || undefined
    } else if (named(opening).includes('${character.name}')) opening = named(opening)
    else opening = `${creatorIntro(d)} ${opening}`
  }
  return { opening, reasoning }
}

export type GenStage = 'core' | 'cards' | 'opening'

/** One-shot: a complete draft from a brief (premise → cards → opening). */
export async function generateDraft(
  brief: string,
  opts: RunOpts & { pref?: OpeningPref; cardCount?: number; onStage?: (s: GenStage, draft: ScenarioDraft) => void } = {}
): Promise<{ draft: ScenarioDraft; reasoning: string }> {
  let reasoning = ''
  let base = ''
  const think = (r: string): void => opts.onReasoning?.(base + r)
  const stageOpts = { ...opts, onReasoning: think }
  const draft = emptyDraft()
  opts.onStage?.('core', draft)
  // An explicit ask for a character creator beats the model's own choice.
  const wantsCreator = /character creat|creat(e|ing) (their|my|your|a) (own )?character|(choose|pick) (a |your |their )?(class|race|origin)/i.test(brief)
  const pref = (opts.pref ?? 'auto') === 'auto' && wantsCreator ? 'characterCreator' : (opts.pref ?? 'auto')
  const core = await generateCore(brief, pref, stageOpts)
  Object.assign(draft, core.core)
  draft.sections = { ...draft.sections, premise: 'proposed', world: 'proposed', rules: 'proposed' }
  reasoning = core.reasoning ?? ''
  base = reasoning ? `${reasoning}\n\n` : ''
  opts.onStage?.('cards', { ...draft })
  const cards = await generateCards(draft, { ...stageOpts, count: opts.cardCount })
  draft.cards = cards.cards
  draft.sections.cards = 'proposed'
  reasoning = [reasoning, cards.reasoning].filter(Boolean).join('\n\n')
  base = reasoning ? `${reasoning}\n\n` : ''
  opts.onStage?.('opening', { ...draft })
  const opening = await generateOpening(draft, stageOpts)
  draft.opening = opening.opening
  draft.sections.opening = 'proposed'
  reasoning = [reasoning, opening.reasoning].filter(Boolean).join('\n\n')
  return { draft, reasoning }
}

/** Regenerate one section of a draft (optionally steered). Returns the patch. */
export async function regenerateSection(d: ScenarioDraft, section: Exclude<SectionId, 'scripts'>, steer: string, opts: RunOpts = {}): Promise<{ patch: Partial<ScenarioDraft>; reasoning?: string }> {
  if (section === 'cards') {
    const r = await generateCards(d, { ...opts, steer, count: Math.max(5, Math.min(10, d.cards.filter((c) => !['class', 'race'].includes(c.type)).length || 7)) })
    return { patch: { cards: r.cards }, reasoning: r.reasoning }
  }
  if (section === 'opening') {
    const r = await generateOpening(d, { ...opts, steer })
    return { patch: { opening: r.opening }, reasoning: r.reasoning }
  }
  const keys: Record<string, string[]> = {
    premise: ['title', 'description', 'tags'],
    world: ['plotEssentials', 'storySummary'],
    rules: ['aiInstructions', 'authorsNote']
  }
  const want = keys[section]
  const schema = CORE_FIELDS.split('\n')
    .filter((l) => want.some((k) => l.includes(`"${k}"`)))
    .join('\n')
  const { data, reasoning } = await runJson<Record<string, unknown>>(
    {
      system: DESIGNER,
      prompt: `Scenario so far:\n${draftDigest(d)}\n\nRewrite only these fields so they are fresher and more compelling while staying consistent with everything else.${steer.trim() ? `\nThe author asks: ${steer.trim()}` : ''}\nReturn JSON:\n{\n${schema}\n}`,
      maxTokens: 1200,
      temperature: 0.95
    },
    opts
  )
  const core = coreFrom(data, d.openingType)
  const patch: Partial<ScenarioDraft> = {}
  for (const k of want) {
    const v = core[k as keyof CoreFields]
    if (v !== undefined && (!Array.isArray(v) || v.length)) (patch as Record<string, unknown>)[k] = v
  }
  if (!Object.keys(patch).length) throw new Error('The model did not return anything for this section. Try again.')
  return { patch, reasoning }
}

// ─── Composer turns ─────────────────────────────────────────────────────────

export interface ComposerTurnResult {
  reply: string
  patch: Partial<ScenarioDraft>
  removeCards: string[]
  suggestions: string[]
  /** A game mechanic the user asked for — the composer writes it as a script. */
  script?: string
  reasoning?: string
}

const SECTION_NAMES: Record<SectionId, string> = {
  premise: 'Premise (title, pitch, tags)',
  world: 'World (plot essentials, backstory summary)',
  cards: 'Cast & places (story cards)',
  opening: 'Opening (opening type and passage)',
  rules: "Rules (narrator instructions, author's note)",
  scripts: 'Scripts (game mechanics)'
}

function composerSystem(d: ScenarioDraft, focus: SectionId): string {
  return `You are the Scenario Composer in Stitch: a warm, sharp co-author who builds a scenario for an AI Dungeon-style interactive story together with the user. The scenario has these sections: Premise (title, pitch, tags), World (plot essentials, backstory summary), Cast & places (story cards), Opening, Rules (narrator instructions, author's note) and Scripts (game mechanics written as code by a separate tool).

Each turn:
1. Understand what the user wants. Take their ideas seriously and build on them with specific, vivid details.
2. Update the draft where it helps — mostly the section in focus — and keep everything consistent. Only include fields you actually change. Write complete field values (not diffs).
3. Reply in 1-3 short sentences: what you changed, then ONE question or idea that moves the scenario forward.

Reply with ONE JSON object:
{
  "reply": "your short message to the user",
  "updates": { only changed fields, chosen from:
    "title": string, "description": string, "tags": [strings],
    "plotEssentials": string, "storySummary": string,
    "aiInstructions": [short narrator rules], "authorsNote": string,
    "openingType": "story" | "characterCreator", "opening": string (second person, present tense),
    "cards": [{"type": "character|location|faction|class|race|custom", "name": string, "entry": "2-4 sentences", "triggers": "comma separated", "notes": "for class/race/location options"}] (new or changed cards only),
    "removeCards": [names of cards to delete]
  },
  "suggestions": ["2-3 very short replies the user might send next"],
  "script": "ONLY when the user asks for a game mechanic, rule system, tracker or automation (e.g. HP, inventory, inner thoughts, auto story cards): a precise one-paragraph spec of the script to write. Otherwise omit."
}

Section in focus: ${SECTION_NAMES[focus]}

Current draft:
${draftDigest(d)}`
}

/** One conversational turn. `onReply` streams the reply text as it is written. */
export async function composeTurn(
  d: ScenarioDraft,
  history: { role: 'user' | 'assistant'; text: string }[],
  userText: string,
  focus: SectionId,
  opts: RunOpts & { onReply?: (text: string) => void } = {}
): Promise<ComposerTurnResult> {
  const messages: LlmMessage[] = [
    ...history.slice(-10).map((m) => ({ role: m.role, content: m.text.slice(0, 1500) }) as LlmMessage),
    { role: 'user', content: userText }
  ]
  const { data, reasoning } = await runJson<Record<string, unknown>>(
    { system: composerSystem(d, focus), messages, maxTokens: 2600, temperature: 0.85 },
    { ...opts, onText: (full) => opts.onReply?.(partialString(full, 'reply') ?? '') }
  )
  const u = (data.updates && typeof data.updates === 'object' ? data.updates : {}) as Record<string, unknown>
  const core = coreFrom(u, d.openingType)
  const patch: Partial<ScenarioDraft> = {}
  for (const [k, v] of Object.entries(core)) {
    if (k === 'openingType' && !u.openingType) continue
    if (v !== undefined && v !== '' && (!Array.isArray(v) || v.length)) (patch as Record<string, unknown>)[k] = v
  }
  if (u.opening) patch.opening = stripMarkdown(str(u.opening, 4000))
  const cards = Array.isArray(u.cards) ? u.cards.map(toCardDraft).filter((c): c is CardDraft => !!c) : []
  if (cards.length) patch.cards = cards
  const removeCards = strList(u.removeCards ?? data.removeCards, 30)
  const script = str(data.script, 1500)
  return {
    reply: str(data.reply, 2000),
    patch,
    removeCards,
    suggestions: strList(data.suggestions, 3).map((s) => s.slice(0, 90)),
    script: script && !/^(none|null|n\/a)$/i.test(script) ? script : undefined,
    reasoning
  }
}
