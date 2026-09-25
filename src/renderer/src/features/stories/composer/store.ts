// Composer session: the draft, the conversation and what the AI is doing.
// Lives in memory (so it survives navigating away) and in localStorage (so a
// half-built scenario survives a restart).
import { nanoid } from 'nanoid'
import { create } from 'zustand'
import type { LlmChoice } from '@/lib/llm'
import { errorText } from '@/lib/api'
import { toast } from '@/stores/toast'
import { composeTurn, generateDraft, isAborted, regenerateSection, type GenStage } from './ai'
import { emptyDraft, mergeCards, sectionOf, SECTIONS, type ScenarioDraft, type ScriptDraft, type SectionId } from './draft'

export interface ComposerMsg {
  id: string
  role: 'user' | 'assistant'
  text: string
  reasoning?: string
  thinkingMs?: number
  /** Sections this reply changed. */
  changed?: SectionId[]
  suggestions?: string[]
  pending?: boolean
  error?: string
}

export type Busy =
  | { kind: 'chat' }
  | { kind: 'section'; section: SectionId }
  | { kind: 'fill'; stage: GenStage }
  | { kind: 'script'; id: string }

interface ComposerState {
  draft: ScenarioDraft
  messages: ComposerMsg[]
  focus: SectionId
  busy: Busy | null
  /** Live thinking for the current section/fill job (chat shows it on the message). */
  liveReasoning: string
  llm?: LlmChoice
  /** Section ids that just changed — for a highlight pulse. */
  flash: Record<string, number>
  setLlm: (llm: LlmChoice) => void
  setFocus: (s: SectionId) => void
  send: (text: string) => Promise<void>
  stop: () => void
  regenerate: (s: Exclude<SectionId, 'scripts'>, steer?: string) => Promise<void>
  fillFromBrief: (brief: string) => Promise<void>
  edit: (patch: Partial<ScenarioDraft>, section?: SectionId) => void
  accept: (s: SectionId) => void
  acceptAll: () => void
  updateScript: (id: string, patch: Partial<ScriptDraft>) => void
  removeScript: (id: string) => void
  reset: () => void
}

const KEY = 'stitch.composer.v1'

function load(): Pick<ComposerState, 'draft' | 'messages' | 'focus'> | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as Pick<ComposerState, 'draft' | 'messages' | 'focus'>
    if (!v?.draft?.sections) return null
    return {
      draft: { ...emptyDraft(), ...v.draft, scripts: (v.draft.scripts ?? []).map((s) => (s.status === 'writing' || s.status === 'checking' ? { ...s, status: 'error', error: 'Interrupted — rewrite it.' } : s)) },
      messages: (v.messages ?? []).filter((m) => !m.pending),
      focus: v.focus ?? 'premise'
    }
  } catch {
    return null
  }
}

let ctrl: AbortController | null = null

function fresh(): AbortSignal {
  ctrl?.abort()
  ctrl = new AbortController()
  return ctrl.signal
}

/** Apply an AI patch: merge cards, mark touched sections as proposed. */
function applyPatch(d: ScenarioDraft, patch: Partial<ScenarioDraft>, removeCards: string[] = [], state: 'proposed' | 'accepted' = 'proposed'): { draft: ScenarioDraft; changed: SectionId[] } {
  const next: ScenarioDraft = { ...d, sections: { ...d.sections } }
  const changed = new Set<SectionId>()
  for (const [k, v] of Object.entries(patch) as [keyof ScenarioDraft, unknown][]) {
    if (k === 'sections') continue
    if (k === 'cards') next.cards = mergeCards(next.cards, v as ScenarioDraft['cards'])
    else (next as unknown as Record<string, unknown>)[k] = v
    const s = sectionOf(k)
    if (s) changed.add(s)
  }
  if (removeCards.length) {
    const drop = new Set(removeCards.map((n) => n.toLowerCase()))
    const before = next.cards.length
    next.cards = next.cards.filter((c) => !drop.has(c.name.toLowerCase()))
    if (next.cards.length !== before) changed.add('cards')
  }
  for (const s of changed) next.sections[s] = state
  return { draft: next, changed: [...changed] }
}

