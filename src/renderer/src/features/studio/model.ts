// Pure timeline helpers: construction, geometry, editing operations, formatting.
import { nanoid } from 'nanoid'
import type { Asset, ID, Timeline, TimelineClip, TimelineTrack } from '@shared/types'

export const DEFAULT_STILL = 4
export const MIN_ZOOM = 4
export const MAX_ZOOM = 640

export interface ResPreset {
  id: string
  w: number
  h: number
  label: string
  hint: string
}

export const RES_PRESETS: ResPreset[] = [
  { id: 'landscape', w: 1920, h: 1080, label: 'Landscape', hint: '1920 × 1080 · 16:9' },
  { id: 'vertical', w: 1080, h: 1920, label: 'Vertical', hint: '1080 × 1920 · 9:16' },
  { id: 'hd', w: 1280, h: 720, label: 'HD 720p', hint: '1280 × 720 · 16:9' },
  { id: 'square', w: 1080, h: 1080, label: 'Square', hint: '1080 × 1080 · 1:1' }
]

export function presetFor(w: number, h: number): ResPreset | undefined {
  return RES_PRESETS.find((p) => p.w === w && p.h === h)
}

export type ClipKind = 'video' | 'image' | 'audio' | 'text'

export function newTrack(kind: TimelineTrack['kind'], name: string): TimelineTrack {
  return { id: nanoid(8), kind, name, muted: false, locked: false, hidden: false }
}

export function newTimeline(name: string, width: number, height: number, fps: number, projectId?: ID): Timeline {
  const now = Date.now()
  return {
    id: nanoid(10),
    name,
    projectId,
    width,
    height,
    fps,
    tracks: [newTrack('video', 'V1'), newTrack('video', 'V2'), newTrack('audio', 'A1'), newTrack('audio', 'A2'), newTrack('text', 'T1')],
    clips: [],
    createdAt: now,
    updatedAt: now
  }
}

export function duplicateTimeline(tl: Timeline, name?: string): Timeline {
  const now = Date.now()
  const trackIds = new Map(tl.tracks.map((t) => [t.id, nanoid(8)]))
  return {
    ...structuredClone(tl),
    id: nanoid(10),
    name: name ?? `${tl.name} copy`,
    tracks: tl.tracks.map((t) => ({ ...t, id: trackIds.get(t.id)! })),
    clips: tl.clips.map((c) => ({ ...c, id: nanoid(10), trackId: trackIds.get(c.trackId) ?? c.trackId })),
    createdAt: now,
    updatedAt: now
  }
}

// ─── Geometry ────────────────────────────────────────────────────────────────

export const clipDur = (c: TimelineClip): number => Math.max(0, c.out - c.in)
export const clipEnd = (c: TimelineClip): number => c.start + clipDur(c)

export function timelineDuration(tl: Pick<Timeline, 'clips'>): number {
  let end = 0
  for (const c of tl.clips) end = Math.max(end, clipEnd(c))
  return end
}

export function clipKind(c: TimelineClip, asset: Asset | undefined): ClipKind {
  if (c.text) return 'text'
  return asset?.kind ?? 'video'
}

/** Source length that bounds trimming; undefined = free length (stills, titles). */
export function sourceLength(asset: Asset | undefined): number | undefined {
  if (!asset || asset.kind === 'image') return undefined
  return asset.duration && asset.duration > 0 ? asset.duration : undefined
}

export function trackAccepts(track: TimelineTrack, kind: ClipKind): boolean {
  if (track.kind === 'video') return kind === 'video' || kind === 'image'
  if (track.kind === 'audio') return kind === 'audio'
  return kind === 'text'
}

export function trackKindFor(kind: ClipKind): TimelineTrack['kind'] {
  return kind === 'audio' ? 'audio' : kind === 'text' ? 'text' : 'video'
}

/** Display order: titles on top, video tracks with V1 nearest the audio, then audio. */
export function displayTracks(tracks: TimelineTrack[]): TimelineTrack[] {
  const text = tracks.filter((t) => t.kind === 'text').reverse()
  const video = tracks.filter((t) => t.kind === 'video').reverse()
  const audio = tracks.filter((t) => t.kind === 'audio')
  return [...text, ...video, ...audio]
}

export const TRACK_H: Record<TimelineTrack['kind'], number> = { video: 62, audio: 50, text: 34 }

/** Stacking layer: later video tracks sit above earlier ones; titles above all. */
export function trackLayer(tracks: TimelineTrack[], trackId: ID): number {
  const idx = tracks.findIndex((t) => t.id === trackId)
  const t = tracks[idx]
  if (!t) return 0
  if (t.kind === 'text') return 1000 + idx
  return tracks.filter((x, i) => x.kind === 'video' && i <= idx).length
}

