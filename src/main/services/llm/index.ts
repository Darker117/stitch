import type { LlmRequest, LlmResult } from '@shared/ipc'
import type { LlmConnector, LlmModelInfo } from '@shared/types'
import { emit, handle } from '../../ipc'
import { getSecret } from '../../settings'
import { db } from '../../store'
import { listAnthropicModels, streamAnthropic } from './anthropic'
import { listOllamaModels, streamOllama } from './ollama'
import { listOpenAiModels, streamOpenAi } from './openai'
import { ThinkSplitter, type ThinkSink } from './think'
import { llamaModels, llamaReady } from '../llama'

const active = new Map<string, AbortController>()

function connector(id: string): LlmConnector {
  const c = db('connectors').get(id)
  if (!c || c.category !== 'llm') throw new Error('Text model connector not found. Add one under Connectors.')
  if (!c.enabled) throw new Error(`${c.name} is disabled`)
  return c
}

/**
 * Stream a completion. Thinking (native reasoning fields or <think> blocks)
 * goes to `sink.reasoning` and never into the returned text.
 */
export async function runLlm(req: LlmRequest, sink: ThinkSink, signal: AbortSignal): Promise<LlmResult> {
  let c = connector(req.connectorId)
  // Stitch's llama.cpp engine starts on demand (its port may change between runs).
  if (c.kind === 'llamacpp') {
    await llamaReady()
    c = connector(req.connectorId)
  }
  const key = getSecret(c.id)
  const splitter = new ThinkSplitter(sink)
  let native = ''
  const onDelta = (t: string): void => splitter.push(t)
  const onReasoning = (t: string): void => {
    native += t
    sink.reasoning(t)
  }
  let res: LlmResult
  switch (c.kind) {
    case 'anthropic':
      res = await streamAnthropic(c, key, req, onDelta, signal, onReasoning)
      break
    case 'ollama':
      res = await streamOllama(c, req, onDelta, signal, onReasoning)
      break
    default:
      res = await streamOpenAi(c, key, req, onDelta, signal, onReasoning)
  }
  splitter.end()
  const reasoning = (native + splitter.reasoning).trim()
  return { ...res, text: splitter.content.trim(), reasoning: reasoning || undefined }
}

const noop: ThinkSink = { text: () => {}, reasoning: () => {}, reset: () => {} }

/** Non-streaming helper for main-process callers. */
export async function completeLlm(req: LlmRequest): Promise<LlmResult> {
  const ctrl = new AbortController()
  return runLlm(req, noop, ctrl.signal)
}

export async function listModels(id: string, refresh = false): Promise<LlmModelInfo[]> {
  const c = connector(id)
  if (c.kind === 'llamacpp') return llamaModels()
  if (!refresh && c.models?.length) return c.models
  const key = getSecret(c.id)
  let models: LlmModelInfo[]
  if (c.kind === 'anthropic') models = await listAnthropicModels(c, key)
  else if (c.kind === 'ollama') models = await listOllamaModels(c)
  else models = await listOpenAiModels(c, key)
  db('connectors').put({ ...c, models })
  return models
}

export function registerLlm(): void {
  handle('llm:models', (id, refresh) => listModels(id, refresh))

  handle('llm:stream', (req, requestId) => {
    const ctrl = new AbortController()
    active.set(requestId, ctrl)
    // Deltas are batched per ~30ms tick to keep IPC traffic sane.
    let text = ''
    let thought = ''
    let timer: NodeJS.Timeout | null = null
    const flush = (): void => {
      timer = null
      if (thought) emit('llm:event', { requestId, type: 'reasoning', text: thought })
      if (text) emit('llm:event', { requestId, type: 'delta', text })
      text = ''
      thought = ''
    }
    const schedule = (): void => {
      if (!timer) timer = setTimeout(flush, 30)
    }
    const sink: ThinkSink = {
      text: (t) => {
        text += t
        schedule()
      },
      reasoning: (t) => {
        thought += t
        schedule()
      },
      reset: (content, reasoning) => {
        if (timer) clearTimeout(timer)
        timer = null
        text = ''
        thought = ''
        emit('llm:event', { requestId, type: 'reset', text: content, reasoning })
      }
    }
    runLlm(req, sink, ctrl.signal)
      .then((res) => {
        if (timer) clearTimeout(timer)
        flush()
        emit('llm:event', { requestId, type: 'done', text: res.text, reasoning: res.reasoning, toolCalls: res.toolCalls, stopReason: res.stopReason })
      })
      .catch((err: Error) => {
        if (timer) clearTimeout(timer)
        flush()
        const aborted = ctrl.signal.aborted
        emit('llm:event', aborted ? { requestId, type: 'done', text: '', stopReason: 'aborted' } : { requestId, type: 'error', message: err.message })
      })
      .finally(() => active.delete(requestId))
  })

  handle('llm:complete', (req) => completeLlm(req))

  handle('llm:abort', (requestId) => {
    active.get(requestId)?.abort()
    active.delete(requestId)
  })
}
