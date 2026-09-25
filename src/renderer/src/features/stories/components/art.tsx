// Illustration pieces for Stories: the flame mark, template art and covers.
import { useId, useMemo } from 'react'
import {
  BookOpen,
  Building2,
  Castle,
  CloudLightning,
  Cpu,
  Crown,
  Dices,
  Feather,
  Fingerprint,
  Flame,
  Ghost,
  KeyRound,
  type LucideIcon,
  Moon,
  PenLine,
  Radiation,
  Search,
  Shield,
  Skull,
  Sparkles,
  Sword,
  Syringe,
  Wand,
  Zap
} from 'lucide-react'
import type { ID } from '@shared/types'
import { fileUrl } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useDoc } from '@/stores/db'

// ─── Flame mark ──────────────────────────────────────────────────────────────

/** The adventure mark: a stitched flame in the accent gradient. */
export function FlameMark({ size = 28, className, animate = false }: { size?: number; className?: string; animate?: boolean }): React.JSX.Element {
  const id = useId()
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className={cn('shrink-0 overflow-visible', className)}>
      <defs>
        <linearGradient id={`${id}-o`} x1="32" y1="4" x2="32" y2="60" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="var(--accent-2)" />
          <stop offset="0.6" stopColor="color-mix(in oklab, var(--accent-2) 35%, var(--accent))" />
          <stop offset="1" stopColor="var(--accent)" />
        </linearGradient>
        <linearGradient id={`${id}-i`} x1="32" y1="28" x2="32" y2="58" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#fff" stopOpacity="0.95" />
          <stop offset="1" stopColor="#fff" stopOpacity="0.55" />
        </linearGradient>
        <filter id={`${id}-g`} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="3.2" />
        </filter>
      </defs>
      <path
        d="M33 3c1.6 10.6 13.8 16.8 15.5 29.6C50.3 46.8 42 59 32 59S13.6 49.5 14.3 38.4c.5-7.4 4.5-11.8 8.6-15.5-.2 6 2.4 9.6 5.4 10.6C26 23.5 28.5 11.4 33 3Z"
        fill={`url(#${id}-o)`}
        opacity="0.55"
        filter={`url(#${id}-g)`}
        className={animate ? 'st-flicker' : undefined}
      />
      <path d="M33 3c1.6 10.6 13.8 16.8 15.5 29.6C50.3 46.8 42 59 32 59S13.6 49.5 14.3 38.4c.5-7.4 4.5-11.8 8.6-15.5-.2 6 2.4 9.6 5.4 10.6C26 23.5 28.5 11.4 33 3Z" fill={`url(#${id}-o)`} />
      <path
        d="M32.6 27.5c.9 6.2 8.7 9 8.7 17.4 0 6.4-4.3 10.6-9.3 10.6s-9.3-3.7-9.3-9.4c0-4.4 2.4-6.8 4.9-8.8.3 3.2 1.7 4.8 3.4 5.2-1-5.6.4-10.3 1.6-15Z"
        fill={`url(#${id}-i)`}
        className={animate ? 'st-flicker-inner' : undefined}
        style={{ transformOrigin: '32px 56px' }}
      />
      <g stroke="#fff" strokeOpacity="0.7" strokeWidth="1.8" strokeLinecap="round">
        <path d="M20.5 41.5l3.2-1.4" />
        <path d="M40.6 40.2l3.2 1.4" />
      </g>
    </svg>
  )
}

// ─── Template art ────────────────────────────────────────────────────────────

type Pattern = 'stars' | 'grid' | 'rain' | 'embers' | 'fog' | 'dots' | 'none'

interface ArtDef {
  main: LucideIcon
  bits: { icon: LucideIcon; x: number; y: number; s: number; r: number; o: number }[]
  bg: string
  glow: string
  pattern: Pattern
}

