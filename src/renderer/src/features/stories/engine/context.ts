// Context assembly for one generation — pure and deterministic.
//
// system  = AI instructions + POV + safety + player + plot essentials
//           + story summary + memories + triggered story cards
// history = actions as alternating assistant (story) / user (player) messages,
//           fitted newest-first into (contextLength − responseLength).
// Author's note rides on the final user message; Continue adds a short cue.
//
// Story scripts see the same context rendered the AI Dungeon way (`aidContext`)
// and may rewrite it; `fromAidContext` turns their text back into model input.
import type { AdventureSettings, MemoryEntry, PlotComponents, StoryAction, StoryCard } from '@shared/types'
import { DEFAULT_INSTRUCTIONS, SAFETY_TEXT, cardTypeLabel, povInstruction } from './defaults'
import { contextLine, isAiAction, playerLine, tokens } from './text'

export interface ContextInput {
  plot: PlotComponents
  cards: StoryCard[]
  memories: MemoryEntry[]
  /** History in order. The newest player action (if any) is already the last item. */
  actions: StoryAction[]
  settings: Pick<AdventureSettings, 'contextLength' | 'responseLength' | 'safety' | 'memoryBank'>
  player: { name: string; persona?: string; choices: Record<string, string> }
  /** Model context window, when known. */
  modelWindow?: number
  /** Script front memory (`state.memory.frontMemory`): after the last action. */
  frontMemory?: string
}

export interface ContextMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface ContextResult {
  system: string
  messages: ContextMessage[]
  tokens: number
  budget: number
  /** Triggered cards that did not fit. */
  droppedCards: number
  /** Index (into input.actions) of the oldest action that made it in. */
  firstIncluded: number
  /** Number of story actions left out because they did not fit. */
  droppedActions: number
  included: StoryCard[]
  triggered: StoryCard[]
  memoriesUsed: MemoryEntry[]
  /** AI instructions + POV + safety: the system prompt without story sections. */
  instructions: string
  /** The pieces that made it in, for the AI Dungeon rendering. */
  parts: { plotEssentials: string; player: string; summary: string; authorsNote: string; frontMemory: string; history: StoryAction[] }
}

export const CONTINUE_CUE = '[Continue the story from exactly where it left off.]'
const MSG_OVERHEAD = 6
const SCAN_ACTIONS = 6

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Trigger keys for a card: its comma-separated triggers plus its name. */
export function cardKeys(card: Pick<StoryCard, 'name' | 'triggers'>): string[] {
  const keys = card.triggers
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean)
  if (card.name.trim()) keys.push(card.name.trim())
  return [...new Set(keys.map((k) => k.toLowerCase()))]
}

function wordRe(key: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(key)}(?![\\p{L}\\p{N}_])`, 'iu')
}

/** Does any of the card's keys appear as a whole word in `text`? */
export function cardMatches(card: Pick<StoryCard, 'name' | 'triggers'>, text: string): boolean {
  if (!text) return false
  return cardKeys(card).some((k) => wordRe(k).test(text))
}

/**
 * Cards triggered by the recent story, most recently mentioned first.
 * Cards whose name matches a player choice (character creator) are pinned.
 */
export function triggeredCards(cards: StoryCard[], recent: string[], pinnedNames: string[] = []): StoryCard[] {
  const pinned = new Set(pinnedNames.map((n) => n.trim().toLowerCase()).filter(Boolean))
  const scored: { card: StoryCard; rank: number }[] = []
  for (const card of cards) {
    if (!card.entry.trim()) continue
    if (pinned.has(card.name.trim().toLowerCase())) {
      scored.push({ card, rank: -1 })
      continue
    }
    // recent[0] is the newest text.
    const idx = recent.findIndex((t) => cardMatches(card, t))
    if (idx >= 0) scored.push({ card, rank: idx })
  }
  return scored.sort((a, b) => a.rank - b.rank).map((s) => s.card)
}

const STOP = new Set(
  'the and that this with from have they them their there then than what when where which while your you are was were been into onto over under about after before again just very some more most such only also like will would could should shall said says around through'.split(
    ' '
  )
)

export function keywords(text: string): Set<string> {
  const out = new Set<string>()
  for (const w of text.toLowerCase().match(/[\p{L}\p{N}']{4,}/gu) ?? []) if (!STOP.has(w)) out.add(w)
  return out
}

/** Memory-bank retrieval by keyword overlap with the recent story. */
export function relevantMemories(memories: MemoryEntry[], recentText: string, max = 5): MemoryEntry[] {
  if (!memories.length) return []
  const kw = keywords(recentText)
  return memories
    .map((m) => {
      let score = 0
      for (const w of keywords(m.text)) if (kw.has(w)) score++
      return { m, score }
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.m.createdAt - a.m.createdAt)
    .slice(0, max)
    .map((x) => x.m)
}

function section(title: string, body: string): string {
  return body.trim() ? `\n\n## ${title}\n${body.trim()}` : ''
}

function cardBlock(c: StoryCard): string {
  return `[${c.name.trim() || 'Untitled'} · ${cardTypeLabel(c)}]\n${c.entry.trim()}`
}

