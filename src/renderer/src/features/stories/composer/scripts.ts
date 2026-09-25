// Script composing: the user describes a mechanic, the model writes an AI
// Dungeon-compatible script (Library / Input / Context / Output), we validate
// it with the scripts runtime (one automatic repair pass) and attach it to the
// scenario on create. The runtime and script storage belong to engine/scripts.
import { nanoid } from 'nanoid'
import type { ID } from '@shared/types'
import { errorText } from '@/lib/api'
import { toast } from '@/stores/toast'
import { AID_SCRIPTING_GUIDE, attachScriptToScenario, createScript, validateScript } from '../engine/scripts/api'
import { isAborted, run, type RunOpts } from './ai'
import { draftDigest, type ScenarioDraft, type ScriptDraft, type ScriptValidation } from './draft'
import { registerScriptWriter, useComposer } from './store'

export const HOOKS = ['library', 'input', 'context', 'output'] as const
export type Hook = (typeof HOOKS)[number]

export const HOOK_HINT: Record<Hook, string> = {
  library: 'Shared helpers, runs before every hook',
  input: "Runs on the player's input",
  context: 'Shapes what the model sees each turn',
  output: "Runs on the AI's reply"
}

const FORMAT = `Write the script in exactly this format — plain text, no JSON:

NAME: a short name for the mechanic itself (2-4 words, e.g. "HP Tracker") — not the story title
DESCRIPTION: one sentence on what it does for the player

=== LIBRARY ===
(shared code, or leave empty)
=== INPUT ===
(complete input modifier)
=== CONTEXT ===
(complete context modifier)
=== OUTPUT ===
(complete output modifier)

Every non-empty hook must define \`const modifier = (text) => { … return { text } }\` and end with the line \`modifier(text)\`. Use a hook only if the mechanic needs it — write "(empty)" otherwise. Keep state in the \`state\` object so it survives between turns. Be defensive: initialise state fields before use and never throw.`

