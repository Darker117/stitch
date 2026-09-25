// Story scripts during play: the Input, Context and Output hooks for an
// adventure, persisting what scripts change (state, story cards) and the
// per-adventure script log shown in the play panel.
import { useMemo } from 'react'
import { create } from 'zustand'
import type { ActionType, Adventure, StoryAction } from '@shared/types'
import { db } from '@/stores/db'
import { toast } from '@/stores/toast'
import { aidContext, fromAidContext, type ContextResult, type ScriptedInput } from '../context'
import { activeScripts, hasActiveScripts } from './library'
import { aidInputText, applyCardChanges, envFor, fromAidInput, HOOK_LABEL, runHook, type HookOutcome } from './runtime'
import { prewarmSandbox } from './sandbox'
import type { AidEnv, HookName, ScriptLogEntry } from './types'

// ─── Log ─────────────────────────────────────────────────────────────────────

const LOG_LIMIT = 200

interface LogState {
  byAdventure: Record<string, ScriptLogEntry[]>
  push: (advId: string, entries: ScriptLogEntry[]) => void
  clear: (advId: string) => void
}

export const useScriptLogStore = create<LogState>((set) => ({
  byAdventure: {},
  push: (advId, entries) =>
    set((s) => {
      if (!entries.length) return s
      const next = [...(s.byAdventure[advId] ?? []), ...entries].slice(-LOG_LIMIT)
      return { byAdventure: { ...s.byAdventure, [advId]: next } }
    }),
  clear: (advId) => set((s) => ({ byAdventure: { ...s.byAdventure, [advId]: [] } }))
}))

const NONE: ScriptLogEntry[] = []
export function useScriptLog(advId: string | undefined): ScriptLogEntry[] {
  const list = useScriptLogStore((s) => (advId ? s.byAdventure[advId] : undefined) ?? NONE)
  return useMemo(() => list, [list])
}

// ─── Persisting effects ──────────────────────────────────────────────────────

/** Save the state and story cards the scripts left behind. */
async function commit(advId: string, env: AidEnv, out: HookOutcome): Promise<void> {
  const cur = db.get('adventures', advId)
  if (!cur) return
  const stateChanged = JSON.stringify(out.state) !== JSON.stringify(env.state)
  const cards = applyCardChanges(cur.cards, env.storyCards, out.storyCards)
  if (!stateChanged && !cards) return
  await db.update('adventures', advId, (a) => ({
    ...a,
    ...(stateChanged ? { scriptState: out.state } : {}),
    ...(cards ? { cards: applyCardChanges(a.cards, env.storyCards, out.storyCards) ?? a.cards } : {}),
    updatedAt: Date.now()
  }))
}

const toasted = new Map<string, number>()

/** Log the run, surface errors (the same one at most once a minute), and show `state.message` like AI Dungeon does. */
function report(advId: string, hook: HookName, out: HookOutcome): void {
  const entries = [...out.logs]
  if (out.message) entries.push({ id: `${Date.now()}-msg`, at: Date.now(), script: out.ran.join(', ') || 'Scripts', hook, level: 'info', message: `Message: ${out.message}` })
  useScriptLogStore.getState().push(advId, entries)
  const first = out.logs.find((l) => l.level === 'error')
  if (first) {
    const key = `${advId}|${hook}|${first.script}|${first.message}`
    if (Date.now() - (toasted.get(key) ?? 0) > 60_000) {
      toasted.set(key, Date.now())
      toast.error(`Script error · ${HOOK_LABEL[hook]}`, `${first.script}: ${first.message}`)
    }
  }
  if (out.message) toast.info(out.message)
}

/** How the last context was sent, per adventure (logged only when it changes). */
const lastMode = new Map<string, ScriptedInput['mode']>()

/** `state.memory` overrides (context / authorsNote / frontMemory) while scripts are on. */
export function scriptMemory(adv: Pick<Adventure, 'scripts' | 'scenarioId' | 'scriptState'>): { context?: string; authorsNote?: string; frontMemory?: string } | undefined {
  const m = adv.scriptState?.memory
  if (!m || typeof m !== 'object' || !hasActiveScripts(adv)) return undefined
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined)
  const r = m as Record<string, unknown>
  return { context: str(r.context), authorsNote: str(r.authorsNote), frontMemory: str(r.frontMemory) }
}

