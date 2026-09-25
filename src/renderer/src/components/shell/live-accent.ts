// Keeps the app's accent colours in step with the background (auto mode):
// recomputed whenever the background changes, and — for video wallpapers —
// continuously re-sampled from the playing frame so the UI follows the scene.
import { useEffect } from 'react'
import type { ThemeSettings } from '@shared/types'
import { SUNSET } from '@shared/theme'
import { accentDistance, accentsForBackground, accentsFromSource, applyAccentsLive, type Accents } from '@/lib/theme'
import { useSettings } from '@/stores/settings'

const LIVE_INTERVAL = 3500

export function useAutoAccent(theme: ThemeSettings | undefined): void {
  const update = useSettings((s) => s.update)
  const bg = theme?.background
  const key = theme ? `${theme.accentMode}|${bg!.type}|${bg!.path ?? ''}|${bg!.wallpaperId ?? ''}` : ''

  // Recompute once per background, however it was set.
  useEffect(() => {
    if (!theme || theme.accentMode !== 'auto') return
    let cancelled = false
    void (async () => {
      const b = theme.background
      const next: Accents | null = b.type === 'gradient' || b.type === 'none' ? { ...SUNSET } : await accentsForBackground(b)
      if (cancelled || !next) return
      if (accentDistance(next, theme) > 0.04) await update({ theme: next })
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  // Video wallpapers: follow the scene as it plays.
  useEffect(() => {
    if (!theme || theme.accentMode !== 'auto' || theme.background.type !== 'video') return
    let last: Accents = { accent: theme.accent, accent2: theme.accent2, tint: theme.tint }
    const tick = (): void => {
      if (document.hidden) return
      const v = document.querySelector<HTMLVideoElement>('video[data-bg-video]')
      if (!v || v.readyState < 2 || v.videoWidth === 0) return
      const next = accentsFromSource(v)
      if (next && accentDistance(next, last) > 0.1) {
        applyAccentsLive(next)
        last = next
      }
    }
    const t = setInterval(tick, LIVE_INTERVAL)
    const first = setTimeout(tick, 1200)
    return () => {
      clearInterval(t)
      clearTimeout(first)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
}
