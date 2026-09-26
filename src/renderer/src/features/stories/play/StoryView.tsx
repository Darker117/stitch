// The story column: AI passages, player actions, streaming text and media.
import { memo, useEffect, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ChevronLeft, ChevronRight, Clapperboard, Eye, Pencil, RefreshCw, Trash2, Volume2 } from 'lucide-react'
import type { Adventure, ID, StoryAction } from '@shared/types'
import { Tooltip } from '@/components/ui/overlay'
import { cn } from '@/lib/utils'
import { ease } from '@/lib/motion'
import { isTouch, useCompact } from '@/lib/platform'
import { ThinkingBlock } from '@/features/create/Messages'
import { isAiAction, playerLine } from '../engine/text'
import { ActionIcon } from './bits'
import { TurnMedia } from './TurnMedia'
import type { PlayController, Streaming } from './usePlay'

function norm(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n')
}

function ToolButton({ label, onClick, children, disabled }: { label: string; onClick: () => void; children: React.ReactNode; disabled?: boolean }): React.JSX.Element {
  return (
    <Tooltip content={label}>
      <button
        onClick={(e) => {
          e.stopPropagation()
          onClick()
        }}
        disabled={disabled}
        aria-label={label}
        className="grid size-7 place-items-center rounded-lg text-fg-3 transition hover:bg-[color-mix(in_oklab,var(--fg)_10%,transparent)] hover:text-fg disabled:opacity-40"
      >
        {children}
      </button>
    </Tooltip>
  )
}

type Tool = { label: string; icon: ReactNode; onClick: () => void; disabled?: boolean }

/** Touch: the passage's tools as a row of labelled chips under the tapped passage. */
function ToolRow({ tools, onDone }: { tools: Tool[]; onDone: () => void }): React.JSX.Element {
  return (
    <motion.div
      initial={{ opacity: 0, y: -6, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -4, scale: 0.98, transition: { duration: 0.14 } }}
      transition={{ duration: 0.26, ease }}
      className="flex origin-top-left flex-wrap gap-1.5 pt-2.5 pb-1 font-sans"
    >
      {tools.map((x) => (
        <button
          key={x.label}
          onClick={(e) => {
            e.stopPropagation()
            onDone()
            x.onClick()
          }}
          disabled={x.disabled}
          className="flex h-9 items-center gap-1.5 rounded-full border border-line bg-[var(--panel)] px-3.5 text-[12px] font-medium text-fg-2 backdrop-blur-xl transition-[transform,opacity] duration-150 active:scale-95 disabled:opacity-40 [&>svg]:size-3.5 [&>svg]:text-accent"
        >
          {x.icon}
          {x.label}
        </button>
      ))}
    </motion.div>
  )
}

function Editor({ text, onDone, className }: { text: string; onDone: (t: string | null) => void; className?: string }): React.JSX.Element {
  const ref = useRef<HTMLTextAreaElement>(null)
  const [v, setV] = useState(text)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [v])
  return (
    <textarea
      ref={ref}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => onDone(v)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onDone(null)
        }
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) onDone(v)
      }}
      className={cn('block w-full resize-none overflow-hidden rounded-lg bg-[color-mix(in_oklab,var(--fg)_5%,transparent)] px-2 py-1 -mx-2 -my-1 outline-none ring-1 ring-[color-mix(in_oklab,var(--accent)_45%,transparent)]', className)}
      style={{ font: 'inherit', lineHeight: 'inherit', color: 'inherit', width: 'calc(100% + 16px)' }}
    />
  )
}

function Thinking({ reasoning, ms, live }: { reasoning: string; ms?: number; live: boolean }): React.JSX.Element {
  return (
    <div className="mb-1.5 font-sans" style={{ fontSize: 13, lineHeight: 1.5 }}>
      <ThinkingBlock reasoning={reasoning} ms={ms} live={live} />
    </div>
  )
}

function StreamingText({ s, animate }: { s: Streaming; animate: boolean }): React.JSX.Element {
  if (!s.text && s.reasoning) return <Thinking reasoning={s.reasoning} live />
  if (!s.text) {
    return (
      <span className="inline-flex items-center gap-1.5 py-2 text-[0.85em] text-fg-3">
        {[0, 1, 2].map((i) => (
          <motion.span key={i} className="size-1.5 rounded-full bg-accent" animate={{ opacity: [0.2, 1, 0.2], y: [0, -3, 0] }} transition={{ duration: 1, repeat: Infinity, delay: i * 0.15 }} />
        ))}
      </span>
    )
  }
  return (
    <>
      {s.reasoning && <Thinking reasoning={s.reasoning} ms={Date.now() - s.startedAt} live={false} />}
      <span className="whitespace-pre-wrap">
      {animate
        ? s.chunks.map((c, i) => (
            <span key={i} className="st-token">
              {c}
            </span>
          ))
        : s.text}
      <span className="st-caret" />
      </span>
    </>
  )
}