export function nextTrackName(tracks: TimelineTrack[], kind: TimelineTrack['kind']): string {
  const prefix = kind === 'video' ? 'V' : kind === 'audio' ? 'A' : 'T'
  let n = tracks.filter((t) => t.kind === kind).length + 1
  while (tracks.some((t) => t.name === `${prefix}${n}`)) n++
  return `${prefix}${n}`
}

export function addTrack(tl: Timeline, kind: TimelineTrack['kind']): { tl: Timeline; track: TimelineTrack } {
  const track = newTrack(kind, nextTrackName(tl.tracks, kind))
  // keep kinds grouped: insert after the last track of the same kind
  const tracks = [...tl.tracks]
  let at = -1
  tracks.forEach((t, i) => t.kind === kind && (at = i))
  tracks.splice(at < 0 ? tracks.length : at + 1, 0, track)
  return { tl: { ...tl, tracks }, track }
}

// ─── Snapping ────────────────────────────────────────────────────────────────

export function frameRound(t: number, fps: number): number {
  return Math.round(t * fps) / fps
}

export function snapPoints(clips: TimelineClip[], exclude: Set<ID>, playhead: number): number[] {
  const pts = [0, playhead]
  for (const c of clips) {
    if (exclude.has(c.id)) continue
    pts.push(c.start, clipEnd(c))
  }
  return pts
}

/** Best snap for any of `edges` against `points` within `threshold` seconds. */
export function snapDelta(edges: number[], points: number[], threshold: number): { delta: number; at: number } | null {
  let best: { delta: number; at: number } | null = null
  for (const e of edges) {
    for (const p of points) {
      const d = p - e
      if (Math.abs(d) <= threshold && (!best || Math.abs(d) < Math.abs(best.delta))) best = { delta: d, at: p }
    }
  }
  return best
}

// ─── Editing operations (pure) ───────────────────────────────────────────────

const EPS = 1e-4

/**
 * Overwrite: clear [s, e) on a track, trimming, splitting or removing clips
 * that overlap it (clips in `keep` are left alone).
 */
export function carve(clips: TimelineClip[], trackId: ID, s: number, e: number, keep: Set<ID>): TimelineClip[] {
  if (e - s <= EPS) return clips
  const out: TimelineClip[] = []
  for (const c of clips) {
    if (c.trackId !== trackId || keep.has(c.id)) {
      out.push(c)
      continue
    }
    const cs = c.start
    const ce = clipEnd(c)
    if (ce <= s + EPS || cs >= e - EPS) {
      out.push(c)
      continue
    }
    if (cs >= s - EPS && ce <= e + EPS) continue // fully covered
    if (cs < s && ce > e) {
      out.push({ ...c, out: c.in + (s - cs) })
      out.push({ ...c, id: nanoid(10), start: e, in: c.in + (e - cs) })
      continue
    }
    if (cs < s) out.push({ ...c, out: c.in + (s - cs) })
    else out.push({ ...c, start: e, in: c.in + (e - cs) })
  }
  return out
}

/** Split clips (all given ids that straddle t) at t. Returns new clips + ids of right halves. */
export function splitClips(clips: TimelineClip[], ids: Set<ID>, t: number): { clips: TimelineClip[]; created: ID[] } {
  const out: TimelineClip[] = []
  const created: ID[] = []
  for (const c of clips) {
    if (!ids.has(c.id) || t <= c.start + EPS || t >= clipEnd(c) - EPS) {
      out.push(c)
      continue
    }
    const cut = c.in + (t - c.start)
    const right: TimelineClip = { ...c, id: nanoid(10), start: t, in: cut, fadeIn: 0 }
    out.push({ ...c, out: cut, fadeOut: 0 }, right)
    created.push(right.id)
  }
  return { clips: out, created }
}

/** Remove clips and close the gaps they leave on their tracks. */
export function rippleDelete(clips: TimelineClip[], ids: Set<ID>): TimelineClip[] {
  const removed = clips.filter((c) => ids.has(c.id)).sort((a, b) => b.start - a.start)
  let rest = clips.filter((c) => !ids.has(c.id))
  for (const r of removed) {
    const d = clipDur(r)
    rest = rest.map((c) => (c.trackId === r.trackId && c.start >= r.start - EPS ? { ...c, start: Math.max(0, c.start - d) } : c))
  }
  return rest
}

/** Make room at t on a track by pushing later clips right (splitting a clip under t). */
export function rippleInsert(clips: TimelineClip[], trackId: ID, t: number, d: number): TimelineClip[] {
  const under = clips.find((c) => c.trackId === trackId && c.start < t - EPS && clipEnd(c) > t + EPS)
  let next = under ? splitClips(clips, new Set([under.id]), t).clips : clips
  next = next.map((c) => (c.trackId === trackId && c.start >= t - EPS ? { ...c, start: c.start + d } : c))
  return next
}