async function scriptsWith(adv: Adventure, hook: HookName) {
  if (!hasActiveScripts(adv)) return []
  prewarmSandbox()
  return (await activeScripts(adv)).filter((s) => s[hook].trim())
}

/** Warm the sandbox when an adventure with scripts opens. */
export function prepareScripts(adv: Adventure | undefined): void {
  if (adv && hasActiveScripts(adv)) prewarmSandbox()
}

// ─── Hooks ───────────────────────────────────────────────────────────────────

export class ScriptStopError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ScriptStopError'
  }
}

export interface InputResult {
  type: ActionType
  text: string
  stop: boolean
  /** A script showed a message (state.message) this turn. */
  messaged: boolean
}

/** Input hook: runs on the player's action before it is added. Null when no script has one. */
export async function runInputScripts(advId: string, type: ActionType, text: string): Promise<InputResult | null> {
  const adv = db.get('adventures', advId)
  if (!adv) return null
  const scripts = await scriptsWith(adv, 'input')
  if (!scripts.length) return null
  const env = envFor(adv, adv.actions, aidInputText(type, text))
  const out = await runHook('input', scripts, env)
  await commit(advId, env, out)
  report(advId, 'input', out)
  if (out.stop) return { type, text, stop: true, messaged: !!out.message }
  return { ...fromAidInput(type, text, out.text), stop: false, messaged: !!out.message }
}

/**
 * Context hook: scripts get the context as AI Dungeon text and may rewrite
 * it. Returns the model input to send, or null when no script has a context
 * hook. Throws ScriptStopError when a script sets `stop`.
 */
export async function runContextScripts(advId: string, history: StoryAction[], ctx: ContextResult): Promise<ScriptedInput | null> {
  const adv = db.get('adventures', advId)
  if (!adv) return null
  const scripts = await scriptsWith(adv, 'context')
  if (!scripts.length) return null
  const aid = aidContext(ctx)
  const env = envFor(adv, history, aid.text, { maxChars: aid.maxChars, memoryLength: aid.memoryLength, contextTokens: ctx.budget })
  const out = await runHook('context', scripts, env)
  await commit(advId, env, out)
  report(advId, 'context', out)
  if (out.stop) throw new ScriptStopError(out.message || 'Sorry, the AI is stumped. Edit or retry your previous action, or write something to help it along.')
  const input = fromAidContext(ctx, aid, out.text)
  if (lastMode.get(advId) !== input.mode) {
    const message = { native: 'Context unchanged — sent in the normal chat layout.', header: 'World info rewritten above Recent Story — the chat layout is kept.', raw: 'Context rewritten — sent as one AI Dungeon-style prompt.' }[input.mode]
    if (lastMode.has(advId) || input.mode !== 'native') useScriptLogStore.getState().push(advId, [{ id: `${Date.now()}-ctx`, at: Date.now(), script: out.ran.join(', '), hook: 'context', level: 'info', message }])
    lastMode.set(advId, input.mode)
  }
  return input
}

/** Output hook: runs on the model's reply before it is saved. Returns the text to keep. */
export async function runOutputScripts(advId: string, history: StoryAction[], text: string): Promise<string> {
  const adv = db.get('adventures', advId)
  if (!adv) return text
  const scripts = await scriptsWith(adv, 'output')
  if (!scripts.length) return text
  const env = envFor(adv, history, text)
  const out = await runHook('output', scripts, env)
  await commit(advId, env, out)
  report(advId, 'output', out)
  if (out.stop) {
    useScriptLogStore.getState().push(advId, [{ id: `${Date.now()}-stop`, at: Date.now(), script: out.ran.join(', '), hook: 'output', level: 'warn', message: 'stop is ignored in the Output hook; the reply was kept.' }])
  }
  if (!out.text.trim()) {
    useScriptLogStore.getState().push(advId, [{ id: `${Date.now()}-blank`, at: Date.now(), script: out.ran.join(', '), hook: 'output', level: 'info', message: 'The reply was replaced with nothing, so no passage was added.' }])
  }
  return out.text
}

/** Forget the adventure's script `state` (scripts start fresh next turn). */
export async function resetScriptState(advId: string): Promise<void> {
  await db.update('adventures', advId, (a) => ({ ...a, scriptState: {}, updatedAt: Date.now() }))
  useScriptLogStore.getState().push(advId, [{ id: `${Date.now()}-reset`, at: Date.now(), script: 'Stitch', hook: 'library', level: 'info', message: 'Script state was reset.' }])
}
