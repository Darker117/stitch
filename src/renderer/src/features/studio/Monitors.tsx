// Clip Viewer (source monitor) and Timeline Viewer (program monitor).
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import {
  ArrowDownToLine,
  Clapperboard,
  Expand,
  ListPlus,
  MousePointerClick,
  Pause,
  Play,
  Repeat,
  SkipBack,
  SkipForward,
  StepBack,
  StepForward,
  Volume2,
  VolumeX,
  X
} from 'lucide-react'
import type { Asset } from '@shared/types'
import { fileUrl } from '@/lib/api'
import { cn } from '@/lib/utils'
import { ease, spring } from '@/lib/motion'
import { useDoc } from '@/stores/db'
import { IconButton } from '@/components/ui/button'
import { Tooltip } from '@/components/ui/overlay'
import { Badge, Kbd } from '@/components/ui/misc'
import { kindIcon } from '@/components/media'
import { clock, useClockPlaying } from './clock'
import { Engine } from './engine'
import { endAssetDrag, startAssetDrag, useAssetMap } from './helpers'
import { usePeaks } from './media-cache'
import { usePreviewPath } from './proxy'
import { placeAsset } from './actions'
import { programControls, sourceControls } from './controls'
import { editor, useEditor } from './store'
import { DEFAULT_STILL, timecode, timelineDuration } from './model'

// ─── Shared chrome ───────────────────────────────────────────────────────────

function MonitorFrame({
  title,
  subtitle,
  focused,
  actions,
  children,
  transport,
  onPointerDown
}: {
  title: string
  subtitle?: ReactNode
  focused: boolean
  actions?: ReactNode
  children: ReactNode
  transport: ReactNode
  onPointerDown?: () => void
}): React.JSX.Element {
  return (
    <section
      onPointerDownCapture={onPointerDown}
      className={cn(
        'relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[14px] border bg-black/25 transition-[border-color,box-shadow] duration-300',
        focused ? 'border-[color-mix(in_oklab,var(--accent)_32%,var(--line))] shadow-[0_0_0_1px_color-mix(in_oklab,var(--accent)_10%,transparent)]' : 'border-line'
      )}
    >
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
        <span className={cn('size-1.5 rounded-full transition-colors duration-300', focused ? 'bg-accent shadow-[0_0_8px_var(--accent)]' : 'bg-white/15')} />
        <span className="label-caps shrink-0 whitespace-nowrap text-fg-2">{title}</span>
        {subtitle && <span className="min-w-0 truncate text-[11.5px] text-fg-3">{subtitle}</span>}
        <div className="flex-1" />
        <div className="flex shrink-0 items-center gap-1.5">{actions}</div>
      </header>
      {children}
      {transport}
    </section>
  )
}

