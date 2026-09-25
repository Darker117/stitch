// Audio building blocks: decoded waveforms, an animated waveform player,
// one-at-a-time playback, and a microphone recorder that produces clean WAV.
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Pause, Play } from 'lucide-react'
import { cn, formatDuration } from '@/lib/utils'
import { springSnappy } from '@/lib/motion'

// ─── Peaks ───────────────────────────────────────────────────────────────────

const peakCache = new Map<string, number[]>()
const inflight = new Map<string, Promise<number[]>>()
let decoding = 0
const waiters: (() => void)[] = []

async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (decoding >= 2) await new Promise<void>((r) => waiters.push(r))
  decoding++
  try {
    return await fn()
  } finally {
    decoding--
    waiters.shift()?.()
  }
}

let sharedCtx: AudioContext | null = null
function audioCtx(): AudioContext {
  if (!sharedCtx || sharedCtx.state === 'closed') sharedCtx = new AudioContext()
  return sharedCtx
}

export function peaksFromBuffer(buf: AudioBuffer, bars: number): number[] {
  const data = buf.getChannelData(0)
  const step = Math.max(1, Math.floor(data.length / bars))
  const out: number[] = []
  for (let i = 0; i < bars; i++) {
    let max = 0
    let sum = 0
    const start = i * step
    const end = Math.min(data.length, start + step)
    for (let j = start; j < end; j += 4) {
      const v = Math.abs(data[j])
      if (v > max) max = v
      sum += v * v
    }
    const rms = Math.sqrt(sum / Math.max(1, (end - start) / 4))
    out.push(max * 0.55 + rms * 1.6)
  }
  const top = Math.max(0.0001, ...out)
  return out.map((v) => Math.max(0.06, Math.min(1, Math.pow(v / top, 0.8))))
}

export function loadPeaks(url: string, bars: number): Promise<number[]> {
  const key = `${bars}|${url}`
  const hit = peakCache.get(key)
  if (hit) return Promise.resolve(hit)
  const pending = inflight.get(key)
  if (pending) return pending
  const p = slot(async () => {
    const res = await fetch(url)
    const buf = await audioCtx().decodeAudioData(await res.arrayBuffer())
    const peaks = peaksFromBuffer(buf, bars)
    peakCache.set(key, peaks)
    return peaks
  }).finally(() => inflight.delete(key))
  inflight.set(key, p)
  return p
}

/** Decoded peaks for a URL, loaded when the element scrolls into view. */
export function usePeaks(url: string | undefined, bars: number): { peaks: number[] | null; ref: (el: Element | null) => void } {
  const [peaks, setPeaks] = useState<number[] | null>(() => (url ? (peakCache.get(`${bars}|${url}`) ?? null) : null))
  const [visible, setVisible] = useState(false)
  const obs = useRef<IntersectionObserver | null>(null)
  const ref = useCallback((el: Element | null) => {
    obs.current?.disconnect()
    if (!el) return
    obs.current = new IntersectionObserver(([e]) => e.isIntersecting && setVisible(true), { rootMargin: '200px' })
    obs.current.observe(el)
  }, [])
  useEffect(() => () => obs.current?.disconnect(), [])
  useEffect(() => {
    if (!url || !visible) return
    let alive = true
    loadPeaks(url, bars)
      .then((p) => alive && setPeaks(p))
      .catch(() => alive && setPeaks(null))
    return () => {
      alive = false
    }
  }, [url, bars, visible])
  return { peaks, ref }
}

/** Deterministic placeholder shape so an undecoded clip still looks like audio. */
export function placeholderPeaks(seed: string, bars: number): number[] {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0
  return Array.from({ length: bars }, (_, i) => {
    h = (h * 1103515245 + 12345) & 0x7fffffff
    const env = Math.sin((i / bars) * Math.PI) * 0.6 + 0.4
    return Math.max(0.12, env * (0.35 + ((h % 1000) / 1000) * 0.65))
  })
}

// ─── One clip at a time ──────────────────────────────────────────────────────

let current: HTMLAudioElement | null = null
export function claimPlayback(el: HTMLAudioElement): void {
  if (current && current !== el) current.pause()
  current = el
}

const listeners = new Set<() => void>()
let previewAudio: HTMLAudioElement | null = null
let previewKey: string | null = null

