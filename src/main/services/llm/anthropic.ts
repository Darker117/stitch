// Anthropic Messages API.
import type { LlmRequest, LlmResult, LlmToolCall } from '@shared/ipc'
import type { LlmConnector, LlmModelInfo } from '@shared/types'
import { baseUrl, ensureOk, imageData, isParamError, sseEvents } from './common'

const VERSION = '2023-06-01'

function headers(key?: string): Record<string, string> {
  return { 'Content-Type': 'application/json', 'x-api-key': key ?? '', 'anthropic-version': VERSION }
}

type Block = Record<string, unknown>

function toAnthropicMessages(req: LlmRequest): { role: 'user' | 'assistant'; content: Block[] }[] {
  const out: { role: 'user' | 'assistant'; content: Block[] }[] = []
  const push = (role: 'user' | 'assistant', blocks: Block[]): void => {
    const last = out[out.length - 1]
    if (last && last.role === role) last.content.push(...blocks)
    else out.push({ role, content: blocks })
  }
  for (const m of req.messages) {
    if (m.role === 'system') {
      push('user', [{ type: 'text', text: m.content }])
    } else if (m.role === 'tool') {
      push('user', [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }])
    } else if (m.role === 'assistant') {
      const blocks: Block[] = []
      if (m.content) blocks.push({ type: 'text', text: m.content })
      for (const t of m.toolCalls ?? []) blocks.push({ type: 'tool_use', id: t.id, name: t.name, input: t.args })
      if (blocks.length) push('assistant', blocks)
    } else {
      const blocks: Block[] = []
      for (const p of m.images ?? []) {
        const { mime, base64 } = imageData(p)
        blocks.push({ type: 'image', source: { type: 'base64', media_type: mime, data: base64 } })
      }
      blocks.push({ type: 'text', text: m.content || '…' })
      push('user', blocks)
    }
  }
  if (!out.length || out[0].role !== 'user') out.unshift({ role: 'user', content: [{ type: 'text', text: 'Begin.' }] })
  return out
}

export async function streamAnthropic(
  c: LlmConnector,
  key: string | undefined,
  req: LlmRequest,
  onDelta: (t: string) => void,
  signal: AbortSignal,
  onReasoning?: (t: string) => void
): Promise<LlmResult> {
  const build = (minimal: boolean): Record<string, unknown> => {
    let system = req.system ?? ''
    if (req.json) system += '\n\nRespond with a single JSON object only, no prose and no code fences.'
    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens ?? 1024,
      messages: toAnthropicMessages(req),
      stream: true
    }
    if (system.trim()) body.system = system.trim()
    if (!minimal) {
      if (req.temperature !== undefined) body.temperature = Math.min(1, req.temperature)
      if (req.topK !== undefined) body.top_k = req.topK
      if (req.stop?.length) body.stop_sequences = req.stop
    }
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }))
    }
    return body
  }

  const send = async (minimal: boolean): Promise<Response> => {
    const res = await fetch(`${baseUrl(c)}/v1/messages`, {
      method: 'POST',
      headers: headers(key),
      body: JSON.stringify(build(minimal)),
      signal
    })
    await ensureOk(res, 'Anthropic request')
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
  const tools = new Map<number, { id: string; name: string; json: string }>()
  for await (const ev of sseEvents(res.body!)) {
    let j: {
      type: string
      index?: number
      content_block?: { type: string; id?: string; name?: string }
      delta?: { type?: string; text?: string; thinking?: string; partial_json?: string; stop_reason?: string }
      error?: { message?: string }
    }
    try {
      j = JSON.parse(ev.data)
    } catch {
      continue
    }
    if (j.type === 'error') throw new Error(j.error?.message ?? 'Anthropic stream error')
    if (j.type === 'content_block_start' && j.content_block?.type === 'tool_use') {
      tools.set(j.index ?? 0, { id: j.content_block.id ?? '', name: j.content_block.name ?? '', json: '' })
    } else if (j.type === 'content_block_delta') {
      if (j.delta?.type === 'text_delta' && j.delta.text) {
        text += j.delta.text
        onDelta(j.delta.text)
      } else if (j.delta?.type === 'thinking_delta' && j.delta.thinking) {
        onReasoning?.(j.delta.thinking)
      } else if (j.delta?.type === 'input_json_delta') {
        const t = tools.get(j.index ?? 0)
        if (t) t.json += j.delta.partial_json ?? ''
      }
    } else if (j.type === 'message_delta' && j.delta?.stop_reason) {
      stopReason = j.delta.stop_reason
    }
  }

  const toolCalls: LlmToolCall[] = [...tools.values()].map((t) => {
    let args: Record<string, unknown> = {}
    try {
      args = t.json ? JSON.parse(t.json) : {}
    } catch {
      args = {}
    }
    return { id: t.id, name: t.name, args }
  })
  return { text, toolCalls: toolCalls.length ? toolCalls : undefined, stopReason }
}

export async function listAnthropicModels(c: LlmConnector, key?: string): Promise<LlmModelInfo[]> {
  const res = await fetch(`${baseUrl(c)}/v1/models?limit=100`, { headers: headers(key) })
  await ensureOk(res, 'Anthropic model list')
  const j = (await res.json()) as { data: { id: string; display_name?: string }[] }
  return j.data.map((m) => ({ id: m.id, name: m.display_name }))
}