export const useComposer = create<ComposerState>((set, get) => {
  const flash = (sections: SectionId[]): void => {
    const now = Date.now()
    set((s) => ({ flash: { ...s.flash, ...Object.fromEntries(sections.map((x) => [x, now])) } }))
  }
  const saved = load()
  return {
    draft: saved?.draft ?? emptyDraft(),
    messages: saved?.messages ?? [],
    focus: saved?.focus ?? 'premise',
    busy: null,
    liveReasoning: '',
    flash: {},
    setLlm: (llm) => set({ llm }),
    setFocus: (focus) => set({ focus }),

    send: async (raw) => {
      const text = raw.trim()
      if (!text || get().busy) return
      const signal = fresh()
      const history = get()
        .messages.filter((m) => !m.error && m.text)
        .map((m) => ({ role: m.role, text: m.text }))
      const reply: ComposerMsg = { id: nanoid(8), role: 'assistant', text: '', pending: true }
      set((s) => ({ messages: [...s.messages, { id: nanoid(8), role: 'user', text }, reply], busy: { kind: 'chat' } }))
      const patchMsg = (p: Partial<ComposerMsg>): void => set((s) => ({ messages: s.messages.map((m) => (m.id === reply.id ? { ...m, ...p } : m)) }))
      const t0 = Date.now()
      let thinkingEnd = 0
      try {
        const res = await composeTurn(get().draft, history, text, get().focus, {
          llm: get().llm,
          signal,
          onReasoning: (r) => patchMsg({ reasoning: r }),
          onReply: (t) => {
            if (t && !thinkingEnd) thinkingEnd = Date.now()
            patchMsg({ text: t })
          }
        })
        const { draft, changed } = applyPatch(get().draft, res.patch, res.removeCards)
        set({ draft })
        flash(changed)
        // Small models don't always flag mechanics — catch the obvious asks too.
        const script = res.script ?? (looksLikeMechanic(text, get().focus) ? text : undefined)
        const replyText =
          res.reply ||
          (script ? 'On it — I’m writing a script for that. You’ll see the code under Scripts.' : changed.length ? 'Updated the draft — take a look.' : 'Tell me a little more about what you have in mind.')
        patchMsg({ text: replyText, reasoning: res.reasoning, thinkingMs: res.reasoning ? (thinkingEnd || Date.now()) - t0 : undefined, changed, suggestions: res.suggestions, pending: false })
        // Advance the focus to the next empty section once this one has content.
        const cur = get().focus
        if (changed.includes(cur)) {
          const nextEmpty = SECTIONS.find((s) => s.id !== 'scripts' && get().draft.sections[s.id] === 'empty')
          if (nextEmpty && nextEmpty.id !== cur) set({ focus: nextEmpty.id })
        }
        set({ busy: null })
        if (script) await composeScriptRequest(script, text)
      } catch (err) {
        if (isAborted(err)) patchMsg({ pending: false, text: get().messages.find((m) => m.id === reply.id)?.text || 'Stopped.' })
        else patchMsg({ pending: false, error: errorText(err) })
      } finally {
        if (get().busy?.kind === 'chat') set({ busy: null })
      }
    },

    stop: () => {
      ctrl?.abort()
      set((s) => ({ busy: null, liveReasoning: '', messages: s.messages.map((m) => (m.pending ? { ...m, pending: false, text: m.text || 'Stopped.' } : m)) }))
    },

    regenerate: async (section, steer = '') => {
      if (get().busy) return
      const signal = fresh()
      set({ busy: { kind: 'section', section }, liveReasoning: '' })
      try {
        const res = await regenerateSection(get().draft, section, steer, { llm: get().llm, signal, onReasoning: (r) => set({ liveReasoning: r }) })
        // A regenerated card set replaces the old one.
        const base = section === 'cards' ? { ...get().draft, cards: [] } : get().draft
        const { draft } = applyPatch(base, res.patch)
        set({ draft })
        flash([section])
      } catch (err) {
        if (!isAborted(err)) toast.error('Could not regenerate', errorText(err))
      } finally {
        set({ busy: null, liveReasoning: '' })
      }
    },

    fillFromBrief: async (brief) => {
      if (get().busy || !brief.trim()) return
      const signal = fresh()
      set((s) => ({ busy: { kind: 'fill', stage: 'core' }, liveReasoning: '', messages: [...s.messages, { id: nanoid(8), role: 'user', text: brief.trim() }] }))
      try {
        const res = await generateDraft(brief, {
          llm: get().llm,
          signal,
          onReasoning: (r) => set({ liveReasoning: r }),
          onStage: (stage, partial) => {
            set({ busy: { kind: 'fill', stage } })
            if (stage !== 'core') {
              const { draft, changed } = applyPatch(get().draft, pickFilled(partial))
              set({ draft })
              flash(changed)
            }
          }
        })
        const { draft, changed } = applyPatch(get().draft, pickFilled(res.draft))
        set((s) => ({
          draft,
          focus: 'premise',
          messages: [
            ...s.messages,
            {
              id: nanoid(8),
              role: 'assistant',
              text: `Here’s a first pass at “${draft.title || 'your scenario'}” — premise, world, ${draft.cards.length} story cards, an opening and narrator rules. Accept what you like, regenerate what you don’t, or tell me what to change.`,
              reasoning: res.reasoning || undefined,
              changed,
              suggestions: ['Make it darker and more dangerous', 'Add a rival for the player', 'Track my health in the author’s note']
            }
          ]
        }))
        flash(changed)
      } catch (err) {
        if (!isAborted(err)) {
          set((s) => ({ messages: [...s.messages, { id: nanoid(8), role: 'assistant', text: '', error: errorText(err) }] }))
        }
      } finally {
        set({ busy: null, liveReasoning: '' })
      }
    },

    edit: (patch, section) => {
      const { draft, changed } = applyPatch(get().draft, patch, [], 'accepted')
      if (section && !changed.includes(section)) draft.sections[section] = 'accepted'
      set({ draft })
    },

    accept: (s) => set((st) => ({ draft: { ...st.draft, sections: { ...st.draft.sections, [s]: st.draft.sections[s] === 'empty' ? 'empty' : 'accepted' } } })),
    acceptAll: () =>
      set((st) => ({
        draft: { ...st.draft, sections: Object.fromEntries(Object.entries(st.draft.sections).map(([k, v]) => [k, v === 'proposed' ? 'accepted' : v])) as ScenarioDraft['sections'] }
      })),

    updateScript: (id, patch) =>
      set((st) => {
        const scripts = st.draft.scripts.map((x) => (x.id === id ? { ...x, ...patch } : x))
        return { draft: { ...st.draft, scripts, sections: { ...st.draft.sections, scripts: scripts.length ? st.draft.sections.scripts === 'empty' ? 'proposed' : st.draft.sections.scripts : 'empty' } } }
      }),
    removeScript: (id) =>
      set((st) => {
        const scripts = st.draft.scripts.filter((x) => x.id !== id)
        return { draft: { ...st.draft, scripts, sections: { ...st.draft.sections, scripts: scripts.length ? st.draft.sections.scripts : 'empty' } } }
      }),

    reset: () => {
      ctrl?.abort()
      set({ draft: emptyDraft(), messages: [], focus: 'premise', busy: null, liveReasoning: '', flash: {} })
    }
  }
})

