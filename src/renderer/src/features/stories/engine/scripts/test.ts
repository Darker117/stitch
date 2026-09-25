// Dry runs: the editor's Test console and the composer's validateScript.
// Nothing here writes to an adventure.
import type { Adventure, StoryScript } from '@shared/types'
import { aidContext, fromAidContext, type ContextResult, type ScriptedInput } from '../context'
import { contextFor } from '../turn'
import { newCard } from '../defaults'
import { action } from '../adventure'
import { aidInputText, envFor, HOOK_LABEL, hookCode, runHook, type HookOutcome } from './runtime'
import { runSandboxed } from './sandbox'
import { HOOKS, type AidCard, type AidEnv, type HookName } from './types'

type Sources = Pick<StoryScript, 'library' | 'input' | 'context' | 'output'>

/** A tiny adventure to run scripts against when no real one is picked. */
export function sampleAdventure(): Adventure {
  const now = Date.now()
  return {
    id: 'sample',
    title: 'Sample adventure',
    description: '',
    tags: [],
    createdAt: now,
    updatedAt: now,
    lastPlayedAt: now,
    plot: {
      aiInstructions: '',
      plotEssentials: 'You are Mara, a courier in the rain-soaked city of Vell. Your sister Ilse vanished a week ago.',
      authorsNote: 'Tone: tense, atmospheric.',
      storySummary: '',
      thirdPerson: false,
      enabled: { storySummary: false, thirdPerson: false }
    },
    cards: [
      newCard({ type: 'character', name: 'Ilse', triggers: 'Ilse, sister', entry: 'Ilse is Mara’s younger sister, a clockmaker’s apprentice with ink-stained fingers.' }),
      newCard({ type: 'location', name: 'The Brass Lantern', triggers: 'Brass Lantern, tavern', entry: 'A cramped tavern by the canal where couriers trade gossip.' })
    ],
    actions: [
      action('start', 'Rain hammers the tin roofs of Vell. You tuck the last parcel of the night under your coat and hurry toward the Brass Lantern, where someone claims to have seen Ilse.'),
      action('do', 'push open the tavern door'),
      action('continue', 'Warm air and pipe smoke roll over you. At the bar, a woman in a grey hood turns at the sound of the bell and quickly looks away.'),
      action('say', 'Have you seen my sister Ilse?')
    ],
    redo: [],
    memories: [],
    player: { name: 'Mara', choices: {} },
    settings: {
      contextLength: 8192,
      memoryBank: false,
      autoSummarize: false,
      responseLength: 250,
      temperature: 0.9,
      topK: 40,
      topP: 0.95,
      safety: 'moderate',
      rawOutput: false,
      contextWarning: true,
      theme: 'dynamic',
      textStyle: 'print',
      textAnimation: true,
      largeText: false,
      stickyInput: false,
      compactButtons: false,
      autoNarrate: false,
      autoSee: false
    },
    scriptState: {}
  }
}

export const SAMPLE_OUTPUT = 'The hooded woman sets down her cup. “Ilse,” she repeats, too quietly. “Not here. Meet me by the canal at midnight.”'

/** The text a hook would receive in this adventure (what the Test console pre-fills). */
export function sampleText(hook: HookName, adv: Adventure): string {
  if (hook === 'input') return aidInputText('do', 'look around the tavern')
  if (hook === 'output') return SAMPLE_OUTPUT
  return aidContext(contextFor(adv, adv.actions)).text
}

/** Environment for one hook against `adv`, as a real turn would build it. */
export function testEnv(hook: HookName, adv: Adventure, text: string, state?: Record<string, unknown>): AidEnv {
  let env: AidEnv
  if (hook === 'context') {
    const ctx: ContextResult = contextFor(adv, adv.actions)
    const aid = aidContext(ctx)
    env = envFor(adv, adv.actions, text, { maxChars: aid.maxChars, memoryLength: aid.memoryLength, contextTokens: ctx.budget })
  } else env = envFor(adv, adv.actions, text)
  if (state) env.state = structuredClone(state)
  return env
}

