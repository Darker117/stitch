// Shared motion presets so every surface moves the same way.
import type { Transition, Variants } from 'motion/react'

export const ease = [0.22, 1, 0.36, 1] as const
export const easeInOut = [0.65, 0, 0.35, 1] as const

export const spring: Transition = { type: 'spring', stiffness: 420, damping: 34, mass: 0.8 }
export const springSoft: Transition = { type: 'spring', stiffness: 260, damping: 30, mass: 0.9 }
export const springSnappy: Transition = { type: 'spring', stiffness: 620, damping: 38 }

export const fade: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.35, ease } },
  exit: { opacity: 0, transition: { duration: 0.18, ease } }
}

/**
 * Page enter/exit — opacity, a few pixels of travel and a whisper of blur.
 * The filter is cleared once the page has entered: any lingering `filter`
 * (even blur(0px)) turns the page into a backdrop root and switches off
 * backdrop-filter glass inside it (frosted sticky headers, pills).
 */
export const page: Variants = {
  initial: { opacity: 0, y: 10, filter: 'blur(6px)' },
  animate: { opacity: 1, y: 0, filter: 'blur(0px)', transition: { duration: 0.45, ease }, transitionEnd: { filter: 'none' } },
  exit: { opacity: 0, y: -6, filter: 'blur(4px)', transition: { duration: 0.2, ease } }
}

export const pop: Variants = {
  initial: { opacity: 0, scale: 0.96, y: 6 },
  animate: { opacity: 1, scale: 1, y: 0, transition: springSoft },
  exit: { opacity: 0, scale: 0.97, y: 4, transition: { duration: 0.15, ease } }
}

export const stagger = (delay = 0.035, start = 0.04): Variants => ({
  animate: { transition: { staggerChildren: delay, delayChildren: start } }
})

export const rise: Variants = {
  initial: { opacity: 0, y: 14 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.5, ease } }
}
