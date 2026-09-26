// A Wallpaper Engine scene as a live background: the WebGL renderer at the
// display's full pixel density, over the scene's largest still (shown while it
// loads, and kept if WebGL can't draw it).
import { useEffect, useRef, useState } from 'react'
import { motion } from 'motion/react'
import type { BackgroundSettings } from '@shared/types'
import { errorText, fileUrl, invoke } from '@/lib/api'
import { isPhone } from '@/lib/platform'
import { subscribeAudio } from '@/lib/wallpaper-audio'
import { SceneRenderer, type SceneRendererOptions } from './renderer'

const OPTIONS: SceneRendererOptions = isPhone
  ? { maxSide: 4096, maxArea: 8_500_000, maxLayerSide: 2048, maxTextureSide: 2048, fps: 30 }
  : { maxSide: 8192, maxArea: 22_000_000, maxLayerSide: 4096, maxTextureSide: 8192, fps: 60 }

declare global {
  interface Window {
    /** Dev diagnostics for the active scene wallpaper. */
    __stitchScene?: () => unknown
  }
}

export function SceneBackground({ bg, style }: { bg: BackgroundSettings; style?: React.CSSProperties }): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const id = bg.wallpaperId
  const audio = bg.audio !== false

  useEffect(() => {
    const canvas = canvasRef.current
    if (!id || !canvas) return
    let alive = true
    let renderer: SceneRenderer | null = null
    let unsubAudio: (() => void) | null = null
    let ro: ResizeObserver | null = null
    let dprQuery: MediaQueryList | null = null
    setState('loading')

    const size = (): void => {
      if (!renderer) return
      renderer.resize(canvas.clientWidth, canvas.clientHeight, window.devicePixelRatio || 1)
      // Moving to a monitor with another scale factor changes the pixel density.
      dprQuery?.removeEventListener('change', size)
      dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
      dprQuery.addEventListener('change', size)
    }
    const onMove = (e: PointerEvent): void => renderer?.setPointer(e.clientX / window.innerWidth, e.clientY / window.innerHeight)
    const onVisible = (): void => {
      if (!renderer) return
      if (document.hidden) renderer.stop()
      else renderer.start()
    }

    void (async () => {
      try {
        const data = await invoke('wallpaper:scene', id)
        if (!alive) return
        renderer = new SceneRenderer(canvas, data, OPTIONS)
        size()
        ro = new ResizeObserver(size)
        ro.observe(canvas)
        await renderer.load()
        if (!alive) return
        renderer.start()
        if (renderer.needsAudio && audio) unsubAudio = subscribeAudio((bands) => renderer?.setAudio(bands))
        const r = renderer
        window.__stitchScene = () => ({ id, skipped: data.skipped, ...r.stats() })
        // Reveal once the first frame is on screen.
        requestAnimationFrame(() => requestAnimationFrame(() => alive && setState('ready')))
      } catch (err) {
        console.warn('[wallpaper] scene renderer unavailable:', errorText(err))
        if (alive) setState('failed')
      }
    })()

    window.addEventListener('pointermove', onMove, { passive: true })
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      alive = false
      window.removeEventListener('pointermove', onMove)
      document.removeEventListener('visibilitychange', onVisible)
      dprQuery?.removeEventListener('change', size)
      ro?.disconnect()
      unsubAudio?.()
      renderer?.dispose()
      if (window.__stitchScene) delete window.__stitchScene
    }
  }, [id, audio])

  return (
    <div className="absolute inset-0" style={style}>
      {state !== 'ready' && bg.path && <img src={fileUrl(bg.path)} alt="" decoding="async" className="absolute inset-0 size-full object-cover" />}
      <motion.canvas ref={canvasRef} className="absolute inset-0 size-full" initial={{ opacity: 0 }} animate={{ opacity: state === 'ready' ? 1 : 0 }} transition={{ duration: 0.6, ease: 'easeOut' }} />
    </div>
  )
}