export function buildContext(input: ContextInput): ContextResult {
  const { plot, settings, player } = input
  const window = input.modelWindow && input.modelWindow > 0 ? input.modelWindow : Infinity
  const budget = Math.max(512, Math.min(settings.contextLength, window) - settings.responseLength)

  // ── Fixed system core ─────────────────────────────────────────────────────
  const thirdPerson = plot.enabled.thirdPerson && plot.thirdPerson
  const choiceLines = Object.entries(player.choices)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k.replace(/^character\./, '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())}: ${v}`)
  const playerBlock = [player.name ? `Name: ${player.name}` : '', player.persona ? `Personality: ${player.persona}` : '', ...choiceLines.filter((l) => !/^Name:/i.test(l))].filter(Boolean).join('\n')

  const instructions = (plot.aiInstructions.trim() || DEFAULT_INSTRUCTIONS) + `\n- ${povInstruction(thirdPerson, player.name)}\n- ${SAFETY_TEXT[settings.safety].addendum}`
  let core = instructions
  core += section('Player character', playerBlock)
  core += section('Plot essentials', plot.plotEssentials)
  core += section('Story so far', plot.storySummary)

  // ── History candidates ────────────────────────────────────────────────────
  const story = input.actions.map((a, i) => ({ a, i })).filter(({ a }) => a.type !== 'see' && a.text.trim())
  const lastAi = story.length > 0 && isAiAction(story[story.length - 1].a)
  const authors = plot.authorsNote.trim() ? `[Author's note: ${plot.authorsNote.trim()}]` : ''
  const front = input.frontMemory?.trim() ?? ''
  const extras = [authors, front].filter(Boolean).join('\n')
  const tail = lastAi ? `${CONTINUE_CUE}${extras ? `\n${extras}` : ''}` : extras ? `\n\n${extras}` : ''

  // ── Triggered cards & memories ────────────────────────────────────────────
  const recent = story
    .slice(-SCAN_ACTIONS)
    .map(({ a }) => a.text)
    .reverse()
  const pinned = Object.values(player.choices)
  const triggered = triggeredCards(input.cards, recent, pinned)
  const memories = settings.memoryBank ? relevantMemories(input.memories, recent.slice(0, 3).join('\n')) : []

  const fixed = tokens(core) + tokens(tail) + MSG_OVERHEAD * 2 + 8
  let avail = budget - fixed

  const costs = story.map(({ a }) => tokens(isAiAction(a) ? a.text : contextLine(a)) + MSG_OVERHEAD)
  const picked: number[] = [] // indices into `story`, newest first
  let used = 0
  const takeHistory = (limit: number): void => {
    for (let k = story.length - 1 - picked.length; k >= 0; k--) {
      const c = costs[k]
      if (picked.length > 0 && used + c > limit) break
      picked.push(k)
      used += c
    }
  }
  // Phase 1: most of the space goes to recent history; cards get the rest.
  takeHistory(triggered.length || memories.length ? avail * 0.7 : avail)
  avail -= used

  const includedMem: MemoryEntry[] = []
  let memText = ''
  for (const m of memories) {
    const line = `- ${m.text.trim()}\n`
    if (tokens(memText + line) + 4 > avail) break
    memText += line
    includedMem.push(m)
  }
  if (memText) avail -= tokens(section('Memories', memText))

  const included: StoryCard[] = []
  let cardText = ''
  for (const c of triggered) {
    const block = `${cardBlock(c)}\n\n`
    if (tokens(cardText + block) + 8 > avail) continue
    cardText += block
    included.push(c)
  }
  if (cardText) avail -= tokens(section('Story cards', cardText)) + 4

  // Phase 2: leftover space extends history further back.
  const before = used
  takeHistory(used + Math.max(0, avail))
  avail -= used - before

  // ── Assemble ──────────────────────────────────────────────────────────────
  let system = core
  system += section('Memories', memText)
  system += section('Story cards (background — use only when relevant)', cardText)

  const chosen = [...picked].sort((x, y) => x - y).map((k) => story[k])
  const messages: ContextMessage[] = []
  const push = (role: ContextMessage['role'], content: string): void => {
    const last = messages[messages.length - 1]
    if (last && last.role === role) last.content += `\n\n${content}`
    else messages.push({ role, content })
  }
  for (const { a } of chosen) push(isAiAction(a) ? 'assistant' : 'user', isAiAction(a) ? a.text.trim() : contextLine(a))
  if (messages[0]?.role === 'assistant') messages.unshift({ role: 'user', content: '[Begin the story.]' })
  if (!messages.length) messages.push({ role: 'user', content: '[Begin the story.]' })
  if (messages[messages.length - 1].role === 'assistant') messages.push({ role: 'user', content: tail.trim() || CONTINUE_CUE })
  else if (tail) messages[messages.length - 1].content += tail

  const total = tokens(system) + messages.reduce((n, m) => n + tokens(m.content) + MSG_OVERHEAD, 0)
  const firstIncluded = chosen.length ? chosen[0].i : input.actions.length
  return {
    system,
    messages,
    tokens: total,
    budget,
    droppedCards: triggered.length - included.length,
    firstIncluded,
    droppedActions: story.length - chosen.length,
    included,
    triggered,
    memoriesUsed: includedMem,
    instructions,
    parts: {
      plotEssentials: plot.plotEssentials.trim(),
      player: playerBlock,
      summary: plot.storySummary.trim(),
      authorsNote: plot.authorsNote.trim(),
      frontMemory: front,
      history: chosen.map(({ a }) => a)
    }
  }
}

// ─── AI Dungeon rendering (for story scripts) ────────────────────────────────

/** How an action reads in AI Dungeon's context and `history`: player lines start with "> ". */
export function aidActionText(a: Pick<StoryAction, 'type' | 'text'>, first = false): string {
  if (a.type === 'do' || a.type === 'say') return `\n> ${playerLine(a.type, a.text)}\n`
  if (a.type === 'story' || a.type === 'see') return `\n${a.text.trim()}\n`
  return first ? a.text.trim() : `\n${a.text.trim()}`
}

export interface AidContext {
  /** The whole context as scripts see it (`text` in the context hook). */
  text: string
  /** Everything before "Recent Story:". */
  header: string
  /** "Recent Story:" to the end. */
  recent: string
  /** Characters of the leading memory block (`info.memoryLength`). */
  memoryLength: number
  /** Room for the context in characters (`info.maxChars`). */
  maxChars: number
}

/**
 * The context in AI Dungeon's layout: memory (plot essentials), World Lore,
 * Story Summary, Memories, then Recent Story with the author's note right
 * before the last action and front memory at the very end. AI instructions
 * stay in the system prompt, as in AID.
 */
export function aidContext(res: ContextResult): AidContext {
  const p = res.parts
  const memory = [p.plotEssentials, p.player && `Player character:\n${p.player}`].filter(Boolean).join('\n\n')
  const blocks: string[] = []
  if (memory) blocks.push(memory)
  const lore = res.included.map((c) => c.entry.trim()).filter(Boolean)
  if (lore.length) blocks.push(`World Lore:\n${lore.join('\n\n')}`)
  if (p.summary) blocks.push(`Story Summary:\n${p.summary}`)
  if (res.memoriesUsed.length) blocks.push(`Memories:\n${res.memoriesUsed.map((m) => m.text.trim()).join('\n')}`)
  const acts = p.history.map((a, i) => aidActionText(a, i === 0))
  const note = p.authorsNote ? `\n[Author's note: ${p.authorsNote}]\n` : ''
  let story = acts.length ? acts.slice(0, -1).join('') + note + acts[acts.length - 1] : note
  if (p.frontMemory) story = `${story.replace(/\s+$/, '')}\n${p.frontMemory}`
  const recent = `Recent Story:\n${story.replace(/^\s+/, '').replace(/\n{3,}/g, '\n\n')}`
  const header = blocks.join('\n\n')
  return {
    text: header ? `${header}\n\n${recent}` : recent,
    header,
    recent,
    memoryLength: memory.length,
    maxChars: Math.max(400, (res.budget - tokens(res.instructions)) * 4)
  }
}

/** Tells the model how to read a script-built context. */
export const AID_CONTEXT_NOTE =
  'The user message is the story context in AI Dungeon format: plot essentials, World Lore, Story Summary and Memories, then Recent Story. Continue the story from exactly where Recent Story ends, following any instructions embedded in the context.'

export interface ScriptedInput {
  system: string
  messages: ContextMessage[]
  tokens: number
  /** native: scripts changed nothing; header: only the world info above Recent Story changed; raw: sent as one AID-style prompt. */
  mode: 'native' | 'header' | 'raw'
}

const squash = (s: string): string => s.replace(/\s+/g, ' ').trim()

function count(system: string, messages: ContextMessage[]): number {
  return tokens(system) + messages.reduce((n, m) => n + tokens(m.content) + MSG_OVERHEAD, 0)
}

/**
 * Model input for a context the scripts returned. Untouched context keeps the
 * normal chat layout; if only the part above "Recent Story:" changed, that
 * part replaces the system prompt's story sections; anything else is sent
 * as-is, as a single AI Dungeon-style prompt.
 */
export function fromAidContext(res: ContextResult, aid: AidContext, modified: string): ScriptedInput {
  if (squash(modified) === squash(aid.text)) return { system: res.system, messages: res.messages, tokens: res.tokens, mode: 'native' }
  const marks = [...modified.matchAll(/Recent\s*Story\s*:/gi)]
  const at = marks.length ? (marks[marks.length - 1].index ?? -1) : -1
  if (at >= 0 && squash(modified.slice(at)) === squash(aid.recent)) {
    const header = modified.slice(0, at).trim()
    const system = header ? `${res.instructions}\n\n${header}` : res.instructions
    return { system, messages: res.messages, tokens: count(system, res.messages), mode: 'header' }
  }
  const system = `${res.instructions}\n\n${AID_CONTEXT_NOTE}`
  const messages: ContextMessage[] = [{ role: 'user', content: modified }]
  return { system, messages, tokens: count(system, messages), mode: 'raw' }
}
