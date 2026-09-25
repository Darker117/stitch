// AI Dungeon ⇄ Stitch mapping and the hook runner.
//
// storyCards ⇄ adventure.cards (title=name, keys=triggers, description=notes)
// history    ⇄ adventure.actions (player lines read "> You …" as in AID)
// state      ⇄ adventure.scriptState, shared by every script of the adventure
//
// Scripts run in run order; each gets the text, state and cards the previous
// one left behind. A failing script is logged and skipped — its changes are
// dropped and the text it received passes on untouched.
import { nanoid } from 'nanoid'
import type { ActionType, Adventure, StoryAction, StoryCard, StoryCardType, StoryScript } from '@shared/types'
import { aidActionText } from '../context'
import { playerLine } from '../text'
import { runSandboxed } from './sandbox'
import type { AidCard, AidEnv, AidHistoryEntry, AidInfo, HookName, LogLevel, SandboxResponse, ScriptLogEntry } from './types'

/** AID hands scripts the most recent actions, not the whole adventure. */
export const HISTORY_LIMIT = 100

// ─── Story cards ─────────────────────────────────────────────────────────────

const CARD_TYPES: StoryCardType[] = ['character', 'class', 'race', 'location', 'faction']

export function toAidCard(c: StoryCard): AidCard {
  return {
    id: c.id,
    title: c.name,
    keys: c.triggers,
    entry: c.entry,
    type: c.type === 'custom' ? c.customType?.trim() || 'custom' : c.type,
    description: c.notes,
    createdAt: new Date(c.createdAt || Date.now()).toISOString(),
    updatedAt: new Date(c.updatedAt || c.createdAt || Date.now()).toISOString(),
    useForCharacterCreation: false
  }
}

function sameCard(a: AidCard, b: AidCard): boolean {
  return a.title === b.title && a.keys === b.keys && a.entry === b.entry && a.type === b.type && a.description === b.description
}

function cardType(type: string): Pick<StoryCard, 'type' | 'customType'> {
  const t = type.trim()
  const lower = t.toLowerCase() as StoryCardType
  if (CARD_TYPES.includes(lower)) return { type: lower, customType: undefined }
  return { type: 'custom', customType: t && lower !== 'custom' ? t : undefined }
}

function mergeCard(cur: StoryCard, a: AidCard, now: number): StoryCard {
  return { ...cur, ...cardType(a.type), name: a.title, triggers: a.keys, entry: a.entry, notes: a.description, updatedAt: now }
}

/**
 * Fold what scripts did to `storyCards` back into the adventure's cards:
 * edits by id, additions, removals and the new order. Cards added elsewhere
 * while the scripts ran are kept. Returns null when nothing changed.
 */
export function applyCardChanges(current: StoryCard[], before: AidCard[], after: AidCard[]): StoryCard[] | null {
  const beforeById = new Map(before.map((c) => [c.id, c]))
  const curById = new Map(current.map((c) => [c.id, c]))
  const used = new Set<string>()
  const now = Date.now()
  let changed = false
  const out: StoryCard[] = []
  for (const a of after) {
    const cur = a.id && !used.has(a.id) ? curById.get(a.id) : undefined
    if (cur) {
      used.add(cur.id)
      const prev = beforeById.get(cur.id) ?? toAidCard(cur)
      if (sameCard(prev, a)) out.push(cur)
      else {
        out.push(mergeCard(cur, a, now))
        changed = true
      }
      continue
    }
    const id = a.id && !used.has(a.id) && !curById.has(a.id) ? a.id : nanoid(10)
    used.add(id)
    out.push({ id, ...cardType(a.type), name: a.title, triggers: a.keys, entry: a.entry, notes: a.description, createdAt: now, updatedAt: now })
    changed = true
  }
  for (const b of before) if (!used.has(b.id)) changed = true
  for (const c of current) if (!used.has(c.id) && !beforeById.has(c.id)) out.push(c)
  if (!changed) {
    const order = current.filter((c) => used.has(c.id) || !beforeById.has(c.id)).map((c) => c.id)
    changed = order.length !== out.length || order.some((id, i) => out[i].id !== id)
  }
  return changed ? out : null
}

// ─── History, input text, state ──────────────────────────────────────────────

export function toAidHistory(actions: StoryAction[]): AidHistoryEntry[] {
  const start = Math.max(0, actions.length - HISTORY_LIMIT)
  return actions.slice(start).map((a, i) => {
    const text = aidActionText(a, start + i === 0)
    return { text, rawText: text, type: a.type }
  })
}

/** The player's action as AID's input hook receives it. */
export function aidInputText(type: ActionType, text: string): string {
  if (type === 'do' || type === 'say') return `\n> ${playerLine(type, text)}\n`
  return `\n${text.trim()}\n`
}

const squash = (s: string): string => s.replace(/\s+/g, ' ').trim()

/** Turn the input hook's text back into an action. Unchanged text keeps the player's exact words. */
export function fromAidInput(type: ActionType, original: string, out: string): { type: ActionType; text: string } {
  if (squash(out) === squash(aidInputText(type, original))) return { type, text: original }
  let t = out.trim()
  if (t.startsWith('>')) {
    t = t.replace(/^>\s*/, '')
    if (type === 'do' || type === 'say') return { type, text: t }
    return { type: /^you\s+say\b/i.test(t) ? 'say' : 'do', text: t }
  }
  return { type: type === 'do' || type === 'say' ? 'story' : type, text: t }
}

