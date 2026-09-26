// Frosted sticky header for the story editors (Edit Scenario, Composer): a
// strong glass card floating over a progressive-blur band, so the page
// diffuses and fades underneath it as you scroll. Built on the theme's glass
// tokens (--panel, --panel-strong, --glass-blur) and accents, so it follows
// the palette and stays readable over wallpaper backgrounds.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { motion } from 'motion/react'
import { cn } from '@/lib/utils'
import { ease } from '@/lib/motion'

const CSS = `
.st-frost {
  background:
    linear-gradient(180deg, color-mix(in oklab, var(--panel-strong) 74%, transparent), color-mix(in oklab, var(--panel) 66%, transparent));
  -webkit-backdrop-filter: blur(calc(var(--glass-blur, 22px) + 20px)) saturate(190%) brightness(1.06);
  backdrop-filter: blur(calc(var(--glass-blur, 22px) + 20px)) saturate(190%) brightness(1.06);
  border: 1px solid var(--line-strong);
  box-shadow:
    inset 0 1px 0 rgb(255 255 255 / 0.11),
    inset 0 -1px 0 rgb(0 0 0 / 0.22),
    0 1px 2px rgb(0 0 0 / 0.25),
    0 22px 48px -30px rgb(0 0 0 / 0.9);
}
[data-bg='media'] .st-frost {
  background:
    linear-gradient(180deg, color-mix(in oklab, var(--panel-strong) 80%, transparent), color-mix(in oklab, var(--panel) 74%, transparent));
}
.st-frost-sheen {
  position: absolute; inset: 0; border-radius: inherit; pointer-events: none;
  background:
    linear-gradient(180deg, rgb(255 255 255 / 0.065), transparent 42%),
    radial-gradient(110% 120% at 0% 0%, color-mix(in oklab, var(--accent-2) 15%, transparent), transparent 55%),
    radial-gradient(90% 120% at 100% 0%, color-mix(in oklab, var(--accent) 11%, transparent), transparent 60%);
}
.st-frost-edge {
  position: absolute; top: -1px; left: 14%; right: 14%; height: 1px; pointer-events: none;
  background: linear-gradient(90deg, transparent, color-mix(in oklab, var(--accent-2) 75%, transparent) 35%, color-mix(in oklab, var(--accent) 75%, transparent) 65%, transparent);
}
.st-frost-lift {
  position: absolute; inset: 0; border-radius: inherit; pointer-events: none;
  box-shadow: 0 30px 70px -24px rgb(0 0 0 / 0.85), 0 10px 30px -18px color-mix(in oklab, var(--accent) 40%, transparent);
}
.st-frost-glow {
  position: absolute; left: 10%; right: 10%; bottom: -16px; height: 34px; pointer-events: none;
  background: radial-gradient(closest-side, color-mix(in oklab, var(--accent) 30%, transparent), transparent);
  filter: blur(16px);
}
/* Phones: no floating card — the header is a flat band; the diffusion layers frost it on scroll. */
@media (max-width: 767px) {
  .st-frost { background: transparent; border: 0; box-shadow: none; -webkit-backdrop-filter: none; backdrop-filter: none; border-radius: 0; }
  .st-frost-sheen, .st-frost-edge, .st-frost-lift, .st-frost-glow { display: none; }
}
/* Progressive blur: each layer is blurrier and masked closer to the top. */
.st-diffuse > * { position: absolute; inset: 0; pointer-events: none; }
.st-diffuse-1 {
  -webkit-backdrop-filter: blur(2px); backdrop-filter: blur(2px);
  -webkit-mask-image: linear-gradient(to bottom, #000 0%, #000 72%, transparent 100%);
  mask-image: linear-gradient(to bottom, #000 0%, #000 72%, transparent 100%);
}
.st-diffuse-2 {
  -webkit-backdrop-filter: blur(6px) saturate(130%); backdrop-filter: blur(6px) saturate(130%);
  -webkit-mask-image: linear-gradient(to bottom, #000 0%, #000 56%, transparent 84%);
  mask-image: linear-gradient(to bottom, #000 0%, #000 56%, transparent 84%);
}
.st-diffuse-3 {
  -webkit-backdrop-filter: blur(calc(var(--glass-blur, 22px) * 0.7)) saturate(160%); backdrop-filter: blur(calc(var(--glass-blur, 22px) * 0.7)) saturate(160%);
  -webkit-mask-image: linear-gradient(to bottom, #000 0%, #000 40%, transparent 68%);
  mask-image: linear-gradient(to bottom, #000 0%, #000 40%, transparent 68%);
}
.st-diffuse-tint {
  background: linear-gradient(to bottom,
    color-mix(in oklab, var(--panel-strong) 78%, transparent) 0%,
    color-mix(in oklab, var(--panel) 55%, transparent) 42%,
    color-mix(in oklab, var(--panel) 18%, transparent) 72%,
    transparent 100%);
}
`

