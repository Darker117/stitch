// `${…}` placeholders: `${character.name}` style values from the character
// creator, anything else is a question asked before the adventure starts.
import type { PlotComponents, StoryCard } from '@shared/types'

const RE = /\$\{([^}]{1,200})\}/g

function isCharacterKey(key: string): boolean {
  return /^character\.[\w -]+$/i.test(key.trim())
}

/** Unique free-form prompts (in order of appearance) across the given texts. */
export function findPrompts(texts: string[]): string[] {
  const out: string[] = []
  for (const t of texts) {
    for (const m of t.matchAll(RE)) {
      const key = m[1].trim()
      if (!key || isCharacterKey(key) || out.includes(key)) continue
      out.push(key)
    }
  }
  return out
}

/** "enter a country..." → "Enter a country" */
export function promptLabel(key: string): string {
  const t = key.replace(/[.…:]+$/g, '').trim()
  return t.charAt(0).toUpperCase() + t.slice(1)
}

/** Does this prompt most likely ask for the player's name? */
export function isNamePrompt(key: string): boolean {
  return /\b(your )?name\b/i.test(key) && !/\b(city|town|ship|country|kingdom|planet|world|dog|pet|company|band|gang|crew)\b/i.test(key)
}

export function characterKey(label: string): string {
  return `character.${label.trim().toLowerCase().replace(/\s+/g, '_')}`
}

/**
 * Replace placeholders. `values` holds free-form answers (keyed by the raw
 * placeholder text) and character values keyed like `character.class`.
 */
export function fill(text: string, values: Record<string, string>): string {
  if (!text || !text.includes('${')) return text
  const lower: Record<string, string> = {}
  for (const [k, v] of Object.entries(values)) lower[k.trim().toLowerCase()] = v
  return text.replace(RE, (whole, raw: string) => {
    const key = raw.trim().toLowerCase()
    const alt = key.replace(/\s+/g, '_')
    const v = lower[key] ?? lower[alt]
    return v !== undefined && v !== '' ? v : isCharacterKey(raw) ? '' : whole
  })
}

export function fillPlot(plot: PlotComponents, values: Record<string, string>): PlotComponents {
  return {
    ...plot,
    aiInstructions: fill(plot.aiInstructions, values),
    plotEssentials: fill(plot.plotEssentials, values),
    authorsNote: fill(plot.authorsNote, values),
    storySummary: fill(plot.storySummary, values)
  }
}

export function fillCards(cards: StoryCard[], values: Record<string, string>): StoryCard[] {
  return cards.map((c) => ({ ...c, name: fill(c.name, values), entry: fill(c.entry, values), triggers: fill(c.triggers, values) }))
}
