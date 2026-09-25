import type { ReactNode } from 'react'
import { motion } from 'motion/react'
import { cn } from '@/lib/utils'
import { page } from '@/lib/motion'

/** Scrollable page body with the standard enter/exit motion. */
export function Page({ children, className, scroll = true }: { children: ReactNode; className?: string; scroll?: boolean }): React.JSX.Element {
  return (
    <motion.div variants={page} initial="initial" animate="animate" exit="exit" className={cn('h-full w-full', scroll ? 'overflow-y-auto' : 'overflow-hidden', className)}>
      {children}
    </motion.div>
  )
}

export function PageHeader({
  title,
  subtitle,
  actions,
  className,
  icon
}: {
  title: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
  className?: string
  icon?: ReactNode
}): React.JSX.Element {
  return (
    <div className={cn('flex items-end justify-between gap-6 px-8 pt-7 pb-5', className)}>
      <div className="min-w-0">
        <h1 className="display flex items-center gap-2.5 text-[26px]">
          {icon && <span className="text-accent [&>svg]:size-6">{icon}</span>}
          {title}
        </h1>
        {subtitle && <p className="mt-1.5 max-w-2xl text-[13px] text-fg-2">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  )
}

/** Big hero used on section landing pages (Skills, Connectors, Characters). */
export function Hero({ eyebrow, title, bullets, actions, art, className }: { eyebrow?: ReactNode; title: ReactNode; bullets?: { icon: ReactNode; strong: string; rest: string }[]; actions?: ReactNode; art?: ReactNode; className?: string }): React.JSX.Element {
  return (
    <div className={cn('relative overflow-hidden border-b border-line', className)}>
      <div className="relative z-10 flex min-h-[300px] flex-col justify-center gap-5 px-10 py-10">
        {eyebrow && <div className="label-caps flex items-center gap-2 text-fg-2">{eyebrow}</div>}
        <h1 className="display max-w-xl text-[40px] uppercase">{title}</h1>
        {bullets && (
          <ul className="flex flex-col gap-2">
            {bullets.map((b, i) => (
              <motion.li key={i} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.1 + i * 0.06, duration: 0.4 }} className="flex items-center gap-2.5 text-[13px] text-fg-3">
                <span className="text-fg-2 [&>svg]:size-3.5">{b.icon}</span>
                <span>
                  <b className="font-semibold text-fg">{b.strong}</b> {b.rest}
                </span>
              </motion.li>
            ))}
          </ul>
        )}
        {actions && <div className="mt-2 flex gap-2">{actions}</div>}
      </div>
      {art && <div className="pointer-events-none absolute inset-y-0 right-0 w-[58%]">{art}</div>}
    </div>
  )
}