export interface CardDiff {
  added: AidCard[]
  changed: { before: AidCard; after: AidCard }[]
  removed: AidCard[]
}

export function diffCards(before: AidCard[], after: AidCard[]): CardDiff {
  const b = new Map(before.map((c) => [c.id, c]))
  const a = new Map(after.map((c) => [c.id, c]))
  const same = (x: AidCard, y: AidCard): boolean => x.title === y.title && x.keys === y.keys && x.entry === y.entry && x.type === y.type && x.description === y.description
  return {
    added: after.filter((c) => !c.id || !b.has(c.id)),
    changed: after.filter((c) => b.has(c.id) && !same(b.get(c.id)!, c)).map((c) => ({ before: b.get(c.id)!, after: c })),
    removed: before.filter((c) => !a.has(c.id))
  }
}

export interface TestRun {
  hook: HookName
  env: AidEnv
  out: HookOutcome
  cards: CardDiff
  /** Context hook: how the result would be sent to the model. */
  mode?: ScriptedInput['mode']
}

/** Run one hook of one script. */
export async function testHook(script: StoryScript, hook: HookName, adv: Adventure, text: string, state?: Record<string, unknown>): Promise<TestRun> {
  const env = testEnv(hook, adv, text, state)
  const out = await runHook(hook, [script], env)
  let mode: ScriptedInput['mode'] | undefined
  if (hook === 'context') {
    const ctx = contextFor(adv, adv.actions)
    const aid = aidContext(ctx)
    mode = out.stop ? undefined : fromAidContext(ctx, { ...aid, text }, out.text).mode
  }
  return { hook, env, out, cards: diffCards(env.storyCards, out.storyCards), mode }
}

/**
 * Compile every tab, then dry-run Input → Context → Output against the
 * sample adventure, sharing state and cards between hooks like a real turn.
 */
export async function validateSources(script: Sources, name = 'Script'): Promise<{ ok: boolean; errors: string[]; logs: string[] }> {
  const s: StoryScript = { id: 'validate', name, source: 'user', createdAt: 0, updatedAt: 0, ...script }
  const errors: string[] = []
  const logs: string[] = []
  let adv = sampleAdventure()
  const env0 = envFor(adv, adv.actions, '')
  // Syntax first, tab by tab, so errors point at the right place.
  if (s.library.trim()) {
    const r = await runSandboxed(s.library, env0, { compileOnly: true })
    if (!r.ok) errors.push(`Library: ${r.error}`)
  }
  for (const h of HOOKS) {
    if (!s[h].trim()) continue
    const r = await runSandboxed(hookCode(s, s[h]), env0, { compileOnly: true })
    if (!r.ok && !errors.some((e) => e.startsWith('Library:'))) errors.push(`${HOOK_LABEL[h]}: ${r.error}`)
  }
  if (!HOOKS.some((h) => s[h].trim())) errors.push('No hook has any code: add Input, Context or Output code ending with modifier(text).')
  if (errors.length) return { ok: false, errors, logs }

  let state: Record<string, unknown> = {}
  for (const h of HOOKS) {
    if (!s[h].trim()) continue
    const env = testEnv(h, adv, sampleText(h, adv), state)
    const out = await runHook(h, [s], env)
    for (const l of out.logs) (l.level === 'error' ? errors : logs).push(`${HOOK_LABEL[h]}${l.level === 'error' ? '' : ` [${l.level}]`}: ${l.message}`)
    if (out.errors === 0 && typeof out.text !== 'string') errors.push(`${HOOK_LABEL[h]}: did not return text`)
    state = out.state
    adv = { ...adv, cards: out.storyCards.map((c) => ({ ...newCard(), id: c.id || newCard().id, name: c.title, triggers: c.keys, entry: c.entry, notes: c.description })) }
  }
  return { ok: errors.length === 0, errors, logs }
}
