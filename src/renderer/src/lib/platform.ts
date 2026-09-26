// Where this renderer runs: the Electron desktop app, or the Stitch phone app (a remote for the PC
// that reuses these same pages over its connection — see `mobile/` in this repo).
import { useSyncExternalStore } from 'react'

/** Running inside the Stitch phone app. */
export const isPhone: boolean = typeof window !== 'undefined' && !!window.stitch?.phone

const compactQuery = '(max-width: 767px)'

function subscribe(cb: () => void): () => void {
  const mq = window.matchMedia(compactQuery)
  mq.addEventListener('change', cb)
  return () => mq.removeEventListener('change', cb)
}

/** Narrow (phone-width) layout. Prefer Tailwind `max-md:` classes; use this when structure must change. */
export function useCompact(): boolean {
  return useSyncExternalStore(subscribe, () => window.matchMedia(compactQuery).matches, () => false)
}

/** Touch-first device (no hover): hover-only affordances should stay visible. */
export const isTouch: boolean = typeof window !== 'undefined' && window.matchMedia?.('(hover: none)').matches
