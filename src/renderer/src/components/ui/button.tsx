import { forwardRef, type ReactNode } from 'react'
import { motion, type HTMLMotionProps } from 'motion/react'
import { cn } from '@/lib/utils'
import { springSnappy } from '@/lib/motion'
import { Spinner } from './misc'

type Variant = 'primary' | 'accent' | 'secondary' | 'ghost' | 'outline' | 'danger' | 'glass'
type Size = 'xs' | 'sm' | 'md' | 'lg'

const variants: Record<Variant, string> = {
  primary:
    'bg-grad text-white shadow-[0_8px_24px_-8px_color-mix(in_oklab,var(--accent)_70%,transparent),inset_0_1px_0_rgb(255_255_255/0.25)] hover:brightness-110',
  accent: 'bg-accent text-accent-fg hover:brightness-110 shadow-[inset_0_1px_0_rgb(255_255_255/0.3)]',
  secondary: 'bg-white/[0.06] text-fg border border-line hover:bg-white/[0.1] hover:border-line-strong hairline',
  glass: 'glass text-fg hover:bg-white/[0.07] hairline',
  ghost: 'text-fg-2 hover:text-fg hover:bg-white/[0.06]',
  outline: 'border border-line-strong text-fg hover:bg-white/[0.05] hover:border-white/25',
  danger: 'bg-danger/12 text-danger border border-danger/25 hover:bg-danger/20'
}

const sizes: Record<Size, string> = {
  xs: 'h-6 px-2 text-[11px] gap-1 rounded-md',
  sm: 'h-7.5 px-2.5 text-[12px] gap-1.5 rounded-lg',
  md: 'h-9 px-3.5 text-[13px] gap-2 rounded-[10px]',
  lg: 'h-11 px-5 text-[14px] gap-2 rounded-xl'
}

export interface ButtonProps extends Omit<HTMLMotionProps<'button'>, 'children'> {
  variant?: Variant
  size?: Size
  icon?: ReactNode
  iconRight?: ReactNode
  loading?: boolean
  children?: ReactNode
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, iconRight, loading, disabled, className, children, ...rest },
  ref
) {
  return (
    <motion.button
      ref={ref}
      whileTap={disabled || loading ? undefined : { scale: 0.965 }}
      transition={springSnappy}
      disabled={disabled || loading}
      className={cn(
        'relative inline-flex shrink-0 select-none items-center justify-center font-medium whitespace-nowrap transition-[background,border-color,color,filter,box-shadow,opacity] duration-200 disabled:pointer-events-none disabled:opacity-45',
        variants[variant],
        sizes[size],
        className
      )}
      {...rest}
    >
      {loading ? <Spinner className="size-3.5" /> : icon}
      {children}
      {iconRight}
    </motion.button>
  )
})

export interface IconButtonProps extends Omit<HTMLMotionProps<'button'>, 'children'> {
  children?: ReactNode
  label: string
  size?: 'xs' | 'sm' | 'md' | 'lg'
  variant?: 'ghost' | 'glass' | 'secondary' | 'primary' | 'accent'
  active?: boolean
}

const iconSizes = { xs: 'size-6 rounded-md', sm: 'size-7 rounded-lg', md: 'size-8.5 rounded-[10px]', lg: 'size-10 rounded-full' }

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, size = 'md', variant = 'ghost', active, className, children, ...rest },
  ref
) {
  return (
    <motion.button
      ref={ref}
      aria-label={label}
      title={label}
      whileTap={{ scale: 0.9 }}
      transition={springSnappy}
      className={cn(
        'inline-flex shrink-0 items-center justify-center transition-[background,color,border-color,box-shadow] duration-200 disabled:opacity-40 disabled:pointer-events-none',
        iconSizes[size],
        variant === 'ghost' && 'text-fg-2 hover:bg-white/[0.07] hover:text-fg',
        variant === 'glass' && 'glass text-fg-2 hover:text-fg hover:bg-white/[0.08]',
        variant === 'secondary' && 'border border-line bg-white/[0.05] text-fg-2 hover:text-fg hover:bg-white/[0.09]',
        variant === 'primary' && 'bg-grad text-white shadow-[0_6px_18px_-6px_color-mix(in_oklab,var(--accent)_75%,transparent)]',
        variant === 'accent' && 'bg-accent text-accent-fg',
        active && 'bg-white/[0.1] text-fg',
        className
      )}
      {...rest}
    >
      {children}
    </motion.button>
  )
})

/** Rounded chip like “Create Image” / “Brainstorm” in the reference. */
export function Chip({
  icon,
  children,
  active,
  className,
  ...rest
}: { icon?: ReactNode; active?: boolean; children?: ReactNode } & Omit<HTMLMotionProps<'button'>, 'children'>): React.JSX.Element {
  return (
    <motion.button
      whileTap={{ scale: 0.96 }}
      transition={springSnappy}
      className={cn(
        'inline-flex h-7.5 items-center gap-1.5 rounded-lg border px-2.5 text-[12px] font-medium transition-[background,border-color,color] duration-200',
        active
          ? 'border-[color-mix(in_oklab,var(--accent)_45%,transparent)] bg-[color-mix(in_oklab,var(--accent)_14%,transparent)] text-fg'
          : 'border-line bg-white/[0.035] text-fg-2 hover:border-line-strong hover:bg-white/[0.07] hover:text-fg',
        className
      )}
      {...rest}
    >
      {icon && <span className="grid size-3.5 place-items-center [&>svg]:size-3.5">{icon}</span>}
      {children}
    </motion.button>
  )
}
