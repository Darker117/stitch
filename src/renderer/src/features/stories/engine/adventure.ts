// Adventure lifecycle: create from a scenario, resolve multiple-choice
// branches, fill placeholders, and apply the character creator.
import { nanoid } from 'nanoid'
import type { Adventure, Scenario, StoryAction, StoryCard } from '@shared/types'
import { db } from '@/stores/db'
import { useSettings } from '@/stores/settings'
import { defaultSettings } from './defaults'
import { fill, fillCards, fillPlot, findPrompts } from './placeholders'
import { scenarioRefsForAdventure } from './scripts/library'

export function action(type: StoryAction['type'], text: string, extra?: Partial<StoryAction>): StoryAction {
  return { id: nanoid(10), type, text, createdAt: Date.now(), ...extra }
}

/** Merge a chosen child scenario into its parent: child text wins, cards combine. */
export function mergeScenario(parent: Scenario, child: Scenario): Scenario {
  const pick = (c: string, p: string): string => (c.trim() ? c : p)
  const byName = new Map<string, StoryCard>()
  for (const c of [...parent.cards, ...child.cards]) byName.set(c.name.trim().toLowerCase() || c.id, c)
  return {
    ...parent,
    openingType: child.openingType,
    opening: child.opening,
    choices: child.choices,
    creatorFields: child.creatorFields.length ? child.creatorFields : parent.creatorFields,
    coverAssetId: child.coverAssetId ?? parent.coverAssetId,
    plot: {
      ...parent.plot,
      aiInstructions: pick(child.plot.aiInstructions, parent.plot.aiInstructions),
      plotEssentials: [parent.plot.plotEssentials, child.plot.plotEssentials].filter((t) => t.trim()).join('\n\n'),
      authorsNote: pick(child.plot.authorsNote, parent.plot.authorsNote),
      storySummary: pick(child.plot.storySummary, parent.plot.storySummary),
      thirdPerson: child.plot.enabled.thirdPerson ? child.plot.thirdPerson : parent.plot.thirdPerson,
      enabled: {
        storySummary: parent.plot.enabled.storySummary || child.plot.enabled.storySummary,
        thirdPerson: parent.plot.enabled.thirdPerson || child.plot.enabled.thirdPerson
      }
    },
    cards: [...byName.values()]
  }
}

export function scenarioTexts(s: Pick<Scenario, 'opening' | 'plot' | 'cards'>): string[] {
  return [s.opening, s.plot.aiInstructions, s.plot.plotEssentials, s.plot.authorsNote, ...s.cards.map((c) => c.entry)]
}

/** Does starting this scenario need player input first? */
export function needsSetup(s: Scenario): boolean {
  if (s.openingType === 'multipleChoice' && s.choices.length) return true
  if (s.openingType === 'characterCreator') return true
  return findPrompts(scenarioTexts(s)).length > 0
}

/** Create and persist an adventure. If the scenario needs no setup, it's ready to play. */
export async function startAdventure(scenario: Scenario): Promise<Adventure> {
  const now = Date.now()
  const settings = useSettings.getState().settings
  const adv: Adventure = {
    id: nanoid(10),
    scenarioId: scenario.id,
    title: scenario.title || 'Untitled adventure',
    description: scenario.description,
    tags: scenario.tags,
    coverAssetId: scenario.coverAssetId,
    projectId: scenario.projectId,
    createdAt: now,
    updatedAt: now,
    lastPlayedAt: now,
    plot: structuredClone(scenario.plot),
    cards: structuredClone(scenario.cards),
    actions: [],
    redo: [],
    memories: [],
    player: { name: settings?.userName ?? 'You', persona: settings?.persona?.personality?.trim() || undefined, choices: {} },
    settings: { ...defaultSettings(scenario.contentRating), ...(settings?.defaultLlm ? { llm: settings.defaultLlm } : {}) },
    contentRating: scenario.contentRating,
    // The scenario's enabled scripts, in run order (they can be disabled per adventure, not removed).
    scripts: scenarioRefsForAdventure(scenario),
    scriptState: {}
  }
  const ready = needsSetup(scenario) ? adv : finalizeAdventure(adv, scenario, {})
  await db.put('adventures', ready)
  return ready
}

/**
 * Apply the resolved scenario (after choices), placeholder answers and
 * character-creator values; the opening becomes the first action.
 */
export function finalizeAdventure(adv: Adventure, resolved: Scenario, values: Record<string, string>, playerName?: string): Adventure {
  const opening = fill(resolved.opening, values).trim()
  const choices: Record<string, string> = {}
  for (const [k, v] of Object.entries(values)) if (k.startsWith('character.') && v) choices[k] = v
  const name = playerName?.trim() || values['character.name'] || adv.player.name
  const isMenuOnly = resolved.openingType === 'multipleChoice'
  return {
    ...adv,
    coverAssetId: adv.coverAssetId ?? resolved.coverAssetId,
    plot: fillPlot(resolved.plot, values),
    cards: fillCards(resolved.cards, values),
    actions: opening && !isMenuOnly ? [action('start', opening)] : [],
    // A character-creator hero isn't the user, so their profile personality no longer applies.
    player: { ...adv.player, name, persona: name === adv.player.name ? adv.player.persona : undefined, choices },
    updatedAt: Date.now(),
    lastPlayedAt: Date.now()
  }
}

/** A scenario and all of its multiple-choice descendants. */
export function scenarioTree(id: string): Scenario[] {
  const s = db.get('scenarios', id)
  return s ? [s, ...s.choices.flatMap((c) => scenarioTree(c))] : []
}

/** Delete a scenario together with its multiple-choice children. */
export async function deleteScenarioTree(id: string): Promise<void> {
  const s = db.get('scenarios', id)
  if (!s) return
  for (const c of s.choices) await deleteScenarioTree(c)
  await db.remove('scenarios', id)
}

/** Deep-copy a scenario tree with fresh ids. */
export async function duplicateScenarioTree(id: string, parentId?: string, suffix = ' (copy)'): Promise<Scenario | undefined> {
  const s = db.get('scenarios', id)
  if (!s) return undefined
  const newId = nanoid(10)
  const kids: string[] = []
  for (const c of s.choices) {
    const k = await duplicateScenarioTree(c, newId, '')
    if (k) kids.push(k.id)
  }
  const now = Date.now()
  const copy: Scenario = {
    ...structuredClone(s),
    id: newId,
    parentId,
    title: s.title + suffix,
    choices: kids,
    cards: s.cards.map((c) => ({ ...c, id: nanoid(10) })),
    createdAt: now,
    updatedAt: now
  }
  await db.put('scenarios', copy)
  return copy
}
