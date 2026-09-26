// Dialogs, popovers, menus, selects and tooltips — Radix behaviour, Stitch look.
import { createContext, useContext, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Dialog as D, DropdownMenu as M, Popover as P, Select as S, Tooltip as T } from 'radix-ui'
import { Check, ChevronDown, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ease, springSoft } from '@/lib/motion'
import { useCompact } from '@/lib/platform'

// ─── Dialog ──────────────────────────────────────────────────────────────────

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  className,
  width = 520,
  hideClose,
  headerAction
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title?: ReactNode
  description?: ReactNode
  children: ReactNode
  footer?: ReactNode
  className?: string
  width?: number
  hideClose?: boolean
  headerAction?: ReactNode
}): React.JSX.Element {
  // Phone width: the dialog becomes a bottom sheet.
  const compact = useCompact()
  const motionProps = compact
    ? {
        style: { width: '100%' },
        initial: { y: '100%' },
        animate: { y: 0 },
        exit: { y: '100%' },
        transition: { type: 'spring' as const, stiffness: 380, damping: 38, mass: 0.9 }
      }
    : {
        style: { width, x: '-50%', y: '-50%' },
        initial: { opacity: 0, scale: 0.95, y: 'calc(-50% + 12px)' },
        animate: { opacity: 1, scale: 1, y: '-50%' },
        exit: { opacity: 0, scale: 0.97, y: 'calc(-50% + 6px)' },
        transition: springSoft
      }
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open && (
          <D.Portal forceMount>
            <D.Overlay asChild forceMount>
              <motion.div
                className="fixed inset-0 z-50 bg-black/55 backdrop-blur-[6px]"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.25, ease }}
              />
            </D.Overlay>
            <D.Content asChild forceMount aria-describedby={undefined}>
              <motion.div
                className={cn(
                  compact
                    ? 'glass-strong fixed inset-x-0 bottom-0 z-50 flex max-h-[92vh] flex-col overflow-hidden rounded-t-[24px] border-b-0 pb-[var(--sab,0px)] shadow-[0_-30px_80px_-20px_rgb(0_0_0/0.8)] outline-none'
                    : 'glass-strong fixed top-1/2 left-1/2 z-50 flex max-h-[86vh] max-w-[calc(100vw-48px)] flex-col overflow-hidden rounded-[20px] shadow-[var(--shadow-pop)] outline-none',
                  className
                )}
                {...motionProps}
              >
                {compact && <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-white/20" />}
                {(title || !hideClose) && (
                  <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
                    <div className="min-w-0">
                      {title && <D.Title className="text-[15px] font-semibold tracking-tight">{title}</D.Title>}
                      {description && <D.Description className="mt-0.5 text-[12px] text-fg-3">{description}</D.Description>}
                    </div>
                    <div className="flex items-center gap-2">
                      {headerAction}
                      {!hideClose && (
                        <D.Close className="grid size-7 place-items-center rounded-lg text-fg-3 transition hover:bg-white/10 hover:text-fg">
                          <X className="size-4" />
                        </D.Close>
                      )}
                    </div>
                  </div>
                )}
                <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
                {footer && <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3.5">{footer}</div>}
              </motion.div>
            </D.Content>
          </D.Portal>
        )}
      </AnimatePresence>
    </D.Root>
  )
}

// ─── Popover ─────────────────────────────────────────────────────────────────

export function Popover({
  trigger,
  children,
  side = 'bottom',
  align = 'start',
  open,
  onOpenChange,
  className,
  sideOffset = 8
}: {
  trigger: ReactNode
  children: ReactNode
  side?: 'top' | 'bottom' | 'left' | 'right'
  align?: 'start' | 'center' | 'end'
  open?: boolean
  onOpenChange?: (o: boolean) => void
  className?: string
  sideOffset?: number
}): React.JSX.Element {
  return (
    <P.Root open={open} onOpenChange={onOpenChange}>
      <P.Trigger asChild>{trigger}</P.Trigger>
      <P.Portal>
        <P.Content side={side} align={align} sideOffset={sideOffset} collisionPadding={12} className="z-50 outline-none">
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: side === 'top' ? 6 : -6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            transition={springSoft}
            className={cn('glass-strong max-w-[calc(100vw-24px)] rounded-2xl p-1.5 shadow-[var(--shadow-pop)]', className)}
            style={{ transformOrigin: 'var(--radix-popover-content-transform-origin)' }}
          >
            {children}
          </motion.div>
        </P.Content>
      </P.Portal>
    </P.Root>
  )
}

