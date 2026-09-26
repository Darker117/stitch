// The multi-track timeline: ruler, playhead, track headers, clips, trimming,
// moving with snapping, marquee selection and asset drops.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type PointerEvent as RPointerEvent } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import {
  AudioLines,
  ChevronsLeft,
  ChevronsRight,
  Copy,
  Eye,
  EyeOff,
  Film,
  ListChecks,
  Lock,
  Magnet,
  Maximize2,
  MonitorPlay,
  MoreHorizontal,
  Plus,
  Redo2,
  Scissors,
  Trash2,
  Type,
  Undo2,
  Unlock,
  Volume2,
  VolumeX,
  X,
  ZoomIn,
  ZoomOut
} from 'lucide-react'
import type { Asset, ID, TimelineClip, TimelineTrack } from '@shared/types'
import { cn } from '@/lib/utils'
import { ease, spring } from '@/lib/motion'
import { useCompact } from '@/lib/platform'
import { db } from '@/stores/db'
import { ACCEPT, importFiles } from '@/components/media'
import { IconButton } from '@/components/ui/button'
import { Menu, MenuCheck, MenuItem, MenuSeparator, Tooltip } from '@/components/ui/overlay'
import { Slider } from '@/components/ui/controls'
import { Kbd } from '@/components/ui/misc'
import { clock } from './clock'
import { ClipView } from './ClipView'
import { ASSET_MIME, dragState, endAssetDrag, useAssetMap } from './helpers'
import { timelineControls } from './controls'
import { addTitle, addTrackOf, deleteSelection, duplicateSelection, jumpToEdit, patchTrack, placeAsset, removeTrack, selectAll, splitAtPlayhead } from './actions'
import { editor, useEditor } from './store'
import {
  DEFAULT_STILL,
  MAX_ZOOM,
  MIN_ZOOM,
  TRACK_H,
  carve,
  clipDur,
  clipEnd,
  clipKind,
  displayTracks,
  frameRound,
  neighbours,
  rulerLabel,
  shortDuration,
  snapDelta,
  snapPoints,
  sourceLength,
  timecode,
  timelineDuration,
  trackAccepts,
  trackKindFor,
  type ClipKind
} from './model'

const HEADER_W = 172
const RULER_H = 30
const GAP = 4
const NEW_ZONE = 46
const SNAP_PX = 9
// Phones: a slim header column (track controls live in a tap menu) and lanes sized for fingers.
const HEADER_W_COMPACT = 60
const NEW_ZONE_COMPACT = 34
const TRACK_H_COMPACT: Record<TimelineTrack['kind'], number> = { video: 54, audio: 44, text: 36 }
/** Finger travel before a touch counts as a drag rather than a tap. */
const TOUCH_SLOP = 8

