import { useId } from 'react'
import { cn } from '@/lib/utils'
import { useSettings } from '@/stores/settings'
import { LOCKUP, MARK, MARK_FILL, WORDMARK } from './logo-paths'

/** The unicorn's painted colour field, stretched over the mark as a pattern. */
function Fill({ id }: { id: string }): React.JSX.Element {
  return (
    <pattern id={id} patternUnits="userSpaceOnUse" width={MARK.w} height={MARK.h}>
      <image href={MARK_FILL} width={MARK.w} height={MARK.h} preserveAspectRatio="none" />
    </pattern>
  )
}

/** The same top-to-bottom blend, built from the live accent tokens. */
function AccentFill({ id }: { id: string }): React.JSX.Element {
  return (
    <linearGradient id={id} gradientUnits="userSpaceOnUse" x1={MARK.w * 0.4} y1={0} x2={MARK.w * 0.55} y2={MARK.h}>
      <stop offset="0" style={{ stopColor: 'var(--accent-2)' }} />
      <stop offset="0.55" style={{ stopColor: 'color-mix(in oklab, var(--accent-2) 40%, var(--accent))' }} />
      <stop offset="1" style={{ stopColor: 'var(--accent)' }} />
    </linearGradient>
  )
}

/** Wallpaper, image and video backgrounds recolour the mark with their accents. */
function useAccentMark(): boolean {
  const type = useSettings((s) => s.settings?.theme.background.type)
  return type === 'image' || type === 'video' || type === 'web'
}

const fade = { transition: 'opacity 1.2s cubic-bezier(0.22, 1, 0.36, 1)' }

/** Brand fill and accent fill stacked, cross-fading when the background changes. */
function MarkPaths({ id, accent }: { id: string; accent: boolean }): React.JSX.Element {
  return (
    <>
      <path fill={`url(#${id}-f)`} fillRule="evenodd" d={MARK.d} style={{ ...fade, opacity: accent ? 0 : 1 }} />
      <path fill={`url(#${id}-a)`} fillRule="evenodd" d={MARK.d} style={{ ...fade, opacity: accent ? 1 : 0 }} />
    </>
  )
}

function Defs({ id }: { id: string }): React.JSX.Element {
  return (
    <defs>
      <Fill id={`${id}-f`} />
      <AccentFill id={`${id}-a`} />
    </defs>
  )
}

/** The Stitch unicorn mark. `size` is the height in px. */
export function LogoMark({ size = 26, className }: { size?: number; className?: string }): React.JSX.Element {
  const id = useId()
  const accent = useAccentMark()
  const w = (size * MARK.w) / MARK.h
  return (
    <svg width={w} height={size} viewBox={`0 0 ${MARK.w} ${MARK.h}`} className={cn('shrink-0', className)} aria-hidden>
      <Defs id={id} />
      <MarkPaths id={id} accent={accent} />
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
  const accent = useAccentMark()
  const totalW = MARK.w + LOCKUP.gap + WORDMARK.w
  const totalH = Math.max(MARK.h, LOCKUP.dy + WORDMARK.h)
  return (
    <svg width={(height * totalW) / totalH} height={height} viewBox={`0 0 ${totalW} ${totalH}`} className={cn('shrink-0', className)} aria-label="Stitch">
      <Defs id={id} />
      <MarkPaths id={id} accent={accent} />
      <path transform={`translate(${MARK.w + LOCKUP.gap} ${LOCKUP.dy})`} fill={ink ?? 'currentColor'} fillRule="evenodd" d={WORDMARK.d} />
    </svg>
  )
}
