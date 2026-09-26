// System audio for audio-reactive wallpapers, in Wallpaper Engine's format:
// 128 values ~30 times a second — 64 frequency bands (low → high) for the
// left channel, then 64 for the right, roughly 0..1.
//
// On the PC, Stitch asks for the system's loopback audio (the main process
// grants it to Stitch's own window only) and runs a local frequency analyser;
// nothing is recorded or sent anywhere. Phones get silence.
import { isPhone } from './platform'

type Listener = (bands: Float32Array) => void

const listeners = new Set<Listener>()
let running: { ctx: AudioContext; stream: MediaStream; timer: ReturnType<typeof setInterval> } | null = null
let starting = false
let failedAt = 0

/** Band edges: 64 log-spaced bands from 30 Hz to 16 kHz. */
function bandEdges(binHz: number, bins: number): Int32Array {
  const edges = new Int32Array(65)
  const lo = Math.log(30)
  const hi = Math.log(16000)
  for (let i = 0; i <= 64; i++) edges[i] = Math.min(bins - 1, Math.max(1, Math.round(Math.exp(lo + ((hi - lo) * i) / 64) / binHz)))
  for (let i = 1; i <= 64; i++) if (edges[i] <= edges[i - 1]) edges[i] = Math.min(bins - 1, edges[i - 1] + 1)
  return edges
}

async function start(): Promise<void> {
  if (running || starting || isPhone || !navigator.mediaDevices?.getDisplayMedia) return
  if (Date.now() - failedAt < 60_000) return
  starting = true
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true })
    // The video track is only there because the API requires it.
    for (const t of stream.getVideoTracks()) t.stop()
    const track = stream.getAudioTracks()[0]
    if (!track) throw new Error('no system audio')
    if (!listeners.size) {
      track.stop()
      return
    }
    const ctx = new AudioContext()
    const src = ctx.createMediaStreamSource(new MediaStream([track]))
    const make = (): AnalyserNode => {
      const a = ctx.createAnalyser()
      a.fftSize = 2048
      a.smoothingTimeConstant = 0.55
      a.minDecibels = -85
      a.maxDecibels = -25
      return a
    }
    const left = make()
    const right = make()
    if ((track.getSettings().channelCount ?? 2) >= 2) {
      const split = ctx.createChannelSplitter(2)
      src.connect(split)
      split.connect(left, 0)
      split.connect(right, 1)
    } else {
      src.connect(left)
      src.connect(right)
    }
    const bins = left.frequencyBinCount
    const edges = bandEdges(ctx.sampleRate / left.fftSize, bins)
    const bufL = new Uint8Array(bins)
    const bufR = new Uint8Array(bins)
    const out = new Float32Array(128)
    const fill = (buf: Uint8Array, offset: number): void => {
      for (let b = 0; b < 64; b++) {
        let peak = 0
        for (let i = edges[b]; i < Math.max(edges[b] + 1, edges[b + 1]); i++) peak = Math.max(peak, buf[i])
        out[offset + b] = Math.pow(peak / 255, 1.6) * 1.1
      }
    }
    const timer = setInterval(() => {
      left.getByteFrequencyData(bufL)
      right.getByteFrequencyData(bufR)
      fill(bufL, 0)
      fill(bufR, 64)
      for (const fn of listeners) fn(out)
    }, 33)
    running = { ctx, stream, timer }
    track.addEventListener('ended', stop)
    // Everyone left while we were starting.
    if (!listeners.size) stop()
  } catch (err) {
    failedAt = Date.now()
    console.warn('[wallpaper] system audio unavailable:', err instanceof Error ? err.message : err)
  } finally {
    starting = false
  }
}

function stop(): void {
  if (!running) return
  clearInterval(running.timer)
  for (const t of running.stream.getTracks()) t.stop()
  void running.ctx.close().catch(() => {})
  running = null
}

/** Receive spectrum frames while subscribed; capture stops when the last listener leaves. */
export function subscribeAudio(fn: Listener): () => void {
  listeners.add(fn)
  void start()
  return () => {
    listeners.delete(fn)
    if (!listeners.size) stop()
  }
}