/** Run `fn` if the pointer comes back up without travelling (a tap); a pan/cancel does nothing. */
function onTap(e: RPointerEvent, fn: () => void): void {
  const pid = e.pointerId
  const x0 = e.clientX
  const y0 = e.clientY
  let moved = false
  const move = (ev: PointerEvent): void => {
    if (ev.pointerId === pid && Math.hypot(ev.clientX - x0, ev.clientY - y0) > TOUCH_SLOP) moved = true
  }
  const done = (ev: PointerEvent): void => {
    if (ev.pointerId !== pid) return
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', done)
    window.removeEventListener('pointercancel', done)
    if (ev.type === 'pointerup' && !moved) fn()
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', done)
  window.addEventListener('pointercancel', done)
}

interface Lane {
  track: TimelineTrack
  y: number
  h: number
  index: number
}

const zoomToSlider = (z: number): number => (Math.log(z / MIN_ZOOM) / Math.log(MAX_ZOOM / MIN_ZOOM)) * 100
const sliderToZoom = (v: number): number => MIN_ZOOM * Math.pow(MAX_ZOOM / MIN_ZOOM, v / 100)

export function TimelinePanel(): React.JSX.Element {
  const tl = useEditor((s) => s.tl)!
  const zoom = useEditor((s) => s.zoom)
  const selection = useEditor((s) => s.selection)
  const snapping = useEditor((s) => s.snapping)
  const canUndo = useEditor((s) => s.past.length > 0)
  const canRedo = useEditor((s) => s.future.length > 0)
  const assets = useAssetMap()
  const compact = useCompact()
  const HW = compact ? HEADER_W_COMPACT : HEADER_W
  const hwRef = useRef(HW)
  hwRef.current = HW
  const newZone = compact ? NEW_ZONE_COMPACT : NEW_ZONE
  const trackH = compact ? TRACK_H_COMPACT : TRACK_H
  /** Phones: taps add to / remove from the selection instead of replacing it. */
  const [multi, setMulti] = useState(false)
  const multiRef = useRef(multi)
  multiRef.current = multi

  const scrollRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const headRef = useRef<HTMLDivElement>(null)
  const lineRef = useRef<HTMLDivElement>(null)
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom
  const pendingScroll = useRef<number | null>(null)
  const [viewW, setViewW] = useState(900)
  const [snapLine, setSnapLine] = useState<number | null>(null)
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const [ghost, setGhost] = useState<{ trackId: ID | null; newKind?: TimelineTrack['kind']; start: number; dur: number; kind: ClipKind | null } | null>(null)
  const [dragging, setDragging] = useState<Set<ID>>(() => new Set())
  /** Floating readout while moving/trimming: anchored at time `t` above `trackId`. */
  const [readout, setReadout] = useState<{ t: number; trackId: ID; text: string } | null>(null)

  const tracks = useMemo(() => displayTracks(tl.tracks), [tl.tracks])
  const lanes = useMemo<Lane[]>(() => {
    let y = 0
    return tracks.map((track, index) => {
      const h = trackH[track.kind]
      const lane = { track, y, h, index }
      y += h + GAP
      return lane
    })
  }, [tracks, trackH])
  const lanesH = lanes.length ? lanes[lanes.length - 1].y + lanes[lanes.length - 1].h + GAP : 0
  const duration = timelineDuration(tl)
  const contentW = Math.max((duration + 30) * zoom, viewW - HW + 1)
  const selSet = useMemo(() => new Set(selection), [selection])
  const lockedSet = useMemo(() => new Set(tl.tracks.filter((t) => t.locked).map((t) => t.id)), [tl.tracks])

  const tlRef = useRef(tl)
  tlRef.current = tl
  const lanesRef = useRef(lanes)
  lanesRef.current = lanes

  // ── geometry helpers ──
  const timeAt = useCallback((clientX: number): number => {
    const sc = scrollRef.current!
    const r = sc.getBoundingClientRect()
    return Math.max(0, (clientX - r.left + sc.scrollLeft - hwRef.current) / zoomRef.current)
  }, [])
  const laneAt = useCallback((clientY: number): Lane | null | 'below' => {
    const sc = scrollRef.current!
    const r = sc.getBoundingClientRect()
    const y = clientY - r.top + sc.scrollTop - RULER_H
    if (y < 0) return null
    for (const l of lanesRef.current) if (y >= l.y && y < l.y + l.h + GAP) return l
    return 'below'
  }, [])

  // ── view size ──
  useLayoutEffect(() => {
    const sc = scrollRef.current!
    const ro = new ResizeObserver(() => setViewW(sc.clientWidth))
    ro.observe(sc)
    setViewW(sc.clientWidth)
    return () => ro.disconnect()
  }, [])

  // ── ruler ──
  const drawRuler = useCallback(() => {
    const canvas = canvasRef.current
    const sc = scrollRef.current
    if (!canvas || !sc) return
    const w = Math.max(1, sc.clientWidth - hwRef.current)
    const h = RULER_H
    const dpr = window.devicePixelRatio || 1
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
    }
    const ctx = canvas.getContext('2d')!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    const z = zoomRef.current
    const fps = tlRef.current.fps
    const steps = [1 / fps, 2 / fps, 5 / fps, 10 / fps, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800]
    const major = steps.find((s) => s * z >= 76) ?? 3600
    const minorOpts = major <= 1 / fps + 1e-9 ? [major] : [major / 10, major / 5, major / 4, major / 2, major]
    const minor = minorOpts.find((m) => m * z >= 7 && (m >= 1 / fps - 1e-9 || major < 1)) ?? major
    const t0 = sc.scrollLeft / z
    const t1 = (sc.scrollLeft + w) / z
    const style = getComputedStyle(canvas)
    const fg3 = style.getPropertyValue('--fg-3').trim() || '#6d687c'
    const fg2 = style.getPropertyValue('--fg-2').trim() || '#aaa4b9'
    ctx.lineWidth = 1
    // minor ticks
    ctx.strokeStyle = fg3
    ctx.globalAlpha = 0.55
    ctx.beginPath()
    for (let t = Math.floor(t0 / minor) * minor; t <= t1 + minor; t += minor) {
      const x = Math.round((t - t0) * z) + 0.5
      ctx.moveTo(x, h - 5)
      ctx.lineTo(x, h)
    }
    ctx.stroke()
    // major ticks + labels
    ctx.globalAlpha = 1
    ctx.beginPath()
    ctx.font = '500 10px "JetBrains Mono Variable", monospace'
    ctx.fillStyle = fg2
    ctx.textBaseline = 'top'
    for (let t = Math.floor(t0 / major) * major; t <= t1 + major; t += major) {
      const x = Math.round((t - t0) * z) + 0.5
      ctx.moveTo(x, h - 11)
      ctx.lineTo(x, h)
      ctx.fillText(rulerLabel(t + 1e-9, fps, major < 1), x + 4, 7)
    }
    ctx.strokeStyle = fg3
    ctx.stroke()
  }, [])

  useEffect(() => {
    drawRuler()
  }, [drawRuler, zoom, viewW, tl.fps, contentW, HW])

  useLayoutEffect(() => {
    if (pendingScroll.current !== null && scrollRef.current) {
      scrollRef.current.scrollLeft = Math.max(0, pendingScroll.current)
      pendingScroll.current = null
      drawRuler()
    }
  }, [zoom, drawRuler])

  // ── playhead (outside React) ──
  useEffect(() => {
    let lastPage = 0
    return clock.onTime((t) => {
      const x = t * zoomRef.current
      const tr = `translate3d(${x}px,0,0)`
      if (headRef.current) headRef.current.style.transform = tr
      if (lineRef.current) lineRef.current.style.transform = tr
      const sc = scrollRef.current
      if (sc && clock.playing) {
        const vx = x - sc.scrollLeft
        const visible = sc.clientWidth - hwRef.current
        const now = performance.now()
        if ((vx > visible - 24 || vx < 0) && now - lastPage > 120) {
          lastPage = now
          sc.scrollLeft = Math.max(0, x - (clock.rate > 0 ? 48 : visible - 48))
        }
      }
    })
  }, [])
  useEffect(() => {
    const x = clock.time * zoom
    const tr = `translate3d(${x}px,0,0)`
    if (headRef.current) headRef.current.style.transform = tr
    if (lineRef.current) lineRef.current.style.transform = tr
  }, [zoom])

  // ── wheel zoom (Ctrl) ──
  useEffect(() => {
    const sc = scrollRef.current!
    let raf = 0
    const onScroll = (): void => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(drawRuler)
    }
    const onWheel = (e: WheelEvent): void => {
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      const r = sc.getBoundingClientRect()
      const cx = Math.max(0, e.clientX - r.left - hwRef.current)
      const z0 = zoomRef.current
      const tAt = (sc.scrollLeft + cx) / z0
      const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z0 * Math.exp(-e.deltaY * 0.0018)))
      if (z === z0) return
      pendingScroll.current = tAt * z - cx
      zoomRef.current = z
      editor.setZoom(z)
    }
    // Two-finger pinch zooms around the fingers' midpoint (touch screens).
    let pinch: { d0: number; z0: number; tAt: number; cx: number } | null = null
    let pinchRaf = 0
    let pinchZ = 0
    const spread = (t: TouchList): number => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY)
    const onTouchStart = (e: TouchEvent): void => {
      if (e.touches.length !== 2) return
      const r = sc.getBoundingClientRect()
      const cx = Math.max(0, (e.touches[0].clientX + e.touches[1].clientX) / 2 - r.left - hwRef.current)
      pinch = { d0: Math.max(1, spread(e.touches)), z0: zoomRef.current, cx, tAt: (sc.scrollLeft + cx) / zoomRef.current }
    }
    const onTouchMove = (e: TouchEvent): void => {
      if (!pinch || e.touches.length !== 2) return
      if (e.cancelable) e.preventDefault()
      pinchZ = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, (pinch.z0 * spread(e.touches)) / pinch.d0))
      if (pinchRaf) return
      pinchRaf = requestAnimationFrame(() => {
        pinchRaf = 0
        if (!pinch || Math.abs(pinchZ - zoomRef.current) < 0.001) return
        pendingScroll.current = pinch.tAt * pinchZ - pinch.cx
        zoomRef.current = pinchZ
        editor.setZoom(pinchZ)
      })
    }
    const onTouchEnd = (e: TouchEvent): void => {
      if (e.touches.length < 2) pinch = null
    }
    sc.addEventListener('wheel', onWheel, { passive: false })
    sc.addEventListener('scroll', onScroll, { passive: true })
    sc.addEventListener('touchstart', onTouchStart, { passive: true })
    sc.addEventListener('touchmove', onTouchMove, { passive: false })
    sc.addEventListener('touchend', onTouchEnd, { passive: true })
    sc.addEventListener('touchcancel', onTouchEnd, { passive: true })
    return () => {
      sc.removeEventListener('wheel', onWheel)
      sc.removeEventListener('scroll', onScroll)
      sc.removeEventListener('touchstart', onTouchStart)
      sc.removeEventListener('touchmove', onTouchMove)
      sc.removeEventListener('touchend', onTouchEnd)
      sc.removeEventListener('touchcancel', onTouchEnd)
      cancelAnimationFrame(raf)
      cancelAnimationFrame(pinchRaf)
    }
  }, [drawRuler])

  const setZoomAnchored = useCallback((z: number) => {
    const sc = scrollRef.current!
    const z0 = zoomRef.current
    const px = clock.time * z0 - sc.scrollLeft
    const visible = sc.clientWidth - hwRef.current
    const cx = px >= 0 && px <= visible ? px : 0
    const tAt = (sc.scrollLeft + cx) / z0
    pendingScroll.current = tAt * z - cx
    zoomRef.current = z
    editor.setZoom(z)
  }, [])

  const fit = useCallback(() => {
    const sc = scrollRef.current!
    const visible = sc.clientWidth - hwRef.current - (hwRef.current < HEADER_W ? 24 : 48)
    const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, visible / Math.max(1, timelineDuration(tlRef.current))))
    pendingScroll.current = 0
    zoomRef.current = z
    editor.setZoom(z)
  }, [])

  timelineControls.zoomBy = (f) => setZoomAnchored(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoomRef.current * f)))
  timelineControls.fit = fit

  // Fit once when a timeline opens
  const fittedFor = useRef<string | null>(null)
  useEffect(() => {
    if (fittedFor.current === tl.id || viewW < 200) return
    fittedFor.current = tl.id
    if (timelineDuration(tl) > 0) fit()
  }, [tl, viewW, fit])

  // ── scrubbing ──
  const scrub = useCallback(
    (e: RPointerEvent) => {
      if (e.button !== 0) return
      e.preventDefault()
      clock.pause()
      const fps = tlRef.current.fps
      const apply = (clientX: number, shift: boolean): void => {
        let t = frameRound(timeAt(clientX), fps)
        if (shift) {
          const pts = snapPoints(tlRef.current.clips, new Set(), -1)
          const s = snapDelta([t], pts, SNAP_PX / zoomRef.current)
          if (s) t = s.at
        }
        clock.seek(t)
      }
      apply(e.clientX, e.shiftKey)
      const pid = e.pointerId
      const move = (ev: PointerEvent): void => {
        if (ev.pointerId === pid) apply(ev.clientX, ev.shiftKey)
      }
      const up = (ev: PointerEvent): void => {
        if (ev.pointerId !== pid) return
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        window.removeEventListener('pointercancel', up)
        document.body.style.cursor = ''
      }
      document.body.style.cursor = 'ew-resize'
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
      window.addEventListener('pointercancel', up)
    },
    [timeAt]
  )

  // ── clip gestures ──
  const onClipDown = useCallback(
    (e: RPointerEvent, clip: TimelineClip, edge: 'l' | 'r' | null) => {
      if (e.button !== 0) return
      e.stopPropagation()
      const cur = tlRef.current
      if (lockedSet.has(clip.trackId)) return
      const touch = e.pointerType === 'touch'
      const additive = e.shiftKey || e.ctrlKey || e.metaKey || multiRef.current
      const sel = editor.get().selection
      const wasSelected = sel.includes(clip.id)
      // Touch: a finger on an unselected clip pans the timeline; a tap selects it, and a
      // selected clip (touch-action: none) can then be dragged or trimmed by its handles.
      if (touch && !edge && !wasSelected) {
        onTap(e, () => (additive ? editor.toggleSelect(clip.id) : editor.select([clip.id])))
        return
      }
      if (additive && !edge && !touch) {
        editor.toggleSelect(clip.id)
        return
      }
      const selNow = wasSelected && !edge ? sel : [clip.id]
      if (!wasSelected || edge) editor.select(selNow)

      const fps = cur.fps
      const x0 = e.clientX
      const pid = e.pointerId
      const slop = touch ? TOUCH_SLOP : 3
      const z = zoomRef.current
      let started = false
      const alt = { v: e.altKey }

      if (edge) {
        const asset = db.get('assets', clip.assetId)
        const bounded = !clip.text && asset?.kind !== 'image'
        const srcLen = bounded ? (sourceLength(asset) ?? Infinity) : Infinity
        const { prevEnd, nextStart } = neighbours(cur.clips, clip)
        const orig = { ...clip }
        const origEnd = clipEnd(clip)
        const pts = snapPoints(cur.clips, new Set([clip.id]), clock.time)
        const move = (ev: PointerEvent): void => {
          if (ev.pointerId !== pid) return
          if (!started) {
            if (Math.abs(ev.clientX - x0) < (touch ? 4 : 2)) return
            started = true
            editor.begin()
          }
          const d = (ev.clientX - x0) / z
          const useSnap = editor.get().snapping && !ev.altKey
          if (edge === 'l') {
            let s = frameRound(orig.start + d, fps)
            if (useSnap) {
              const sn = snapDelta([s], pts, SNAP_PX / z)
              if (sn) s = sn.at
              setSnapLine(sn ? sn.at : null)
            }
            const minS = Math.max(prevEnd, bounded ? orig.start - orig.in : 0, 0)
            s = Math.min(Math.max(s, minS), origEnd - 1 / fps)
            const dd = s - orig.start
            setReadout({ t: s, trackId: clip.trackId, text: `${timecode(s, fps).slice(3)} · ${shortDuration(origEnd - s)}` })
            editor.preview((t) => ({
              ...t,
              clips: t.clips.map((c) => (c.id === clip.id ? (bounded ? { ...c, start: s, in: orig.in + dd } : { ...c, start: s, out: orig.out - dd }) : c))
            }))
          } else {
            let en = frameRound(origEnd + d, fps)
            if (useSnap) {
              const sn = snapDelta([en], pts, SNAP_PX / z)
              if (sn) en = sn.at
              setSnapLine(sn ? sn.at : null)
            }
            const maxE = Math.min(nextStart, orig.start + (srcLen - orig.in))
            en = Math.max(Math.min(en, maxE), orig.start + 1 / fps)
            setReadout({ t: en, trackId: clip.trackId, text: shortDuration(en - orig.start) })
            editor.preview((t) => ({ ...t, clips: t.clips.map((c) => (c.id === clip.id ? { ...c, out: orig.out + (en - origEnd) } : c)) }))
          }
        }
        const up = (ev: PointerEvent): void => {
          if (ev.pointerId !== pid) return
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
          window.removeEventListener('pointercancel', up)
          document.body.style.cursor = ''
          setSnapLine(null)
          setReadout(null)
          if (started) editor.end()
        }
        document.body.style.cursor = 'ew-resize'
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
        window.addEventListener('pointercancel', up)
        return
      }

      // move
      const moving = cur.clips.filter((c) => selNow.includes(c.id) && !lockedSet.has(c.trackId))
      const ids = new Set(moving.map((c) => c.id))
      const origin = new Map(moving.map((c) => [c.id, { start: c.start, trackId: c.trackId }]))
      const laneIdx = new Map(lanesRef.current.map((l) => [l.track.id, l.index]))
      const kinds = new Map(moving.map((c) => [c.id, clipKind(c, db.get('assets', c.assetId))]))
      const anchorLane = laneIdx.get(clip.trackId) ?? 0
      const minStart = Math.min(...moving.map((c) => c.start))
      const pts = snapPoints(cur.clips, ids, clock.time)
      const move = (ev: PointerEvent): void => {
        if (ev.pointerId !== pid) return
        alt.v = ev.altKey
        if (!started) {
          if (Math.abs(ev.clientX - x0) < slop && Math.abs(ev.clientY - e.clientY) < slop) return
          started = true
          editor.begin()
          setDragging(ids)
        }
        let delta = frameRound((ev.clientX - x0) / z, fps)
        // track change
        const lane = laneAt(ev.clientY)
        let offset = 0
        if (lane && lane !== 'below') {
          const want = lane.index - anchorLane
          const ok = moving.every((c) => {
            const l = lanesRef.current[(laneIdx.get(c.trackId) ?? 0) + want]
            return l && !l.track.locked && trackAccepts(l.track, kinds.get(c.id)!)
          })
          if (ok) offset = want
        }
        // snapping
        if (editor.get().snapping && !ev.altKey) {
          const edges: number[] = []
          for (const c of moving) edges.push(c.start + delta, clipEnd(c) + delta)
          const sn = snapDelta(edges, pts, SNAP_PX / z)
          if (sn) delta += sn.delta
          setSnapLine(sn ? sn.at : null)
        } else setSnapLine(null)
        if (minStart + delta < 0) delta = -minStart
        const anchorTrack = offset ? lanesRef.current[anchorLane + offset].track.id : clip.trackId
        setReadout({ t: origin.get(clip.id)!.start + delta, trackId: anchorTrack, text: timecode(origin.get(clip.id)!.start + delta, fps).slice(3) })
        editor.preview((t) => ({
          ...t,
          clips: t.clips.map((c) => {
            const o = origin.get(c.id)
            if (!o) return c
            const trackId = offset ? lanesRef.current[(laneIdx.get(o.trackId) ?? 0) + offset].track.id : o.trackId
            return { ...c, start: o.start + delta, trackId }
          })
        }))
      }
      const up = (ev: PointerEvent): void => {
        if (ev.pointerId !== pid) return
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        window.removeEventListener('pointercancel', up)
        setSnapLine(null)
        setReadout(null)
        setDragging(new Set())
        if (!started) {
          // a tap on a selected clip: multi-select mode drops it, otherwise it becomes the only one
          if (ev.type === 'pointerup' && touch && multiRef.current) editor.toggleSelect(clip.id)
          else if (wasSelected && sel.length > 1) editor.select([clip.id])
          return
        }
        // overwrite whatever the moved clips landed on
        editor.end((t) => {
          let clips = t.clips
          for (const c of t.clips.filter((x) => ids.has(x.id)).sort((a, b) => a.start - b.start)) clips = carve(clips, c.trackId, c.start, clipEnd(c), ids)
          return clips === t.clips ? t : { ...t, clips }
        })
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
      window.addEventListener('pointercancel', up)
    },
    [laneAt, lockedSet]
  )

  // ── marquee / click on empty space ──
  const onLanesDown = useCallback(
    (e: RPointerEvent) => {
      if (e.button !== 0) return
      if (e.pointerType === 'touch') {
        const x = e.clientX
        onTap(e, () => {
          if (!multiRef.current) editor.select([])
          clock.pause()
          clock.seek(frameRound(timeAt(x), tlRef.current.fps))
        })
        return
      }
      const sc = scrollRef.current!
      const r = sc.getBoundingClientRect()
      const toContent = (cx: number, cy: number): { x: number; y: number } => ({ x: cx - r.left + sc.scrollLeft, y: cy - r.top + sc.scrollTop })
      const p0 = toContent(e.clientX, e.clientY)
      const additive = e.shiftKey || e.ctrlKey || e.metaKey
      const base = additive ? editor.get().selection : []
      let moved = false
      const move = (ev: PointerEvent): void => {
        const p = toContent(ev.clientX, ev.clientY)
        if (!moved && Math.hypot(p.x - p0.x, p.y - p0.y) < 4) return
        moved = true
        const m = { x0: Math.min(p0.x, p.x), y0: Math.min(p0.y, p.y), x1: Math.max(p0.x, p.x), y1: Math.max(p0.y, p.y) }
        setMarquee(m)
        const ta = (m.x0 - hwRef.current) / zoomRef.current
        const tb = (m.x1 - hwRef.current) / zoomRef.current
        const hit: ID[] = []
        for (const l of lanesRef.current) {
          if (l.track.locked) continue
          const ly0 = RULER_H + l.y
          if (ly0 + l.h < m.y0 || ly0 > m.y1) continue
          for (const c of tlRef.current.clips) if (c.trackId === l.track.id && clipEnd(c) > ta && c.start < tb) hit.push(c.id)
        }
        editor.select([...new Set([...base, ...hit])])
      }
      const up = (ev: PointerEvent): void => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        window.removeEventListener('pointercancel', up)
        setMarquee(null)
        if (!moved && ev.type === 'pointerup') {
          if (!additive) editor.select([])
          clock.pause()
          clock.seek(frameRound(timeAt(ev.clientX), tlRef.current.fps))
        }
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
      window.addEventListener('pointercancel', up)
    },
    [timeAt]
  )

  // ── drops from the assets panel / the OS ──
  const ghostKey = useRef('')
  const onDragOver = useCallback(
    (e: DragEvent) => {
      const types = e.dataTransfer.types
      const isAsset = types.includes(ASSET_MIME)
      const isFiles = types.includes('Files')
      if (!isAsset && !isFiles) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      const asset = dragState.asset
      const kind: ClipKind | null = asset ? asset.kind : null
      const z = zoomRef.current
      const range = dragState.range
      const dur = asset
        ? asset.kind === 'image'
          ? DEFAULT_STILL
          : (range?.out ?? asset.duration ?? DEFAULT_STILL) - (range?.in ?? 0)
        : DEFAULT_STILL
      let start = frameRound(timeAt(e.clientX) - (isAsset ? 0 : 0), tlRef.current.fps)
      const lane = laneAt(e.clientY)
      let trackId: ID | null = null
      let newKind: TimelineTrack['kind'] | undefined
      if (kind) {
        if (lane && lane !== 'below' && trackAccepts(lane.track, kind) && !lane.track.locked) trackId = lane.track.id
        else if (lane === 'below') newKind = trackKindFor(kind)
        else {
          const candidates = lanesRef.current.filter((l) => trackAccepts(l.track, kind) && !l.track.locked)
          const ly = lane ? lane.y : 0
          candidates.sort((a, b) => Math.abs(a.y - ly) - Math.abs(b.y - ly))
          if (candidates[0]) trackId = candidates[0].track.id
          else newKind = trackKindFor(kind)
        }
      } else if (lane && lane !== 'below') trackId = lane.track.id
      if (editor.get().snapping && !e.altKey) {
        const sn = snapDelta([start, start + dur], snapPoints(tlRef.current.clips, new Set(), clock.time), SNAP_PX / z)
        if (sn) start = Math.max(0, start + sn.delta)
      }
      const key = `${trackId}|${newKind}|${start.toFixed(3)}|${dur}`
      if (key !== ghostKey.current) {
        ghostKey.current = key
        setGhost({ trackId, newKind, start, dur, kind })
      }
    },
    [laneAt, timeAt]
  )

  const onDragLeave = useCallback((e: DragEvent) => {
    const sc = scrollRef.current
    if (sc && e.relatedTarget instanceof Node && sc.contains(e.relatedTarget)) return
    ghostKey.current = ''
    setGhost(null)
  }, [])

  const onDrop = useCallback(
    async (e: DragEvent) => {
      e.preventDefault()
      const g = ghost
      ghostKey.current = ''
      setGhost(null)
      const id = e.dataTransfer.getData(ASSET_MIME)
      const range = dragState.range
      endAssetDrag()
      const start = g?.start ?? frameRound(timeAt(e.clientX), tlRef.current.fps)
      if (id) {
        const a = db.get('assets', id)
        if (a) placeAsset(a, { start, trackId: g?.trackId ?? undefined, newTrack: !!g?.newKind, range })
        return
      }
      const accepted = new Set(Object.values(ACCEPT).flat())
      const paths = [...e.dataTransfer.files]
        .filter((f) => accepted.has(f.name.split('.').pop()?.toLowerCase() ?? ''))
        .map((f) => window.stitch.pathForFile(f))
        .filter(Boolean)
      if (!paths.length) return
      const imported = await importFiles(paths)
      let t = start
      for (const a of imported) {
        const lane = g?.trackId ? tlRef.current.tracks.find((x) => x.id === g.trackId) : undefined
        placeAsset(a, { start: t, trackId: lane && trackAccepts(lane, a.kind) ? lane.id : undefined })
        t += a.kind === 'image' ? DEFAULT_STILL : (a.duration ?? DEFAULT_STILL)
      }
    },
    [ghost, timeAt]
  )

  const ghostLane = ghost?.trackId ? lanes.find((l) => l.track.id === ghost.trackId) : undefined

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {compact ? (
        <CompactToolbar
          hasSelection={selection.length > 0}
          selection={selection}
          zoom={zoom}
          snapping={snapping}
          multi={multi}
          onMulti={setMulti}
          onZoom={setZoomAnchored}
          onFit={fit}
        />
      ) : (
        <Toolbar
          canUndo={canUndo}
          canRedo={canRedo}
          hasSelection={selection.length > 0}
          zoom={zoom}
          snapping={snapping}
          onZoom={setZoomAnchored}
          onFit={fit}
          fps={tl.fps}
          duration={duration}
        />
      )}
      <div
        ref={scrollRef}
        className={cn('relative min-h-0 flex-1 overflow-auto overscroll-contain', compact && 'touch-pan-x touch-pan-y')}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={(e) => void onDrop(e)}
      >
        <div className="relative" style={{ width: HW + contentW, minHeight: '100%', height: RULER_H + lanesH + newZone }}>
          {/* Ruler */}
          <div className="sticky top-0 z-40 flex border-b border-line bg-solid" style={{ height: RULER_H }}>
            <div className={cn('sticky left-0 z-10 flex shrink-0 items-center gap-1 border-r border-line bg-solid', compact ? 'justify-center' : 'pl-3')} style={{ width: HW }}>
              {!compact && (
                <>
                  <span className="label-caps">Tracks</span>
                  <div className="flex-1" />
                </>
              )}
              <Menu
                align="start"
                trigger={
                  <button
                    className={cn(
                      'grid place-items-center text-fg-3 transition hover:bg-white/[0.08] hover:text-fg',
                      compact ? 'size-7 rounded-lg active:bg-white/[0.08]' : 'mr-1.5 size-6 rounded-md'
                    )}
                    aria-label="Add track"
                  >
                    <Plus className="size-3.5" />
                  </button>
                }
              >
                <MenuItem icon={<Film />} onSelect={() => addTrackOf('video')}>
                  Video track
                </MenuItem>
                <MenuItem icon={<AudioLines />} onSelect={() => addTrackOf('audio')}>
                  Audio track
                </MenuItem>
                <MenuItem icon={<Type />} onSelect={() => addTrackOf('text')}>
                  Title track
                </MenuItem>
              </Menu>
            </div>
            <div className="relative cursor-ew-resize touch-none" style={{ width: contentW }} onPointerDown={scrub}>
              <canvas ref={canvasRef} className="pointer-events-none sticky block" style={{ left: HW }} />
              <div ref={headRef} className="pointer-events-none absolute top-0 left-0 z-10 will-change-transform">
                <div className="absolute top-[3px] -left-[7px] h-[15px] w-[15px] rounded-[4px] rounded-b-[8px] bg-accent shadow-[0_2px_10px_-2px_var(--accent)]" />
                <div className="absolute top-[16px] left-[-0.5px] h-[14px] w-px bg-accent" />
              </div>
            </div>
          </div>

          {/* Tracks */}
          {lanes.map((l) => (
            <div key={l.track.id} className="flex" style={{ height: l.h, marginBottom: GAP }}>
              <TrackHeader
                track={l.track}
                height={l.h}
                width={HW}
                compact={compact}
                canRemove={tl.tracks.filter((t) => t.kind === l.track.kind).length > 1 || !tl.clips.some((c) => c.trackId === l.track.id)}
              />
              <div
                className={cn('relative', l.track.kind === 'audio' ? 'bg-white/[0.018]' : l.track.kind === 'text' ? 'bg-white/[0.012]' : 'bg-white/[0.025]', l.track.locked && 'bg-[repeating-linear-gradient(135deg,transparent_0_8px,rgb(255_255_255/0.02)_8px_9px)]')}
                style={{ width: contentW }}
                onPointerDown={onLanesDown}
              >
                <LaneClips
                  track={l.track}
                  clips={tl.clips}
                  assets={assets}
                  zoom={zoom}
                  height={l.h}
                  selection={selSet}
                  dragging={dragging}
                  locked={l.track.locked}
                  compact={compact}
                  onDown={onClipDown}
                />
              </div>
            </div>
          ))}

          {/* New-track drop zone */}
          <div className="flex" style={{ height: newZone }}>
            <div className="sticky left-0 z-30 flex shrink-0 items-center gap-1 border-r border-line bg-solid px-2" style={{ width: HW }}>
              {!compact && (
                <>
              <Tooltip content="Add video track">
                <button onClick={() => addTrackOf('video')} className="flex h-7 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium text-fg-3 transition hover:bg-white/[0.06] hover:text-fg">
                  <Plus className="size-3" /> V
                </button>
              </Tooltip>
              <Tooltip content="Add audio track">
                <button onClick={() => addTrackOf('audio')} className="flex h-7 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium text-fg-3 transition hover:bg-white/[0.06] hover:text-fg">
                  <Plus className="size-3" /> A
                </button>
              </Tooltip>
              <Tooltip content="Add title track">
                <button onClick={() => addTrackOf('text')} className="flex h-7 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium text-fg-3 transition hover:bg-white/[0.06] hover:text-fg">
                  <Plus className="size-3" /> T
                </button>
              </Tooltip>
                </>
              )}
            </div>
            <div className="relative" style={{ width: contentW }} onPointerDown={onLanesDown} />
          </div>

          {/* Overlays */}
          <div
            ref={lineRef}
            className="pointer-events-none absolute z-20 w-0 will-change-transform"
            style={{ left: HW, top: RULER_H, height: lanesH + newZone - 6 }}
          >
            <div className="absolute inset-y-0 -left-px w-[1.5px] bg-accent shadow-[0_0_10px_color-mix(in_oklab,var(--accent)_60%,transparent)]" />
          </div>

          <AnimatePresence>
            {snapLine !== null && (
              <motion.div
                key="snap"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.12 }}
                className="pointer-events-none absolute z-20 w-px bg-accent-2 shadow-[0_0_8px_var(--accent-2)]"
                style={{ left: HW + snapLine * zoom, top: RULER_H - 6, height: lanesH + 6 }}
              />
            )}
          </AnimatePresence>

          {ghost && (ghostLane || ghost.newKind) && (
            <div
              className="pointer-events-none absolute z-20 rounded-[7px] border border-dashed border-[color-mix(in_oklab,var(--accent)_75%,transparent)] bg-[color-mix(in_oklab,var(--accent)_16%,transparent)] transition-[transform,width] duration-75"
              style={{
                left: HW,
                top: ghostLane ? RULER_H + ghostLane.y + 2 : RULER_H + lanesH + 4,
                height: ghostLane ? ghostLane.h - 4 : newZone - 10,
                width: Math.max(8, ghost.dur * zoom),
                transform: `translateX(${ghost.start * zoom}px)`
              }}
            >
              {ghost.newKind && <span className="absolute top-1/2 left-2 -translate-y-1/2 text-[10.5px] font-medium whitespace-nowrap text-fg-2">New {ghost.newKind} track</span>}
            </div>
          )}

          <AnimatePresence>
            {readout &&
              (() => {
                const lane = lanes.find((l) => l.track.id === readout.trackId)
                if (!lane) return null
                return (
                  <motion.div
                    key="readout"
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.12 }}
                    className="pointer-events-none absolute z-30 -translate-x-1/2 rounded-md border border-line-strong bg-[rgb(14_12_21/0.92)] px-1.5 py-0.5 font-mono text-[10.5px] whitespace-nowrap text-fg shadow-[0_6px_16px_-6px_rgb(0_0_0/0.8)]"
                    style={{ left: HW + readout.t * zoom, top: Math.max(RULER_H + 2, RULER_H + lane.y - 20) }}
                  >
                    {readout.text}
                  </motion.div>
                )
              })()}
          </AnimatePresence>

          {marquee && (
            <div
              className="pointer-events-none absolute z-20 rounded-md border border-[color-mix(in_oklab,var(--accent-2)_70%,transparent)] bg-[color-mix(in_oklab,var(--accent-2)_12%,transparent)]"
              style={{ left: marquee.x0, top: marquee.y0, width: marquee.x1 - marquee.x0, height: marquee.y1 - marquee.y0 }}
            />
          )}
        </div>

        {tl.clips.length === 0 && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, ease, delay: 0.2 }}
            className="pointer-events-none absolute inset-y-0 grid place-items-center"
            style={{ left: HW, right: 0, top: RULER_H }}
          >
            <div className="flex flex-col items-center gap-1.5 px-4 text-center">
              <div className="text-[13px] font-medium text-fg-2">{compact ? 'Add media to start cutting' : 'Drag media here to start cutting'}</div>
              <div className="text-[11.5px] text-fg-3">
                {compact ? 'Pick shots in the Media tab, then tap + or insert them at the playhead' : 'From the Assets panel, the Clip Viewer, or straight from your file explorer'}
              </div>
            </div>
          </motion.div>
        )}
      </div>
    </div>
  )
}

