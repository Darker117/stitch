// Stable entry points for other features (the Scenario Composer writes
// scripts with an LLM through these). Keep the signatures stable.
import { nanoid } from 'nanoid'
import type { ID, StoryScript } from '@shared/types'
import { db, loadCollection } from '@/stores/db'
import { validateSources } from './test'

export { AID_SCRIPTING_GUIDE } from './guide'
export { BUILTIN_SCRIPTS } from './builtin'
export { loadScript, useScripts } from './library'

/** Save a new script to the `scripts` collection (source 'user' unless given). */
export async function createScript(input: Partial<StoryScript> & { name: string }): Promise<StoryScript> {
  const now = Date.now()
  const script: StoryScript = {
    library: '',
    input: '',
    context: '',
    output: '',
    ...input,
    id: input.id && !input.id.startsWith('builtin:') ? input.id : nanoid(10),
    name: input.name.trim() || 'Untitled script',
    source: input.source ?? 'user',
    createdAt: input.createdAt ?? now,
    updatedAt: now
  }
  await loadCollection('scripts')
  await db.put('scripts', script)
  return script
}

/**
 * Add a script to the end of a scenario's run order (no-op if it is already
 * there) and switch the scenario's scripts on unless they were explicitly
 * turned off.
 */
export async function attachScriptToScenario(scenarioId: ID, scriptId: ID): Promise<void> {
  await loadCollection('scenarios')
  await db.update('scenarios', scenarioId, (cur) => {
    const refs = cur.scripts ?? []
    return {
      ...cur,
      scriptsEnabled: cur.scriptsEnabled ?? true,
      scripts: refs.some((r) => r.scriptId === scriptId) ? refs : [...refs, { scriptId, enabled: true }],
      updatedAt: Date.now()
    }
  })
}

/**
 * Compile check of every tab plus a dry run of each defined hook (Input →
 * Context → Output, sharing state) in the sandbox against a sample
 * adventure. `errors` explain what to fix; `logs` are the script's own output.
 */
export async function validateScript(script: Pick<StoryScript, 'library' | 'input' | 'context' | 'output'>): Promise<{ ok: boolean; errors: string[]; logs: string[] }> {
  return validateSources(script)
}
