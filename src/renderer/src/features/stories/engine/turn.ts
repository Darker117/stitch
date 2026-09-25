// One generation turn (streamed) plus background upkeep: auto summarization
// of passages that fell out of the window and the memory bank. Story scripts'
// Context hook runs between building the context and calling the model.
import type { Adventure, StoryAction } from '@shared/types'
import { streamLlm, type StreamHandle } from '@/lib/api'
import { contextWindow, type LlmChoice } from '@/lib/llm'
import { db } from '@/stores/db'
import { extractMemories, summarize } from './ai'
import { buildContext, type ContextResult, type ScriptedInput } from './context'
import { NoModelError, storyModel } from './llm'
import { runContextScripts, scriptMemory } from './scripts/play'
import { cleanOutput, contextLine, isAiAction, streamingDisplay } from './text'
import { nanoid } from 'nanoid'

export interface TurnHandle {
  done: Promise<{ text: string; raw: string; reasoning?: string; llm: LlmChoice; context: ContextResult }>
  abort: () => void
}

/** Models seen emitting reasoning: they get extra output headroom (thinking eats tokens on some servers). */
const reasoners = new Set<string>()
const REASONING_HINT = /(think|reason|r1|qwq|qwen3|gpt-oss|magistral|deepseek|o[134]-|o[134]$)/i
export function isReasoner(model: string): boolean {
  return reasoners.has(model) || REASONING_HINT.test(model)
}

export function contextFor(adv: Adventure, history: StoryAction[], llm?: LlmChoice): ContextResult {
  const choice = llm ?? storyModel(adv)
  // Scripts' state.memory takes precedence over the plot components (as in AID).
  const mem = scriptMemory(adv)
  const plot = mem?.context || mem?.authorsNote ? { ...adv.plot, plotEssentials: mem.context ?? adv.plot.plotEssentials, authorsNote: mem.authorsNote ?? adv.plot.authorsNote } : adv.plot
  return buildContext({
    plot,
    cards: adv.cards,
    memories: adv.memories,
    actions: history,
    settings: adv.settings,
    player: adv.player,
    modelWindow: contextWindow(choice),
    frontMemory: mem?.frontMemory
  })
}

/** Stream a story continuation for `history`. `onText` gets display-ready text, `onReasoning` the model's hidden thinking. */
export function runTurn(adv: Adventure, history: StoryAction[], onText: (text: string) => void, onReasoning?: (thinking: string) => void): TurnHandle {
  const llm = storyModel(adv)
  if (!llm) {
    return { done: Promise.reject(new NoModelError()), abort: () => {} }
  }
  const window = contextWindow(llm)
  const s = adv.settings
  let sent: Pick<ScriptedInput, 'system' | 'messages' | 'tokens'>
  const request = (extra: number) => ({
    connectorId: llm.connectorId,
    model: llm.model,
    system: sent.system,
    messages: sent.messages,
    maxTokens: s.responseLength + extra,
    temperature: s.temperature,
    topP: s.topP,
    topK: s.topK > 0 ? s.topK : undefined,
    contextLength: Math.min(s.contextLength, window ?? Infinity)
  })
  const onReason = (t: string): void => {
    if (t) reasoners.add(llm.model)
    onReasoning?.(t)
  }
  let handle: StreamHandle | undefined
  let aborted = false
  const done = (async () => {
    const ctx = contextFor(adv, history, llm)
    sent = ctx
    // Context hook: scripts may rewrite what the model sees.
    const scripted = await runContextScripts(adv.id, history, ctx)
    if (scripted) sent = scripted
    if (aborted) throw new Error('Stopped')
    handle = streamLlm(request(isReasoner(llm.model) ? 1536 : 0), (full) => onText(streamingDisplay(full)), onReason)
    // Record exactly what was sent, for Inspect Input.
    void db.patch('adventures', adv.id, {
      lastInput: { system: sent.system, messages: sent.messages, tokens: sent.tokens, droppedCards: ctx.droppedCards }
    })
    let r = await handle.done
    // Thinking used up the whole budget: try once more with room for the reply.
    if (!cleanOutput(r.text).trim() && r.reasoning && !aborted) {
      handle = streamLlm(request(2048), (full) => onText(streamingDisplay(full)), onReason)
      r = await handle.done
    }
    const text = cleanOutput(r.text, { raw: s.rawOutput })
    if (!text) throw new Error('The model returned an empty reply. Try Retry, or raise the response length.')
    return { text, raw: r.text, reasoning: r.reasoning, llm, context: ctx }
  })()
  return {
    done,
    abort: () => {
      aborted = true
      handle?.abort()
    }
  }
}

// ─── Background upkeep ───────────────────────────────────────────────────────

const busy = new Set<string>()

function passages(actions: StoryAction[]): string {
  return actions
    .filter((a) => a.type !== 'see' && a.text.trim())
    .map((a) => (isAiAction(a) ? a.text.trim() : contextLine(a)))
    .join('\n\n')
}

/** Run after a successful turn. Never throws. */
export async function upkeep(advId: string, ctx: ContextResult): Promise<void> {
  if (busy.has(advId)) return
  busy.add(advId)
  try {
    let adv = db.get('adventures', advId)
    if (!adv) return
    const llm = storyModel(adv)
    if (!llm) return

    // Auto summarization: fold everything before the context window into the summary.
    const upTo = adv.summaryUpTo ?? 0
    if (adv.settings.autoSummarize && ctx.firstIncluded > upTo) {
      const text = passages(adv.actions.slice(upTo, ctx.firstIncluded))
      if (text.length > 200) {
        const summary = await summarize(adv.plot.storySummary, text, llm)
        if (summary) {
          adv =
            (await db.update('adventures', advId, (cur) => ({
              ...cur,
              plot: { ...cur.plot, storySummary: summary, enabled: { ...cur.plot.enabled, storySummary: true } },
              summaryUpTo: ctx.firstIncluded
            }))) ?? adv
        }
      }
    }

    // Memory bank: every ~8 actions, remember a few durable facts.
    if (adv.settings.memoryBank) {
      const last = adv.memories.reduce((m, x) => Math.max(m, x.upTo), -1)
      const end = adv.actions.length - 1
      if (end - last >= 8) {
        const facts = await extractMemories(
          passages(adv.actions.slice(last + 1)),
          adv.memories.map((m) => m.text),
          llm
        )
        if (facts.length) {
          const now = Date.now()
          await db.update('adventures', advId, (cur) => ({
            ...cur,
            memories: [...cur.memories, ...facts.map((text) => ({ id: nanoid(8), text, upTo: end, createdAt: now }))]
          }))
        }
      }
    }
  } catch (err) {
    console.warn('[stories] upkeep failed', err)
  } finally {
    busy.delete(advId)
  }
}
