// Non-component helpers shared across the studio (kept apart so Fast Refresh works).
import type { DragEvent } from 'react'
import { useMemo } from 'react'
import type { Asset, ID, Timeline } from '@shared/types'
import { fileUrl } from '@/lib/api'
import { useCollection } from '@/stores/db'
import { timelineDuration } from './model'

// ─── Drag & drop of assets onto the timeline ─────────────────────────────────

export const ASSET_MIME = 'application/x-stitch-asset'

/** The asset being dragged inside this window (dataTransfer is unreadable during dragover). */
export const dragState: { asset: Asset | null; range?: { in?: number; out?: number } } = { asset: null }

export function startAssetDrag(e: DragEvent, asset: Asset, range?: { in?: number; out?: number }): void {
  e.dataTransfer.setData(ASSET_MIME, asset.id)
  e.dataTransfer.setData('text/plain', asset.name)
  e.dataTransfer.effectAllowed = 'copy'
  dragState.asset = asset
  dragState.range = range
}

export function endAssetDrag(): void {
  dragState.asset = null
  dragState.range = undefined
}

// ─── Posters ─────────────────────────────────────────────────────────────────

/** Poster source for a timeline: its earliest visual clip. */
export function timelinePoster(tl: Timeline, assets: Map<ID, Asset>): Asset | undefined {
  const visual = tl.clips
    .map((c) => ({ c, a: assets.get(c.assetId) }))
    .filter((x) => x.a && (x.a.kind === 'video' || x.a.kind === 'image'))
    .sort((x, y) => x.c.start - y.c.start)
  return visual[0]?.a
}

export function posterUrl(a: Asset | undefined): string {
  if (!a) return ''
  if (a.kind === 'image') return fileUrl(a.path)
  return a.thumbPath ? fileUrl(a.thumbPath) : ''
}

export function useAssetMap(): Map<ID, Asset> {
  const assets = useCollection('assets')
  return useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets])
}

export function timelineMeta(tl: Timeline): string {
  const d = timelineDuration(tl)
  const m = Math.floor(d / 60)
  const s = Math.round(d % 60)
  return `${m}:${String(s).padStart(2, '0')} · ${tl.width}×${tl.height} · ${tl.fps} fps`
}