/** Play a URL on a shared element (voice previews). Returns when playback ends. */
export function playPreview(url: string, key: string): Promise<void> {
  if (!previewAudio) previewAudio = new Audio()
  const el = previewAudio
  el.pause()
  el.src = url
  previewKey = key
  listeners.forEach((l) => l())
  claimPlayback(el)
  return new Promise((resolve) => {
    const done = (): void => {
      el.removeEventListener('ended', done)
      el.removeEventListener('pause', done)
      el.removeEventListener('error', done)
      if (previewKey === key) {
        previewKey = null
        listeners.forEach((l) => l())
      }
      resolve()
    }
    el.addEventListener('ended', done)
    el.addEventListener('pause', done)
    el.addEventListener('error', done)
    void el.play().catch(done)
  })
}

export function stopPreview(): void {
  previewAudio?.pause()
}

export function usePreviewKey(): string | null {
  const [k, setK] = useState(previewKey)
  useEffect(() => {
    const l = (): void => setK(previewKey)
    listeners.add(l)
    return () => {
      listeners.delete(l)
    }
  }, [])
  return k
}

// ─── Visuals ─────────────────────────────────────────────────────────────────

/** Three bouncing bars — shown on play buttons while audio is playing. */
export function EqBars({ className, bars = 3 }: { className?: string; bars?: number }): React.JSX.Element {
  return (
    <span className={cn('flex h-3.5 items-end gap-[2px]', className)}>
      {Array.from({ length: bars }, (_, i) => (
        <motion.span
          key={i}
          className="h-full w-[3px] origin-bottom rounded-full bg-current"
          animate={{ scaleY: [0.3, 1, 0.45, 0.85, 0.3] }}
          transition={{ duration: 0.9 + i * 0.17, repeat: Infinity, ease: 'easeInOut', delay: i * 0.12 }}
        />
      ))}
    </span>
  )
}

/**
 * Bar waveform. Bars grow in from the centre when peaks arrive; `progressRef`
 * is driven imperatively by the player so playback never re-renders React.
 */
function WaveBars({
  peaks,
  height,
  progressRef,
  hoverRef,
  className
}: {
  peaks: number[]
  height: number
  progressRef?: React.Ref<SVGRectElement>
  hoverRef?: React.Ref<SVGRectElement>
  className?: string
}): React.JSX.Element {
  const id = useId().replace(/:/g, '')
  const [grown, setGrown] = useState(false)
  useEffect(() => {
    const r = requestAnimationFrame(() => setGrown(true))
    return () => cancelAnimationFrame(r)
  }, [])
  const n = peaks.length
  const w = 1000
  const gap = w / n
  const bw = Math.max(2, gap * 0.56)
  const bars = (fill: string): React.JSX.Element[] =>
    peaks.map((p, i) => (
      <rect
        key={i}
        x={i * gap + (gap - bw) / 2}
        y={0}
        width={bw}
        height={height}
        rx={bw / 2}
        fill={fill}
        style={{
          transformBox: 'fill-box',
          transformOrigin: 'center',
          transform: `scaleY(${grown ? p : 0.06})`,
          transition: `transform 700ms cubic-bezier(0.22, 1, 0.36, 1) ${Math.min(i * 7, 420)}ms`
        }}
      />
    ))
  return (
    <svg viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" className={cn('block w-full', className)} style={{ height }}>
      <defs>
        <linearGradient id={`g-${id}`} x1="0" x2={w} y1="0" y2="0" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="var(--accent-2)" />
          <stop offset="100%" stopColor="var(--accent)" />
        </linearGradient>
        <clipPath id={`p-${id}`}>
          <rect ref={progressRef} x="0" y="0" width="0" height={height} />
        </clipPath>
        <clipPath id={`h-${id}`}>
          <rect ref={hoverRef} x="0" y="0" width="0" height={height} />
        </clipPath>
      </defs>
      <g>{bars('rgb(255 255 255 / 0.16)')}</g>
      <g clipPath={`url(#h-${id})`}>{bars('rgb(255 255 255 / 0.3)')}</g>
      <g clipPath={`url(#p-${id})`}>{bars(`url(#g-${id})`)}</g>
    </svg>
  )
}

