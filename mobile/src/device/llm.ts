// "This phone" as a text connector: shows up in every model picker (chat, stories, cards) and answers
// llm:* calls with the on-device model instead of the PC.
import type { LlmEvent, LlmMessage, LlmRequest, LlmResult, LlmTool } from '@shared/ipc'
import type { LlmConnector } from '@shared/types'
import { emitLocal, override, PASS } from '@mobile/bridge/router'
import type { PluginListenerHandle } from '@capacitor/core'
import { StitchDevice, type ChatTurn } from './plugin'
import { deviceOnly, modelById, readyModels, resolveBackend, useDevice, BACKEND_LABEL } from './store'
import { thinkSplitter } from './think'

export const PHONE_LLM_ID = 'phone-llm'

export function phoneLlmConnector(): LlmConnector {
  const { prefs } = useDevice.getState()
  return {
    id: PHONE_LLM_ID,
    name: 'This phone',
    category: 'llm',
    kind: 'device',
    baseUrl: '',
    hasKey: false,
    enabled: prefs.enabled.text,
    createdAt: 0,
    models: readyModels('text').map((m) => ({
      id: m.id,
      name: m.name,
      contextLength: m.contextLength,
      description: `${m.family} · ${BACKEND_LABEL[resolveBackend('text', m)]}`
    }))
  }
}

type Schema = { properties?: Record<string, { type?: string; enum?: string[] }>; required?: string[] }

/**
 * The on-device runtime has no tool channel, so tools are described in the prompt and the model
 * answers with a `<tool_call>` line — the chat agent picks those up (`extractTextToolCalls`).
 */
function toolGuide(tools: LlmTool[]): string {
  const lines = tools.map((t) => {
    const s = t.parameters as Schema
    const req = new Set(s.required ?? [])
    const args = Object.entries(s.properties ?? {})
      .map(([k, v]) => `${k}${req.has(k) ? '' : '?'}: ${v.enum ? v.enum.map((e) => JSON.stringify(e)).join(' | ') : (v.type ?? 'any')}`)
      .join(', ')
    return `- ${t.name}(${args}): ${t.description}`
  })
  return `You can use tools. To use one, reply with nothing but a single line like:
<tool_call>{"name": "web_search", "arguments": {"query": "..."}}</tool_call>
Then stop — the result arrives in the next message. One tool call per reply. When you have what you need, answer normally.

Tools:
${lines.join('\n')}`
}

/** Flatten the app's messages into plain chat turns the on-device runtime understands. */
function turns(req: LlmRequest): { system?: string; messages: ChatTurn[] } {
  let system = req.system ?? ''
  if (req.json) system += `${system ? '\n\n' : ''}Reply with a single JSON object only — no prose, no code fences.`
  if (req.tools?.length) system += `${system ? '\n\n' : ''}${toolGuide(req.tools)}`
  const messages: ChatTurn[] = []
  for (const m of req.messages as LlmMessage[]) {
    if (m.role === 'system') {
      system += `${system ? '\n\n' : ''}${m.content}`
      continue
    }
    const role = m.role === 'assistant' ? 'assistant' : 'user'
    const content = m.role === 'tool' ? `(tool result) ${m.content}` : m.content
    if (!content.trim()) continue
    // Merge consecutive same-role turns (templates expect alternation).
    const last = messages[messages.length - 1]
    if (last && last.role === role) last.content += `\n\n${content}`
    else messages.push({ role, content })
  }
  if (!messages.length || messages[0].role !== 'user') messages.unshift({ role: 'user', content: 'Begin.' })
  return { system: system || undefined, messages }
}

const running = new Map<string, { off: Promise<PluginListenerHandle> }>()

async function generate(req: LlmRequest, requestId: string, onDelta: (t: string) => void, onReasoning: (t: string) => void): Promise<LlmResult> {
  const m = modelById(req.model) ?? readyModels('text')[0]
  if (!m) throw new Error('No on-device text model yet — download one in More → This phone.')
  const st = useDevice.getState().status[m.id]
  if (!st?.ready) throw new Error(`${m.name} isn't downloaded yet — get it in More → This phone.`)
  const backend = resolveBackend('text', m)
  const split = thinkSplitter(onDelta, onReasoning)
  const off = StitchDevice.addListener('text', (e) => {
    if (e.requestId === requestId) split.push(e.delta)
  })
  running.set(requestId, { off })
  try {
    const { system, messages } = turns(req)
    const res = await StitchDevice.textGenerate({
      requestId,
      modelId: m.id,
      backend,
      dir: st.dir,
      file: m.entry ?? m.files[0]?.path ?? '',
      format: m.format,
      system,
      messages,
      maxTokens: req.maxTokens,
      temperature: req.temperature,
      topP: req.topP,
      topK: req.topK,
      stop: req.stop,
      contextLength: req.contextLength ?? m.contextLength,
      config: m.config
    })
    split.end()
    // Events may lag the final result; trust the full text if deltas were missed.
    if (!split.text && !split.reasoning && res.text) {
      const again = thinkSplitter(onDelta, onReasoning)
      again.push(res.text)
      again.end()
      return { text: again.text, reasoning: again.reasoning || undefined, stopReason: res.stopReason }
    }
    return { text: split.text, reasoning: split.reasoning || undefined, stopReason: res.stopReason }
  } finally {
    running.delete(requestId)
    void off.then((h) => h.remove())
  }
}

export function installLlm(): void {
  override('llm:models', ([id]) => (id === PHONE_LLM_ID ? phoneLlmConnector().models : PASS))

  override('llm:stream', ([r, rid]) => {
    const req = r as LlmRequest
    // "This phone only": PC models are answered here too, with the phone's model.
    if (req.connectorId !== PHONE_LLM_ID && !deviceOnly()) return PASS
    const requestId = String(rid)
    const send = (ev: LlmEvent): void => emitLocal('llm:event', ev)
    // Resolve the invoke right away; the reply streams as llm:event, like the PC does.
    void generate(
      req,
      requestId,
      (text) => send({ requestId, type: 'delta', text }),
      (text) => send({ requestId, type: 'reasoning', text })
    )
      .then((res) => send({ requestId, type: 'done', text: res.text, reasoning: res.reasoning, stopReason: res.stopReason }))
      .catch((err) => send({ requestId, type: 'error', message: err instanceof Error ? err.message : String(err) }))
    return undefined
  })

  override('llm:complete', async ([r]) => {
    const req = r as LlmRequest
    if (req.connectorId !== PHONE_LLM_ID && !deviceOnly()) return PASS
    return generate(req, `c-${Math.random().toString(36).slice(2)}`, () => {}, () => {})
  })

  override('llm:abort', async ([rid]) => {
    const requestId = String(rid)
    if (!running.has(requestId)) return PASS
    await StitchDevice.textAbort({ requestId }).catch(() => {})
    return undefined
  })
}