function useFitBox(ref: React.RefObject<HTMLDivElement | null>, aspect: number): { w: number; h: number } {
  const [box, setBox] = useState({ w: 0, h: 0 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = (): void => {
      const pad = 12
      const W = Math.max(0, el.clientWidth - pad * 2)
      const H = Math.max(0, el.clientHeight - pad * 2)
      let w = W
      let h = w / aspect
      if (h > H) {
        h = H
        w = h * aspect
      }
      setBox((b) => (Math.abs(b.w - w) < 0.5 && Math.abs(b.h - h) < 0.5 ? b : { w: Math.floor(w), h: Math.floor(h) }))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref, aspect])
  return box
}

function TransportButton({ label, onClick, children, big, active, disabled }: { label: ReactNode; onClick: () => void; children: ReactNode; big?: boolean; active?: boolean; disabled?: boolean }): React.JSX.Element {
  return (
    <Tooltip content={label}>
      <motion.button
        whileTap={{ scale: 0.88 }}
        transition={spring}
        disabled={disabled}
        onClick={onClick}
        className={cn(
          'grid place-items-center rounded-full transition-[background,color,box-shadow] duration-200 disabled:opacity-35',
          big
            ? 'size-8.5 bg-white text-black shadow-[0_6px_20px_-6px_rgb(255_255_255/0.4)] hover:bg-white/90 [&>svg]:size-3.5'
            : cn('size-7 text-fg-2 hover:bg-white/[0.08] hover:text-fg [&>svg]:size-3.5', active && 'text-accent')
        )}
      >
        {children}
      </motion.button>
    </Tooltip>
  )
}

function tip(label: string, key?: string): ReactNode {
  return (
    <span className="flex items-center gap-2">
      {label}
      {key && <Kbd>{key}</Kbd>}
    </span>
  )
}

// ─── Timeline Viewer (program) ───────────────────────────────────────────────

export function TimelineViewer(): React.JSX.Element {
  const tl = useEditor((s) => s.tl)!
  const focused = useEditor((s) => s.focus === 'program')
  const assets = useAssetMap()
  const wrapRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const tcRef = useRef<HTMLSpanElement>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const engine = useMemo(() => new Engine(), [])
  const { playing, rate } = useClockPlaying()
  const [loop, setLoop] = useState(clock.loop)
  const [muted, setMuted] = useState(false)
  const box = useFitBox(wrapRef, tl.width / tl.height)
  const duration = timelineDuration(tl)
  const durRef = useRef(duration)
  durRef.current = duration

  useEffect(() => {
    engine.attach(stageRef.current!)
    return () => engine.detach()
  }, [engine])
  useEffect(() => {
    engine.setTimeline(tl, (id) => assets.get(id))
  }, [tl, assets, engine])
  useEffect(() => {
    engine.setMonitorVolume(1, muted)
  }, [muted, engine])
  useEffect(() => {
    stageRef.current?.style.setProperty('--k', String(box.h / tl.height || 0.5))
  }, [box.h, tl.height])
  useEffect(
    () =>
      clock.onTime((t) => {
        if (tcRef.current) tcRef.current.textContent = timecode(t, tl.fps)
        if (barRef.current) barRef.current.style.transform = `scaleX(${durRef.current > 0 ? Math.min(1, t / durRef.current) : 0})`
      }),
    [tl.fps]
  )

  programControls.fullscreen = () => void wrapRef.current?.requestFullscreen?.()

  const seekBar = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    const apply = (x: number): void => {
      const r = el.getBoundingClientRect()
      clock.seek(Math.round(((x - r.left) / r.width) * durRef.current * clock.fps) / clock.fps)
    }
    clock.pause()
    apply(e.clientX)
    const move = (ev: PointerEvent): void => apply(ev.clientX)
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }, [])

  return (
    <MonitorFrame
      title="Timeline Viewer"
      subtitle={tl.name}
      focused={focused}
      onPointerDown={() => useEditor.setState({ focus: 'program' })}
      actions={
        <Badge tone="outline" className="font-mono">
          {tl.width}×{tl.height} · {tl.fps}
        </Badge>
      }
      transport={
        <div className="shrink-0">
          <div className="group/bar relative h-3 cursor-pointer px-3" onPointerDown={seekBar}>
            <div className="absolute inset-x-3 top-1/2 h-[3px] -translate-y-1/2 overflow-hidden rounded-full bg-white/[0.08] transition-[height] duration-200 group-hover/bar:h-[5px]">
              <div ref={barRef} className="h-full w-full origin-left bg-grad will-change-transform" style={{ transform: 'scaleX(0)' }} />
            </div>
          </div>
          <div className="flex h-11 items-center gap-1 px-3">
            <span ref={tcRef} className="w-[88px] font-mono text-[11.5px] text-fg tabular-nums">
              00:00:00:00
            </span>
            <div className="flex flex-1 items-center justify-center gap-0.5">
              <TransportButton label={tip('Go to start', 'Home')} onClick={() => (clock.pause(), clock.seek(0))}>
                <SkipBack />
              </TransportButton>
              <TransportButton label={tip('Previous frame', '←')} onClick={() => clock.step(-1)}>
                <StepBack />
              </TransportButton>
              <TransportButton big label={tip(playing ? 'Pause' : 'Play', 'Space')} onClick={() => clock.toggle()} disabled={duration <= 0}>
                <AnimatePresence mode="popLayout" initial={false}>
                  <motion.span key={playing ? 'p' : 'l'} initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.4, opacity: 0 }} transition={{ duration: 0.16, ease }}>
                    {playing ? <Pause className="size-3.5 fill-current" /> : <Play className="ml-0.5 size-3.5 fill-current" />}
                  </motion.span>
                </AnimatePresence>
              </TransportButton>
              <TransportButton label={tip('Next frame', '→')} onClick={() => clock.step(1)}>
                <StepForward />
              </TransportButton>
              <TransportButton label={tip('Go to end', 'End')} onClick={() => (clock.pause(), clock.seek(clock.end))}>
                <SkipForward />
              </TransportButton>
            </div>
            <div className="flex w-[88px] items-center justify-end gap-0.5">
              {playing && Math.abs(rate) !== 1 && <span className="mr-1 font-mono text-[10.5px] text-accent">{rate > 0 ? `${rate}×` : `◀ ${-rate}×`}</span>}
              <TransportButton
                label="Loop playback"
                active={loop}
                onClick={() => {
                  clock.loop = !clock.loop
                  setLoop(clock.loop)
                }}
              >
                <Repeat />
              </TransportButton>
              <TransportButton label={muted ? 'Unmute monitor' : 'Mute monitor'} onClick={() => setMuted((m) => !m)}>
                {muted ? <VolumeX /> : <Volume2 />}
              </TransportButton>
              <TransportButton label="Full screen" onClick={() => programControls.fullscreen()}>
                <Expand />
              </TransportButton>
            </div>
          </div>
        </div>
      }
    >
      <div ref={wrapRef} className="relative grid min-h-0 flex-1 place-items-center bg-black/35" onDoubleClick={() => programControls.fullscreen()}>
        <div
          ref={stageRef}
          className="relative overflow-hidden bg-black shadow-[0_20px_50px_-20px_rgb(0_0_0/0.9)] ring-1 ring-white/[0.06]"
          style={{ width: box.w, height: box.h, containerType: 'size' }}
          onClick={() => clock.toggle()}
        />
        <AnimatePresence>
          {duration <= 0 && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3, ease }}
              className="pointer-events-none absolute inset-0 grid place-items-center"
            >
              <div className="flex flex-col items-center gap-2 text-fg-3">
                <Clapperboard className="size-6" strokeWidth={1.5} />
                <span className="text-[12px]">Your cut plays here</span>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </MonitorFrame>
  )
}

