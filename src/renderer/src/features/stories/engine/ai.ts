// AI helpers: story cards, cover/scene prompts, summaries and memories.
import type { PlotComponents, StoryCard, StoryCardGenerator, StoryCardType } from '@shared/types'
import type { LlmChoice } from '@/lib/llm'
import { cardTypeLabel, CARD_TYPES } from './defaults'
import { complete, completeJson } from './llm'

/** What the helpers know about the story being written. */
export interface StoryInfo {
  title: string
  description: string
  opening: string
  plot: Pick<PlotComponents, 'plotEssentials' | 'storySummary' | 'aiInstructions'>
  cards: StoryCard[]
}

function clip(s: string, n: number): string {
  const t = s.trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

function storyBrief(info: StoryInfo, gen?: StoryCardGenerator): string {
  const lines = [
    info.title && `Title: ${info.title}`,
    info.description && `Premise: ${clip(info.description, 800)}`,
    info.plot.plotEssentials && `Plot essentials: ${clip(info.plot.plotEssentials, 1200)}`,
    info.opening && `Opening: ${clip(info.opening, 1000)}`,
    (gen?.includeSummary ?? true) && info.plot.storySummary && `Story so far: ${clip(info.plot.storySummary, 1200)}`,
    gen?.storyInfo && `Key story information: ${clip(gen.storyInfo, 1500)}`,
    info.cards.length && `Existing story cards: ${info.cards.map((c) => `${c.name} (${cardTypeLabel(c)})`).join(', ')}`
  ]
  return lines.filter(Boolean).join('\n')
}

const CARD_SYSTEM = `You write "story cards" for an interactive fiction engine. A story card is a compact reference entry the narrator AI reads when the card's trigger words appear.
Entries are written in plain present-tense prose, 2–5 sentences, under 700 characters, dense with concrete, usable detail (appearance, personality, motives, secrets, relationships, notable features). No markdown.`

export interface CardDraft {
  name: string
  entry: string
  triggers: string
  notes?: string
}

function typeName(type: StoryCardType, customType?: string): string {
  return type === 'custom' ? customType || 'custom element' : (CARD_TYPES.find((t) => t.value === type)?.label ?? type).toLowerCase()
}

/** "Generate New Name & Entry" / "Generate New Entry" / "Create class for me". */
export async function generateCard(opts: {
  info: StoryInfo
  type: StoryCardType
  customType?: string
  /** Keep this name and only write the entry. */
  name?: string
  /** Current entry to improve on (optional). */
  entry?: string
  generator?: StoryCardGenerator
  /** Also write a short player-facing description (character creator options). */
  withNotes?: boolean
  llm?: LlmChoice
}): Promise<CardDraft> {
  const kind = typeName(opts.type, opts.customType)
  const existing = opts.info.cards.filter((c) => c.type === opts.type).map((c) => c.name)
  const ask = opts.name
    ? `Write the entry for the ${kind} named "${opts.name}".${opts.entry ? ` Improve on this draft: ${clip(opts.entry, 600)}` : ''}`
    : `Invent a new, distinctive ${kind} that fits this story${existing.length ? ` and is different from: ${existing.join(', ')}` : ''}.`
  const fields = `{"name": string, "entry": string, "triggers": "comma separated words that should trigger this card (name variants, nicknames, key nouns)"${opts.withNotes ? ', "notes": "one enticing sentence shown to the player when choosing"' : ''}}`
  const res = await completeJson<Partial<CardDraft>>({
    system: `${CARD_SYSTEM}${opts.generator?.aiInstructions ? `\n\nAdditional instructions from the author:\n${opts.generator.aiInstructions}` : ''}`,
    prompt: `${storyBrief(opts.info, opts.generator)}\n\n${ask}\nReturn JSON: ${fields}`,
    temperature: 0.95,
    maxTokens: 700,
    llm: opts.llm
  })
  if (!res || !(res.entry || res.name)) throw new Error('The model did not return a usable card. Try again or pick another model.')
  const name = (opts.name ?? res.name ?? '').toString().trim()
  const triggers = (res.triggers ?? '').toString().trim() || name
  return { name, entry: (res.entry ?? '').toString().trim().slice(0, 1000), triggers, notes: res.notes?.toString().trim() }
}

/** Short visual prompt for a cover image, written from the title, description and opening. */
export async function coverPrompt(info: StoryInfo, llm?: LlmChoice, steer?: string): Promise<string> {
  const text = await complete({
    system:
      'You write prompts for an image model. Reply with ONE vivid prompt only (40–80 words): the key subject, setting, composition, lighting, colour palette, mood and art style. Pick the single most iconic, intriguing image for the story — like a book cover or a game key art. Describe only what is visible: no quoted words, names of ships or places written out, numbers, coordinates, signs, captions, titles or lettering (image models paint those as text). No preamble.',
    prompt: `Design the cover illustration for this interactive story.${steer?.trim() ? `\nArt direction from the author: ${clip(steer, 300)}` : ''}\n\n${storyBrief({ ...info, cards: info.cards.slice(0, 12) })}`,
    temperature: 0.9,
    maxTokens: 260,
    llm
  })
  // Quoted phrases and markdown emphasis make image models letter them onto the picture.
  const prompt = text
    .replace(/^(image )?prompt:\s*/i, '')
    .replace(/[*_`#]+/g, '')
    .replace(/["“”]([^"“”]{0,80})["“”]/g, '$1')
    .replace(/["“”]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
  if (!prompt) throw new Error('The model did not return a cover prompt. Try again or pick another model.')
  return prompt
}

/** "See": a concise visual prompt for the current moment. */
export async function scenePrompt(opts: { recent: string; focus?: string; cards: StoryCard[]; names: string[]; llm?: LlmChoice }): Promise<string> {
  const refs = opts.cards
    .filter((c) => c.type !== 'character' || !opts.names.includes(c.name))
    .slice(0, 5)
    .map((c) => `${c.name}: ${clip(c.entry, 220)}`)
    .join('\n')
  const text = await complete({
    system:
      'You turn interactive-fiction passages into prompts for an image model. Reply with ONE prompt (40–80 words) describing a single cinematic frame: who is visible and what they are doing, setting, camera angle, lighting, mood. Refer to named characters by name only (their looks are supplied separately). No quotes, no preamble, no text overlays.',
    prompt: `${refs ? `Reference:\n${refs}\n\n` : ''}Story (most recent last):\n${clip(opts.recent, 2400)}\n\n${opts.focus ? `The player wants to see: ${opts.focus}\n` : ''}${opts.names.length ? `Characters present: ${opts.names.join(', ')}\n` : ''}Write the image prompt.`,
    temperature: 0.7,
    maxTokens: 220,
    llm: opts.llm
  })
  return text.replace(/^["']|["']$/g, '').trim()
}

/** Visual description for a Stitch character created from a story card. */
export async function extractAppearance(card: Pick<StoryCard, 'name' | 'entry'>, llm?: LlmChoice): Promise<{ appearance: string; description: string }> {
  const res = await completeJson<{ appearance?: string; description?: string }>({
    system: 'You extract character details for a consistent-character image pipeline.',
    prompt: `Character: ${card.name}\nEntry: ${card.entry}\n\nReturn JSON {"appearance": "one comma-separated line of visible traits only: age, build, face, hair, eyes, skin, outfit, accessories (invent plausible details if missing)", "description": "one or two sentences on who they are"}`,
    temperature: 0.5,
    maxTokens: 400,
    llm
  })
  return { appearance: res?.appearance?.trim() ?? '', description: res?.description?.trim() ?? card.entry.slice(0, 300) }
}

/** Trim to at most `max` characters, ending on a full sentence. */
function capSentences(text: string, max: number): string {
  const t = text.trim()
  if (t.length <= max) return t
  const cut = t.slice(0, max)
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('." '), cut.lastIndexOf('! '), cut.lastIndexOf('? '))
  return (end > max * 0.5 ? cut.slice(0, end + 1) : cut).trim()
}

/** Fold passages that fell out of the context window into the running summary. */
export async function summarize(existing: string, passages: string, llm?: LlmChoice): Promise<string> {
  const text = await complete({
    system:
      'You condense interactive fiction into a running summary. Only summarize what is written — never continue the story, never add dialogue, never invent events. Past tense, third person (call the protagonist "the player" or by name). Plain prose, no headings or lists.',
    prompt: `${existing ? `Summary so far:\n${existing}\n\n` : ''}New passages to fold in:\n"""\n${clip(passages, 6000)}\n"""\n\nWrite the updated summary of everything above in at most 8 sentences. Keep characters, relationships, locations, items, goals and unresolved threads${existing.length > 1600 ? '; compress older events harder' : ''}. Output only the summary.`,
    temperature: 0.2,
    maxTokens: 420,
    llm
  })
  return capSentences(text.replace(/^(updated )?summary:\s*/i, ''), 1800)
}

/** Memory bank: 3–5 durable facts from recent passages. */
export async function extractMemories(passages: string, existing: string[], llm?: LlmChoice): Promise<string[]> {
  const res = await completeJson<{ memories?: string[] }>({
    system: 'You extract durable facts from an interactive story for long-term memory: names, relationships, promises, discoveries, injuries, possessions, locations and goals. Each fact is one short standalone sentence.',
    prompt: `${existing.length ? `Already remembered:\n- ${existing.slice(-20).join('\n- ')}\n\n` : ''}Passages:\n${passages}\n\nReturn JSON {"memories": ["3 to 5 NEW facts not already remembered"]}`,
    temperature: 0.3,
    maxTokens: 500,
    llm
  })
  return (res?.memories ?? []).map((m) => String(m).trim()).filter((m) => m.length > 8).slice(0, 5)
}
