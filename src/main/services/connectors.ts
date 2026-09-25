import { nanoid } from 'nanoid'
import type { Connector, ConnectorCategory } from '@shared/types'
import { handle } from '../ipc'
import { getSecret, setSecret } from '../settings'
import { db } from '../store'
import { listModels } from './llm'

type Tester = (c: Connector) => Promise<{ ok: boolean; message: string }>
const testers: Partial<Record<ConnectorCategory, Tester>> = {
  llm: async (c) => {
    const models = await listModels(c.id, true)
    return { ok: true, message: `Connected — ${models.length} model${models.length === 1 ? '' : 's'} available` }
  }
}

export function registerTester(category: ConnectorCategory, fn: Tester): void {
  testers[category] = fn
}

export function hasKey(id: string): boolean {
  return !!getSecret(id)
}

/** First-run defaults so local backends work out of the box. */
export function seedConnectors(): void {
  const col = db('connectors')
  if (col.list().length) return
  const now = Date.now()
  col.put({ id: 'comfy-local', name: 'ComfyUI', category: 'comfy', url: 'http://127.0.0.1:8188', roles: [], enabled: true, createdAt: now })
  col.put({ id: 'lmstudio', name: 'LM Studio', category: 'llm', kind: 'lmstudio', baseUrl: 'http://127.0.0.1:1234/v1', hasKey: false, enabled: true, createdAt: now })
  col.put({ id: 'ollama', name: 'Ollama', category: 'llm', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', hasKey: false, enabled: true, createdAt: now })
  col.put({ id: 'voice-local', name: 'Stitch Voice (Qwen3-TTS)', category: 'voice', kind: 'local-qwen', baseUrl: 'http://127.0.0.1:7862', hasKey: false, enabled: true, createdAt: now })
}

export function registerConnectors(): void {
  handle('connectors:save', (connector, apiKey) => {
    const c = { ...connector, id: connector.id || nanoid(10), createdAt: connector.createdAt || Date.now() } as Connector
    if (apiKey !== undefined) setSecret(c.id, apiKey)
    if ('hasKey' in c) c.hasKey = hasKey(c.id)
    return db('connectors').put(c)
  })
  handle('connectors:delete', (id) => {
    setSecret(id, null)
    db('connectors').delete(id)
  })
  handle('connectors:test', async (id) => {
    const c = db('connectors').get(id)
    if (!c) return { ok: false, message: 'Connector not found' }
    const t = testers[c.category]
    if (!t) return { ok: false, message: 'No test available' }
    try {
      return await t(c)
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  })
}