// ─── Clip Viewer (source) ────────────────────────────────────────────────────


export function ClipViewer(): React.JSX.Element {
  const sourceId = useEditor((s) => s.sourceId)
  const asset = useDoc('assets', sourceId)
  const focused = useEditor((s) => s.focus === 'source')
  return (
    <MonitorFrame
      title="Clip Viewer"
      subtitle={asset?.name}
      focused={focused}
      onPointerDown={() => asset && useEditor.setState({ focus: 'source' })}
      actions={
        asset && (
          <>
            <Badge className="gap-1 capitalize">
              {kindIcon(asset.kind, 'size-2.5')}
              {asset.kind}
            </Badge>
            <IconButton label="Close" size="xs" onClick={() => editor.setSource(null)}>
              <X className="size-3" />
            </IconButton>
          </>
        )
      }
      transport={null}
    >
      <AnimatePresence mode="wait" initial={false}>
        {asset ? (
          <motion.div key={asset.id} className="flex min-h-0 flex-1 flex-col" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2, ease }}>
            <SourcePlayer asset={asset} />
          </motion.div>
        ) : (
          <motion.div key="empty" className="grid min-h-0 flex-1 place-items-center bg-black/25" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <div className="flex max-w-[240px] flex-col items-center gap-2.5 text-center">
              <div className="glass hairline grid size-11 place-items-center rounded-2xl text-fg-2">
                <MousePointerClick className="size-4.5" />
              </div>
              <div className="text-[12.5px] font-medium text-fg-2">Pick a clip to preview</div>
              <div className="text-[11.5px] text-fg-3">
                Click an asset, mark <Kbd>I</Kbd> in and <Kbd>O</Kbd> out, then insert it at the playhead or drag it down.
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </MonitorFrame>
  )
}