export const PopoverClose = P.Close

// ─── Dropdown menu ───────────────────────────────────────────────────────────

export function Menu({
  trigger,
  children,
  align = 'start',
  side = 'bottom',
  className
}: {
  trigger: ReactNode
  children: ReactNode
  align?: 'start' | 'center' | 'end'
  side?: 'top' | 'bottom' | 'left' | 'right'
  className?: string
}): React.JSX.Element {
  return (
    <M.Root>
      <M.Trigger asChild>{trigger}</M.Trigger>
      <M.Portal>
        <M.Content align={align} side={side} sideOffset={6} collisionPadding={12} className="z-50 outline-none">
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            transition={springSoft}
            className={cn('glass-strong max-w-[calc(100vw-24px)] min-w-[200px] rounded-xl p-1 shadow-[var(--shadow-pop)]', className)}
            style={{ transformOrigin: 'var(--radix-dropdown-menu-content-transform-origin)' }}
          >
            {children}
          </motion.div>
        </M.Content>
      </M.Portal>
    </M.Root>
  )
}

export function MenuItem({
  icon,
  children,
  onSelect,
  danger,
  hint,
  disabled,
  right
}: {
  icon?: ReactNode
  children: ReactNode
  onSelect?: () => void
  danger?: boolean
  hint?: ReactNode
  disabled?: boolean
  right?: ReactNode
}): React.JSX.Element {
  return (
    <M.Item
      disabled={disabled}
      onSelect={onSelect}
      className={cn(
        'flex h-8.5 cursor-default items-center gap-2.5 rounded-lg px-2.5 text-[12.5px] outline-none transition-colors data-[disabled]:opacity-40 data-[highlighted]:bg-white/[0.08]',
        danger ? 'text-danger' : 'text-fg'
      )}
    >
      {icon && <span className={cn('grid size-4 place-items-center [&>svg]:size-3.5', danger ? 'text-danger' : 'text-fg-2')}>{icon}</span>}
      <span className="flex-1">{children}</span>
      {hint && <span className="text-[11px] text-fg-3">{hint}</span>}
      {right}
    </M.Item>
  )
}

export function MenuLabel({ children }: { children: ReactNode }): React.JSX.Element {
  return <M.Label className="label-caps px-2.5 pt-2 pb-1">{children}</M.Label>
}

export function MenuSeparator(): React.JSX.Element {
  return <M.Separator className="my-1 h-px bg-line" />
}

export function MenuCheck({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }): React.JSX.Element {
  return (
    <M.CheckboxItem
      checked={checked}
      onCheckedChange={(v) => onChange(v === true)}
      onSelect={(e) => e.preventDefault()}
      className="flex h-8.5 cursor-default items-center gap-2.5 rounded-lg px-2.5 text-[12.5px] outline-none data-[highlighted]:bg-white/[0.08]"
    >
      <span className={cn('grid size-4 place-items-center rounded border transition', checked ? 'border-transparent bg-accent text-accent-fg' : 'border-line-strong')}>
        {checked && <Check className="size-3" strokeWidth={3} />}
      </span>
      {children}
    </M.CheckboxItem>
  )
}

// ─── Select ──────────────────────────────────────────────────────────────────

export interface SelectOption {
  value: string
  label: ReactNode
  hint?: ReactNode
  icon?: ReactNode
  disabled?: boolean
}

