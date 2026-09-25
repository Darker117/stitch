// Glowing dotted sphere (canvas). Colours follow the live accent tokens:
// accent-2 at the top fading through to accent at the bottom, like a sunset.
import { useEffect, useRef } from 'react'
import { hexToRgb, type RGB } from '@shared/theme'
import { cn } from '@/lib/utils'

export type OrbState = 'idle' | 'thinking' | 'listening' | 'generating'

interface Point {
  x: number
  y: number
  z: number
  seed: number
}

function fibonacciSphere(n: number): Point[] {
  const pts: Point[] = []
  const golden = Math.PI * (3 - Math.sqrt(5))
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2
    const r = Math.sqrt(1 - y * y)
    const t = golden * i
    pts.push({ x: Math.cos(t) * r, y, z: Math.sin(t) * r, seed: Math.random() * Math.PI * 2 })
  }
  return pts
}

/** Accepts #hex or rgb()/rgba() — registered colour props compute to rgb(). */
function parseColor(v: string, fallback: string): RGB {
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(v)
  if (m) return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) }
  return hexToRgb(v.startsWith('#') ? v : fallback)
}

function readColors(): { a: RGB; b: RGB } {
  const cs = getComputedStyle(document.documentElement)
  return { a: parseColor(cs.getPropertyValue('--accent-2').trim(), '#8c84e6'), b: parseColor(cs.getPropertyValue('--accent').trim(), '#f08a6c') }
}

function mix(a: RGB, b: RGB, t: number): RGB {
  return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t }
}

export function Orb({ size = 132, state = 'idle', className, density = 1 }: { size?: number; state?: OrbState; className?: string; density?: number }): React.JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null)
  const stateRef = useRef(state)
  stateRef.current = state

  useEffect(() => {
    const el = canvas.current!
    const ctx = el.getContext('2d')!
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const pad = size * 0.18
    const full = size + pad * 2
    el.width = full * dpr
    el.height = full * dpr
    ctx.scale(dpr, dpr)

    const points = fibonacciSphere(Math.round(900 * density))
    // Re-read the (possibly transitioning) accent colours a few times a second.
    let colors = readColors()
    let frameNo = 0

    let raf = 0
    let last = performance.now()
    let rotY = 0
    let energy = 0 // eases towards the target for the current state
    let visible = true
    const io = new IntersectionObserver(([e]) => (visible = e.isIntersecting))
    io.observe(el)

    const frame = (now: number): void => {
      raf = requestAnimationFrame(frame)
      if (!visible) return
      if (++frameNo % 12 === 0) colors = readColors()
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      const s = stateRef.current
      const target = s === 'idle' ? 0 : s === 'listening' ? 0.55 : s === 'thinking' ? 0.8 : 1
      energy += (target - energy) * Math.min(1, dt * 3)
      rotY += dt * (0.32 + energy * 0.9)
      const t = now / 1000
      const tilt = Math.sin(t * 0.35) * 0.18 + 0.28
      const cy = Math.cos(rotY)
      const sy = Math.sin(rotY)
      const cx = Math.cos(tilt)
      const sx = Math.sin(tilt)
      const R = size / 2
      const c = full / 2
      const breathe = 1 + Math.sin(t * 1.4) * 0.012 + energy * Math.sin(t * 6) * 0.02

      ctx.clearRect(0, 0, full, full)
      ctx.globalCompositeOperation = 'lighter'
      for (const p of points) {
        // Surface ripple — stronger while the model is busy.
        const wave = 1 + Math.sin(p.y * 7 + t * (1.2 + energy * 4) + p.seed * 0.3) * (0.018 + energy * 0.05)
        const x0 = p.x * wave
        const y0 = p.y * wave
        const z0 = p.z * wave
        const x1 = x0 * cy + z0 * sy
        const z1 = -x0 * sy + z0 * cy
        const y2 = y0 * cx - z1 * sx
        const z2 = y0 * sx + z1 * cx
        const persp = 2.6 / (2.6 - z2)
        const px = c + x1 * R * persp * breathe
        const py = c + y2 * R * persp * breathe
        const depth = (z2 + 1) / 2 // 0 back … 1 front
        const alpha = 0.08 + depth * depth * 0.85
        const rad = (0.45 + depth * 1.15) * (size / 132)
        const col = mix(colors.a, colors.b, (p.y + 1) / 2)
        const lift = 0.35 + depth * 0.65
        ctx.fillStyle = `rgba(${Math.round(col.r * lift + 255 * (1 - lift) * 0.35)},${Math.round(col.g * lift + 255 * (1 - lift) * 0.35)},${Math.round(col.b * lift + 255 * (1 - lift) * 0.35)},${alpha})`
        ctx.beginPath()
        ctx.arc(px, py, rad, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.globalCompositeOperation = 'source-over'
    }
    raf = requestAnimationFrame(frame)
    return () => {
      cancelAnimationFrame(raf)
      io.disconnect()
    }
  }, [size, density])

  const full = size * 1.36
  return (
    <div className={cn('relative grid place-items-center', className)} style={{ width: full, height: full }}>
      <div
        className="absolute rounded-full opacity-70 blur-2xl transition-[transform,opacity] duration-1000"
        style={{
          width: size * 0.9,
          height: size * 0.9,
          background: 'radial-gradient(circle at 50% 35%, color-mix(in oklab, var(--accent-2) 55%, transparent), color-mix(in oklab, var(--accent) 40%, transparent) 60%, transparent 75%)',
          transform: `scale(${state === 'idle' ? 1 : 1.18})`,
          opacity: state === 'idle' ? 0.55 : 0.85
        }}
      />
      <canvas ref={canvas} className="relative" style={{ width: full, height: full }} />
    </div>
  )
}
