// Phone layout for Generate: the desktop's side-by-side columns become two panes
// (Create / Results, Studio / History) under an underlined tab row.
import type { ReactNode } from 'react'
import { motion } from 'motion/react'
import { Tabs, type TabItem } from '@/components/ui/controls'
import { cn } from '@/lib/utils'
import { ease } from '@/lib/motion'

/** Full-width tab row that switches the panes. */
export function PaneTabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: TabItem<T>[] }): React.JSX.Element {
  return <Tabs value={value} onChange={onChange} items={items} className="shrink-0 gap-0 px-3 [&>button]:h-10 [&>button]:flex-1 [&>button]:justify-center" />
}

/**
 * One pane. Both stay mounted so drafts and scroll positions survive the switch;
 * the inactive one slides a little toward its side, fades out and goes inert.
 */
export function Pane({ active, side, children, className }: { active: boolean; side: 'left' | 'right'; children: ReactNode; className?: string }): React.JSX.Element {
  const dx = side === 'left' ? -28 : 28
  return (
    <motion.div
      inert={!active}
      aria-hidden={!active}
      initial={false}
      animate={active ? { opacity: 1, x: 0 } : { opacity: 0, x: dx }}
      transition={{ duration: 0.34, ease }}
      className={cn('absolute inset-0', !active && 'pointer-events-none', className)}
    >
      {children}
    </motion.div>
  )
}

/** Small pulsing accent dot for "something is rendering" on a tab. */
export function LiveDot(): React.JSX.Element {
  return (
    <span className="relative ml-0.5 flex size-1.5">
      <span className="absolute inset-0 animate-ping rounded-full bg-accent opacity-70" />
      <span className="relative size-1.5 rounded-full bg-accent" />
    </span>
  )
}