// ─── Clips of one lane ───────────────────────────────────────────────────────

const LaneClips = memo(function LaneClips({
  track,
  clips,
  assets,
  zoom,
  height,
  selection,
  dragging,
  locked,
  compact,
  onDown
}: {
  track: TimelineTrack
  clips: TimelineClip[]
  assets: Map<ID, Asset>
  zoom: number
  height: number
  selection: Set<ID>
  dragging: Set<ID>
  locked: boolean
  compact: boolean
  onDown: (e: RPointerEvent, clip: TimelineClip, edge: 'l' | 'r' | null) => void
}): React.JSX.Element {
  const mine = clips.filter((c) => c.trackId === track.id)
  const dimmed = track.kind === 'audio' ? track.muted : track.hidden
  return (
    <>
      {mine.map((c) => (
        <ClipItem
          key={c.id}
          clip={c}
          asset={assets.get(c.assetId)}
          zoom={zoom}
          height={height}
          selected={selection.has(c.id)}
          dragging={dragging.has(c.id)}
          locked={locked}
          dimmed={dimmed}
          compact={compact}
          onDown={onDown}
        />
      ))}
    </>
  )
})

const ClipItem = memo(function ClipItem({
  clip,
  asset,
  zoom,
  height,
  selected,
  dragging,
  locked,
  dimmed,
  compact,
  onDown
}: {
  clip: TimelineClip
  asset: Asset | undefined
  zoom: number
  height: number
  selected: boolean
  dragging: boolean
  locked: boolean
  dimmed: boolean
  compact: boolean
  onDown: (e: RPointerEvent, clip: TimelineClip, edge: 'l' | 'r' | null) => void
}): React.JSX.Element {
  const kind = clipKind(clip, asset)
  const w = Math.max(2, clipDur(clip) * zoom)
  const h = height - 4
  return (
    <motion.div
      initial={{ opacity: 0, scaleY: 0.7 }}
      animate={{ opacity: 1, scaleY: 1 }}
      transition={spring}
      className={cn(
        'group/clip absolute top-[2px]',
        dragging ? 'z-10 cursor-grabbing' : 'cursor-grab',
        locked && 'cursor-not-allowed',
        // a selected clip owns the finger (drag/trim) instead of panning the timeline
        selected && !locked && 'touch-none',
        compact && selected && !dragging && 'z-[5]'
      )}
      style={{ left: clip.start * zoom, width: w, height: h }}
      onPointerDown={(e) => onDown(e, clip, null)}
      onDoubleClick={() => asset && editor.setSource(asset.id)}
    >
      <ClipView clip={clip} asset={asset} kind={kind} zoom={zoom} height={h} selected={selected} dragging={dragging} locked={locked} dimmed={dimmed} />
      {compact ? (
        <AnimatePresence>{selected && !locked && <TouchHandles key="handles" clip={clip} flush={clip.start * zoom < 14} onDown={onDown} />}</AnimatePresence>
      ) : !locked && w > 14 && (
        <>
          <div className="absolute inset-y-0 left-0 z-[1] w-[7px] cursor-ew-resize" onPointerDown={(e) => onDown(e, clip, 'l')}>
            <div className={cn('absolute inset-y-1 left-[2px] w-[3px] rounded-full bg-white/80 opacity-0 transition-opacity duration-150 group-hover/clip:opacity-60 hover:!opacity-100', selected && 'opacity-50')} />
          </div>
          <div className="absolute inset-y-0 right-0 z-[1] w-[7px] cursor-ew-resize" onPointerDown={(e) => onDown(e, clip, 'r')}>
            <div className={cn('absolute inset-y-1 right-[2px] w-[3px] rounded-full bg-white/80 opacity-0 transition-opacity duration-150 group-hover/clip:opacity-60 hover:!opacity-100', selected && 'opacity-50')} />
          </div>
        </>
      )}
    </motion.div>
  )
})