/** The adventure's persisted `state`, ready to hand to scripts. */
export function initialState(adv: Pick<Adventure, 'scriptState'>): Record<string, unknown> {
  const s = structuredClone(adv.scriptState ?? {}) as Record<string, unknown>
  if (!s.memory || typeof s.memory !== 'object' || Array.isArray(s.memory)) s.memory = {}
  return s
}

/** `state.message` as display text (AID also accepts `{ text }` or a list of them). */
export function messageText(v: unknown): string {
  if (typeof v === 'string') return v.trim()
  if (Array.isArray(v)) return v.map(messageText).filter(Boolean).join('\n')
  if (v && typeof v === 'object' && typeof (v as { text?: unknown }).text === 'string') return ((v as { text: string }).text ?? '').trim()
  return ''
}

export function envFor(adv: Pick<Adventure, 'cards' | 'scriptState' | 'player' | 'plot'>, history: StoryAction[], text: string, info?: Partial<AidInfo>): AidEnv {
  const name = adv.player.name?.trim() || 'You'
  return {
    text,
    state: initialState(adv),
    info: { actionCount: history.length, characters: [name], characterNames: [name], ...info },
    history: toAidHistory(history),
    storyCards: adv.cards.map(toAidCard),
    memory: { context: adv.plot.plotEssentials, authorsNote: adv.plot.authorsNote }
  }
}

// ─── Running a hook ──────────────────────────────────────────────────────────

export interface HookOutcome {
  text: string
  stop: boolean
  state: Record<string, unknown>
  storyCards: AidCard[]
  logs: ScriptLogEntry[]
  errors: number
  /** Names of the scripts that ran. */
  ran: string[]
  /** `state.message` when a script changed it. */
  message?: string
  ms: number
}

export const HOOK_LABEL: Record<HookName | 'library', string> = { library: 'Library', input: 'Input', context: 'Context', output: 'Output' }

function logEntry(s: Pick<StoryScript, 'id' | 'name'>, hook: HookName | 'library', level: LogLevel, message: string): ScriptLogEntry {
  return { id: nanoid(8), at: Date.now(), scriptId: s.id, script: s.name || 'Untitled script', hook, level, message }
}

function lines(code: string): number {
  let n = 1
  for (let i = code.indexOf('\n'); i >= 0; i = code.indexOf('\n', i + 1)) n++
  return n
}

/** Library + hook, as AI Dungeon evaluates them. */
export function hookCode(s: Pick<StoryScript, 'library'>, hook: string): string {
  return `${s.library}\n${hook}`
}

/** Point an error at the tab (and line) it came from. */
export async function describeError(s: Pick<StoryScript, 'library'>, hook: HookName, res: SandboxResponse, env: AidEnv): Promise<string> {
  const msg = res.error ?? 'Unknown error'
  if (res.errorKind === 'syntax') {
    const lib = s.library.trim() ? await runSandboxed(s.library, env, { compileOnly: true }) : null
    return `${lib && !lib.ok ? 'Library' : HOOK_LABEL[hook]}: ${msg}`
  }
  if (res.line) {
    const libLines = lines(s.library)
    return res.line <= libLines ? `${msg} (Library line ${res.line})` : `${msg} (${HOOK_LABEL[hook]} line ${res.line - libLines})`
  }
  return msg
}

/** Run one hook across `scripts` in order. Never throws. */
export async function runHook(hook: HookName, scripts: StoryScript[], env: AidEnv, opts: { timeoutMs?: number } = {}): Promise<HookOutcome> {
  const t0 = performance.now()
  let text = env.text
  let stop = false
  let state = env.state
  let cards = env.storyCards
  let errors = 0
  const logs: ScriptLogEntry[] = []
  const ran: string[] = []
  for (const s of scripts) {
    const code = s[hook]
    if (!code.trim()) continue
    ran.push(s.name)
    const res = await runSandboxed(hookCode(s, code), { ...env, text, state, storyCards: cards }, opts)
    for (const l of res.logs) logs.push(logEntry(s, hook, l.level, l.message))
    if (!res.ok) {
      errors++
      logs.push(logEntry(s, hook, 'error', await describeError(s, hook, res, env)))
      continue
    }
    const empty = res.text === null || res.text === ''
    if (empty && hook !== 'context' && !res.stop) {
      // AID refuses empty input/output; keep what the script was given.
      errors++
      logs.push(logEntry(s, hook, 'error', `Returned empty text from the ${HOOK_LABEL[hook]} hook, which AI Dungeon treats as an error. Its changes were ignored.`))
      continue
    }
    if (!res.returned) logs.push(logEntry(s, hook, 'warn', `The ${HOOK_LABEL[hook]} code should end with modifier(text) returning { text } — used the global text instead.`))
    // An empty context means "build it as if the script had not run".
    if (!empty) text = res.text as string
    state = res.state
    cards = res.storyCards
    if (res.stop) {
      stop = true
      logs.push(logEntry(s, hook, 'info', `Stopped the ${HOOK_LABEL[hook].toLowerCase()} step.`))
      break
    }
  }
  const before = messageText(env.state.message)
  const after = messageText(state.message)
  return { text, stop, state, storyCards: cards, logs, errors, ran, message: after && after !== before ? after : undefined, ms: performance.now() - t0 }
}
