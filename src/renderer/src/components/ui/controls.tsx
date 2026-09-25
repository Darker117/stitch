// Switch, slider, tabs and segmented controls.
import { useId, type ReactNode } from 'react'
import { motion } from 'motion/react'
import { Slider as RS, Switch as RSw } from 'radix-ui'
import { cn } from '@/lib/utils'
import { spring, springSnappy } from '@/lib/motion'

export function Switch({ checked, onChange, disabled, size = 'md' }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; size?: 'sm' | 'md' }): React.JSX.Element {
  const w = size === 'md' ? 38 : 30
  const h = size === 'md' ? 22 : 18
  const k = h - 6
  return (
    <RSw.Root
      checked={checked}
      onCheckedChange={onChange}
      disabled={disabled}
      className={cn(
        'relative shrink-0 rounded-full border transition-colors duration-300 disabled:opacity-40',
        checked ? 'border-transparent bg-grad' : 'border-line-strong bg-white/[0.08]'
      )}
      style={{ width: w, height: h }}
    >
      <RSw.Thumb asChild>
        <motion.span
          className="absolute top-[2px] left-[2px] block rounded-full bg-white shadow-[0_2px_6px_rgb(0_0_0/0.35)]"
          style={{ width: k, height: k }}
          animate={{ x: checked ? w - k - 6 : 0 }}
          transition={springSnappy}
        />
      </RSw.Thumb>
    </RSw.Root>
  )
}

export function Slider({
  value,
  onChange,
  min = 0,
  max = 100,
  step = 1,
  className,
  disabled
}: {
  value: number
  onChange: (v: number) => void
  min?: number
  max?: number
  step?: number
  className?: string
  disabled?: boolean
}): React.JSX.Element {
  return (
    <RS.Root
      value={[value]}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      onValueChange={(v) => onChange(v[0])}
      className={cn('relative flex h-5 w-full touch-none items-center select-none', className)}
    >
      <RS.Track className="relative h-[3px] grow overflow-hidden rounded-full bg-white/[0.1]">
        <RS.Range className="absolute h-full rounded-full bg-grad" />
      </RS.Track>
      <RS.Thumb className="block size-4 rounded-full bg-white shadow-[0_2px_10px_rgb(0_0_0/0.4),0_0_0_4px_color-mix(in_oklab,var(--accent)_22%,transparent)] transition-transform duration-150 outline-none hover:scale-110 focus-visible:scale-110" />
    </RS.Root>
  )
}

/** Labelled slider row with value readout and reset, like AI Dungeon's settings. */
export function SliderField({
  label,
  help,
  value,
  onChange,
  min,
  max,
  step,
  defaultValue,
  format
}: {
  label: ReactNode
  help?: ReactNode
  value: number
  onChange: (v: number) => void
  min: number
  max: number
  step?: number
  defaultValue?: number
  format?: (v: number) => string
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      <div>
        <div className="label-caps">{label}</div>
        {help && <div className="mt-1 text-[12px] font-medium text-fg-2">{help}</div>}
      </div>
      <div className="flex items-center justify-between text-[12.5px]">
        <span className="font-semibold tabular-nums">{format ? format(value) : value}</span>
        {defaultValue !== undefined && value !== defaultValue && (
          <button className="text-[11px] font-semibold tracking-wide text-accent uppercase hover:brightness-125" onClick={() => onChange(defaultValue)}>
            Reset ({format ? format(defaultValue) : defaultValue})
          </button>
        )}
      </div>
      <Slider value={value} onChange={onChange} min={min} max={max} step={step} />
    </div>
  )
}

export function SwitchRow({ label, help, checked, onChange, disabled }: { label: ReactNode; help?: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }): React.JSX.Element {
  return (
    <label className={cn('flex cursor-default items-start justify-between gap-4', disabled && 'opacity-50')}>
      <div className="min-w-0">
        <div className="label-caps">{label}</div>
        {help && <div className="mt-1 text-[12px] leading-snug font-medium text-fg-2">{help}</div>}
      </div>
      <Switch checked={checked} onChange={onChange} disabled={disabled} />
    </label>
  )
}

export interface TabItem<T extends string> {
  value: T
  label: ReactNode
  icon?: ReactNode
  count?: number
}

