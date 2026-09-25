// Defaults, presets and factories for scenarios, adventures and story cards.
import { nanoid } from 'nanoid'
import type { AdventureSettings, CreatorField, PlotComponents, SafetyLevel, Scenario, StoryCard, StoryCardGenerator, StoryCardType } from '@shared/types'

// ─── AI instruction presets ──────────────────────────────────────────────────

export const DEFAULT_INSTRUCTIONS = `You are the narrator of an interactive story. The player controls the protagonist; you control the world and everyone in it.
- Be specific, descriptive and creative. Use concrete sensory detail instead of vague summary.
- Never write the player's actions, dialogue, thoughts or decisions. Stop where the player would naturally act next.
- Keep the story moving: introduce complications, consequences, discoveries and characters with their own motives.
- Characters can disagree, refuse, lie or act against the player when it fits who they are.
- Avoid repetition. Do not restate what just happened; build on it.
- Stay consistent with the plot essentials, story cards and everything that has already happened.
- Write only story prose. No headings, notes, options lists or questions to the player.`

export interface InstructionPreset {
  id: string
  label: string
  hint: string
  text: string
}

export const INSTRUCTION_PRESETS: InstructionPreset[] = [
  { id: 'stitch', label: 'Stitch Default', hint: 'Balanced, descriptive, never acts for you', text: DEFAULT_INSTRUCTIONS },
  {
    id: 'cinematic',
    label: 'Cinematic',
    hint: 'Visual, camera-ready scenes — great with See & Animate',
    text: `${DEFAULT_INSTRUCTIONS}
- Write like a film: establish place, light and movement in each scene so it could be storyboarded.
- Favour visible action and striking images over internal description.`
  },
  {
    id: 'dialogue',
    label: 'Dialogue-driven',
    hint: 'Characters talk a lot, with distinct voices',
    text: `${DEFAULT_INSTRUCTIONS}
- Let characters speak often, in quoted dialogue with distinct voices, verbal tics and agendas.
- Reveal information through conversation rather than narration.`
  },
  {
    id: 'concise',
    label: 'Fast & punchy',
    hint: 'Short replies, quick pacing',
    text: `${DEFAULT_INSTRUCTIONS}
- Keep each response short: two to four sentences. Favour momentum over description.`
  },
  {
    id: 'novel',
    label: 'Literary',
    hint: 'Rich prose, slower pacing, strong atmosphere',
    text: `${DEFAULT_INSTRUCTIONS}
- Write rich, literary prose with rhythm and atmosphere. Let quiet moments breathe.
- Use metaphor sparingly and precisely.`
  }
]

export const SAFETY_TEXT: Record<SafetyLevel, { label: string; description: string; addendum: string }> = {
  safe: {
    label: 'Safe',
    description: 'Family friendly. No graphic violence, sexual content or strong language.',
    addendum: 'Keep all content suitable for all ages: no graphic violence, no sexual content and no strong language. Steer the story away from such material gracefully.'
  },
  moderate: {
    label: 'Moderate',
    description: 'Peril, fights and darker themes, without graphic detail.',
    addendum: 'Violence, danger and darker themes may appear, but keep them non-graphic. No explicit sexual content.'
  },
  mature: {
    label: 'Mature',
    description: 'Darker themes and intense scenes when the story calls for it.',
    addendum: 'The player has opted into mature fiction: darker themes, intense violence and strong language are allowed when the story calls for it. Never include sexual content involving minors.'
  }
}

export function povInstruction(thirdPerson: boolean, playerName: string): string {
  return thirdPerson
    ? `Write in third person past tense. The protagonist is ${playerName || 'the main character'}; refer to them by name, never as "you".`
    : 'Write in second person present tense, addressing the protagonist as "you" (for example: "You push open the door and see…").'
}

// ─── Factories ───────────────────────────────────────────────────────────────

export function emptyPlot(partial?: Partial<PlotComponents>): PlotComponents {
  return {
    aiInstructions: '',
    plotEssentials: '',
    authorsNote: '',
    storySummary: '',
    thirdPerson: false,
    enabled: { storySummary: false, thirdPerson: false },
    ...partial
  }
}

export const DEFAULT_GENERATOR: StoryCardGenerator = {
  speedCreate: false,
  includeSummary: true,
  logInNotes: true,
  aiInstructions: '',
  storyInfo: ''
}

export function newCard(partial?: Partial<StoryCard>): StoryCard {
  const now = Date.now()
  return { id: nanoid(10), type: 'character', name: '', entry: '', triggers: '', notes: '', createdAt: now, updatedAt: now, ...partial }
}

export function newScenario(partial?: Partial<Scenario>): Scenario {
  const now = Date.now()
  return {
    id: nanoid(10),
    title: '',
    description: '',
    tags: [],
    createdAt: now,
    updatedAt: now,
    openingType: 'story',
    opening: '',
    choices: [],
    creatorFields: [],
    plot: emptyPlot(),
    cards: [],
    ...partial
  }
}

export const DEFAULT_CREATOR_FIELDS: Omit<CreatorField, 'id'>[] = [
  { label: 'Class', cardType: 'class' },
  { label: 'Race', cardType: 'race' },
  { label: 'Location', cardType: 'location' },
  { label: 'Faction', cardType: 'faction' }
]

export function defaultCreatorFields(): CreatorField[] {
  return DEFAULT_CREATOR_FIELDS.map((f) => ({ ...f, id: nanoid(8) }))
}

export const DEFAULT_CONTEXT = 8192
export const DEFAULT_RESPONSE = 200

/** `rating` is the legacy content rating of older scenarios; new ones have none (moderate safety). */
export function defaultSettings(rating?: Scenario['contentRating']): AdventureSettings {
  return {
    contextLength: DEFAULT_CONTEXT,
    memoryBank: true,
    autoSummarize: true,
    responseLength: DEFAULT_RESPONSE,
    temperature: 0.9,
    topK: 40,
    topP: 0.95,
    safety: rating === 'everyone' ? 'safe' : rating === 'mature' ? 'mature' : 'moderate',
    rawOutput: false,
    contextWarning: true,
    theme: 'dynamic',
    textStyle: 'print',
    textAnimation: true,
    largeText: false,
    stickyInput: false,
    compactButtons: false,
    autoNarrate: false,
    autoSee: false,
    autoAnimate: false
  }
}

// ─── Labels ──────────────────────────────────────────────────────────────────

export const CARD_TYPES: { value: StoryCardType; label: string; plural: string }[] = [
  { value: 'character', label: 'Character', plural: 'Characters' },
  { value: 'class', label: 'Class', plural: 'Classes' },
  { value: 'race', label: 'Race', plural: 'Races' },
  { value: 'location', label: 'Location', plural: 'Locations' },
  { value: 'faction', label: 'Faction', plural: 'Factions' },
  { value: 'custom', label: 'Custom', plural: 'Custom' }
]

export function cardTypeLabel(card: Pick<StoryCard, 'type' | 'customType'>): string {
  if (card.type === 'custom' && card.customType) return card.customType
  return CARD_TYPES.find((t) => t.value === card.type)?.label ?? card.type
}

export const LIMITS = { opening: 4000, plot: 4000, authorsNote: 400, title: 70, description: 5000, tags: 10, entry: 1000, plotTokens: 1500 }