/**
 * Phone trim handles: white brackets hugging a selected clip, each with a finger-sized hit area.
 * A clip that starts flush with the timeline start gets its in-handle tucked inside, clear of the
 * sticky track header.
 */
function TouchHandles({ clip, flush, onDown }: { clip: TimelineClip; flush: boolean; onDown: (e: RPointerEvent, clip: TimelineClip, edge: 'l' | 'r' | null) => void }): React.JSX.Element {
  return (
    <>
      {(['l', 'r'] as const).map((edge) => (
        <motion.div
          key={edge}
          initial={{ opacity: 0, scaleY: 0.6 }}
          animate={{ opacity: 1, scaleY: 1 }}
          exit={{ opacity: 0, scaleY: 0.6 }}
          transition={spring}
          className={cn('absolute -inset-y-[2px] z-[2] w-7 touch-none', edge === 'r' ? '-right-4' : flush ? 'left-0' : '-left-4')}
          onPointerDown={(e) => onDown(e, clip, edge)}
        >
          <div
            className={cn(
              'absolute inset-y-0 grid w-3 place-items-center bg-white shadow-[0_2px_10px_-2px_rgb(0_0_0/0.7)]',
              edge === 'r' ? 'left-4 rounded-r-[6px]' : flush ? 'left-0 rounded-l-[6px]' : 'right-4 rounded-l-[6px]'
            )}
          >
            <span className="h-3.5 w-[2px] rounded-full bg-black/45" />
          </div>
        </motion.div>
      ))}
    </>
  )
}