function SourcePlayer({ asset }: { asset: Asset }): React.JSX.Element {
  const marks = useEditor((s) => s.marks[asset.id])
  const wrapRef = useRef<HTMLDivElement>(null)
  const mediaRef = useRef<HTMLVideoElement & HTMLAudioElement>(null)
  const tcRef = useRef<HTMLSpanElement>(null)
  const headRef = useRef<HTMLDivElement>(null)
  const [playing, setPlaying] = useState(false)
  const [dur, setDur] = useState(asset.kind === 'image' ? DEFAULT_STILL : (asset.duration ?? 0))
  const aspect = asset.width && asset.height ? asset.width / asset.height : asset.kind === 'audio' ? 16 / 9 : 16 / 9
  const box = useFitBox(wrapRef, aspect)
  const fps = useEditor((s) => s.tl?.fps ?? 30)
  const peaks = usePeaks(asset, asset.kind === 'audio')
  const isMedia = asset.kind !== 'image'
  const mediaPath = usePreviewPath(asset)
  const lastTime = useRef(0)

  const paint = useCallback(
    (t: number) => {
      lastTime.current = t
      if (tcRef.current) tcRef.current.textContent = timecode(t, fps)
      if (headRef.current) headRef.current.style.left = `${dur > 0 ? (t / dur) * 100 : 0}%`
    },
    [dur, fps]
  )

  // rAF while playing
  useEffect(() => {
    if (!playing) return
    let raf = 0
    const loop = (): void => {
      const m = mediaRef.current
      if (m) {
        paint(m.currentTime)
        const out = useEditor.getState().marks[asset.id]?.out
        if (out !== undefined && m.currentTime >= out) {
          m.pause()
          m.currentTime = out
        }
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [playing, paint, asset.id])

  // one monitor plays at a time
  useEffect(
    () =>
      clock.onState(() => {
        if (clock.playing) mediaRef.current?.pause()
      }),
    []
  )

  const seek = useCallback(
    (t: number) => {
      const m = mediaRef.current
      const c = Math.max(0, Math.min(dur, t))
      if (m) m.currentTime = c
      paint(c)
    },
    [dur, paint]
  )

  const toggle = useCallback(() => {
    const m = mediaRef.current
    if (!m) return
    if (m.paused) {
      clock.pause()
      const mk = useEditor.getState().marks[asset.id]
      if (mk?.out !== undefined && m.currentTime >= mk.out - 0.02) m.currentTime = mk.in ?? 0
      else if (mk?.in !== undefined && m.currentTime < mk.in) m.currentTime = mk.in
      void m.play()
    } else m.pause()
  }, [asset.id])

  const current = (): number => mediaRef.current?.currentTime ?? 0
  const range = (): { in?: number; out?: number } => {
    const mk = useEditor.getState().marks[asset.id]
    return asset.kind === 'image' ? {} : { in: mk?.in, out: mk?.out }
  }

  useEffect(() => {
    sourceControls.active = true
    sourceControls.toggle = toggle
    sourceControls.markIn = () => isMedia && editor.setMark(asset.id, 'in', Math.round(current() * fps) / fps)
    sourceControls.markOut = () => isMedia && editor.setMark(asset.id, 'out', Math.round(current() * fps) / fps)
    sourceControls.step = (f) => {
      mediaRef.current?.pause()
      seek(current() + f / fps)
    }
    sourceControls.insert = (overwrite) => placeAsset(asset, { range: range(), insert: !overwrite })
    return () => {
      sourceControls.active = false
    }
  })

  const scrubBar = (e: React.PointerEvent<HTMLDivElement>): void => {
    const el = e.currentTarget
    mediaRef.current?.pause()
    const apply = (x: number): void => {
      const r = el.getBoundingClientRect()
      seek(((x - r.left) / r.width) * dur)
    }
    apply(e.clientX)
    const move = (ev: PointerEvent): void => apply(ev.clientX)
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const inPct = marks?.in !== undefined && dur ? (marks.in / dur) * 100 : 0
  const outPct = marks?.out !== undefined && dur ? (marks.out / dur) * 100 : 100
  const markedLen = (marks?.out ?? dur) - (marks?.in ?? 0)

  return (
    <>
      <div ref={wrapRef} className="relative grid min-h-0 flex-1 place-items-center bg-black/35">
        <div
          draggable
          onDragStart={(e) => startAssetDrag(e, asset, range())}
          onDragEnd={endAssetDrag}
          onClick={() => isMedia && toggle()}
          className="relative cursor-grab overflow-hidden bg-black shadow-[0_20px_50px_-20px_rgb(0_0_0/0.9)] ring-1 ring-white/[0.06] active:cursor-grabbing"
          style={{ width: box.w, height: box.h }}
        >
          {asset.kind === 'video' && (
            <video
              ref={mediaRef}
              src={fileUrl(mediaPath)}
              poster={asset.thumbPath ? fileUrl(asset.thumbPath) : undefined}
              preload="auto"
              playsInline
              className="pointer-events-none size-full object-contain"
              onLoadedMetadata={(e) => {
                const v = e.currentTarget
                if (Number.isFinite(v.duration)) setDur(v.duration)
                // keep the position when the proxy replaces the original
                if (lastTime.current > 0) v.currentTime = lastTime.current
              }}
              onPlay={() => setPlaying(true)}
              onPause={(e) => {
                setPlaying(false)
                paint(e.currentTarget.currentTime)
              }}
              onSeeked={(e) => paint(e.currentTarget.currentTime)}
            />
          )}
          {asset.kind === 'image' && <img src={fileUrl(asset.path)} alt="" draggable={false} className="pointer-events-none size-full object-contain" />}
          {asset.kind === 'audio' && (
            <div className="pointer-events-none relative size-full bg-[radial-gradient(ellipse_at_center,color-mix(in_oklab,var(--accent)_14%,transparent),transparent_70%)]">
              <audio
                ref={mediaRef}
                src={fileUrl(asset.path)}
                preload="auto"
                onLoadedMetadata={(e) => Number.isFinite(e.currentTarget.duration) && setDur(e.currentTarget.duration)}
                onPlay={() => setPlaying(true)}
                onPause={(e) => {
                  setPlaying(false)
                  paint(e.currentTarget.currentTime)
                }}
                onSeeked={(e) => paint(e.currentTarget.currentTime)}
              />
              {peaks ? (
                <svg className="absolute inset-x-4 top-[18%] h-[64%] w-[calc(100%-2rem)]" viewBox={`0 0 ${peaks.data.length} 1`} preserveAspectRatio="none">
                  <defs>
                    <linearGradient id="src-wave" x1="0" x2="1" y1="0" y2="0">
                      <stop offset="0%" stopColor="var(--accent-2)" />
                      <stop offset="100%" stopColor="var(--accent)" />
                    </linearGradient>
                  </defs>
                  <path d={peaks.path} fill="url(#src-wave)" />
                </svg>
              ) : (
                <div className="absolute inset-0 grid place-items-center text-fg-3">{kindIcon('audio', 'size-6')}</div>
              )}
            </div>
          )}
          <AnimatePresence>
            {isMedia && !playing && (
              <motion.div
                initial={{ opacity: 0, scale: 0.85 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 1.1 }}
                transition={{ duration: 0.2, ease }}
                className="pointer-events-none absolute inset-0 grid place-items-center"
              >
                <span className="grid size-10 place-items-center rounded-full bg-black/45 text-white ring-1 ring-white/20 backdrop-blur-md">
                  <Play className="ml-0.5 size-4 fill-current" />
                </span>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      <div className="@container shrink-0">
        {isMedia ? (
          <div className="group/bar relative mx-3 h-3 cursor-pointer" onPointerDown={scrubBar}>
            <div className="absolute inset-x-0 top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-white/[0.08] transition-[height] duration-200 group-hover/bar:h-[5px]" />
            <div
              className="absolute top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-grad opacity-80 transition-[height] duration-200 group-hover/bar:h-[5px]"
              style={{ left: `${inPct}%`, width: `${Math.max(0, outPct - inPct)}%` }}
            />
            {marks?.in !== undefined && <div className="absolute top-0 h-3 w-[2px] -translate-x-1/2 rounded-full bg-accent-2" style={{ left: `${inPct}%` }} />}
            {marks?.out !== undefined && <div className="absolute top-0 h-3 w-[2px] -translate-x-1/2 rounded-full bg-accent" style={{ left: `${outPct}%` }} />}
            <div ref={headRef} className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_0_0_3px_rgb(0_0_0/0.35)]" style={{ left: '0%' }} />
          </div>
        ) : (
          <div className="h-3" />
        )}
        <div className="flex h-11 items-center gap-1 px-3">
          <span ref={tcRef} className="min-w-[76px] shrink-0 font-mono text-[11px] tabular-nums text-fg">
            {isMedia ? '00:00:00:00' : 'Still'}
          </span>
          <div className="flex flex-1 items-center justify-center gap-0.5">
            {isMedia && (
              <>
                <TransportButton label={tip('Mark in', 'I')} onClick={() => sourceControls.markIn()} active={marks?.in !== undefined}>
                  <span className="font-mono text-[12px] font-bold">{'{'}</span>
                </TransportButton>
                <TransportButton big label={tip(playing ? 'Pause' : 'Play', 'Space')} onClick={toggle}>
                  {playing ? <Pause className="size-3.5 fill-current" /> : <Play className="ml-0.5 size-3.5 fill-current" />}
                </TransportButton>
                <TransportButton label={tip('Mark out', 'O')} onClick={() => sourceControls.markOut()} active={marks?.out !== undefined}>
                  <span className="font-mono text-[12px] font-bold">{'}'}</span>
                </TransportButton>
              </>
            )}
            {!isMedia && <span className="truncate text-[11px] text-fg-3">Lands as a {DEFAULT_STILL}s clip</span>}
          </div>
          <div className="flex shrink-0 items-center justify-end gap-1">
            {isMedia && (
              <span className="mr-0.5 hidden font-mono text-[10.5px] text-fg-3 tabular-nums @[360px]:inline" title="Marked duration">
                {timecode(Math.max(0, markedLen), fps).slice(3)}
              </span>
            )}
            <Tooltip content={tip('Insert at playhead (ripple)', ',')}>
              <IconButton label="Insert at playhead" size="sm" variant="secondary" onClick={() => sourceControls.insert(false)}>
                <ListPlus className="size-3.5" />
              </IconButton>
            </Tooltip>
            <Tooltip content={tip('Overwrite at playhead', '.')}>
              <IconButton label="Overwrite at playhead" size="sm" variant="primary" onClick={() => sourceControls.insert(true)}>
                <ArrowDownToLine className="size-3.5" />
              </IconButton>
            </Tooltip>
          </div>
        </div>
      </div>
    </>
  )
}