export function Select({
  value,
  onChange,
  options,
  placeholder = 'Select…',
  className,
  size = 'md',
  triggerIcon,
  align = 'start'
}: {
  value: string | undefined
  onChange: (v: string) => void
  options: SelectOption[]
  placeholder?: string
  className?: string
  size?: 'sm' | 'md'
  triggerIcon?: ReactNode
  align?: 'start' | 'center' | 'end'
}): React.JSX.Element {
  const current = options.find((o) => o.value === value)
  return (
    <S.Root value={value ?? ''} onValueChange={onChange}>
      <S.Trigger
        className={cn(
          'group inline-flex w-full min-w-0 items-center gap-2 rounded-[10px] border border-line bg-white/[0.035] px-3 text-left text-fg outline-none transition-[border-color,background] duration-200 hover:border-line-strong hover:bg-white/[0.06] data-[state=open]:border-line-strong',
          size === 'md' ? 'h-9 text-[13px]' : 'h-7.5 text-[12px]',
          className
        )}
      >
        {triggerIcon && <span className="text-fg-3 [&>svg]:size-3.5">{triggerIcon}</span>}
        {current?.icon && <span className="[&>svg]:size-3.5">{current.icon}</span>}
        <span className={cn('min-w-0 flex-1 truncate', !current && 'text-fg-3')}>{current?.label ?? placeholder}</span>
        <ChevronDown className="size-3.5 shrink-0 text-fg-3 transition-transform duration-300 group-data-[state=open]:rotate-180" />
      </S.Trigger>
      <S.Portal>
        <S.Content position="popper" sideOffset={6} align={align} collisionPadding={12} className="z-50 outline-none">
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={springSoft}
            className="glass-strong max-h-[var(--radix-select-content-available-height)] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-xl shadow-[var(--shadow-pop)]"
            style={{ transformOrigin: 'var(--radix-select-content-transform-origin)' }}
          >
            <S.Viewport className="max-h-[360px] p-1">
              {options.map((o) => (
                <S.Item
                  key={o.value}
                  value={o.value}
                  disabled={o.disabled}
                  className="relative flex min-h-8.5 cursor-default items-center gap-2 rounded-lg py-1.5 pr-8 pl-2.5 text-[12.5px] text-fg outline-none data-[disabled]:opacity-40 data-[highlighted]:bg-white/[0.08]"
                >
                  {o.icon && <span className="text-fg-2 [&>svg]:size-3.5">{o.icon}</span>}
                  <div className="min-w-0 flex-1">
                    <S.ItemText>{o.label}</S.ItemText>
                    {o.hint && <div className="truncate text-[11px] text-fg-3">{o.hint}</div>}
                  </div>
                  <S.ItemIndicator className="absolute right-2.5">
                    <Check className="size-3.5 text-accent" />
                  </S.ItemIndicator>
                </S.Item>
              ))}
            </S.Viewport>
          </motion.div>
        </S.Content>
      </S.Portal>
    </S.Root>
  )
}

// ─── Tooltip ─────────────────────────────────────────────────────────────────

const TooltipReady = createContext(false)

export function TooltipProvider({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <T.Provider delayDuration={350} skipDelayDuration={200}>
      <TooltipReady.Provider value>{children}</TooltipReady.Provider>
    </T.Provider>
  )
}

export function Tooltip({ content, children, side = 'top' }: { content: ReactNode; children: ReactNode; side?: 'top' | 'bottom' | 'left' | 'right' }): React.JSX.Element {
  const ready = useContext(TooltipReady)
  if (!ready || !content) return <>{children}</>
  return (
    <T.Root>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content side={side} sideOffset={6} className="z-[60]">
          <motion.div
            initial={{ opacity: 0, y: side === 'top' ? 3 : -3, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 0.18, ease }}
            className="rounded-lg border border-line-strong bg-[color-mix(in_oklab,var(--panel-solid)_95%,transparent)] px-2 py-1 text-[11.5px] text-fg shadow-xl backdrop-blur"
          >
            {content}
          </motion.div>
        </T.Content>
      </T.Portal>
    </T.Root>
  )
}
