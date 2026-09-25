// Text helpers: how actions read in the story and in the model's context,
// and cleanup of raw model output.
import type { ActionType, StoryAction } from '@shared/types'

export function isAiAction(a: Pick<StoryAction, 'type'>): boolean {
  return a.type === 'start' || a.type === 'continue'
}

export function isPlayerAction(a: Pick<StoryAction, 'type'>): boolean {
  return a.type === 'do' || a.type === 'say' || a.type === 'story' || a.type === 'see'
}

/** Rough token estimate (~4 characters per token for English prose). */
export function tokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function sentenceEnd(s: string): string {
  const t = s.trim()
  return /[.!?…"”')\]]$/.test(t) ? t : `${t}.`
}

function stripYou(s: string): string {
  return s.trim().replace(/^(you|i)\s+/i, '')
}

/** How the player's input reads in the story (no leading ">"). */
export function playerLine(type: ActionType, text: string): string {
  const t = text.trim()
  if (type === 'do') return `You ${sentenceEnd(stripYou(t))}`
  if (type === 'say') {
    const words = t.replace(/^(you|i)\s+say\s+/i, '').replace(/^["“]|["”]$/g, '')
    return `You say "${sentenceEnd(words).replace(/"$/, '')}"`
  }
  return t
}

/** How a player action is written into the model's context (AI Dungeon style). */
export function contextLine(a: Pick<StoryAction, 'type' | 'text'>): string {
  if (a.type === 'do' || a.type === 'say') return `> ${playerLine(a.type, a.text)}`
  return a.text.trim()
}

/** Reasoning models may emit <think> blocks; never show or keep them. */
export function stripThinking(text: string): string {
  let t = text.replace(/<think>[\s\S]*?<\/think>/gi, '')
  const open = t.search(/<think>/i)
  if (open >= 0) t = t.slice(0, open)
  return t
}

/** Trim to the last complete sentence and drop echoed "> You …" lines. */
export function cleanOutput(raw: string, opts: { raw?: boolean } = {}): string {
  let t = stripThinking(raw)
  if (opts.raw) return t.replace(/^\s*\n/, '').trimEnd()
  t = t
    .split('\n')
    .filter((line) => !/^\s*>/.test(line))
    .join('\n')
    .replace(/^\s*(narrator|assistant|ai|story)\s*:\s*/i, '')
    .replace(/\[(author'?s note|continue)[^\]]*\]/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  const re = /[.!?…]["”’')\]*_]*/g
  let last = -1
  for (const m of t.matchAll(re)) last = (m.index ?? 0) + m[0].length
  if (last > 0 && last < t.length && t.length - last < 400) t = t.slice(0, last)
  return t.trim()
}

/** Live-display version of a streaming response (hides think blocks and echoes). */
export function streamingDisplay(raw: string): string {
  return stripThinking(raw)
    .split('\n')
    .filter((line) => !/^\s*>/.test(line))
    .join('\n')
    .replace(/^\s+/, '')
}

/** Plain-text transcript for export. */
export function storyText(actions: StoryAction[]): string {
  return actions
    .filter((a) => a.type !== 'see')
    .map((a) => (isPlayerAction(a) ? `> ${playerLine(a.type, a.text)}` : a.text.trim()))
    .join('\n\n')
}
