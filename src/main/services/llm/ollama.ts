// Ollama native chat API (gives us num_ctx and top_k, which /v1 doesn't).
import { readFileSync } from 'node:fs'
import type { LlmRequest, LlmResult, LlmToolCall } from '@shared/ipc'
import type { LlmConnector, LlmModelInfo } from '@shared/types'
import { baseUrl, ensureOk, ndjson } from './common'

export async function streamOllama(
  c: LlmConnector,
  req: LlmRequest,
  onDelta: (t: string) => void,
  signal: AbortSignal,
  onReasoning?: (t: string) => void
): Promise<LlmResult> {
  const messages: unknown[] = []
  if (req.system) messages.push({ role: 'system', content: req.system })
  for (const m of req.messages) {
    if (m.role === 'tool') messages.push({ role: 'tool', content: m.content })
    else if (m.role === 'assistant' && m.toolCalls?.length)
      messages.push({ role: 'assistant', content: m.content, tool_calls: m.toolCalls.map((t) => ({ function: { name: t.name, arguments: t.args } })) })
    else
      messages.push({
        role: m.role,
        content: m.content,
        ...(m.images?.length ? { images: m.images.map((p) => readFileSync(p).toString('base64')) } : {})
      })
  }
  const options: Record<string, unknown> = {}
  if (req.temperature !== undefined) options.temperature = req.temperature
  if (req.topK !== undefined) options.top_k = req.topK
  if (req.topP !== undefined) options.top_p = req.topP
  if (req.maxTokens) options.num_predict = req.maxTokens
  if (req.contextLength) options.num_ctx = req.contextLength
  if (req.stop?.length) options.stop = req.stop

  const body: Record<string, unknown> = { model: req.model, messages, stream: true, options }
  if (req.json) body.format = 'json'
  if (req.tools?.length) body.tools = req.tools.map((t) => ({ type: 'function', function: t }))

  const res = await fetch(`${baseUrl(c)}/api/chat`, { method: 'POST', body: JSON.stringify(body), signal })
  await ensureOk(res, 'Ollama request')

  let text = ''
  let stopReason: string | undefined
  const toolCalls: LlmToolCall[] = []
  for await (const raw of ndjson(res.body!)) {
    const j = raw as {
      message?: { content?: string; thinking?: string; tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[] }
      done?: boolean
      done_reason?: string
      error?: string
    }
    if (j.error) throw new Error(j.error)
    if (j.message?.thinking) onReasoning?.(j.message.thinking)
    if (j.message?.content) {
      text += j.message.content
      onDelta(j.message.content)
    }
    for (const tc of j.message?.tool_calls ?? []) {
      toolCalls.push({ id: `call_${toolCalls.length}`, name: tc.function.name, args: tc.function.arguments ?? {} })
    }
    if (j.done) stopReason = j.done_reason
  }
  return { text, toolCalls: toolCalls.length ? toolCalls : undefined, stopReason }
}

export async function listOllamaModels(c: LlmConnector): Promise<LlmModelInfo[]> {
  const res = await fetch(`${baseUrl(c)}/api/tags`)
  await ensureOk(res, 'Ollama model list')
  const j = (await res.json()) as { models: { name: string; details?: { parameter_size?: string; family?: string } }[] }
  return j.models.map((m) => ({
    id: m.name,
    description: [m.details?.family, m.details?.parameter_size].filter(Boolean).join(' · ') || undefined
  }))
}