const Passage = memo(function Passage({
  adv,
  a,
  isLast,
  fresh,
  streaming,
  ctl,
  animateText,
  onOpen,
  touch,
  selected,
  onSelect
}: {
  adv: Adventure
  a: StoryAction
  isLast: boolean
  fresh: boolean
  streaming: Streaming | null
  ctl: PlayController
  animateText: boolean
  onOpen: (id: ID) => void
  /** Touch layout: tap selects the passage and shows its tools (no hover). */
  touch: boolean
  selected: boolean
  onSelect: (id: ID | null) => void
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const ai = isAiAction(a)
  const live = streaming?.retry && streaming.targetId === a.id
  const pending = ctl.pending[a.id]
  const alts = a.alternates ?? []
  const altIdx = alts.indexOf(a.text)
  // Session thoughts first, then whatever was saved with the passage.
  const thought = ctl.thoughts[a.id] ?? (a.reasoning ? { text: a.reasoning, ms: a.thinkingMs ?? 0 } : undefined)

  const done = (t: string | null): void => {
    setEditing(false)
    if (t === null || t === a.text) return
    if (!t.trim()) void ctl.remove(a.id)
    else void ctl.edit(a.id, t)
  }

  const tools: Tool[] = [
    ...(ai
      ? [
          { label: 'See this moment', icon: <Eye className="size-3.5" />, onClick: () => void ctl.see(a.id), disabled: !!pending?.see },
          { label: 'Animate', icon: <Clapperboard className="size-3.5" />, onClick: () => void ctl.animate(a.id), disabled: !!pending?.animate },
          { label: 'Narrate', icon: <Volume2 className="size-3.5" />, onClick: () => void ctl.narrate(a.id), disabled: !!pending?.narrate }
        ]
      : []),
    ...(a.type === 'see' ? [{ label: 'See again', icon: <RefreshCw className="size-3.5" />, onClick: () => void ctl.see(a.id, a.text || undefined), disabled: !!pending?.see }] : []),
    ...(a.type !== 'see' ? [{ label: 'Edit', icon: <Pencil className="size-3.5" />, onClick: () => setEditing(true) }] : []),
    { label: 'Delete', icon: <Trash2 className="size-3.5" />, onClick: () => void ctl.remove(a.id) }
  ]

  const toolbar = touch ? null : (
    <div className="pointer-events-none absolute -top-3 right-0 z-10 flex items-center gap-0.5 rounded-xl border border-line bg-[var(--panel)] p-0.5 opacity-0 shadow-[0_10px_30px_-12px_rgb(0_0_0/0.6)] backdrop-blur-xl transition-all duration-200 group-hover:pointer-events-auto group-hover:-translate-y-1 group-hover:opacity-100">
      {tools.map((x) => (
        <ToolButton key={x.label} label={x.label} onClick={x.onClick} disabled={x.disabled}>
          {x.icon}
        </ToolButton>
      ))}
    </div>
  )
  const toolRow = <AnimatePresence initial={false}>{touch && selected && !editing && <ToolRow key="tools" tools={tools} onDone={() => onSelect(null)} />}</AnimatePresence>
  // Desktop: click edits in place. Touch: tap selects (tools appear), Edit is one of the tools.
  const tap = (edit: () => void): void => {
    if (!touch) return edit()
    if (!editing) onSelect(selected ? null : a.id)
  }

  if (!ai) {
    return (
      <motion.div layout="position" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease }} className="group relative my-5" data-passage={a.id}>
        {toolbar}
        <div className="flex items-start gap-2.5" style={{ color: 'var(--st-muted)' }}>
          <span className="mt-[0.3em] h-[1.35em] w-[7px] shrink-0 rounded-l-[4px] border-y-2 border-l-2 border-[color-mix(in_oklab,var(--accent)_75%,transparent)]" />
          <span className="mt-[0.38em] shrink-0 text-accent">
            <ActionIcon type={a.type} className="size-[0.95em]" />
          </span>
          <div className="min-w-0 flex-1 cursor-text" onClick={() => tap(() => a.type !== 'see' && setEditing(true))}>
            {editing ? (
              <Editor text={a.text} onDone={done} />
            ) : (
              <p className="whitespace-pre-wrap">{a.type === 'see' ? (a.text ? `You see ${a.text.replace(/^you see\s+/i, '')}` : 'You look around.') : playerLine(a.type, a.text)}</p>
            )}
          </div>
        </div>
        <div className="pl-[34px]">
          {toolRow}
          <TurnMedia adv={adv} action={a} pending={pending} onOpen={onOpen} onAnimate={() => void ctl.animate(a.id)} autoplay={ctl.autoplay} />
        </div>
      </motion.div>
    )
  }

  return (
    <motion.div layout="position" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.5, ease }} className="group relative my-3" data-passage={a.id}>
      {!live && toolbar}
      <div
        className={cn(
          '-mx-4 rounded-2xl px-4 py-2 transition-[background-color,box-shadow] duration-700 max-md:-mx-3 max-md:px-3',
          (fresh || live) && 'bg-[color-mix(in_oklab,var(--accent)_7%,transparent)] shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--accent)_12%,transparent)]',
          touch && selected && !fresh && !live && 'bg-[color-mix(in_oklab,var(--fg)_5%,transparent)] duration-300'
        )}
      >
        {thought && !live && isLast && <Thinking reasoning={thought.text} ms={thought.ms} live={false} />}
        <div className="cursor-text" onClick={() => !live && tap(() => setEditing(true))} style={{ color: 'var(--st-text)' }}>
          {live && streaming ? (
            <StreamingText s={streaming} animate={animateText} />
          ) : editing ? (
            <Editor text={a.text} onDone={done} className="whitespace-pre-wrap" />
          ) : (
            <span className={cn('whitespace-pre-wrap', fresh ? 'st-fresh-line' : 'st-stale-line')}>{norm(a.text)}</span>
          )}
        </div>
        {isLast && alts.length > 1 && !live && (
          <div className="mt-2 flex items-center gap-1 text-[12px] text-fg-3 max-md:-ml-2 max-md:gap-0.5 max-md:font-sans">
            <button onClick={() => void ctl.cycle(a.id, -1)} className="grid size-6 place-items-center rounded-md hover:bg-white/10 hover:text-fg max-md:size-9 max-md:rounded-full max-md:active:bg-white/10" aria-label="Previous version">
              <ChevronLeft className="size-3.5 max-md:size-4" />
            </button>
            <span className="tabular-nums">
              {altIdx < 0 ? '·' : altIdx + 1} / {alts.length}
            </span>
            <button onClick={() => void ctl.cycle(a.id, 1)} className="grid size-6 place-items-center rounded-md hover:bg-white/10 hover:text-fg max-md:size-9 max-md:rounded-full max-md:active:bg-white/10" aria-label="Next version">
              <ChevronRight className="size-3.5 max-md:size-4" />
            </button>
          </div>
        )}
        {toolRow}
      </div>
      <TurnMedia adv={adv} action={a} pending={pending} onOpen={onOpen} onAnimate={() => void ctl.animate(a.id)} autoplay={ctl.autoplay} />
    </motion.div>
  )
})