const ART: Record<string, ArtDef> = {
  random: {
    main: Dices,
    bits: [
      { icon: Sparkles, x: 26, y: 30, s: 22, r: -12, o: 0.55 },
      { icon: Castle, x: 74, y: 28, s: 20, r: 8, o: 0.35 },
      { icon: Skull, x: 13, y: 56, s: 18, r: 10, o: 0.3 },
      { icon: Cpu, x: 86, y: 58, s: 20, r: -8, o: 0.35 }
    ],
    bg: 'radial-gradient(90% 90% at 50% 100%, color-mix(in oklab, var(--sunset-3) 45%, transparent), transparent 70%), linear-gradient(150deg, #231c3d 0%, #120f20 60%, #0b0914 100%)',
    glow: 'var(--sunset-2)',
    pattern: 'dots'
  },
  empty: {
    main: PenLine,
    bits: [
      { icon: Feather, x: 72, y: 30, s: 20, r: 18, o: 0.35 },
      { icon: BookOpen, x: 18, y: 36, s: 20, r: -8, o: 0.3 }
    ],
    bg: 'radial-gradient(70% 80% at 50% 50%, rgb(255 255 255 / 0.06), transparent 70%), linear-gradient(160deg, #1a1822 0%, #0e0d13 100%)',
    glow: '#b8b3c9',
    pattern: 'grid'
  },
  fantasy: {
    main: Castle,
    bits: [
      { icon: Moon, x: 76, y: 24, s: 20, r: -20, o: 0.6 },
      { icon: Sword, x: 22, y: 36, s: 20, r: -35, o: 0.4 },
      { icon: Crown, x: 13, y: 58, s: 18, r: 12, o: 0.35 },
      { icon: Wand, x: 87, y: 58, s: 18, r: 20, o: 0.35 }
    ],
    bg: 'radial-gradient(80% 70% at 50% 110%, color-mix(in oklab, var(--sunset-4) 55%, transparent), transparent 70%), linear-gradient(170deg, #2a2352 0%, #1b1535 50%, #0d0a18 100%)',
    glow: 'var(--sunset-4)',
    pattern: 'stars'
  },
  mystery: {
    main: Search,
    bits: [
      { icon: Fingerprint, x: 24, y: 30, s: 22, r: -10, o: 0.35 },
      { icon: KeyRound, x: 85, y: 58, s: 18, r: 30, o: 0.4 },
      { icon: Moon, x: 78, y: 26, s: 16, r: 0, o: 0.3 }
    ],
    bg: 'radial-gradient(70% 60% at 30% 20%, color-mix(in oklab, var(--sunset-1) 40%, transparent), transparent 70%), linear-gradient(175deg, #141a2c 0%, #0c0f1a 60%, #07080e 100%)',
    glow: 'var(--sunset-1)',
    pattern: 'rain'
  },
  zombie: {
    main: Skull,
    bits: [
      { icon: Syringe, x: 24, y: 32, s: 18, r: -30, o: 0.35 },
      { icon: Ghost, x: 76, y: 30, s: 20, r: 10, o: 0.3 },
      { icon: Radiation, x: 86, y: 60, s: 16, r: 0, o: 0.3 }
    ],
    bg: 'radial-gradient(80% 60% at 50% 110%, color-mix(in oklab, var(--sunset-6) 55%, transparent), transparent 70%), linear-gradient(170deg, #1d1a1c 0%, #140f12 55%, #0a0709 100%)',
    glow: 'var(--sunset-6)',
    pattern: 'fog'
  },
  cyberpunk: {
    main: Cpu,
    bits: [
      { icon: Building2, x: 14, y: 50, s: 24, r: 0, o: 0.35 },
      { icon: Zap, x: 76, y: 28, s: 20, r: 12, o: 0.5 },
      { icon: Building2, x: 87, y: 58, s: 18, r: 0, o: 0.25 }
    ],
    bg: 'radial-gradient(70% 60% at 80% 0%, color-mix(in oklab, var(--sunset-2) 50%, transparent), transparent 70%), radial-gradient(70% 60% at 10% 110%, color-mix(in oklab, var(--sunset-5) 45%, transparent), transparent 70%), linear-gradient(170deg, #161233 0%, #0c0a1f 100%)',
    glow: 'var(--sunset-2)',
    pattern: 'grid'
  },
  apocalyptic: {
    main: Radiation,
    bits: [
      { icon: Flame, x: 14, y: 52, s: 20, r: -6, o: 0.45 },
      { icon: CloudLightning, x: 74, y: 26, s: 22, r: 0, o: 0.4 },
      { icon: Shield, x: 86, y: 58, s: 16, r: 14, o: 0.3 }
    ],
    bg: 'radial-gradient(90% 70% at 50% 115%, color-mix(in oklab, var(--sunset-5) 60%, transparent), transparent 70%), linear-gradient(170deg, #2a1a1f 0%, #1a0f12 55%, #0c0708 100%)',
    glow: 'var(--sunset-5)',
    pattern: 'embers'
  }
}

function seeded(n: number, seed: number): number[] {
  const out: number[] = []
  let x = seed
  for (let i = 0; i < n; i++) {
    x = (x * 9301 + 49297) % 233280
    out.push(x / 233280)
  }
  return out
}

