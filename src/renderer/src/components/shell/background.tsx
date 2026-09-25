// Full-window backdrop: sunset gradient, custom image/video, or a Wallpaper Engine item.
import { memo } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { BackgroundSettings } from '@shared/types'
import { fileUrl } from '@/lib/api'

function webUrl(bg: BackgroundSettings): string {
  if (!bg.wallpaperId || !bg.path) return ''
  const file = bg.path.replace(/\\/g, '/').split('/').pop() ?? 'index.html'
  return `stitch://wp-${bg.wallpaperId}/${encodeURIComponent(file)}`
}

function SunsetGradient(): React.JSX.Element {
  return (
    <div className="absolute inset-0 overflow-hidden bg-[#08070d]">
      {/* Horizon glow rising from the bottom, sampled from the reference photo. */}
      <div
        className="absolute inset-0"
        style={{
          background:
            'linear-gradient(180deg, #0a0912 0%, #0d0b17 38%, color-mix(in oklab, #312b47 55%, #0a0912) 62%, color-mix(in oklab, #8e3452 30%, #0a0912) 80%, color-mix(in oklab, #c85d56 30%, #0a0912) 92%, color-mix(in oklab, #cc7b62 38%, #0a0912) 100%)'
        }}
      />
      <motion.div
        className="absolute -top-[30%] -left-[15%] size-[75vmax] rounded-full opacity-[0.28] blur-[110px]"
        style={{ background: 'radial-gradient(circle, #6d65b8, transparent 62%)' }}
        animate={{ x: ['0%', '8%', '0%'], y: ['0%', '5%', '0%'] }}
        transition={{ duration: 28, repeat: Infinity, ease: 'easeInOut' }}
      />
      <motion.div
        className="absolute -right-[20%] -bottom-[35%] size-[80vmax] rounded-full opacity-[0.26] blur-[120px]"
        style={{ background: 'radial-gradient(circle, #c85d56, #8e3452 40%, transparent 65%)' }}
        animate={{ x: ['0%', '-6%', '0%'], y: ['0%', '-4%', '0%'] }}
        transition={{ duration: 34, repeat: Infinity, ease: 'easeInOut' }}
      />
      <motion.div
        className="absolute top-[35%] left-[30%] size-[50vmax] rounded-full opacity-[0.14] blur-[120px]"
        style={{ background: 'radial-gradient(circle, #ad849d, transparent 60%)' }}
        animate={{ x: ['0%', '10%', '-4%', '0%'], y: ['0%', '-6%', '4%', '0%'] }}
        transition={{ duration: 40, repeat: Infinity, ease: 'easeInOut' }}
      />
    </div>
  )
}

export const Background = memo(function Background({ bg }: { bg: BackgroundSettings }): React.JSX.Element {
  const key = `${bg.type}|${bg.path ?? ''}|${bg.wallpaperId ?? ''}`
  return (
    <div className="grain pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      <AnimatePresence mode="sync">
        <motion.div key={key} className="absolute inset-0" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.9, ease: 'easeInOut' }}>
          {bg.type === 'gradient' && <SunsetGradient />}
          {bg.type === 'none' && <div className="absolute inset-0 bg-bg" />}
          {bg.type === 'image' && bg.path && (
            <img src={fileUrl(bg.path)} className="absolute inset-0 size-full object-cover" style={{ filter: bg.blur ? `blur(${bg.blur}px)` : undefined, transform: bg.blur ? 'scale(1.06)' : undefined }} />
          )}
          {bg.type === 'video' && bg.path && (
            <video
              data-bg-video
              crossOrigin="anonymous"
              src={fileUrl(bg.path)}
              autoPlay
              muted
              loop
              playsInline
              className="absolute inset-0 size-full object-cover"
              style={{ filter: bg.blur ? `blur(${bg.blur}px)` : undefined, transform: bg.blur ? 'scale(1.06)' : undefined }}
            />
          )}
          {bg.type === 'web' && bg.wallpaperId && (
            <iframe
              src={webUrl(bg)}
              sandbox="allow-scripts allow-same-origin"
              className="absolute inset-0 size-full border-0"
              style={{ filter: bg.blur ? `blur(${bg.blur}px)` : undefined }}
              title="Wallpaper"
            />
          )}
        </motion.div>
      </AnimatePresence>
      {/* Dim + vignette keep text readable over any wallpaper. */}
      <div className="absolute inset-0 transition-colors duration-700" style={{ background: `rgb(6 5 10 / ${bg.type === 'gradient' ? bg.dim * 0.4 : bg.dim})` }} />
      <div className="absolute inset-0" style={{ background: `radial-gradient(ellipse at center, transparent 45%, rgb(0 0 0 / ${bg.type === 'gradient' || bg.type === 'none' ? 0.55 : 0.3}) 100%)` }} />
    </div>
  )
})