/** Does this message ask for a game mechanic (→ a script)? */
function looksLikeMechanic(text: string, focus: SectionId): boolean {
  if (focus === 'scripts') return true
  return /\b(scripts?|mechanics?|track (my|the|our)|hp|hit points|health bar|inventory|xp|experience points|level(s|ing)? up|mana|stamina|every turn|each turn|auto-?(create|add|generate)|inner[- ]thoughts?)\b/i.test(text)
}

/** Only the filled fields of a generated draft (so an in-progress stage never blanks others). */
function pickFilled(d: ScenarioDraft): Partial<ScenarioDraft> {
  const out: Partial<ScenarioDraft> = {}
  for (const [k, v] of Object.entries(d) as [keyof ScenarioDraft, unknown][]) {
    if (k === 'sections' || k === 'scripts' || k === 'creatorFields') continue
    if (k === 'openingType') {
      if (d.title || d.description) out.openingType = d.openingType
      continue
    }
    if (typeof v === 'string' ? v.trim() : Array.isArray(v) ? v.length : false) (out as Record<string, unknown>)[k] = v
  }
  return out
}

// Scripts are written by composer/scripts.ts (registered at import time, so
// the store has no hard dependency on the scripts API).
let scriptWriter: ((request: string, context?: string) => Promise<void>) | null = null
export function registerScriptWriter(fn: (request: string, context?: string) => Promise<void>): void {
  scriptWriter = fn
}
async function composeScriptRequest(spec: string, userText: string): Promise<void> {
  if (scriptWriter) await scriptWriter(spec, userText)
}

// Persist (debounced) whenever the draft or conversation changes.
let saveTimer: ReturnType<typeof setTimeout> | undefined
useComposer.subscribe((s, prev) => {
  if (s.draft === prev.draft && s.messages === prev.messages && s.focus === prev.focus) return
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify({ draft: s.draft, messages: s.messages.slice(-60), focus: s.focus }))
    } catch {
      /* storage full or unavailable — the in-memory session still works */
    }
  }, 500)
})
