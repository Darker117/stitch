// Placeholder figures for character-sheet slots (like the reference sheet).
import type { SheetSlot } from '@shared/types'
import { cn } from '@/lib/utils'

export function Silhouette({ slot, className, dim }: { slot: SheetSlot; className?: string; dim?: boolean }): React.JSX.Element {
  const back = slot === 'back'
  const fill = back ? 'rgb(255 255 255 / 0.5)' : 'rgb(255 255 255 / 0.82)'
  const collar = 'var(--accent)'
  const common = cn('h-full w-full', dim && 'opacity-60', className)

  if (slot === 'full-body') {
    return (
      <svg viewBox="0 0 100 100" className={common}>
        <circle cx="50" cy="20" r="8" fill={fill} />
        <rect x="46" y="28.5" width="8" height="3" rx="1.5" fill={collar} />
        <path d="M38 34 Q50 30 62 34 L64 62 L36 62 Z" fill={fill} />
        <rect x="39" y="62" width="9" height="26" rx="3" fill={fill} />
        <rect x="52" y="62" width="9" height="26" rx="3" fill={fill} />
      </svg>
    )
  }

  const turn: Partial<Record<SheetSlot, number>> = {
    'three-quarter-left': -6,
    'three-quarter-right': 6,
    'profile-left': -10,
    'profile-right': 10
  }
  const dx = turn[slot] ?? 0
  const low = slot === 'low-angle'
  const high = slot === 'high-angle'
  const headY = low ? 38 : high ? 34 : 36
  const headR = low ? 11 : high ? 14 : 12.5
  const isProfile = slot === 'profile-left' || slot === 'profile-right'
  const isExpr = slot.startsWith('expr-')
  const isLight = slot.startsWith('light-')

  return (
    <svg viewBox="0 0 100 100" className={common}>
      {isLight && <circle cx={slot === 'light-rim' ? 72 : 30} cy="24" r="10" fill="var(--accent)" opacity="0.22" />}
      <path
        d={`M${24 + dx * 0.4} 86 Q${50 + dx * 0.6} ${high ? 58 : 54} ${76 + dx * 0.4} 86 Z`}
        fill={fill}
        transform={dx ? `skewX(${dx * 0.8})` : undefined}
        style={{ transformOrigin: '50% 86%' }}
      />
      {!back && !isExpr && <rect x={44 + dx * 0.3} y={headY + headR - 1} width="12" height="4" rx="2" fill={collar} />}
      <circle cx={50 + dx * 0.5} cy={headY} r={headR} fill={fill} />
      {isProfile && <path d={slot === 'profile-left' ? `M${50 + dx * 0.5 - headR - 2} ${headY} l4 -3 v6 Z` : `M${50 + dx * 0.5 + headR + 2} ${headY} l-4 -3 v6 Z`} fill={fill} />}
      {isExpr && (
        <g stroke="rgb(20 16 30 / 0.7)" strokeWidth="1.6" strokeLinecap="round" fill="none">
          <circle cx="45.5" cy={headY - 2} r="0.9" fill="rgb(20 16 30 / 0.7)" />
          <circle cx="54.5" cy={headY - 2} r="0.9" fill="rgb(20 16 30 / 0.7)" />
          {slot === 'expr-happy' && <path d={`M45 ${headY + 4} Q50 ${headY + 8} 55 ${headY + 4}`} />}
          {slot === 'expr-sad' && <path d={`M45 ${headY + 7} Q50 ${headY + 3} 55 ${headY + 7}`} />}
          {slot === 'expr-angry' && <path d={`M45 ${headY + 6} L55 ${headY + 6} M43 ${headY - 6} L48 ${headY - 4} M57 ${headY - 6} L52 ${headY - 4}`} />}
          {slot === 'expr-surprised' && <circle cx="50" cy={headY + 5} r="2.2" />}
          {slot === 'expr-neutral' && <path d={`M46 ${headY + 5} L54 ${headY + 5}`} />}
        </g>
      )}
    </svg>
  )
}
