// Text-model selection helpers shared by chat, stories and card generation.
import { useCallback, useEffect, useState } from 'react'
import type { LlmConnector, LlmModelInfo } from '@shared/types'
import { errorText, invoke } from './api'
import { db, useCollection } from '@/stores/db'
import { useSettings } from '@/stores/settings'

export interface LlmChoice {
  connectorId: string
  model: string
}

export const LLM_KIND_LABEL: Record<LlmConnector['kind'], string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  openrouter: 'OpenRouter',
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  gemini: 'Google Gemini',
  'openai-compatible': 'OpenAI-compatible',
  device: 'This phone',
  llamacpp: 'llama.cpp'
}

export function isLocalKind(kind: LlmConnector['kind']): boolean {
  return kind === 'ollama' || kind === 'lmstudio' || kind === 'openai-compatible' || kind === 'llamacpp'
}

export function useLlmConnectors(): LlmConnector[] {
  const all = useCollection('connectors')
  return all.filter((c): c is LlmConnector => c.category === 'llm' && c.enabled)
}

/** Model list for one connector, with refresh. Cached list shows instantly. */
export function useModels(connectorId: string | undefined): { models: LlmModelInfo[]; loading: boolean; error?: string; refresh: () => void } {
  const connector = useCollection('connectors').find((c) => c.id === connectorId) as LlmConnector | undefined
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const load = useCallback(
    async (refresh: boolean) => {
      if (!connectorId) return
      setLoading(true)
      setError(undefined)
      try {
        await invoke('llm:models', connectorId, refresh)
      } catch (err) {
        setError(errorText(err))
      } finally {
        setLoading(false)
      }
    },
    [connectorId]
  )
  useEffect(() => {
    if (connectorId && !connector?.models?.length) void load(true)
  }, [connectorId, connector?.models?.length, load])
  return { models: connector?.models ?? [], loading, error, refresh: () => void load(true) }
}

/**
 * The model to use when a feature has no explicit choice: the user's default,
 * else the first connector that has a model list (local servers first).
 */
export function defaultLlm(): LlmChoice | undefined {
  const s = useSettings.getState().settings
  if (s?.defaultLlm) {
    const c = db.get('connectors', s.defaultLlm.connectorId)
    if (c?.enabled) return s.defaultLlm
  }
  const conns = db.all('connectors').filter((c): c is LlmConnector => c.category === 'llm' && c.enabled && !!c.models?.length)
  conns.sort((a, b) => Number(isLocalKind(b.kind)) - Number(isLocalKind(a.kind)))
  const c = conns[0]
  return c ? { connectorId: c.id, model: c.models![0].id } : undefined
}

export function useDefaultLlm(): LlmChoice | undefined {
  useCollection('connectors')
  const settings = useSettings((s) => s.settings)
  void settings
  return defaultLlm()
}

export function modelLabel(choice: LlmChoice | undefined): string {
  if (!choice) return 'No model'
  const c = db.get('connectors', choice.connectorId) as LlmConnector | undefined
  const m = c?.models?.find((x) => x.id === choice.model)
  const name = m?.name ?? choice.model
  return name.replace(/^[^/]+\//, '')
}

export function contextWindow(choice: LlmChoice | undefined): number | undefined {
  if (!choice) return undefined
  const c = db.get('connectors', choice.connectorId) as LlmConnector | undefined
  return c?.models?.find((x) => x.id === choice.model)?.contextLength
}