/** Place clips right after the selection on the same tracks (overwriting). */
export function duplicateClips(clips: TimelineClip[], ids: Set<ID>): { clips: TimelineClip[]; created: ID[] } {
  const sel = clips.filter((c) => ids.has(c.id))
  if (!sel.length) return { clips, created: [] }
  const s = Math.min(...sel.map((c) => c.start))
  const e = Math.max(...sel.map(clipEnd))
  const offset = e - s
  let next = clips
  const created: ID[] = []
  for (const c of sel) {
    const copy: TimelineClip = { ...structuredClone(c), id: nanoid(10), start: c.start + offset }
    next = carve(next, copy.trackId, copy.start, clipEnd(copy), new Set())
    next = [...next, copy]
    created.push(copy.id)
  }
  return { clips: next, created }
}

/** Neighbour limits on a track for trimming a clip without overlapping. */
export function neighbours(clips: TimelineClip[], clip: TimelineClip, ignore: Set<ID> = new Set()): { prevEnd: number; nextStart: number } {
  let prevEnd = 0
  let nextStart = Infinity
  for (const c of clips) {
    if (c.id === clip.id || c.trackId !== clip.trackId || ignore.has(c.id)) continue
    if (clipEnd(c) <= clip.start + EPS) prevEnd = Math.max(prevEnd, clipEnd(c))
    else if (c.start >= clipEnd(clip) - EPS) nextStart = Math.min(nextStart, c.start)
  }
  return { prevEnd, nextStart }
}

/** Clip for an asset placed at `start`. */
export function clipForAsset(asset: Asset, trackId: ID, start: number, range?: { in?: number; out?: number }): TimelineClip {
  const len = sourceLength(asset)
  const i = asset.kind === 'image' ? 0 : Math.max(0, range?.in ?? 0)
  const o = asset.kind === 'image' ? (range?.out ?? DEFAULT_STILL) : Math.max(i + 0.05, range?.out ?? len ?? DEFAULT_STILL)
  return { id: nanoid(10), assetId: asset.id, trackId, start: Math.max(0, start), in: i, out: o, volume: 1 }
}

export function textClip(trackId: ID, start: number, content = 'Your title'): TimelineClip {
  return {
    id: nanoid(10),
    assetId: '',
    trackId,
    start: Math.max(0, start),
    in: 0,
    out: DEFAULT_STILL,
    volume: 1,
    fadeIn: 0.3,
    fadeOut: 0.3,
    text: { content, size: 84, color: '#ffffff', x: 0.5, y: 0.82 }
  }
}

/** Fade envelope 0..1 at timeline time t. */
export function fadeGain(c: TimelineClip, t: number): number {
  const d = clipDur(c)
  const local = t - c.start
  let g = 1
  const fi = Math.min(c.fadeIn ?? 0, d / 2)
  const fo = Math.min(c.fadeOut ?? 0, d / 2)
  if (fi > 0 && local < fi) g = Math.min(g, Math.max(0, local / fi))
  if (fo > 0 && local > d - fo) g = Math.min(g, Math.max(0, (d - local) / fo))
  return g
}

// ─── Formatting ──────────────────────────────────────────────────────────────

/** HH:MM:SS:FF timecode. */
export function timecode(t: number, fps: number): string {
  const total = Math.max(0, Math.round(t * fps))
  const f = total % fps
  const s = Math.floor(total / fps)
  const pad = (v: number): string => String(v).padStart(2, '0')
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}:${pad(f)}`
}

/** Short label for the ruler: 0:05, 1:30, or 0:05:12 with frames. */
export function rulerLabel(t: number, fps: number, withFrames: boolean): string {
  const total = Math.round(t * fps)
  const s = Math.floor(total / fps)
  const f = total % fps
  const base = s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
  return withFrames && f ? `${base}:${String(f).padStart(2, '0')}` : base
}

export function shortDuration(t: number): string {
  if (t < 60) return `${t < 10 ? Math.round(t * 10) / 10 : Math.round(t)}s`
  const m = Math.floor(t / 60)
  const s = Math.round(t % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

export function isEditableTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

/** Parse "12.5", "0:12", "00:12:05" (mm:ss:ff) or "00:00:12:05" into seconds. */
export function parseTime(s: string, fps: number): number | undefined {
  const t = s.trim().replace(/s$/i, '')
  if (!t) return undefined
  if (/^-?\d+(\.\d+)?$/.test(t)) return parseFloat(t)
  const parts = t.split(':').map(Number)
  if (parts.some((p) => !Number.isFinite(p))) return undefined
  if (parts.length === 4) return parts[0] * 3600 + parts[1] * 60 + parts[2] + parts[3] / fps
  if (parts.length === 3) return parts[0] * 60 + parts[1] + parts[2] / fps
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return undefined
}
