// Preview proxies: short-GOP copies of video assets made by the main process so
// seeking (scrubbing, cuts, filmstrips) is near-instant. Originals are still
// used for export; until a proxy exists everything falls back to the original.
import { useEffect, useState } from 'react'
import type { Asset, ID } from '@shared/types'
import { invoke } from '@/lib/api'

const ready = new Map<ID, string>()
const pending = new Map<ID, Promise<string | null>>()
/** Assets whose proxy could not be made (no ffmpeg, unreadable file) — retried after a while. */
const failed = new Map<ID, number>()
const subs = new Set<(assetId: ID) => void>()

export function requestProxy(asset: Asset): Promise<string | null> {
  if (asset.kind !== 'video') return Promise.resolve(null)
  const hit = ready.get(asset.id)
  if (hit) return Promise.resolve(hit)
  if (Date.now() - (failed.get(asset.id) ?? -Infinity) < 60_000) return Promise.resolve(null)
  let p = pending.get(asset.id)
  if (!p) {
    p = invoke('editor:proxy', asset.id)
      .catch(() => null)
      .then((path) => {
        pending.delete(asset.id)
        if (path) {
          ready.set(asset.id, path)
          for (const fn of subs) fn(asset.id)
        } else failed.set(asset.id, Date.now())
        return path
      })
    pending.set(asset.id, p)
  }
  return p
}

/** Best local path for previewing an asset (proxy when ready). Kicks off proxy creation. */
export function previewPath(asset: Asset): string {
  const hit = ready.get(asset.id)
  if (hit) return hit
  if (asset.kind === 'video') void requestProxy(asset)
  return asset.path
}

export function onProxyReady(fn: (assetId: ID) => void): () => void {
  subs.add(fn)
  return () => subs.delete(fn)
}

/** Re-render when this asset's proxy lands. */
export function usePreviewPath(asset: Asset | undefined): string {
  const [, bump] = useState(0)
  useEffect(() => {
    if (!asset || asset.kind !== 'video') return
    return onProxyReady((id) => id === asset.id && bump((n) => n + 1))
  }, [asset?.id, asset?.kind])
  return asset ? previewPath(asset) : ''
}
