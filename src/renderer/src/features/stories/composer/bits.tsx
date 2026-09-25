// Small pieces shared by the Composer and “Generate with AI”.
import { Fragment, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Check } from 'lucide-react'
import { Spinner } from '@/components/ui/misc'
import { cn } from '@/lib/utils'
import { ease, spring } from '@/lib/motion'
import type { SectionState } from './draft'

export interface Stage {
  id: string
  label: string
  hint?: string
}

/** Vertical list of generation stages with animated state. */
export function StageList({ stages, current, done }: { stages: Stage[]; current?: string; done?: boolean }): React.JSX.Element {
  const at = done ? stages.length : Math.max(0, stages.findIndex((s) => s.id === current))
  return (
    <div className="flex flex-col gap-2.5">
      {stages.map((s, i) => {
        const state = i < at ? 'done' : i === at ? 'active' : 'todo'
        return (
          <motion.div key={s.id} initial={{ opacity: 0, x: -6 }} animate={{ opacity: state === 'todo' ? 0.45 : 1, x: 0 }} transition={{ duration: 0.35, ease, delay: i * 0.04 }} className="flex items-center gap-3">
            <span
              className={cn(
                'relative grid size-6 shrink-0 place-items-center rounded-full border transition-colors duration-300',
                state === 'done' ? 'border-transparent bg-grad text-white' : state === 'active' ? 'border-[color-mix(in_oklab,var(--accent)_55%,transparent)] text-accent' : 'border-line-strong text-fg-3'
              )}
            >
              <AnimatePresence mode="wait" initial={false}>
                {state === 'done' ? (
                  <motion.span key="d" initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.4, opacity: 0 }} transition={spring}>
                    <Check className="size-3.5" strokeWidth={3} />
                  </motion.span>
                ) : state === 'active' ? (
                  <motion.span key="a" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                    <Spinner className="size-3.5" />
                  </motion.span>
                ) : (
                  <motion.span key="t" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="text-[10.5px] font-semibold tabular-nums">
                    {i + 1}
                  </motion.span>
                )}
              </AnimatePresence>
            </span>
            <div className="min-w-0">
              <div className={cn('text-[12.5px] font-medium', state === 'active' ? 'text-fg' : 'text-fg-2')}>{s.label}</div>
              {s.hint && state === 'active' && <div className="text-[11px] text-fg-3">{s.hint}</div>}
            </div>
          </motion.div>
        )
      })}
    </div>
  )
}

/** Opening text with `${…}` placeholders shown as chips. */
export function PlaceholderText({ text, className }: { text: string; className?: string }): React.JSX.Element {
  const parts = text.split(/(\$\{[^}]{1,120}\})/g)
  return (
    <div className={cn('whitespace-pre-wrap', className)}>
      {parts.map((p, i) =>
        /^\$\{.*\}$/.test(p) ? (
          <span key={i} className="mx-0.5 inline-flex items-center rounded-md border border-[color-mix(in_oklab,var(--accent)_35%,transparent)] bg-[color-mix(in_oklab,var(--accent)_12%,transparent)] px-1.5 align-baseline font-mono text-[0.78em] text-fg">
            {p.slice(2, -1)}
          </span>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        )
      )}
    </div>
  )
}

export function StatusBadge({ state }: { state: SectionState }): React.JSX.Element {
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.span
        key={state}
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.9 }}
        transition={{ duration: 0.2, ease }}
        className={cn(
          'inline-flex h-5 items-center gap-1 rounded-full px-2 text-[10.5px] font-semibold tracking-wide whitespace-nowrap',
          state === 'accepted' && 'bg-success/12 text-success',
          state === 'proposed' && 'bg-[color-mix(in_oklab,var(--accent)_16%,transparent)] text-accent',
          state === 'empty' && 'border border-line text-fg-3'
        )}
      >
        {state === 'accepted' && <Check className="size-3" strokeWidth={3} />}
        {state === 'proposed' && <span className="size-1.5 animate-pulse rounded-full bg-accent" />}
        {state === 'accepted' ? 'Accepted' : state === 'proposed' ? 'Proposed' : 'Empty'}
      </motion.span>
    </AnimatePresence>
  )
}

/** Dot used in the stepper. */
export function StateDot({ state }: { state: SectionState }): React.JSX.Element {
  return (
    <span
      className={cn(
        'size-1.5 rounded-full transition-colors duration-300',
        state === 'accepted' ? 'bg-success' : state === 'proposed' ? 'bg-accent shadow-[0_0_8px_var(--accent)]' : 'bg-white/20'
      )}
    />
  )
}

export function Shimmer({ lines = 3 }: { lines?: number }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2 py-1">
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="shimmer h-3 rounded-md" style={{ width: `${92 - ((i * 17) % 35)}%` }} />
      ))}
    </div>
  )
}

export function Label({ children, className }: { children: ReactNode; className?: string }): React.JSX.Element {
  return <div className={cn('label-caps mb-1.5', className)}>{children}</div>
}
