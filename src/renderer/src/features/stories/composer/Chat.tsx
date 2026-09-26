// Composer chat: the conversational side of building a scenario.
import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ArrowUp, ChevronDown, RotateCcw, Sparkles, Square } from 'lucide-react'
import { ModelPicker } from '@/components/model-picker'
import { Button, Chip, IconButton } from '@/components/ui/button'
import { Textarea } from '@/components/ui/input'
import { Menu, MenuItem } from '@/components/ui/overlay'
import { LogoMark } from '@/components/shell/logo'
import { useDefaultLlm } from '@/lib/llm'
import { cn } from '@/lib/utils'
import { ease, rise, spring, stagger } from '@/lib/motion'
import { isTouch, useCompact } from '@/lib/platform'
import { ThinkingBlock } from '@/features/create/Messages'
import { StageList, StateDot } from './bits'
import { SECTIONS, type SectionId } from './draft'
import { stopScript } from './scripts'
import { useComposer, type ComposerMsg } from './store'

const STARTERS = [
  { title: 'A heist in a floating sky-city', body: 'You have one night to rob the Cloud Bank before the city drifts out of reach.' },
  { title: 'A cozy mystery by the sea', body: 'Everyone in the fishing village is lying about the lighthouse keeper.' },
  { title: 'Alone on a haunted station', body: 'The crew vanished. The station still answers when you speak.' },
  { title: 'Transfer student at a rival wizard school', body: 'Your old school sent you as a spy. Your new roommate knows.' }
]

const PLACEHOLDER: Record<SectionId, string> = {
  premise: 'Pitch your story — a premise, a vibe, a character…',
  world: 'What is the world like? Who holds power, what is at stake?',
  cards: 'Who and what should the story know about? Characters, places, factions…',
  opening: 'How should the adventure begin?',
  rules: 'How should the narrator write? Tone, pacing, what to emphasise…',
  scripts: "Describe a mechanic — e.g. track my HP in the author's note"
}

export const FILL_STAGES = [
  { id: 'core', label: 'Premise, world & rules', hint: 'Title, pitch, plot essentials, narrator rules' },
  { id: 'cards', label: 'Cast & places', hint: 'Story cards for characters, locations and lore' },
  { id: 'opening', label: 'Opening', hint: 'The first scene of the adventure' }
]

function Avatar(): React.JSX.Element {
  return (
    <span className="grid size-7 shrink-0 place-items-center rounded-full border border-line bg-white/[0.05]">
      <LogoMark size={16} />
    </span>
  )
}

function Typing(): React.JSX.Element {
  return (
    <div className="flex h-5 items-center gap-1">
      {[0, 1, 2].map((i) => (
        <motion.span key={i} className="size-1.5 rounded-full bg-fg-3" animate={{ opacity: [0.3, 1, 0.3], y: [0, -2, 0] }} transition={{ duration: 1, repeat: Infinity, delay: i * 0.15, ease: 'easeInOut' }} />
      ))}
    </div>
  )
}