function PatternLayer({ pattern, id }: { pattern: Pattern; id: string }): React.JSX.Element | null {
  const pts = useMemo(() => seeded(80, id.length * 7 + 13), [id])
  if (pattern === 'none') return null
  return (
    <svg className="absolute inset-0 size-full" viewBox="0 0 100 60" preserveAspectRatio="xMidYMid slice" aria-hidden>
      {pattern === 'stars' &&
        pts.slice(0, 40).map((p, i) => <circle key={i} cx={p * 100} cy={pts[(i + 17) % 80] * 42} r={0.18 + pts[(i + 5) % 80] * 0.35} fill="#fff" opacity={0.25 + pts[(i + 9) % 80] * 0.6} />)}
      {pattern === 'dots' &&
        pts.slice(0, 50).map((p, i) => <circle key={i} cx={p * 100} cy={pts[(i + 23) % 80] * 60} r={0.25} fill="#fff" opacity={0.18} />)}
      {pattern === 'grid' && (
        <g stroke="#fff" strokeOpacity="0.05" strokeWidth="0.15">
          {Array.from({ length: 21 }, (_, i) => (
            <line key={`v${i}`} x1={i * 5} y1="0" x2={i * 5} y2="60" />
          ))}
          {Array.from({ length: 13 }, (_, i) => (
            <line key={`h${i}`} x1="0" y1={i * 5} x2="100" y2={i * 5} />
          ))}
        </g>
      )}
      {pattern === 'rain' && (
        <g stroke="#cfd8ff" strokeOpacity="0.12" strokeWidth="0.18" strokeLinecap="round">
          {pts.slice(0, 55).map((p, i) => {
            const x = p * 110 - 5
            const y = pts[(i + 31) % 80] * 60
            return <line key={i} x1={x} y1={y} x2={x - 1.4} y2={y + 4.5} />
          })}
        </g>
      )}
      {pattern === 'embers' &&
        pts.slice(0, 36).map((p, i) => (
          <circle key={i} cx={p * 100} cy={30 + pts[(i + 11) % 80] * 30} r={0.2 + pts[(i + 3) % 80] * 0.45} fill="var(--sunset-4)" opacity={0.25 + pts[(i + 7) % 80] * 0.55} />
        ))}
      {pattern === 'fog' && (
        <g fill="#fff">
          <ellipse cx="25" cy="52" rx="40" ry="8" opacity="0.04" />
          <ellipse cx="80" cy="56" rx="45" ry="9" opacity="0.05" />
          <ellipse cx="50" cy="60" rx="60" ry="8" opacity="0.05" />
        </g>
      )}
    </svg>
  )
}

/** Layered icon illustration on a dark sunset gradient for a template. */
export function TemplateArt({ template, className, compact }: { template?: string; className?: string; compact?: boolean }): React.JSX.Element {
  const art = ART[template ?? ''] ?? ART.empty
  const Main = art.main
  const scale = compact ? 0.7 : 1
  return (
    <div className={cn('relative isolate overflow-hidden', className)} style={{ background: art.bg }}>
      <PatternLayer pattern={art.pattern} id={template ?? 'x'} />
      <div
        className="absolute top-[44%] left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full opacity-60 blur-2xl transition-transform duration-700 ease-out group-hover:scale-125"
        style={{ width: 150 * scale, height: 150 * scale, background: `radial-gradient(circle, ${art.glow}, transparent 70%)` }}
      />
      {art.bits.map((b, i) => {
        const Icon = b.icon
        return (
          <Icon
            key={i}
            className="absolute text-white transition-transform duration-700 ease-out group-hover:scale-110"
            strokeWidth={1.4}
            style={{
              left: `${b.x}%`,
              top: `${b.y}%`,
              width: b.s * scale,
              height: b.s * scale,
              opacity: b.o,
              transform: `translate(-50%, -50%) rotate(${b.r}deg)`,
              translate: `${(b.x - 50) * 0.02}% 0`
            }}
          />
        )
      })}
      <div className="absolute top-[44%] left-1/2 -translate-x-1/2 -translate-y-1/2 transition-transform duration-500 ease-out group-hover:-translate-y-[56%] group-hover:scale-[1.06]">
        <div
          className="grid place-items-center rounded-[22px] border border-white/15 bg-white/[0.07] backdrop-blur-md"
          style={{ width: 76 * scale, height: 76 * scale, boxShadow: `0 12px 40px -8px ${art.glow}, inset 0 1px 0 rgb(255 255 255 / 0.2)` }}
        >
          <Main className="text-white" style={{ width: 34 * scale, height: 34 * scale, filter: `drop-shadow(0 0 12px ${art.glow})` }} strokeWidth={1.5} />
        </div>
      </div>
      <div className="absolute inset-0 bg-[linear-gradient(to_top,rgb(0_0_0/0.55),transparent_45%)]" />
    </div>
  )
}

/** Cover image if there is one, otherwise the template illustration. */
export function CoverArt({ coverAssetId, template, className, compact, children }: { coverAssetId?: ID; template?: string; className?: string; compact?: boolean; children?: React.ReactNode }): React.JSX.Element {
  const asset = useDoc('assets', coverAssetId)
  return (
    <div className={cn('relative overflow-hidden', className)}>
      {asset ? (
        asset.kind === 'video' ? (
          <video src={fileUrl(asset.path)} muted loop autoPlay playsInline className="absolute inset-0 size-full object-cover" />
        ) : (
          <img src={fileUrl(asset.path)} draggable={false} className="absolute inset-0 size-full object-cover transition-transform duration-700 ease-out group-hover:scale-[1.04]" />
        )
      ) : (
        <TemplateArt template={template} className="absolute inset-0" compact={compact} />
      )}
      {children}
    </div>
  )
}