/**
 * Sticky, frosted header. Place it as the first child of a scrolling `Page`;
 * `width` matches the page's content column. With `overlay` it floats over
 * sibling scroll areas instead (the parent passes `stuck` and pads them by
 * the height reported through `onHeight`).
 */
export function FrostHeader({
  children,
  width = 780,
  className,
  overlay,
  stuck: stuckProp,
  onHeight
}: {
  children: ReactNode
  width?: number
  className?: string
  overlay?: boolean
  stuck?: boolean
  onHeight?: (px: number) => void
}): React.JSX.Element {
  const sentinel = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const [seen, setSeen] = useState(false)
  const stuck = overlay ? !!stuckProp : seen
  useEffect(() => {
    const el = sentinel.current
    if (!el || overlay) return
    const io = new IntersectionObserver(([e]) => setSeen(!e.isIntersecting), { threshold: 0 })
    io.observe(el)
    return () => io.disconnect()
  }, [overlay])
  useEffect(() => {
    const el = box.current
    if (!el || !onHeight) return
    const ro = new ResizeObserver(() => onHeight(el.offsetHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [onHeight])
  return (
    <>
      <style>{CSS}</style>
      {!overlay && <div ref={sentinel} aria-hidden className="h-px" />}
      <div ref={box} className={overlay ? 'pointer-events-none absolute inset-x-0 top-0 z-20' : 'sticky top-0 z-20 -mt-px'}>
        {/* Diffusion band: content blurs and fades as it slides under the header. */}
        {/* Each layer fades on its own: an ancestor with opacity < 1 would cut off their backdrop. */}
        <div aria-hidden className="st-diffuse pointer-events-none absolute inset-x-0 top-0 -bottom-16">
          {['st-diffuse-1', 'st-diffuse-2', 'st-diffuse-3', 'st-diffuse-tint'].map((c) => (
            <motion.div key={c} initial={false} animate={{ opacity: stuck ? 1 : 0 }} transition={{ duration: 0.45, ease }} className={c} />
          ))}
        </div>
        <div className="pointer-events-auto relative mx-auto px-6 pt-4 pb-3 max-md:px-0 max-md:pt-1 max-md:pb-0" style={{ maxWidth: width }}>
          <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease }} className="relative">
            <motion.div aria-hidden initial={false} animate={{ opacity: stuck ? 1 : 0.45 }} transition={{ duration: 0.45, ease }} className="st-frost-glow" />
            <motion.div aria-hidden initial={false} animate={{ opacity: stuck ? 1 : 0 }} transition={{ duration: 0.45, ease }} className="st-frost-lift rounded-[20px] max-md:rounded-[18px]" />
            <div className={cn('st-frost relative rounded-[20px] p-4 max-md:rounded-none max-md:px-4 max-md:py-3', className)}>
              <span aria-hidden className="st-frost-sheen" />
              <span aria-hidden className="st-frost-edge opacity-70" />
              <div className="relative">{children}</div>
            </div>
          </motion.div>
        </div>
      </div>
    </>
  )
}
