// Full-window backdrop: sunset gradient, custom image/video, or a Wallpaper Engine item.
import { memo, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { BackgroundSettings } from '@shared/types'
import { fileUrl, resolveUrl } from '@/lib/api'
import { subscribeAudio } from '@/lib/wallpaper-audio'
import { SceneBackground } from './scene/SceneBackground'

function webUrl(bg: BackgroundSettings): string {
  if (!bg.wallpaperId || !bg.path) return ''
  const file = bg.path.replace(/\\/g, '/').split('/').pop() ?? 'index.html'
  return resolveUrl(`stitch://wp-${bg.wallpaperId}/${encodeURIComponent(file)}`)
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

function useDevicePixelRatio(): number {
  const [dpr, setDpr] = useState(() => window.devicePixelRatio || 1)
  useEffect(() => {
    const q = window.matchMedia(`(resolution: ${dpr}dppx)`)
    const on = (): void => setDpr(window.devicePixelRatio || 1)
    q.addEventListener('change', on)
    return () => q.removeEventListener('change', on)
  }, [dpr])
  return dpr
}

/**
 * A web wallpaper in its sandbox. Like in Wallpaper Engine, the page gets a
 * viewport in physical pixels (devicePixelRatio 1), so canvases sized to
 * innerWidth render crisp on high-DPI screens. It can ask for the system audio
 * spectrum, which we forward ~30 times a second.
 */
function WebWallpaper({ bg, filter }: { bg: BackgroundSettings; filter?: string }): React.JSX.Element {
  const ref = useRef<HTMLIFrameElement>(null)
  const dpr = useDevicePixelRatio()
  const audio = bg.audio !== false
  useEffect(() => {
    let unsub: (() => void) | null = null
    const onMessage = (ev: MessageEvent): void => {
      const frame = ref.current?.contentWindow
      if (!frame || ev.source !== frame) return
      const d = ev.data as { stitchWallpaper?: string } | null
      if (d?.stitchWallpaper === 'audio' && audio && !unsub) {
        unsub = subscribeAudio((bands) => ref.current?.contentWindow?.postMessage({ stitchAudio: bands }, '*'))
      }
    }
    // The wallpaper sits under Stitch's UI; like Wallpaper Engine, pass it the mouse movement (not clicks).
    let frameReq = 0
    let last: [number, number] = [0, 0]
    const onMove = (e: PointerEvent): void => {
      last = [e.clientX * dpr, e.clientY * dpr]
      if (frameReq) return
      frameReq = requestAnimationFrame(() => {
        frameReq = 0
        ref.current?.contentWindow?.postMessage({ stitchPointer: last }, '*')
      })
    }
    window.addEventListener('message', onMessage)
    window.addEventListener('pointermove', onMove, { passive: true })
    return () => {
      window.removeEventListener('message', onMessage)
      window.removeEventListener('pointermove', onMove)
      cancelAnimationFrame(frameReq)
      unsub?.()
    }
  }, [bg.wallpaperId, bg.path, audio, dpr])
  return (
    <iframe
      ref={ref}
      src={webUrl(bg)}
      sandbox="allow-scripts allow-same-origin"
      className="absolute inset-0 size-full border-0"
      style={{ zoom: dpr !== 1 ? 1 / dpr : undefined, filter }}
      title="Wallpaper"
    />
  )
}

export const Background = memo(function Background({ bg }: { bg: BackgroundSettings }): React.JSX.Element {
  const key = `${bg.type}|${bg.path ?? ''}|${bg.wallpaperId ?? ''}`
  const blurred = bg.blur ? { filter: `blur(${bg.blur}px)`, transform: 'scale(1.06)' } : undefined
  const media = bg.type !== 'gradient' && bg.type !== 'none'
  return (
    // Film grain belongs to the built-in gradient; it would only muddy real wallpapers.
    <div className={`${media ? '' : 'grain '}pointer-events-none fixed inset-0 -z-10 overflow-hidden`}>
      <AnimatePresence mode="sync">
        <motion.div key={key} className="absolute inset-0" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.9, ease: 'easeInOut' }}>
          {bg.type === 'gradient' && <SunsetGradient />}
          {bg.type === 'none' && <div className="absolute inset-0 bg-bg" />}
          {bg.type === 'image' && bg.path && <img src={fileUrl(bg.path)} decoding="async" className="absolute inset-0 size-full object-cover" style={blurred} />}
          {bg.type === 'video' && bg.path && (
            <video data-bg-video crossOrigin="anonymous" src={fileUrl(bg.path)} autoPlay muted loop playsInline className="absolute inset-0 size-full object-cover" style={blurred} />
          )}
          {bg.type === 'web' && bg.wallpaperId && <WebWallpaper bg={bg} filter={bg.blur ? `blur(${bg.blur}px)` : undefined} />}
          {bg.type === 'scene' && bg.wallpaperId && <SceneBackground bg={bg} style={blurred} />}
        </motion.div>
      </AnimatePresence>
      {/* Dim + vignette keep text readable over any wallpaper. */}
      <div className="absolute inset-0 transition-colors duration-700" style={{ background: `rgb(6 5 10 / ${bg.type === 'gradient' ? bg.dim * 0.4 : bg.dim})` }} />
      <div className="absolute inset-0" style={{ background: `radial-gradient(ellipse at center, transparent 45%, rgb(0 0 0 / ${bg.type === 'gradient' || bg.type === 'none' ? 0.55 : 0.3}) 100%)` }} />
    </div>
  )
})
