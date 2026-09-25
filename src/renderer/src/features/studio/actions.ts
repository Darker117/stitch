// Editing commands shared by the toolbar, keyboard shortcuts and panels.
import type { Asset, ID, Timeline, TimelineTrack } from '@shared/types'
import { db } from '@/stores/db'
import { clock } from './clock'
import { editor, useEditor } from './store'
import {
  addTrack,
  carve,
  clipDur,
  clipEnd,
  clipForAsset,
  clipKind,
  duplicateClips,
  rippleDelete,
  rippleInsert,
  splitClips,
  textClip,
  trackKindFor,
  type ClipKind
} from './model'

const getAsset = (id: ID): Asset | undefined => db.get('assets', id)

function lockedTracks(tl: Timeline): Set<ID> {
  return new Set(tl.tracks.filter((t) => t.locked).map((t) => t.id))
}

/** Clip ids that edits may touch: the selection minus clips on locked tracks. */
function editable(tl: Timeline, ids: ID[]): Set<ID> {
  const locked = lockedTracks(tl)
  return new Set(tl.clips.filter((c) => ids.includes(c.id) && !locked.has(c.trackId)).map((c) => c.id))
}

export function splitAtPlayhead(): void {
  const { tl, selection } = editor.get()
  if (!tl) return
  const t = Math.round(clock.time * tl.fps) / tl.fps
  const locked = lockedTracks(tl)
  // With a selection, split the selected clips; otherwise everything under the playhead.
  const under = tl.clips.filter((c) => !locked.has(c.trackId) && c.start < t && clipEnd(c) > t)
  const targets = selection.length ? under.filter((c) => selection.includes(c.id)) : under
  if (!targets.length) return
  editor.commit((cur) => {
    const { clips, created } = splitClips(cur.clips, new Set(targets.map((c) => c.id)), t)
    useEditor.setState({ selection: selection.length ? created : [] })
    return { ...cur, clips }
  })
}

export function deleteSelection(ripple = false): void {
  const { tl, selection } = editor.get()
  if (!tl || !selection.length) return
  const ids = editable(tl, selection)
  if (!ids.size) return
  editor.commit((cur) => ({ ...cur, clips: ripple ? rippleDelete(cur.clips, ids) : cur.clips.filter((c) => !ids.has(c.id)) }), [])
}

export function duplicateSelection(): void {
  const { tl, selection } = editor.get()
  if (!tl || !selection.length) return
  const ids = editable(tl, selection)
  if (!ids.size) return
  let created: ID[] = []
  editor.commit((cur) => {
    const r = duplicateClips(cur.clips, ids)
    created = r.created
    return { ...cur, clips: r.clips }
  })
  editor.select(created)
}

export function selectAll(): void {
  const tl = editor.get().tl
  if (!tl) return
  const locked = lockedTracks(tl)
  editor.select(tl.clips.filter((c) => !locked.has(c.trackId)).map((c) => c.id))
}

/** First unlocked track that accepts a kind; creates one when needed. */
export function ensureTrack(tl: Timeline, kind: ClipKind, preferred?: ID): { tl: Timeline; track: TimelineTrack } {
  const want = trackKindFor(kind)
  const pref = tl.tracks.find((t) => t.id === preferred && t.kind === want && !t.locked)
  if (pref) return { tl, track: pref }
  const found = tl.tracks.find((t) => t.kind === want && !t.locked)
  if (found) return { tl, track: found }
  return addTrack(tl, want)
}

/** Place an asset on the timeline (overwrite at `start`, or ripple-insert). */
export function placeAsset(asset: Asset, opts: { start?: number; trackId?: ID; range?: { in?: number; out?: number }; insert?: boolean; newTrack?: boolean } = {}): ID {
  const tl = editor.get().tl
  if (!tl) return ''
  const start = Math.max(0, opts.start ?? clock.time)
  let id = ''
  editor.commit((cur) => {
    const { tl: withTrack, track } = opts.newTrack ? addTrack(cur, trackKindFor(asset.kind)) : ensureTrack(cur, asset.kind, opts.trackId)
    const clip = clipForAsset(asset, track.id, Math.round(start * cur.fps) / cur.fps, opts.range)
    id = clip.id
    const clips = opts.insert ? rippleInsert(withTrack.clips, track.id, clip.start, clipDur(clip)) : carve(withTrack.clips, track.id, clip.start, clipEnd(clip), new Set())
    return { ...withTrack, clips: [...clips, clip] }
  })
  editor.select([id])
  return id
}

/** Append after the last clip on the first matching track. */
export function appendAsset(asset: Asset): void {
  const tl = editor.get().tl
  if (!tl) return
  const { track } = ensureTrack(tl, asset.kind)
  const end = tl.clips.filter((c) => c.trackId === track.id).reduce((m, c) => Math.max(m, clipEnd(c)), 0)
  placeAsset(asset, { start: end, trackId: track.id })
}

export function addTitle(): void {
  const tl = editor.get().tl
  if (!tl) return
  let id = ''
  editor.commit((cur) => {
    const { tl: withTrack, track } = ensureTrack(cur, 'text')
    const clip = textClip(track.id, Math.round(clock.time * cur.fps) / cur.fps)
    id = clip.id
    return { ...withTrack, clips: [...carve(withTrack.clips, track.id, clip.start, clipEnd(clip), new Set()), clip] }
  })
  editor.select([id])
}

export function addTrackOf(kind: TimelineTrack['kind']): void {
  editor.commit((cur) => addTrack(cur, kind).tl)
}

export function removeTrack(id: ID): void {
  editor.commit((cur) => ({ ...cur, tracks: cur.tracks.filter((t) => t.id !== id), clips: cur.clips.filter((c) => c.trackId !== id) }))
  editor.pruneSelection()
}

export function patchTrack(id: ID, patch: Partial<TimelineTrack>): void {
  editor.commit((cur) => ({ ...cur, tracks: cur.tracks.map((t) => (t.id === id ? { ...t, ...patch } : t)) }))
}

export function kindOfClip(id: ID): ClipKind | undefined {
  const c = editor.get().tl?.clips.find((x) => x.id === id)
  return c ? clipKind(c, getAsset(c.assetId)) : undefined
}

/** Jump the playhead to the previous/next cut. */
export function jumpToEdit(dir: -1 | 1): void {
  const tl = editor.get().tl
  if (!tl) return
  const pts = new Set<number>([0])
  for (const c of tl.clips) {
    pts.add(c.start)
    pts.add(clipEnd(c))
  }
  const sorted = [...pts].sort((a, b) => a - b)
  const t = clock.time
  const eps = 0.5 / tl.fps
  const target = dir > 0 ? sorted.find((p) => p > t + eps) : [...sorted].reverse().find((p) => p < t - eps)
  if (target !== undefined) {
    clock.pause()
    clock.seek(target)
  }
}