export function StoryView({ adv, ctl, animateText, onOpen }: { adv: Adventure; ctl: PlayController; animateText: boolean; onOpen: (id: ID) => void }): React.JSX.Element {
  const s = ctl.streaming
  const newStream = s && !s.retry
  const touch = useCompact() || isTouch
  const [sel, setSel] = useState<ID | null>(null)
  // Tapping anywhere outside the selected passage puts its tools away.
  useEffect(() => {
    if (!sel) return
    const away = (e: PointerEvent): void => {
      if (!(e.target as HTMLElement | null)?.closest?.(`[data-passage="${sel}"]`)) setSel(null)
    }
    document.addEventListener('pointerdown', away, true)
    return () => document.removeEventListener('pointerdown', away, true)
  }, [sel])
  return (
    <div>
      <AnimatePresence initial={false}>
        {adv.actions.map((a, i) => (
          <Passage
            key={a.id}
            adv={adv}
            a={a}
            isLast={i === adv.actions.length - 1}
            fresh={ctl.freshId === a.id}
            streaming={s?.retry && s.targetId === a.id ? s : null}
            ctl={ctl}
            animateText={animateText}
            onOpen={onOpen}
            touch={touch}
            selected={sel === a.id}
            onSelect={setSel}
          />
        ))}
      </AnimatePresence>
      {newStream && s && (
        <motion.div key={s.targetId} layout="position" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3 }} className="my-3">
          <div className="-mx-4 rounded-2xl bg-[color-mix(in_oklab,var(--accent)_7%,transparent)] px-4 py-2 max-md:-mx-3 max-md:px-3 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--accent)_12%,transparent)]" style={{ color: 'var(--st-text)' }}>
            <StreamingText s={s} animate={animateText} />
          </div>
        </motion.div>
      )}
    </div>
  )
}
