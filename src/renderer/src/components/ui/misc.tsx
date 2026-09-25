import type { HTMLAttributes, ReactNode } from 'react'
import { motion } from 'motion/react'
import { cn } from '@/lib/utils'
import { ease } from '@/lib/motion'

export function Spinner({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg className={cn('size-4 animate-spin', className)} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.18" strokeWidth="2.5" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  )
}

/** Circular progress with the sunset gradient. value 0..1, undefined = indeterminate. */
export function ProgressRing({ value, size = 28, stroke = 2.5, className }: { value?: number; size?: number; stroke?: number; className?: string }): React.JSX.Element {
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const id = `pr-${size}-${stroke}`
  return (
    <svg width={size} height={size} className={cn(value === undefined && 'animate-spin', className)} viewBox={`0 0 ${size} ${size}`}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="var(--accent-2)" />
          <stop offset="100%" stopColor="var(--accent)" />
        </linearGradient>
      </defs>
      <circle cx={size / 2} cy={size / 2} r={r} stroke="rgb(255 255 255 / 0.1)" strokeWidth={stroke} fill="none" />
      <motion.circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        stroke={`url(#${id})`}
        strokeWidth={stroke}
        fill="none"
        strokeLinecap="round"
        strokeDasharray={c}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        animate={{ strokeDashoffset: c * (1 - (value ?? 0.28)) }}
        transition={{ duration: 0.5, ease }}
      />
    </svg>
  )
}

export function ProgressBar({ value, className }: { value?: number; className?: string }): React.JSX.Element {
  return (
    <div className={cn('relative h-1 overflow-hidden rounded-full bg-white/[0.08]', className)}>
      {value === undefined ? (
        <motion.div
          className="absolute inset-y-0 w-1/3 rounded-full bg-grad"
          animate={{ left: ['-35%', '105%'] }}
          transition={{ duration: 1.3, repeat: Infinity, ease: 'easeInOut' }}
        />
      ) : (
        <motion.div className="h-full rounded-full bg-grad" animate={{ width: `${Math.max(2, value * 100)}%` }} transition={{ duration: 0.4, ease }} />
      )}
    </div>
  )
}

export function Badge({
  children,
  tone = 'default',
  className
}: {
  children: ReactNode
  tone?: 'default' | 'accent' | 'success' | 'warning' | 'danger' | 'outline'
  className?: string
}): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex h-5 items-center gap-1 rounded-md px-1.5 text-[10.5px] font-semibold tracking-wide whitespace-nowrap',
        tone === 'default' && 'bg-white/[0.07] text-fg-2',
        tone === 'accent' && 'bg-[color-mix(in_oklab,var(--accent)_18%,transparent)] text-accent',
        tone === 'success' && 'bg-success/12 text-success',
        tone === 'warning' && 'bg-warning/12 text-warning',
        tone === 'danger' && 'bg-danger/12 text-danger',
        tone === 'outline' && 'border border-line-strong text-fg-2',
        className
      )}
    >
      {children}
    </span>
  )
}

export function Kbd({ children }: { children: ReactNode }): React.JSX.Element {
  return <kbd className="rounded border border-line bg-white/[0.05] px-1 font-mono text-[10px] text-fg-3">{children}</kbd>
}

export function StatusDot({ state }: { state: 'online' | 'offline' | 'busy' | 'warn' }): React.JSX.Element {
  const color = { online: 'bg-success', offline: 'bg-fg-3', busy: 'bg-accent', warn: 'bg-warning' }[state]
  return (
    <span className="relative inline-flex size-2">
      {state !== 'offline' && <span className={cn('absolute inset-0 animate-ping rounded-full opacity-50', color)} style={{ animationDuration: '2.4s' }} />}
      <span className={cn('relative size-2 rounded-full', color)} />
    </span>
  )
}

export function Surface({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div className={cn('glass hairline rounded-2xl', className)} {...rest}>
      {children}
    </div>
  )
}

export function Divider({ className, vertical }: { className?: string; vertical?: boolean }): React.JSX.Element {
  return <div className={cn(vertical ? 'w-px self-stretch bg-line' : 'h-px w-full bg-line', className)} />
}

export function Skeleton({ className }: { className?: string }): React.JSX.Element {
  return <div className={cn('shimmer rounded-lg', className)} />
}

export function Field({
  label,
  help,
  count,
  max,
  children,
  className,
  action
}: {
  label?: ReactNode
  help?: ReactNode
  count?: number
  max?: number
  children: ReactNode
  className?: string
  action?: ReactNode
}): React.JSX.Element {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {(label || action) && (
        <div className="flex items-center justify-between gap-2">
          {label && <span className="label-caps">{label}</span>}
          {action}
        </div>
      )}
      {children}
      {(help || max !== undefined) && (
        <div className="flex items-start justify-between gap-3 text-[11px] text-fg-3">
          <span>{help}</span>
          {max !== undefined && (
            <span className={cn('tabular-nums whitespace-nowrap', (count ?? 0) > max && 'text-danger')}>
              <b className="font-semibold text-fg-2">{count ?? 0}</b> / {max}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

export function EmptyState({
  icon,
  title,
  body,
  action,
  className
}: {
  icon?: ReactNode
  title: ReactNode
  body?: ReactNode
  action?: ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease }}
      className={cn('flex flex-col items-center justify-center gap-3 py-16 text-center', className)}
    >
      {icon && (
        <div className="glass hairline grid size-12 place-items-center rounded-2xl text-fg-2 [&>svg]:size-5">{icon}</div>
      )}
      <div className="display text-[17px] font-semibold tracking-tight">{title}</div>
      {body && <p className="max-w-sm text-[12.5px] text-fg-3">{body}</p>}
      {action && <div className="mt-1">{action}</div>}
    </motion.div>
  )
}

export function Avatar({ src, name, size = 28, className }: { src?: string; name?: string; size?: number; className?: string }): React.JSX.Element {
  const initials = (name ?? '?')
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()
  return (
    <div
      className={cn('relative shrink-0 overflow-hidden rounded-full bg-grad ring-1 ring-white/15', className)}
      style={{ width: size, height: size }}
    >
      {src ? (
        <img src={src} alt="" className="size-full object-cover" draggable={false} />
      ) : (
        <span className="grid size-full place-items-center font-semibold text-white" style={{ fontSize: size * 0.38 }}>
          {initials}
        </span>
      )}
    </div>
  )
}

export function SectionTitle({ children, icon, action, className }: { children: ReactNode; icon?: ReactNode; action?: ReactNode; className?: string }): React.JSX.Element {
  return (
    <div className={cn('flex items-center justify-between gap-3', className)}>
      <h2 className="flex items-center gap-2 text-[15px] font-semibold tracking-tight text-fg">
        {icon && <span className="text-accent [&>svg]:size-4">{icon}</span>}
        {children}
      </h2>
      {action}
    </div>
  )
}