// ─── Track header ────────────────────────────────────────────────────────────

function TrackHeader({ track, height, width, compact: phone, canRemove }: { track: TimelineTrack; height: number; width: number; compact: boolean; canRemove: boolean }): React.JSX.Element {
  const icon = track.kind === 'video' ? <Film /> : track.kind === 'audio' ? <AudioLines /> : <Type />
  const tone = track.kind === 'audio' ? 'var(--accent)' : track.kind === 'text' ? 'color-mix(in oklab, var(--accent) 45%, #fff)' : 'var(--accent-2)'
  const compact = height < 44
  if (phone) return <CompactTrackHeader track={track} width={width} icon={icon} tone={tone} canRemove={canRemove} />
  return (
    <div className="group/th sticky left-0 z-30 flex shrink-0 items-center gap-1.5 border-r border-line bg-solid pr-1.5 pl-2.5" style={{ width }}>
      <span
        className="grid size-6 shrink-0 place-items-center rounded-md [&>svg]:size-3"
        style={{ background: `color-mix(in oklab, ${tone} 18%, transparent)`, color: tone, boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${tone} 35%, transparent)` }}
      >
        {icon}
      </span>
      <span className="w-7 text-[12px] font-semibold tabular-nums">{track.name}</span>
      <div className="flex-1" />
      <div className={cn('flex items-center', compact ? 'gap-0' : 'gap-0.5')}>
        {track.kind !== 'audio' && (
          <HeaderToggle label={track.hidden ? 'Show track' : 'Hide track'} on={track.hidden} onClick={() => patchTrack(track.id, { hidden: !track.hidden })}>
            {track.hidden ? <EyeOff /> : <Eye />}
          </HeaderToggle>
        )}
        {track.kind !== 'text' && (
          <HeaderToggle label={track.muted ? 'Unmute track' : 'Mute track'} on={track.muted} onClick={() => patchTrack(track.id, { muted: !track.muted })}>
            {track.muted ? <VolumeX /> : <Volume2 />}
          </HeaderToggle>
        )}
        <HeaderToggle label={track.locked ? 'Unlock track' : 'Lock track'} on={track.locked} onClick={() => patchTrack(track.id, { locked: !track.locked })}>
          {track.locked ? <Lock /> : <Unlock />}
        </HeaderToggle>
        {canRemove && (
          <button
            aria-label="Remove track"
            title="Remove track"
            onClick={() => removeTrack(track.id)}
            className="grid size-6 place-items-center rounded-md text-fg-3 opacity-0 transition hover:bg-danger/15 hover:text-danger group-hover/th:opacity-100"
          >
            <X className="size-3" />
          </button>
        )}
      </div>
    </div>
  )
}

/** Phone track header: badge + name; tap for hide / mute / lock / remove. */
function CompactTrackHeader({ track, width, icon, tone, canRemove }: { track: TimelineTrack; width: number; icon: React.ReactNode; tone: string; canRemove: boolean }): React.JSX.Element {
  const flags = [track.hidden && <EyeOff key="h" />, track.muted && <VolumeX key="m" />, track.locked && <Lock key="l" />].filter(Boolean)
  return (
    <Menu
      align="start"
      trigger={
        <button
          className="sticky left-0 z-30 flex shrink-0 flex-col items-center justify-center gap-1 border-r border-line bg-solid transition-colors active:bg-white/[0.06]"
          style={{ width }}
          aria-label={`${track.name} track options`}
        >
          <span className="flex items-center gap-1">
            <span
              className="grid size-5 shrink-0 place-items-center rounded-md [&>svg]:size-2.5"
              style={{ background: `color-mix(in oklab, ${tone} 18%, transparent)`, color: tone, boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${tone} 35%, transparent)` }}
            >
              {icon}
            </span>
            <span className="text-[11px] font-semibold tabular-nums">{track.name}</span>
          </span>
          {flags.length > 0 && <span className="flex items-center gap-1 text-accent [&>svg]:size-2.5">{flags}</span>}
        </button>
      }
    >
      {track.kind !== 'audio' && (
        <MenuItem icon={track.hidden ? <Eye /> : <EyeOff />} onSelect={() => patchTrack(track.id, { hidden: !track.hidden })}>
          {track.hidden ? 'Show track' : 'Hide track'}
        </MenuItem>
      )}
      {track.kind !== 'text' && (
        <MenuItem icon={track.muted ? <Volume2 /> : <VolumeX />} onSelect={() => patchTrack(track.id, { muted: !track.muted })}>
          {track.muted ? 'Unmute track' : 'Mute track'}
        </MenuItem>
      )}
      <MenuItem icon={track.locked ? <Unlock /> : <Lock />} onSelect={() => patchTrack(track.id, { locked: !track.locked })}>
        {track.locked ? 'Unlock track' : 'Lock track'}
      </MenuItem>
      {canRemove && (
        <>
          <MenuSeparator />
          <MenuItem icon={<X />} danger onSelect={() => removeTrack(track.id)}>
            Remove track
          </MenuItem>
        </>
      )}
    </Menu>
  )
}

