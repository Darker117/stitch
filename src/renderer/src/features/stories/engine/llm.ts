// Model resolution and one-shot completions for the story engine's helpers.
import type { LlmMessage } from '@shared/ipc'
import type { Adventure, LlmConnector } from '@shared/types'
import { invoke, parseJsonLoose } from '@/lib/api'
import { defaultLlm, type LlmChoice } from '@/lib/llm'
import { db } from '@/stores/db'
import { stripThinking } from './text'

/** The adventure's story model, falling back to the app default. */
export function storyModel(adv?: Pick<Adventure, 'settings'>): LlmChoice | undefined {
  const s = adv?.settings.llm
  if (s) {
    const c = db.get('connectors', s.connectorId)
    if (c?.enabled) return s
  }
  return defaultLlm()
}

export class NoModelError extends Error {
  constructor() {
    super('No text model is set up. Add LM Studio, Ollama or a cloud provider under Connectors.')
  }
}

function supportsJsonMode(connectorId: string): boolean {
  const c = db.get('connectors', connectorId) as LlmConnector | undefined
  return !!c && (c.kind === 'openai' || c.kind === 'ollama' || c.kind === 'anthropic' || c.kind === 'openrouter')
}

export async function complete(opts: {
  system?: string
  prompt?: string
  messages?: LlmMessage[]
  maxTokens?: number
  temperature?: number
  json?: boolean
  llm?: LlmChoice
}): Promise<string> {
  const llm = opts.llm ?? defaultLlm()
  if (!llm) throw new NoModelError()
  const messages: LlmMessage[] = opts.messages ?? [{ role: 'user', content: opts.prompt ?? '' }]
  const req = {
    connectorId: llm.connectorId,
    model: llm.model,
    system: opts.system,
    messages,
    maxTokens: opts.maxTokens ?? 600,
    temperature: opts.temperature ?? 0.8,
    json: opts.json && supportsJsonMode(llm.connectorId)
  }
  const run = async (r: typeof req): Promise<string> => {
    const res = await invoke('llm:complete', r)
    const text = stripThinking(res.text).trim()
    // Reasoning models can spend the whole budget thinking; give them room once.
    if (!text && res.reasoning) return stripThinking((await invoke('llm:complete', { ...r, maxTokens: (r.maxTokens ?? 600) + 2048 })).text).trim()
    return text
  }
  try {
    return await run(req)
  } catch (err) {
    if (!req.json) throw err
    return run({ ...req, json: false })
  }
}

/** Ask for a JSON object and parse it leniently. */
export async function completeJson<T = Record<string, unknown>>(opts: Parameters<typeof complete>[0]): Promise<T | null> {
  const system = `${opts.system ?? ''}\n\nReply with a single JSON object only — no prose, no code fences.`.trim()
  const text = await complete({ ...opts, system, json: true })
  return parseJsonLoose<T>(text)
}
