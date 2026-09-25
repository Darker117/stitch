// Small play-screen building blocks: action icons, themed command buttons,
// accordions and the theme context.
import { createContext, forwardRef, useContext, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ChevronDown, Eye, Feather, MessageCircle } from 'lucide-react'
import type { ActionType } from '@shared/types'
import { Button, type ButtonProps } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { ease } from '@/lib/motion'
import { THEMES, type ThemeDef } from '../themes'

/** Running figure for "Do" (lucide has none). */
export function RunIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={cn('size-4', className)}>
      <circle cx="15.5" cy="4" r="2" />
      <path d="M13.5 8 11 13.5" />
      <path d="M13.5 8.2 17 11l2.5-.8" />
      <path d="M13 8.2 9.2 8.6 7.5 11.5" />
      <path d="M11 13.5l3.2 2.6-1 4.9" />
      <path d="M11 13.5 8.4 17 4.8 17.4" />
    </svg>
  )
}

export function ActionIcon({ type, className }: { type: ActionType; className?: string }): React.JSX.Element {
  const c = cn('size-4', className)
  if (type === 'do') return <RunIcon className={c} />
  if (type === 'say') return <MessageCircle className={c} />
  if (type === 'see') return <Eye className={c} />
  return <Feather className={c} />
}

export const ThemeCtx = createContext<ThemeDef>(THEMES[0])
export const useTheme = (): ThemeDef => useContext(ThemeCtx)

/** Command button that takes on the active play theme (bevels, angles, glows). */
export const CmdButton = forwardRef<HTMLButtonElement, ButtonProps & { tone?: 'primary' | 'secondary'; compact?: boolean; label: string }>(function CmdButton(
  { tone = 'secondary', compact, label, icon, className, style, ...rest },
  ref
) {
  const t = useTheme()
  const themed = t.id !== 'dynamic'
  const look = tone === 'primary' ? t.button.primary : t.button.secondary
  const glow = tone === 'primary' && !themed
  return (
    <span className="relative isolate inline-flex">
      {glow && <span aria-hidden className="st-glow pointer-events-none absolute -inset-1 -z-10 rounded-2xl bg-grad blur-lg" />}
    <Button
      ref={ref}
      variant={themed ? 'ghost' : tone === 'primary' ? 'primary' : 'glass'}
      size="lg"
      icon={icon}
      title={compact ? label : undefined}
      aria-label={label}
      className={cn(
        'h-11 font-semibold tracking-[0.06em] uppercase transition-[filter,transform,box-shadow,background] duration-300 hover:brightness-110',
        compact ? 'w-11 px-0' : 'px-4.5 text-[12.5px]',
        themed && 'hover:bg-transparent',
        className
      )}
      style={{ borderRadius: t.button.radius, clipPath: t.button.clip, ...(themed ? look : {}), ...style }}
      {...rest}
    >
      {!compact && label}
    </Button>
    </span>
  )
})

export function Accordion({ title, icon, children, defaultOpen = false, aside }: { title: ReactNode; icon?: ReactNode; children: ReactNode; defaultOpen?: boolean; aside?: ReactNode }): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-white/[0.025]">
      <button onClick={() => setOpen((o) => !o)} className="flex h-12 w-full items-center gap-2.5 px-4 text-left transition-colors hover:bg-white/[0.03]">
        {icon && <span className="text-fg-2 [&>svg]:size-4">{icon}</span>}
        <span className="flex-1 text-[12px] font-bold tracking-[0.06em] uppercase">{title}</span>
        {aside}
        <motion.span animate={{ rotate: open ? 180 : 0 }} transition={{ duration: 0.3, ease }} className="text-fg-3">
          <ChevronDown className="size-4" />
        </motion.span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.32, ease }}>
            <div className="flex flex-col gap-5 border-t border-line px-4 pt-4 pb-5">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