function HeaderToggle({ label, on, onClick, children }: { label: string; on: boolean; onClick: () => void; children: React.ReactNode }): React.JSX.Element {
  return (
    <button
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        'grid size-6 place-items-center rounded-md transition-colors duration-150 [&>svg]:size-3.5',
        on ? 'bg-[color-mix(in_oklab,var(--accent)_16%,transparent)] text-accent' : 'text-fg-3 hover:bg-white/[0.07] hover:text-fg'
      )}
    >
      {children}
    </button>
  )
}

// ─── Toolbar ─────────────────────────────────────────────────────────────────

function LiveTimecode({ fps, className }: { fps: number; className?: string }): React.JSX.Element {
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(
    () =>
      clock.onTime((t) => {
        if (ref.current) ref.current.textContent = timecode(t, fps)
      }),
    [fps]
  )
  return <span ref={ref} className={className} />
}

/** Phone toolbar: every keyboard-only edit gets a finger-sized button or a menu entry. */
function CompactToolbar({
  hasSelection,
  selection,
  zoom,
  snapping,
  multi,
  onMulti,
  onZoom,
  onFit
}: {
  hasSelection: boolean
  selection: ID[]
  zoom: number
  snapping: boolean
  multi: boolean
  onMulti: (v: boolean) => void
  onZoom: (z: number) => void
  onFit: () => void
}): React.JSX.Element {
  const single = useEditor((s) => (s.selection.length === 1 ? s.tl?.clips.find((c) => c.id === s.selection[0]) : undefined))
  const btn = 'size-8 shrink-0 rounded-[10px] active:bg-white/[0.08] [&>svg]:size-4'
  return (
    <div className="flex h-11 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-line px-1.5">
      <AnimatePresence initial={false}>
        {multi && (
          <motion.button
            key="multi"
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            transition={spring}
            onClick={() => onMulti(false)}
            className="mr-0.5 flex h-7 shrink-0 items-center gap-1 rounded-full border border-[color-mix(in_oklab,var(--accent)_45%,transparent)] bg-[color-mix(in_oklab,var(--accent)_14%,transparent)] pr-1.5 pl-2 text-[11px] font-semibold text-fg"
            aria-label="Leave multi-select"
          >
            <ListChecks className="size-3.5 text-accent" />
            <span className="tabular-nums">{selection.length}</span>
            <X className="size-3 text-fg-3" />
          </motion.button>
        )}
      </AnimatePresence>
      <IconButton label="Split at playhead" className={btn} onClick={splitAtPlayhead}>
        <Scissors />
      </IconButton>
      <IconButton label="Duplicate" className={btn} disabled={!hasSelection} onClick={duplicateSelection}>
        <Copy />
      </IconButton>
      <IconButton label="Delete" className={btn} disabled={!hasSelection} onClick={() => deleteSelection(false)}>
        <Trash2 />
      </IconButton>
      <IconButton label="Add title" className={btn} onClick={addTitle}>
        <Type />
      </IconButton>
      <IconButton label="Snapping" className={cn(btn, snapping && 'text-accent')} active={snapping} onClick={() => useEditor.setState({ snapping: !snapping })}>
        <Magnet />
      </IconButton>
      <div className="min-w-1 flex-1" />
      <IconButton label="Zoom out" className={btn} onClick={() => onZoom(Math.max(MIN_ZOOM, zoom / 1.5))}>
        <ZoomOut />
      </IconButton>
      <IconButton label="Zoom in" className={btn} onClick={() => onZoom(Math.min(MAX_ZOOM, zoom * 1.5))}>
        <ZoomIn />
      </IconButton>
      <IconButton label="Fit timeline" className={btn} onClick={onFit}>
        <Maximize2 />
      </IconButton>
      <Menu
        align="end"
        trigger={
          <IconButton label="More edit actions" className={btn}>
            <MoreHorizontal />
          </IconButton>
        }
      >
        <MenuCheck checked={multi} onChange={onMulti}>
          Select multiple
        </MenuCheck>
        <MenuItem icon={<ListChecks />} onSelect={selectAll}>
          Select all
        </MenuItem>
        <MenuItem icon={<X />} disabled={!hasSelection} onSelect={() => editor.select([])}>
          Clear selection
        </MenuItem>
        <MenuSeparator />
        <MenuItem icon={<Trash2 />} disabled={!hasSelection} onSelect={() => deleteSelection(true)}>
          Ripple delete
        </MenuItem>
        <MenuItem icon={<MonitorPlay />} disabled={!single?.assetId} onSelect={() => single?.assetId && editor.setSource(single.assetId)}>
          Open in Clip Viewer
        </MenuItem>
        <MenuSeparator />
        <MenuItem icon={<ChevronsLeft />} onSelect={() => jumpToEdit(-1)}>
          Previous cut
        </MenuItem>
        <MenuItem icon={<ChevronsRight />} onSelect={() => jumpToEdit(1)}>
          Next cut
        </MenuItem>
      </Menu>
    </div>
  )
}

