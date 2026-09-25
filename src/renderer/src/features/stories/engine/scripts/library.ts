// The script library: built-ins plus the `scripts` collection, lookups that
// resolve full sources, and which scripts an adventure actually runs.
import { useMemo } from 'react'
import type { Adventure, ID, Scenario, ScriptRef, StoryScript } from '@shared/types'
import { db, loadCollection, useCollection } from '@/stores/db'
import { BUILTIN_SCRIPTS, builtin, builtinStub, isBuiltinId, loadBuiltin } from './builtin'
import { HOOKS, type HookName } from './types'

export type AdventureScriptRef = ScriptRef & { fromScenario?: boolean }

const STUBS = BUILTIN_SCRIPTS.map(builtinStub)

/** Every script the user can pick: built-ins first, then imported and their own, newest first. */
export function useScripts(): StoryScript[] {
  const docs = useCollection('scripts')
  return useMemo(() => [...STUBS, ...docs], [docs])
}

/** Catalog entry (no code for built-ins) — synchronous, for rendering lists. */
export function scriptMeta(id: ID): StoryScript | undefined {
  if (isBuiltinId(id)) return STUBS.find((s) => s.id === id)
  return db.get('scripts', id)
}

/** A script with its full sources, or undefined if it no longer exists. */
export async function loadScript(id: ID): Promise<StoryScript | undefined> {
  const b = builtin(id)
  if (b) return loadBuiltin(b)
  await loadCollection('scripts')
  return db.get('scripts', id)
}

/** Hooks a script defines (non-empty code). */
export function scriptHooks(s: StoryScript): HookName[] {
  const b = builtin(s.id)
  if (b) return b.hooks
  return HOOKS.filter((h) => s[h].trim().length > 0)
}

export function scriptKindLabel(s: Pick<StoryScript, 'source'>): string {
  return s.source === 'builtin' ? 'Built-in' : s.source === 'import' ? 'Imported' : 'Yours'
}

// ─── Run lists ───────────────────────────────────────────────────────────────

/**
 * An adventure's scripts in run order, reconciled with its scenario the way
 * AI Dungeon applies scenario scripts retroactively: scripts the scenario
 * added later join the list, ones it removed leave it. Scenario scripts come
 * first, then the adventure's own.
 */
export function adventureScriptRefs(adv: Pick<Adventure, 'scripts'>, scenario: Scenario | undefined): AdventureScriptRef[] {
  const own = (adv.scripts ?? []).filter((r) => !r.fromScenario)
  let fromScenario = (adv.scripts ?? []).filter((r) => r.fromScenario)
  if (scenario) {
    const refs = scenario.scriptsEnabled ? (scenario.scripts ?? []).filter((r) => r.enabled) : []
    const known = new Map(fromScenario.map((r) => [r.scriptId, r]))
    fromScenario = refs.map((r) => known.get(r.scriptId) ?? { scriptId: r.scriptId, enabled: true, fromScenario: true })
  }
  const seen = new Set(fromScenario.map((r) => r.scriptId))
  return [...fromScenario, ...own.filter((r) => !seen.has(r.scriptId))]
}

/** Ids that will run for this adventure, in order. */
export function activeScriptIds(adv: Pick<Adventure, 'scripts' | 'scenarioId'>, scenario = adv.scenarioId ? db.get('scenarios', adv.scenarioId) : undefined): ID[] {
  return adventureScriptRefs(adv, scenario)
    .filter((r) => r.enabled)
    .map((r) => r.scriptId)
}

export function hasActiveScripts(adv: Pick<Adventure, 'scripts' | 'scenarioId'>): boolean {
  return activeScriptIds(adv).length > 0
}

/** Full sources of the scripts an adventure runs; missing scripts are skipped. */
export async function activeScripts(adv: Pick<Adventure, 'scripts' | 'scenarioId'>): Promise<StoryScript[]> {
  const ids = activeScriptIds(adv)
  const all = await Promise.all(ids.map((id) => loadScript(id).catch(() => undefined)))
  return all.filter((s): s is StoryScript => !!s)
}

/** Built-ins that already contain another enabled one (e.g. Inner Self includes Auto-Cards). */
export function overlapWarning(ids: ID[], names: Map<ID, StoryScript>): string | null {
  for (const b of BUILTIN_SCRIPTS) {
    if (!ids.includes(b.id)) continue
    const dup = b.includes?.find((i) => ids.includes(i))
    if (dup) return `${b.name} already includes ${names.get(dup)?.name ?? 'that script'} — running both makes it act twice. Keep just one.`
  }
  return null
}

/** Enabled refs to copy into a new adventure (only when the scenario has scripts on). */
export function scenarioRefsForAdventure(scenario: Scenario): AdventureScriptRef[] {
  if (!scenario.scriptsEnabled) return []
  return (scenario.scripts ?? []).filter((r) => r.enabled).map((r) => ({ scriptId: r.scriptId, enabled: true, fromScenario: true }))
}
