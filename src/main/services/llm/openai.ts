// OpenAI Chat Completions — also used for OpenRouter, LM Studio, Gemini's
// OpenAI endpoint and any other OpenAI-compatible server.
import type { LlmMessage, LlmRequest, LlmResult, LlmToolCall } from '@shared/ipc'
import type { LlmConnector, LlmModelInfo } from '@shared/types'
import { baseUrl, ensureOk, imageData, isParamError, sseEvents } from './common'

function headers(c: LlmConnector, key?: string): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' }
  if (key) h.Authorization = `Bearer ${key}`
  if (c.kind === 'openrouter') {
    h['HTTP-Referer'] = 'https://github.com/stitch-app'
    h['X-Title'] = 'Stitch'
  }
  return h
}

function toOpenAiMessages(req: LlmRequest): unknown[] {
  const out: unknown[] = []
  if (req.system) out.push({ role: 'system', content: req.system })
  for (const m of req.messages as LlmMessage[]) {
    if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content })
    } else if (m.role === 'assistant' && m.toolCalls?.length) {
      out.push({
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.args) } }))
      })
    } else if (m.images?.length && m.role === 'user') {
      out.push({
        role: 'user',
        content: [
          { type: 'text', text: m.content },
          ...m.images.map((p) => {
            const { mime, base64 } = imageData(p)
            return { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } }
          })
        ]
      })
    } else {
      out.push({ role: m.role, content: m.content })
    }
  }
  return out
}

export async function streamOpenAi(
  c: LlmConnector,
  key: string | undefined,
  req: LlmRequest,
  onDelta: (t: string) => void,
  signal: AbortSignal,
  onReasoning?: (t: string) => void
): Promise<LlmResult> {
  const build = (minimal: boolean): Record<string, unknown> => {
    const body: Record<string, unknown> = { model: req.model, messages: toOpenAiMessages(req), stream: true }
    const official = c.kind === 'openai'
    if (req.maxTokens) body[official || minimal ? 'max_completion_tokens' : 'max_tokens'] = req.maxTokens
    if (!minimal) {
      if (req.temperature !== undefined) body.temperature = req.temperature
      if (req.topP !== undefined) body.top_p = req.topP
      if (req.topK !== undefined && !official && c.kind !== 'gemini') body.top_k = req.topK
      if (req.stop?.length) body.stop = req.stop.slice(0, 4)
    }
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))
    }
    if (req.json && !req.tools?.length) body.response_format = { type: 'json_object' }
    if (c.kind === 'openrouter') body.usage = { include: false }
    return body
  }

  const send = async (minimal: boolean): Promise<Response> => {
    const res = await fetch(`${baseUrl(c)}/chat/completions`, {
      method: 'POST',
      headers: headers(c, key),
      body: JSON.stringify(build(minimal)),
      signal
    })
    await ensureOk(res, `${c.name} request`)
    return res
  }

  let res: Response
  try {
    res = await send(false)
  } catch (err) {
    if (!isParamError(err)) throw err
    res = await send(true)
  }

  let text = ''
  let stopReason: string | undefined
  const calls = new Map<number, { id: string; name: string; args: string }>()
  for await (const ev of sseEvents(res.body!)) {
    if (ev.data === '[DONE]') break
    let j: {
      choices?: {
        delta?: { content?: string; reasoning?: string; reasoning_content?: string; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] }
        finish_reason?: string
      }[]
      error?: { message?: string }
    }
    try {
      j = JSON.parse(ev.data)
    } catch {
      continue
    }
    if (j.error) throw new Error(j.error.message ?? 'Stream error')
    const choice = j.choices?.[0]
    if (!choice) continue
    const d = choice.delta
    const thought = d?.reasoning_content ?? d?.reasoning
    if (thought) onReasoning?.(thought)
    if (d?.content) {
      text += d.content
      onDelta(d.content)
    }
    for (const tc of d?.tool_calls ?? []) {
      const cur = calls.get(tc.index) ?? { id: '', name: '', args: '' }
      if (tc.id) cur.id = tc.id
      if (tc.function?.name) cur.name += tc.function.name
      if (tc.function?.arguments) cur.args += tc.function.arguments
      calls.set(tc.index, cur)
    }
    if (choice.finish_reason) stopReason = choice.finish_reason
  }

  const toolCalls: LlmToolCall[] = [...calls.values()].map((t, i) => {
    let args: Record<string, unknown> = {}
    try {
      args = t.args ? JSON.parse(t.args) : {}
    } catch {
      args = { _raw: t.args }
    }
    return { id: t.id || `call_${i}`, name: t.name, args }
  })
  return { text, toolCalls: toolCalls.length ? toolCalls : undefined, stopReason }
}

const NON_CHAT = /embed|whisper|tts|dall-e|davinci|babbage|moderation|image|audio|transcribe|realtime|search|sora|computer-use/i

export async function listOpenAiModels(c: LlmConnector, key?: string): Promise<LlmModelInfo[]> {
  // LM Studio exposes context sizes on its native endpoint.
  if (c.kind === 'lmstudio') {
    try {
      const root = baseUrl(c).replace(/\/v1$/, '')
      const res = await fetch(`${root}/api/v0/models`, { headers: headers(c, key) })
      if (res.ok) {
        const j = (await res.json()) as { data: { id: string; type?: string; max_context_length?: number; loaded_context_length?: number }[] }
        return j.data
          .filter((m) => m.type !== 'embeddings')
          .map((m) => ({ id: m.id, contextLength: m.loaded_context_length ?? m.max_context_length }))
      }
    } catch {
      /* fall through */
    }
  }
  const res = await fetch(`${baseUrl(c)}/models`, { headers: headers(c, key) })
  await ensureOk(res, `${c.name} model list`)
  const j = (await res.json()) as { data?: { id: string; name?: string; context_length?: number; description?: string }[] }
  let models = (j.data ?? []).map((m) => ({
    id: c.kind === 'gemini' ? m.id.replace(/^models\//, '') : m.id,
    name: m.name,
    contextLength: m.context_length,
    description: m.description?.slice(0, 200)
  }))
  if (c.kind === 'openai' || c.kind === 'gemini') models = models.filter((m) => !NON_CHAT.test(m.id))
  return models.sort((a, b) => a.id.localeCompare(b.id))
}
