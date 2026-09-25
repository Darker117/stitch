import { useId } from 'react'
import { cn } from '@/lib/utils'
import { LOCKUP, MARK, MARK_FILL, WORDMARK } from './logo-paths'

/** The unicorn's painted colour field, stretched over the mark as a pattern. */
function Fill({ id }: { id: string }): React.JSX.Element {
  return (
    <pattern id={id} patternUnits="userSpaceOnUse" width={MARK.w} height={MARK.h}>
      <image href={MARK_FILL} width={MARK.w} height={MARK.h} preserveAspectRatio="none" />
    </pattern>
  )
}

/** The Stitch unicorn mark in its brand colours. `size` is the height in px. */
export function LogoMark({ size = 26, className }: { size?: number; className?: string }): React.JSX.Element {
  const id = useId()
  const w = (size * MARK.w) / MARK.h
  return (
    <svg width={w} height={size} viewBox={`0 0 ${MARK.w} ${MARK.h}`} className={cn('shrink-0', className)} aria-hidden>
      <defs>
        <Fill id={id} />
      </defs>
      <path fill={`url(#${id})`} fillRule="evenodd" d={MARK.d} />
    </svg>
  )
}

/** The “stitch” wordmark. Uses currentColor so it reads on dark and light surfaces. */
export function Wordmark({ height = 16, className }: { height?: number; className?: string }): React.JSX.Element {
  return (
    <svg width={(height * WORDMARK.w) / WORDMARK.h} height={height} viewBox={`0 0 ${WORDMARK.w} ${WORDMARK.h}`} className={cn('shrink-0', className)} aria-label="stitch">
      <path fill="currentColor" fillRule="evenodd" d={WORDMARK.d} />
    </svg>
  )
}

/** Mark + wordmark lockup, proportioned like the brand artwork (the horn overhangs the “s”). `height` is the mark height. */
export function LogoLockup({ height = 40, className, ink }: { height?: number; className?: string; ink?: string }): React.JSX.Element {
  const id = useId()
  const totalW = MARK.w + LOCKUP.gap + WORDMARK.w
  const totalH = Math.max(MARK.h, LOCKUP.dy + WORDMARK.h)
  return (
    <svg width={(height * totalW) / totalH} height={height} viewBox={`0 0 ${totalW} ${totalH}`} className={cn('shrink-0', className)} aria-label="Stitch">
      <defs>
        <Fill id={id} />
      </defs>
      <path fill={`url(#${id})`} fillRule="evenodd" d={MARK.d} />
      <path transform={`translate(${MARK.w + LOCKUP.gap} ${LOCKUP.dy})`} fill={ink ?? 'currentColor'} fillRule="evenodd" d={WORDMARK.d} />
    </svg>
  )
}