/** Underlined tabs (Explore / My skills). The indicator glides between tabs. */
export function Tabs<T extends string>({ value, onChange, items, className }: { value: T; onChange: (v: T) => void; items: TabItem<T>[]; className?: string }): React.JSX.Element {
  const id = useId()
  return (
    <div className={cn('flex items-center gap-1 border-b border-line', className)}>
      {items.map((it) => (
        <button
          key={it.value}
          onClick={() => onChange(it.value)}
          className={cn('relative flex h-9 items-center gap-1.5 px-2.5 text-[13px] font-medium transition-colors duration-200', value === it.value ? 'text-fg' : 'text-fg-3 hover:text-fg-2')}
        >
          {it.icon && <span className="[&>svg]:size-3.5">{it.icon}</span>}
          {it.label}
          {it.count !== undefined && <span className="text-[11px] text-fg-3 tabular-nums">{it.count}</span>}
          {value === it.value && (
            <motion.span layoutId={`tab-${id}`} className="absolute inset-x-1.5 -bottom-px h-[2px] rounded-full bg-grad" transition={spring} />
          )}
        </button>
      ))}
    </div>
  )
}

/** Pill segmented control (PLOT / STORY CARDS / DETAILS). */
export function Segmented<T extends string>({
  value,
  onChange,
  items,
  className,
  size = 'md',
  caps
}: {
  value: T
  onChange: (v: T) => void
  items: TabItem<T>[]
  className?: string
  size?: 'sm' | 'md'
  caps?: boolean
}): React.JSX.Element {
  const id = useId()
  return (
    <div className={cn('inline-flex items-center gap-1 rounded-xl border border-line bg-white/[0.03] p-1', className)}>
      {items.map((it) => {
        const active = value === it.value
        return (
          <button
            key={it.value}
            onClick={() => onChange(it.value)}
            className={cn(
              'relative flex items-center gap-1.5 rounded-lg font-semibold transition-colors duration-200',
              size === 'md' ? 'h-7.5 px-3 text-[12px]' : 'h-6.5 px-2.5 text-[11.5px]',
              caps && 'tracking-wide uppercase',
              active ? 'text-fg' : 'text-fg-3 hover:text-fg-2'
            )}
          >
            {active && (
              <motion.span
                layoutId={`seg-${id}`}
                className="absolute inset-0 rounded-lg border border-line-strong bg-white/[0.1] shadow-[inset_0_1px_0_rgb(255_255_255/0.08)]"
                transition={spring}
              />
            )}
            <span className="relative flex items-center gap-1.5 [&>svg]:size-3.5">
              {it.icon}
              {it.label}
              {it.count !== undefined && (
                <span className="ml-0.5 rounded-md bg-white/10 px-1.5 text-[10.5px] tabular-nums text-fg-2">{it.count}</span>
              )}
            </span>
          </button>
        )
      })}
    </div>
  )
}

/** Radio-card list (Story / Multiple Choice / Character Creator). */
export function RadioCards<T extends string>({
  value,
  onChange,
  items
}: {
  value: T
  onChange: (v: T) => void
  items: { value: T; title: ReactNode; description?: ReactNode; icon?: ReactNode; group?: string }[]
}): React.JSX.Element {
  let lastGroup: string | undefined
  return (
    <div className="flex flex-col gap-2">
      {items.map((it) => {
        const header = it.group && it.group !== lastGroup ? it.group : null
        lastGroup = it.group
        const active = value === it.value
        return (
          <div key={it.value}>
            {header && <div className="label-caps mt-2 mb-2 first:mt-0">{header}</div>}
            <motion.button
              whileTap={{ scale: 0.99 }}
              onClick={() => onChange(it.value)}
              className={cn(
                'flex w-full items-center gap-4 rounded-xl border px-4 py-3.5 text-left transition-[background,border-color] duration-200',
                active ? 'border-[color-mix(in_oklab,var(--accent)_45%,transparent)] bg-[color-mix(in_oklab,var(--accent)_8%,transparent)]' : 'border-line bg-white/[0.03] hover:bg-white/[0.06]'
              )}
            >
              {it.icon && <span className="text-fg-2 [&>svg]:size-5">{it.icon}</span>}
              <div className="min-w-0 flex-1">
                <div className="font-serif text-[16px] font-semibold">{it.title}</div>
                {it.description && <div className="mt-0.5 text-[12px] font-medium text-fg-2">{it.description}</div>}
              </div>
              <span className={cn('grid size-6 place-items-center rounded-full border transition-all duration-300', active ? 'border-transparent bg-grad' : 'border-line-strong')}>
                <motion.svg viewBox="0 0 24 24" className="size-3.5 text-white" initial={false} animate={{ opacity: active ? 1 : 0, scale: active ? 1 : 0.5 }}>
                  <path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                </motion.svg>
              </span>
            </motion.button>
          </div>
        )
      })}
    </div>
  )
}