function Toolbar({
  canUndo,
  canRedo,
  hasSelection,
  zoom,
  snapping,
  onZoom,
  onFit,
  fps,
  duration
}: {
  canUndo: boolean
  canRedo: boolean
  hasSelection: boolean
  zoom: number
  snapping: boolean
  onZoom: (z: number) => void
  onFit: () => void
  fps: number
  duration: number
}): React.JSX.Element {
  const tip = (label: string, key?: string): React.ReactNode => (
    <span className="flex items-center gap-2">
      {label}
      {key && <Kbd>{key}</Kbd>}
    </span>
  )
  return (
    <div className="flex h-11 shrink-0 items-center gap-1 border-b border-line px-2.5">
      <Tooltip content={tip('Undo', 'Ctrl Z')}>
        <IconButton label="Undo" size="sm" disabled={!canUndo} onClick={() => editor.undo()}>
          <Undo2 className="size-3.5" />
        </IconButton>
      </Tooltip>
      <Tooltip content={tip('Redo', 'Ctrl ⇧ Z')}>
        <IconButton label="Redo" size="sm" disabled={!canRedo} onClick={() => editor.redo()}>
          <Redo2 className="size-3.5" />
        </IconButton>
      </Tooltip>
      <div className="mx-1.5 h-4 w-px bg-line" />
      <Tooltip content={tip('Split at playhead', 'S')}>
        <IconButton label="Split" size="sm" onClick={splitAtPlayhead}>
          <Scissors className="size-3.5" />
        </IconButton>
      </Tooltip>
      <Tooltip content={tip('Duplicate', 'Ctrl D')}>
        <IconButton label="Duplicate" size="sm" disabled={!hasSelection} onClick={duplicateSelection}>
          <Copy className="size-3.5" />
        </IconButton>
      </Tooltip>
      <Tooltip content={tip('Delete', 'Del · ⇧Del ripples')}>
        <IconButton label="Delete" size="sm" disabled={!hasSelection} onClick={(e) => deleteSelection(e.shiftKey)}>
          <Trash2 className="size-3.5" />
        </IconButton>
      </Tooltip>
      <div className="mx-1.5 h-4 w-px bg-line" />
      <Tooltip content={tip('Add title', 'T')}>
        <IconButton label="Add title" size="sm" onClick={addTitle}>
          <Type className="size-3.5" />
        </IconButton>
      </Tooltip>
      <Tooltip content={tip(snapping ? 'Snapping on — hold Alt to bypass' : 'Snapping off', 'N')}>
        <IconButton label="Snapping" size="sm" active={snapping} className={cn(snapping && 'text-accent')} onClick={() => useEditor.setState({ snapping: !snapping })}>
          <Magnet className="size-3.5" />
        </IconButton>
      </Tooltip>

      <div className="flex flex-1 items-center justify-center gap-2 font-mono text-[11.5px] tabular-nums">
        <LiveTimecode fps={fps} className="text-fg" />
        <span className="text-fg-3">/</span>
        <span className="text-fg-3">{timecode(duration, fps)}</span>
      </div>

      <Tooltip content="Zoom out">
        <IconButton label="Zoom out" size="sm" onClick={() => onZoom(Math.max(MIN_ZOOM, zoom / 1.5))}>
          <ZoomOut className="size-3.5" />
        </IconButton>
      </Tooltip>
      <Slider className="w-32" min={0} max={100} step={0.5} value={zoomToSlider(zoom)} onChange={(v) => onZoom(sliderToZoom(v))} />
      <Tooltip content="Zoom in">
        <IconButton label="Zoom in" size="sm" onClick={() => onZoom(Math.min(MAX_ZOOM, zoom * 1.5))}>
          <ZoomIn className="size-3.5" />
        </IconButton>
      </Tooltip>
      <Tooltip content={tip('Fit timeline', '⇧ Z')}>
        <IconButton label="Fit" size="sm" onClick={onFit}>
          <Maximize2 className="size-3.5" />
        </IconButton>
      </Tooltip>
    </div>
  )
}