export interface WavePlayerProps {
  src: string
  /** Seed for the placeholder shape until the file is decoded. */
  seed?: string
  duration?: number
  bars?: number
  height?: number
  size?: 'sm' | 'md'
  className?: string
  autoPlay?: boolean
  onPlayingChange?: (playing: boolean) => void
}

/** Play button + seekable waveform + time. */
export function WavePlayer({ src, seed, duration, bars = 64, height = 34, size = 'md', className, autoPlay, onPlayingChange }: WavePlayerProps): React.JSX.Element {
  const audio = useRef<HTMLAudioElement>(null)
  const progress = useRef<SVGRectElement>(null)
  const hover = useRef<SVGRectElement>(null)
  const timeEl = useRef<HTMLSpanElement>(null)
  const [playing, setPlaying] = useState(false)
  const [dur, setDur] = useState(duration ?? 0)
  const { peaks, ref } = usePeaks(src, bars)
  const shape = useMemo(() => peaks ?? placeholderPeaks(seed ?? src, bars), [peaks, seed, src, bars])

  const paint = useCallback(() => {
    const a = audio.current
    if (!a) return
    const d = Number.isFinite(a.duration) && a.duration > 0 ? a.duration : dur
    const p = d ? Math.min(1, a.currentTime / d) : 0
    progress.current?.setAttribute('width', String(p * 1000))
    if (timeEl.current) timeEl.current.textContent = a.currentTime > 0.05 ? formatDuration(a.currentTime) : formatDuration(d || undefined) || '0:00'
  }, [dur])

  useEffect(() => {
    if (!playing) return
    let raf = 0
    const tick = (): void => {
      paint()
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, paint])

  useEffect(() => {
    onPlayingChange?.(playing)
  }, [playing, onPlayingChange])

  useEffect(() => {
    if (autoPlay && audio.current) {
      claimPlayback(audio.current)
      void audio.current.play().catch(() => {})
    }
  }, [autoPlay, src])

  const toggle = (): void => {
    const a = audio.current
    if (!a) return
    if (a.paused) {
      claimPlayback(a)
      void a.play().catch(() => {})
    } else a.pause()
  }

  const seek = (e: React.MouseEvent<HTMLDivElement>): void => {
    const a = audio.current
    if (!a) return
    const r = e.currentTarget.getBoundingClientRect()
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
    const d = Number.isFinite(a.duration) && a.duration > 0 ? a.duration : dur
    if (d) a.currentTime = x * d
    claimPlayback(a)
    void a.play().catch(() => {})
    paint()
  }

  const btn = size === 'md' ? 'size-9' : 'size-7.5'
  return (
    <div ref={ref as React.Ref<HTMLDivElement>} className={cn('flex min-w-0 items-center gap-3', className)}>
      <audio
        ref={audio}
        src={src}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false)
          if (audio.current) audio.current.currentTime = 0
          paint()
        }}
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration
          if (Number.isFinite(d)) setDur(d)
          paint()
        }}
      />
      <motion.button
        whileTap={{ scale: 0.9 }}
        transition={springSnappy}
        onClick={toggle}
        aria-label={playing ? 'Pause' : 'Play'}
        className={cn(
          'relative grid shrink-0 place-items-center rounded-full text-white transition-[box-shadow,filter] duration-300 hover:brightness-110',
          btn,
          playing ? 'bg-grad shadow-[0_6px_22px_-6px_color-mix(in_oklab,var(--accent)_80%,transparent)]' : 'border border-line-strong bg-white/[0.07] text-fg hover:bg-white/[0.12]'
        )}
      >
        <AnimatePresence mode="wait" initial={false}>
          {playing ? (
            <motion.span key="pause" initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.6, opacity: 0 }} transition={{ duration: 0.14 }}>
              <Pause className={cn(size === 'md' ? 'size-3.5' : 'size-3', 'fill-current')} />
            </motion.span>
          ) : (
            <motion.span key="play" initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.6, opacity: 0 }} transition={{ duration: 0.14 }}>
              <Play className={cn(size === 'md' ? 'size-3.5' : 'size-3', 'translate-x-[1px] fill-current')} />
            </motion.span>
          )}
        </AnimatePresence>
      </motion.button>
      <div
        className="group/wave relative min-w-0 flex-1 cursor-pointer py-1"
        onClick={seek}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          hover.current?.setAttribute('width', String(((e.clientX - r.left) / r.width) * 1000))
        }}
        onMouseLeave={() => hover.current?.setAttribute('width', '0')}
      >
        <WaveBars peaks={shape} height={height} progressRef={progress} hoverRef={hover} className={cn('transition-opacity duration-500', !peaks && 'opacity-60')} />
      </div>
      <span ref={timeEl} className="w-9 shrink-0 text-right font-mono text-[10.5px] text-fg-3 tabular-nums">
        {formatDuration(dur || duration) || '0:00'}
      </span>
    </div>
  )
}