function Msg({ m, onRetry, onOpenSection }: { m: ComposerMsg; onRetry: () => void; onOpenSection?: (id: SectionId) => void }): React.JSX.Element {
  const setFocus = useComposer((s) => s.setFocus)
  if (m.role === 'user') {
    return (
      <motion.div variants={rise} initial="initial" animate="animate" className="flex justify-end">
        <div className="selectable max-w-[88%] rounded-2xl rounded-br-md border border-line bg-white/[0.07] px-3.5 py-2 text-[13px] leading-relaxed whitespace-pre-wrap text-fg">{m.text}</div>
      </motion.div>
    )
  }
  return (
    <motion.div variants={rise} initial="initial" animate="animate" className="flex gap-2.5">
      <Avatar />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 pt-0.5">
        {m.reasoning && <ThinkingBlock reasoning={m.reasoning} ms={m.thinkingMs} live={!!m.pending && !m.text} />}
        {m.pending && !m.text ? <Typing /> : m.text && <p className="selectable text-[13px] leading-relaxed whitespace-pre-wrap text-fg">{m.text}</p>}
        {m.error && (
          <div className="flex items-start gap-2 rounded-xl border border-danger/25 bg-danger/10 px-3 py-2 text-[12px] text-danger">
            <span className="flex-1">{m.error}</span>
            <button onClick={onRetry} className="flex shrink-0 items-center gap-1 font-medium hover:underline">
              <RotateCcw className="size-3" /> Retry
            </button>
          </div>
        )}
        {!!m.changed?.length && (
          <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
            <span className="text-[11px] text-fg-3">Updated</span>
            {m.changed.map((s) => (
              <button
                key={s}
                onClick={() => {
                  setFocus(s)
                  onOpenSection?.(s)
                }}
                className="rounded-full border border-[color-mix(in_oklab,var(--accent)_30%,transparent)] bg-[color-mix(in_oklab,var(--accent)_10%,transparent)] px-2 py-0.5 text-[11px] font-medium text-fg-2 transition hover:text-fg max-md:px-2.5 max-md:py-1"
              >
                {SECTIONS.find((x) => x.id === s)?.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </motion.div>
  )
}

function FillProgress(): React.JSX.Element | null {
  const busy = useComposer((s) => s.busy)
  const live = useComposer((s) => s.liveReasoning)
  if (busy?.kind !== 'fill') return null
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.3, ease }} className="flex gap-2.5">
      <Avatar />
      <div className="flex min-w-0 flex-1 flex-col gap-3 rounded-2xl border border-line bg-white/[0.03] p-3.5">
        <div className="text-[12.5px] font-medium text-fg-2">Drafting the whole scenario…</div>
        <StageList stages={FILL_STAGES} current={busy.stage} />
        {live && <ThinkingBlock reasoning={live} live />}
      </div>
    </motion.div>
  )
}

/** Phones: the Focus pill picks the section the chat works on (the stepper lives in Preview). */
function FocusMenu({ children }: { children: React.ReactNode }): React.JSX.Element {
  const sections = useComposer((s) => s.draft.sections)
  const focus = useComposer((s) => s.focus)
  const setFocus = useComposer((s) => s.setFocus)
  return (
    <Menu align="end" trigger={<button className="flex h-8 items-center gap-1 rounded-full">{children}</button>}>
      {SECTIONS.map((s, i) => (
        <MenuItem key={s.id} onSelect={() => setFocus(s.id)} right={<StateDot state={sections[s.id]} />} hint={focus === s.id ? 'focus' : undefined}>
          <span className="mr-1.5 text-fg-3 tabular-nums">{i + 1}</span>
          {s.label}
        </MenuItem>
      ))}
    </Menu>
  )
}

export function ChatPanel({ initial, onOpenSection }: { initial?: string; onOpenSection?: (id: SectionId) => void }): React.JSX.Element {
  const compact = useCompact()
  const defLlm = useDefaultLlm()
  const llm = useComposer((s) => s.llm)
  const setLlm = useComposer((s) => s.setLlm)
  const messages = useComposer((s) => s.messages)
  const busy = useComposer((s) => s.busy)
  const focus = useComposer((s) => s.focus)
  const pristine = useComposer((s) => Object.values(s.draft.sections).every((v) => v === 'empty'))
  const { send, stop, fillFromBrief } = useComposer.getState()
  const [text, setText] = useState(initial ?? '')
  const scroller = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const pinned = useRef(true)

  const lastText = messages[messages.length - 1]?.text
  useEffect(() => {
    const el = scroller.current
    // (Not while the welcome screen shows — on a phone it would scroll its heading away.)
    if (el && pinned.current && (messages.length || busy)) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [messages.length, lastText, busy])

  const last = [...messages].reverse().find((m) => m.role === 'assistant')
  const suggestions = !busy && last && !last.pending ? (last.suggestions ?? []) : []
  const focusLabel = SECTIONS.find((s) => s.id === focus)?.label

  const submit = (mode: 'chat' | 'draft', value = text): void => {
    const v = value.trim()
    if (!v || busy) return
    setText('')
    pinned.current = true
    if (mode === 'draft') void fillFromBrief(v)
    else void send(v)
  }
  const retry = (): void => {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')
    if (!lastUser) return
    useComposer.setState((s) => ({ messages: s.messages.filter((m) => !m.error) }))
    void send(lastUser.text)
  }

  return (
    <div className="pointer-events-auto flex min-h-0 flex-1 flex-col overflow-hidden rounded-[20px] border border-line bg-[var(--panel)] shadow-[0_24px_60px_-30px_rgb(0_0_0/0.8)] backdrop-blur-xl hairline">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5 max-md:py-1.5 max-md:pr-2">
        <span className="label-caps">Co-author</span>
        <span className="ml-auto flex items-center gap-1.5 text-[11px] text-fg-3">
          Focus
          {compact ? (
            <FocusMenu>
              <AnimatePresence mode="wait" initial={false}>
                <motion.span key={focus} initial={{ opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -3 }} transition={{ duration: 0.18, ease }} className="flex items-center gap-1 rounded-full bg-white/[0.07] py-1 pr-2 pl-2.5 text-[11.5px] font-medium text-fg-2">
                  {focusLabel}
                  <ChevronDown className="size-3 text-fg-3" />
                </motion.span>
              </AnimatePresence>
            </FocusMenu>
          ) : (
            <AnimatePresence mode="wait" initial={false}>
              <motion.span key={focus} initial={{ opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -3 }} transition={{ duration: 0.18, ease }} className="rounded-full bg-white/[0.07] px-2 py-0.5 font-medium text-fg-2">
                {focusLabel}
              </motion.span>
            </AnimatePresence>
          )}
        </span>
      </div>

      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        }}
        className="scroll-fade min-h-0 flex-1 overflow-y-auto px-4 py-4 max-md:px-3.5"
      >
        {messages.length === 0 && busy?.kind !== 'fill' ? (
          <motion.div variants={stagger(0.05, 0.05)} initial="initial" animate="animate" className="flex flex-col items-center gap-3 pt-4 text-center">
            <motion.div variants={rise}>
              <LogoMark size={42} className="drop-shadow-[0_8px_24px_color-mix(in_oklab,var(--accent)_45%,transparent)]" />
            </motion.div>
            <motion.div variants={rise} className="font-serif text-[19px] font-semibold tracking-tight">
              What story do you want to play?
            </motion.div>
            <motion.p variants={rise} className="max-w-[320px] text-[12.5px] leading-relaxed text-fg-3">
              Pitch a premise, a vibe or a character. I’ll shape it into a scenario with you, section by section — or draft the whole thing at once.
            </motion.p>
            <div className="mt-2 flex w-full flex-col gap-2">
              {STARTERS.map((s) => (
                <motion.button
                  key={s.title}
                  variants={rise}
                  whileHover={{ x: 3 }}
                  transition={spring}
                  onClick={() => {
                    setText(`${s.title}. ${s.body}`)
                    input.current?.focus()
                  }}
                  className="rounded-2xl border border-line bg-white/[0.03] px-3.5 py-2.5 text-left transition-colors hover:border-line-strong hover:bg-white/[0.06]"
                >
                  <div className="text-[12.5px] font-semibold">{s.title}</div>
                  <div className="text-[11.5px] text-fg-3">{s.body}</div>
                </motion.button>
              ))}
            </div>
          </motion.div>
        ) : (
          <div className="flex flex-col gap-4">
            {messages.map((m) => (
              <Msg key={m.id} m={m} onRetry={retry} onOpenSection={onOpenSection} />
            ))}
            <AnimatePresence>
              <FillProgress key="fill" />
            </AnimatePresence>
          </div>
        )}
      </div>

      <AnimatePresence initial={false}>
        {suggestions.length > 0 && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.25, ease }} className="overflow-hidden">
            {/* Phones: one swipeable row so the input keeps its room. */}
            <div className="flex flex-wrap gap-1.5 px-4 pb-2 max-md:flex-nowrap max-md:overflow-x-auto max-md:px-3 max-md:[scrollbar-width:none]">
              {suggestions.map((s) => (
                <Chip key={s} onClick={() => submit('chat', s)} className="h-7 text-[11.5px] max-md:h-8 max-md:shrink-0 max-md:whitespace-nowrap">
                  {s}
                </Chip>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="p-3 pt-1 max-md:p-2 max-md:pt-1">
        <div className={cn('rounded-2xl border bg-white/[0.04] p-2.5 transition-colors', busy ? 'border-line' : 'border-line focus-within:border-line-strong')}>
          <Textarea
            ref={input}
            bare
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              // Touch keyboards: Enter is a new line; the send button sends.
              if (e.key === 'Enter' && !e.shiftKey && !isTouch) {
                e.preventDefault()
                submit('chat')
              }
            }}
            minRows={2}
            maxRows={8}
            placeholder={PLACEHOLDER[focus]}
            className="px-1 text-[13px] leading-relaxed"
          />
          <div className="mt-1.5 flex items-center gap-2">
            {/* Phones: the model picker lives here (no keyboard hint on touch). */}
            {compact ? (
              <ModelPicker value={llm ?? defLlm} onChange={setLlm} className="h-8 min-w-0 max-w-[170px] shrink rounded-full" />
            ) : (
              <span className="text-[10.5px] text-fg-3">Enter to send · Shift+Enter for a new line</span>
            )}
            <div className="flex-1" />
            {pristine && !busy && (
              <Button size="sm" variant="secondary" icon={<Sparkles className="size-3.5" />} disabled={!text.trim()} onClick={() => submit('draft')} title="Draft every section from this pitch" className="max-md:h-9 max-md:rounded-full">
                Draft it all
              </Button>
            )}
            {busy ? (
              <IconButton label="Stop" variant="secondary" size="sm" onClick={() => (busy.kind === 'script' ? stopScript() : stop())} className="rounded-full max-md:size-9">
                <Square className="size-3 fill-current" />
              </IconButton>
            ) : (
              <IconButton label="Send" variant="primary" size="sm" disabled={!text.trim()} onClick={() => submit('chat')} className="rounded-full max-md:size-9">
                <ArrowUp className="size-4" />
              </IconButton>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