const MARK = /^[ \t]*(?:#{1,4}[ \t]*|[=\-*]{2,}[ \t]*|\/\/[ \t]*)?(LIBRARY|INPUT|CONTEXT|OUTPUT)(?:[ \t]+(?:MODIFIER|HOOK|SCRIPT|TAB))?[ \t]*(?:[=\-*]{2,}|:)?[ \t]*$/gim

function cleanCode(code: string): string {
  let c = code.replace(/\r/g, '')
  c = c.replace(/^\s*```[a-z]*\s*\n?/i, '').replace(/\n?\s*```\s*$/i, '')
  c = c.trim()
  if (!c || /^\(?(empty|none|not needed|unused|n\/a)\)?\.?$/i.test(c)) return ''
  return `${c}\n`
}

/** Parse the model's reply (also while it is still streaming). */
export function parseScript(text: string): Partial<Pick<ScriptDraft, 'name' | 'description' | Hook>> {
  const out: Partial<Pick<ScriptDraft, 'name' | 'description' | Hook>> = {}
  const name = /^[ \t]*\**NAME\**[ \t]*:[ \t]*(.+)$/im.exec(text)
  const desc = /^[ \t]*\**DESCRIPTION\**[ \t]*:[ \t]*(.+)$/im.exec(text)
  if (name) out.name = name[1].replace(/[*`"]/g, '').trim().slice(0, 60)
  if (desc) out.description = desc[1].replace(/[*`]/g, '').trim().slice(0, 300)
  const marks = [...text.matchAll(MARK)]
  marks.forEach((m, i) => {
    const hook = m[1].toLowerCase() as Hook
    const start = (m.index ?? 0) + m[0].length
    const end = i + 1 < marks.length ? (marks[i + 1].index ?? text.length) : text.length
    out[hook] = cleanCode(text.slice(start, end))
  })
  return out
}

export async function checkScript(d: Pick<ScriptDraft, 'name' | 'description' | Hook>): Promise<ScriptValidation> {
  if (!d.input.trim() && !d.context.trim() && !d.output.trim()) return { ok: false, errors: ['The script has no Input, Context or Output hook.'], logs: [] }
  try {
    const r = await validateScript({ library: d.library, input: d.input, context: d.context, output: d.output })
    return { ok: r.ok, errors: r.errors ?? [], logs: r.logs ?? [] }
  } catch (err) {
    return { ok: false, errors: [errorText(err)], logs: [] }
  }
}

const STOP = new Set(['in', 'on', 'when', 'and', 'that', 'which', 'so', 'to', 'for', 'with', 'from', 'where', 'if'])

/** A short name from the request when the model gives none: "Add a mechanic: track my HP in…" → "Track my HP". */
function nameFrom(request: string): string {
  const t = request
    .replace(/^\s*(please\s+)?(add|make|create|write|build|give me|i want|i'd like)\s+(me\s+)?(an?\s+)?((game\s+)?(mechanic|script|system)s?)?\s*(that|to|which|for)?\s*:?\s*/i, '')
    .split(/[.,;:!?\n]/)[0]
    .trim()
  const words: string[] = []
  for (const w of t.split(/\s+/)) {
    if (words.length >= 2 && STOP.has(w.toLowerCase())) break
    words.push(w)
    if (words.length >= 5) break
  }
  const name = words.join(' ')
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : 'Composer script'
}

function scriptPrompt(draft: ScenarioDraft, request: string, context?: string): string {
  return `Scenario this script belongs to:\n${draftDigest(draft, { cards: false, clip: 500 })}\n\nThe author wants this mechanic:\n"""\n${request.trim()}\n"""${context && context.trim() !== request.trim() ? `\n(Their words: "${context.trim().slice(0, 600)}")` : ''}\n\nWrite the script.`
}

/** Write (or rewrite) a script with the model, streaming parsed code into `onDraft`. */
export async function writeScript(
  draft: ScenarioDraft,
  request: string,
  opts: RunOpts & { context?: string; previous?: Pick<ScriptDraft, 'name' | 'description' | Hook>; errors?: string[]; onDraft?: (p: Partial<ScriptDraft>) => void } = {}
): Promise<{ script: Pick<ScriptDraft, 'name' | 'description' | Hook>; reasoning?: string }> {
  const fix = opts.previous
    ? `\n\nHere is the current version:\nNAME: ${opts.previous.name}\nDESCRIPTION: ${opts.previous.description}\n${HOOKS.map((h) => `=== ${h.toUpperCase()} ===\n${opts.previous![h] || '(empty)'}`).join('\n')}\n\n${opts.errors?.length ? `It fails validation with these errors — fix them:\n- ${opts.errors.slice(0, 8).join('\n- ')}` : 'Improve it as the author asks.'} Return the complete script again in the same format.`
    : ''
  const res = await run(
    {
      system: `${AID_SCRIPTING_GUIDE}\n\n${FORMAT}`,
      prompt: scriptPrompt(draft, request, opts.context) + fix,
      maxTokens: 3200,
      temperature: opts.previous ? 0.3 : 0.5
    },
    { ...opts, onText: (full) => opts.onDraft?.(parseScript(full)) }
  )
  const p = parseScript(res.text)
  if (!p.input && !p.context && !p.output && !p.library) throw new Error('The model did not write any script code. Try again, or pick a larger model.')
  return { script: { name: p.name || nameFrom(request), description: p.description || request.slice(0, 160), library: p.library ?? '', input: p.input ?? '', context: p.context ?? '', output: p.output ?? '' }, reasoning: res.reasoning }
}

let scriptCtrl: AbortController | null = null

/**
 * Composer action: write a script for `request`, validate it and repair once.
 * Pass `id` to rewrite an existing script draft (with an optional `change`).
 */
export async function composeScript(request: string, opts: { context?: string; id?: string; change?: string } = {}): Promise<void> {
  const st = useComposer.getState()
  if (st.busy) return
  scriptCtrl?.abort()
  scriptCtrl = new AbortController()
  const signal = scriptCtrl.signal
  const existing = opts.id ? st.draft.scripts.find((s) => s.id === opts.id) : undefined
  const id = existing?.id ?? nanoid(8)
  if (!existing) {
    const blank: ScriptDraft = { id, request, name: '', description: '', library: '', input: '', context: '', output: '', status: 'writing', attach: true }
    useComposer.setState((s) => ({ draft: { ...s.draft, scripts: [...s.draft.scripts, blank], sections: { ...s.draft.sections, scripts: 'proposed' } } }))
  } else st.updateScript(id, { status: 'writing', error: undefined })
  useComposer.setState({ busy: { kind: 'script', id }, liveReasoning: '', focus: 'scripts' })
  const upd = (p: Partial<ScriptDraft>): void => useComposer.getState().updateScript(id, p)
  try {
    const first = await writeScript(useComposer.getState().draft, existing ? `${existing.request}${opts.change ? `\nChange: ${opts.change}` : ''}` : request, {
      llm: st.llm,
      signal,
      context: opts.context,
      previous: existing && opts.change ? existing : undefined,
      errors: undefined,
      onDraft: (p) => upd(p),
      onReasoning: (r) => upd({ reasoning: r })
    })
    upd({ ...first.script, reasoning: first.reasoning, status: 'checking' })
    let script = first.script
    let validation = await checkScript(script)
    if (!validation.ok) {
      upd({ status: 'writing', validation })
      const fixed = await writeScript(useComposer.getState().draft, request, { llm: st.llm, signal, previous: script, errors: validation.errors, onDraft: (p) => upd(p) })
      script = fixed.script
      upd({ ...script, status: 'checking' })
      validation = await checkScript(script)
    }
    upd({ ...script, validation, status: validation.ok ? 'ready' : 'error', error: validation.ok ? undefined : 'Still failing validation — edit the code or rewrite it.', attach: validation.ok })
    useComposer.getState().setFocus('scripts')
  } catch (err) {
    if (isAborted(err)) upd({ status: 'error', error: 'Stopped.' })
    else upd({ status: 'error', error: errorText(err) })
  } finally {
    useComposer.setState((s) => (s.busy?.kind === 'script' && s.busy.id === id ? { busy: null, liveReasoning: '' } : {}))
  }
}

export function stopScript(): void {
  scriptCtrl?.abort()
}

/** Re-validate a script after manual edits. */
export async function revalidate(id: string): Promise<void> {
  const s = useComposer.getState().draft.scripts.find((x) => x.id === id)
  if (!s) return
  useComposer.getState().updateScript(id, { status: 'checking' })
  const validation = await checkScript(s)
  useComposer.getState().updateScript(id, { validation, status: validation.ok ? 'ready' : 'error', error: validation.ok ? undefined : 'Validation failed.' })
}

/** Save the scripts marked “attach” and attach them to the new scenario. */
export async function attachDraftScripts(scenarioId: ID, scripts: ScriptDraft[]): Promise<number> {
  let n = 0
  for (const s of scripts.filter((x) => x.attach && x.status !== 'writing' && (x.input.trim() || x.context.trim() || x.output.trim()))) {
    try {
      // Unused hooks stay empty — the runtime skips them (and AID exports fill in the no-op).
      const saved = await createScript({ name: s.name || 'Composer script', description: s.description || s.request.slice(0, 200), source: 'user', library: s.library, input: s.input, context: s.context, output: s.output })
      await attachScriptToScenario(scenarioId, saved.id)
      n++
    } catch (err) {
      toast.error(`Could not attach “${s.name}”`, errorText(err))
    }
  }
  return n
}

// Let chat turns that ask for a mechanic hand off to the script writer.
registerScriptWriter((request, context) => composeScript(request, { context }))