/** Non-interactive animated bars for "generating…" placeholders. */
export function PendingWave({ bars = 48, height = 30, className }: { bars?: number; height?: number; className?: string }): React.JSX.Element {
  return (
    <div className={cn('flex items-center gap-[3px]', className)} style={{ height }}>
      {Array.from({ length: bars }, (_, i) => (
        <motion.span
          key={i}
          className="h-full flex-1 rounded-full bg-grad opacity-70"
          initial={{ scaleY: 0.1 }}
          animate={{ scaleY: [0.12, 0.25 + Math.abs(Math.sin(i * 0.7)) * 0.75, 0.12] }}
          transition={{ duration: 1.3, repeat: Infinity, ease: 'easeInOut', delay: (i % 16) * 0.06 }}
        />
      ))}
    </div>
  )
}

// ─── Recording ───────────────────────────────────────────────────────────────

export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const out = new ArrayBuffer(44 + samples.length * 2)
  const dv = new DataView(out)
  const str = (o: number, s: string): void => {
    for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i))
  }
  str(0, 'RIFF')
  dv.setUint32(4, 36 + samples.length * 2, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  dv.setUint32(16, 16, true)
  dv.setUint16(20, 1, true)
  dv.setUint16(22, 1, true)
  dv.setUint32(24, sampleRate, true)
  dv.setUint32(28, sampleRate * 2, true)
  dv.setUint16(32, 2, true)
  dv.setUint16(34, 16, true)
  str(36, 'data')
  dv.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]))
    dv.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true)
  }
  return new Uint8Array(out)
}

/** Decode any recorded blob → trimmed, peak-normalised 24 kHz mono WAV. */
export async function blobToWav(blob: Blob, sampleRate = 24000): Promise<{ bytes: Uint8Array; duration: number }> {
  const decoded = await audioCtx().decodeAudioData(await blob.arrayBuffer())
  const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * sampleRate)), sampleRate)
  const src = off.createBufferSource()
  src.buffer = decoded
  src.connect(off.destination)
  src.start()
  const rendered = await off.startRendering()
  let data = rendered.getChannelData(0)
  // Trim silence at both ends, keeping a little air.
  const thr = 0.012
  let a = 0
  let b = data.length - 1
  while (a < data.length && Math.abs(data[a]) < thr) a++
  while (b > a && Math.abs(data[b]) < thr) b--
  const pad = Math.floor(sampleRate * 0.15)
  data = data.slice(Math.max(0, a - pad), Math.min(data.length, b + pad))
  let peak = 0
  for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]))
  if (peak > 0.001) {
    const g = Math.min(0.92 / peak, 6)
    for (let i = 0; i < data.length; i++) data[i] *= g
  }
  return { bytes: encodeWav(data, sampleRate), duration: data.length / sampleRate }
}

export type RecorderState = 'idle' | 'recording' | 'processing'

export interface Recorder {
  state: RecorderState
  elapsed: number
  analyser: AnalyserNode | null
  error?: string
  start: () => Promise<void>
  stop: () => Promise<{ bytes: Uint8Array; duration: number } | null>
  cancel: () => void
}

