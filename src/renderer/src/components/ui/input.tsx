import { forwardRef, useEffect, useImperativeHandle, useRef, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react'
import { Search, X } from 'lucide-react'
import { cn } from '@/lib/utils'

const base =
  'w-full rounded-[10px] border border-line bg-white/[0.035] px-3 text-[13px] text-fg placeholder:text-fg-3 transition-[border-color,background,box-shadow] duration-200 outline-none hover:border-line-strong focus:border-[color-mix(in_oklab,var(--accent)_55%,transparent)] focus:bg-white/[0.05] focus:shadow-[0_0_0_4px_color-mix(in_oklab,var(--accent)_12%,transparent)] disabled:opacity-50'

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  icon?: ReactNode
  suffix?: ReactNode
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ className, icon, suffix, ...rest }, ref) {
  if (!icon && !suffix) return <input ref={ref} className={cn(base, 'h-9', className)} {...rest} />
  return (
    <div className={cn('relative flex items-center', className)}>
      {icon && <span className="pointer-events-none absolute left-2.5 text-fg-3 [&>svg]:size-3.5">{icon}</span>}
      <input ref={ref} className={cn(base, 'h-9', icon && 'pl-8', suffix && 'pr-9')} {...rest} />
      {suffix && <span className="absolute right-1.5">{suffix}</span>}
    </div>
  )
})

export function SearchField({
  value,
  onChange,
  placeholder = 'Search',
  className,
  autoFocus
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  className?: string
  autoFocus?: boolean
}): React.JSX.Element {
  return (
    <Input
      icon={<Search />}
      value={value}
      autoFocus={autoFocus}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className={className}
      suffix={
        value ? (
          <button className="grid size-6 place-items-center rounded-md text-fg-3 hover:bg-white/10 hover:text-fg" onClick={() => onChange('')}>
            <X className="size-3" />
          </button>
        ) : undefined
      }
    />
  )
}

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  autosize?: boolean
  minRows?: number
  maxRows?: number
  bare?: boolean
}

/** Textarea that grows with its content. */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, autosize = true, minRows = 3, maxRows = 16, bare, value, ...rest },
  ref
) {
  const inner = useRef<HTMLTextAreaElement>(null)
  useImperativeHandle(ref, () => inner.current!)
  useEffect(() => {
    const el = inner.current
    if (!el || !autosize) return
    const lh = parseFloat(getComputedStyle(el).lineHeight) || 20
    const pad = parseFloat(getComputedStyle(el).paddingTop) + parseFloat(getComputedStyle(el).paddingBottom)
    el.style.height = 'auto'
    const h = Math.min(Math.max(el.scrollHeight, lh * minRows + pad), lh * maxRows + pad)
    el.style.height = `${h}px`
    el.style.overflowY = el.scrollHeight > h + 1 ? 'auto' : 'hidden'
  }, [value, autosize, minRows, maxRows])
  return (
    <textarea
      ref={inner}
      value={value}
      className={cn(
        bare
          ? 'w-full resize-none bg-transparent text-[13px] text-fg outline-none placeholder:text-fg-3 focus-visible:shadow-none'
          : cn(base, 'resize-none py-2.5 leading-relaxed'),
        className
      )}
      {...rest}
    />
  )
})