export function useRecorder(maxSeconds = 30): Recorder {
  const [state, setState] = useState<RecorderState>('idle')
  const [elapsed, setElapsed] = useState(0)
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null)
  const [error, setError] = useState<string>()
  const rec = useRef<MediaRecorder | null>(null)
  const stream = useRef<MediaStream | null>(null)
  const chunks = useRef<Blob[]>([])
  const timer = useRef<number | null>(null)
  const startedAt = useRef(0)
  const finish = useRef<((b: Blob | null) => void) | null>(null)
  const stopRef = useRef<() => void>(() => {})

  const cleanup = useCallback(() => {
    if (timer.current) window.clearInterval(timer.current)
    timer.current = null
    stream.current?.getTracks().forEach((t) => t.stop())
    stream.current = null
    setAnalyser(null)
  }, [])

  useEffect(() => () => {
    finish.current = null
    if (rec.current && rec.current.state !== 'inactive') rec.current.stop()
    cleanup()
  }, [cleanup])

  const start = useCallback(async () => {
    setError(undefined)
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: false } })
      stream.current = s
      const ctx = audioCtx()
      if (ctx.state === 'suspended') await ctx.resume()
      const node = ctx.createAnalyser()
      node.fftSize = 1024
      ctx.createMediaStreamSource(s).connect(node)
      setAnalyser(node)
      const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].find((m) => MediaRecorder.isTypeSupported(m))
      const r = new MediaRecorder(s, mime ? { mimeType: mime, audioBitsPerSecond: 128000 } : undefined)
      chunks.current = []
      r.ondataavailable = (e) => e.data.size && chunks.current.push(e.data)
      r.onstop = () => {
        const blob = chunks.current.length ? new Blob(chunks.current, { type: r.mimeType }) : null
        finish.current?.(blob)
        finish.current = null
      }
      rec.current = r
      r.start(250)
      startedAt.current = performance.now()
      setElapsed(0)
      setState('recording')
      timer.current = window.setInterval(() => {
        const t = (performance.now() - startedAt.current) / 1000
        setElapsed(t)
        if (t >= maxSeconds) stopRef.current()
      }, 100)
    } catch (err) {
      cleanup()
      setState('idle')
      setError(err instanceof Error && err.name === 'NotAllowedError' ? 'Microphone access was blocked' : 'No microphone available')
    }
  }, [cleanup, maxSeconds])

  const stop = useCallback(async () => {
    const r = rec.current
    if (!r || r.state === 'inactive') return null
    setState('processing')
    const blob = await new Promise<Blob | null>((resolve) => {
      finish.current = resolve
      r.stop()
    })
    cleanup()
    rec.current = null
    if (!blob) {
      setState('idle')
      return null
    }
    try {
      return await blobToWav(blob)
    } catch {
      setError('Could not process the recording')
      return null
    } finally {
      setState('idle')
    }
  }, [cleanup])

  stopRef.current = () => void stop()

  const cancel = useCallback(() => {
    finish.current = null
    if (rec.current && rec.current.state !== 'inactive') rec.current.stop()
    rec.current = null
    cleanup()
    setState('idle')
  }, [cleanup])

  return { state, elapsed, analyser, error, start, stop, cancel }
}

/** Scrolling live input level, drawn from an AnalyserNode without re-rendering React. */
export function LiveWave({ analyser, bars = 44, height = 26, className }: { analyser: AnalyserNode | null; bars?: number; height?: number; className?: string }): React.JSX.Element {
  const els = useRef<(HTMLSpanElement | null)[]>([])
  useEffect(() => {
    if (!analyser) return
    const buf = new Float32Array(analyser.fftSize)
    const hist = new Array<number>(bars).fill(0.06)
    let raf = 0
    let last = 0
    const tick = (now: number): void => {
      raf = requestAnimationFrame(tick)
      if (now - last < 45) return
      last = now
      analyser.getFloatTimeDomainData(buf)
      let sum = 0
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
      const rms = Math.sqrt(sum / buf.length)
      hist.shift()
      hist.push(Math.max(0.06, Math.min(1, rms * 5.5)))
      for (let i = 0; i < bars; i++) {
        const el = els.current[i]
        if (el) el.style.transform = `scaleY(${hist[i]})`
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [analyser, bars])
  return (
    <div className={cn('flex items-center gap-[2px]', className)} style={{ height }}>
      {Array.from({ length: bars }, (_, i) => (
        <span
          key={i}
          ref={(el) => {
            els.current[i] = el
          }}
          className="h-full flex-1 rounded-full bg-fg/85 transition-transform duration-75"
          style={{ transform: 'scaleY(0.06)', opacity: 0.35 + (i / bars) * 0.65 }}
        />
      ))}
    </div>
  )
}
