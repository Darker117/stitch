// Cached filmstrip frames (sampled with a hidden <video> + canvas) and audio
// waveform peaks (Web Audio decode). Work is queued so the UI never stalls.
import { useEffect, useState } from 'react'
import type { Asset, ID } from '@shared/types'
import { fileUrl } from '@/lib/api'
import { requestProxy } from './proxy'

// ─── Work queues ─────────────────────────────────────────────────────────────

type Task = () => Promise<void>

/** Tiny bounded-concurrency queue; `front` jumps the line (hovered assets). */
function makeQueue(parallel: number): <T>(fn: () => Promise<T>, front?: boolean) => Promise<T> {
  const queue: Task[] = []
  let busy = 0
  const pump = (): void => {
    while (busy < parallel && queue.length) {
      const task = queue.shift()!
      busy++
      void task().finally(() => {
        busy--
        pump()
      })
    }
  }
  return <T>(fn: () => Promise<T>, front = false): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const task: Task = () => fn().then(resolve, reject)
      if (front) queue.unshift(task)
      else queue.push(task)
      pump()
    })
}

// Frame sampling and audio decoding run on separate lanes so waveforms never
// wait behind filmstrips.
const frameQueue = makeQueue(2)
const peakQueue = makeQueue(2)

function idle(): Promise<void> {
  return new Promise((r) => (window.requestIdleCallback ? window.requestIdleCallback(() => r(), { timeout: 200 }) : setTimeout(r, 16)))
}

// ─── Filmstrip frames ────────────────────────────────────────────────────────

export interface FrameSet {
  /** Source time of each frame. */
  times: number[]
  urls: string[]
  aspect: number
}

const frames = new Map<ID, FrameSet>()
const framePending = new Map<ID, Promise<FrameSet | null>>()
const frameSubs = new Map<ID, Set<(f: FrameSet) => void>>()

function once<K extends keyof HTMLMediaElementEventMap>(el: HTMLMediaElement, ev: K, ms = 8000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`timeout waiting for ${ev}`))
    }, ms)
    const ok = (): void => {
      cleanup()
      resolve()
    }
    const bad = (): void => {
      cleanup()
      reject(new Error('media error'))
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      el.removeEventListener(ev, ok)
      el.removeEventListener('error', bad)
    }
    el.addEventListener(ev, ok, { once: true })
    el.addEventListener('error', bad, { once: true })
  })
}

async function sampleFrames(asset: Asset): Promise<FrameSet | null> {
  // sample from the short-GOP proxy: every seek is then a few frames of decode
  const path = (await requestProxy(asset)) ?? asset.path
  const video = document.createElement('video')
  video.crossOrigin = 'anonymous'
  video.muted = true
  video.preload = 'auto'
  video.playsInline = true
  // a distinct URL keeps the sampler off the playback elements' shared media cache
  video.src = `${fileUrl(path)}?filmstrip`
  try {
    await once(video, 'loadeddata')
    const dur = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : (asset.duration ?? 1)
    const aspect = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 16 / 9
    const count = Math.max(4, Math.min(48, Math.round(dur * 2)))
    const h = 72
    const w = Math.round(h * aspect)
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')!
    const set: FrameSet = { times: [], urls: [], aspect }
    for (let i = 0; i < count; i++) {
      const t = Math.min(dur - 0.02, ((i + 0.5) / count) * dur)
      video.currentTime = Math.max(0, t)
      await once(video, 'seeked')
      ctx.drawImage(video, 0, 0, w, h)
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.72))
      if (!blob) continue
      set.times.push(t)
      set.urls.push(URL.createObjectURL(blob))
      // publish progressively so strips fill in as frames arrive
      if (i === 0 || i === count - 1 || i % 6 === 5) {
        frames.set(asset.id, { ...set, times: [...set.times], urls: [...set.urls] })
        for (const fn of frameSubs.get(asset.id) ?? []) fn(frames.get(asset.id)!)
      }
      await idle()
    }
    return set.urls.length ? set : null
  } catch {
    return null
  } finally {
    video.removeAttribute('src')
    video.load()
  }
}

export function getFrames(asset: Asset, priority = false): Promise<FrameSet | null> {
  const hit = frames.get(asset.id)
  const pend = framePending.get(asset.id)
  if (pend) return pend
  if (hit) return Promise.resolve(hit)
  const p = frameQueue(() => sampleFrames(asset), priority).then((set) => {
    if (set) {
      frames.set(asset.id, set)
      for (const fn of frameSubs.get(asset.id) ?? []) fn(set)
    }
    framePending.delete(asset.id)
    return set
  })
  framePending.set(asset.id, p)
  return p
}

export function useFrames(asset: Asset | undefined, enabled = true): FrameSet | null {
  const id = asset?.kind === 'video' ? asset.id : undefined
  const [set, setSet] = useState<FrameSet | null>(() => (id ? (frames.get(id) ?? null) : null))
  useEffect(() => {
    if (!id || !asset || !enabled) return
    let subs = frameSubs.get(id)
    if (!subs) frameSubs.set(id, (subs = new Set()))
    const fn = (f: FrameSet): void => setSet(f)
    subs.add(fn)
    const cur = frames.get(id)
    if (cur) setSet(cur)
    void getFrames(asset)
    return () => {
      subs!.delete(fn)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, enabled])
  return set
}

/** Nearest cached frame URL for a source time. */
export function frameAt(set: FrameSet, t: number): string | undefined {
  if (!set.urls.length) return undefined
  let best = 0
  let bestD = Infinity
  for (let i = 0; i < set.times.length; i++) {
    const d = Math.abs(set.times[i] - t)
    if (d < bestD) {
      bestD = d
      best = i
    }
  }
  return set.urls[best]
}

// ─── Waveforms ───────────────────────────────────────────────────────────────

export interface Peaks {
  /** Peaks per second. */
  rate: number
  data: Float32Array
  duration: number
  /** SVG path in (sample index, 0..1) units, mirrored around 0.5. */
  path: string
}

const peaks = new Map<ID, Peaks | null>()
const peakPending = new Map<ID, Promise<Peaks | null>>()
let decoder: OfflineAudioContext | null = null

function buildPath(data: Float32Array): string {
  const n = data.length
  if (!n) return ''
  const top: string[] = []
  const bottom: string[] = []
  for (let i = 0; i < n; i++) {
    const v = Math.max(0.012, data[i]) * 0.5
    top.push(`${i},${(0.5 - v).toFixed(3)}`)
    bottom.push(`${i},${(0.5 + v).toFixed(3)}`)
  }
  return `M0,0.5L${top.join('L')}L${n},0.5L${bottom.reverse().join('L')}Z`
}

async function decodePeaks(asset: Asset): Promise<Peaks | null> {
  try {
    const res = await fetch(fileUrl(asset.path))
    const len = Number(res.headers.get('content-length') ?? 0)
    if (!res.ok || len > 400 * 1024 * 1024) return null
    const buf = await res.arrayBuffer()
    decoder ??= new OfflineAudioContext(1, 1, 44100)
    const audio = await decoder.decodeAudioData(buf)
    const duration = audio.duration
    const rate = Math.max(8, Math.min(100, Math.floor(30000 / Math.max(1, duration))))
    const n = Math.max(1, Math.ceil(duration * rate))
    const data = new Float32Array(n)
    const chans = Array.from({ length: audio.numberOfChannels }, (_, i) => audio.getChannelData(i))
    const per = audio.sampleRate / rate
    for (let i = 0; i < n; i++) {
      const a = Math.floor(i * per)
      const b = Math.min(audio.length, Math.floor((i + 1) * per))
      let m = 0
      for (const ch of chans) {
        for (let j = a; j < b; j += 4) {
          const v = Math.abs(ch[j])
          if (v > m) m = v
        }
      }
      data[i] = m
      if (i % 4000 === 3999) await idle()
    }
    let max = 0
    for (const v of data) max = Math.max(max, v)
    const norm = max > 0.02 ? 1 / max : 1
    for (let i = 0; i < n; i++) data[i] = Math.min(1, Math.pow(data[i] * norm, 0.8))
    return { rate, data, duration, path: buildPath(data) }
  } catch {
    return null
  }
}

export function getPeaks(asset: Asset): Promise<Peaks | null> {
  if (peaks.has(asset.id)) return Promise.resolve(peaks.get(asset.id) ?? null)
  let p = peakPending.get(asset.id)
  if (!p) {
    p = peakQueue(() => decodePeaks(asset)).then((r) => {
      peaks.set(asset.id, r)
      peakPending.delete(asset.id)
      return r
    })
    peakPending.set(asset.id, p)
  }
  return p
}

export function usePeaks(asset: Asset | undefined, enabled = true): Peaks | null {
  const ok = !!asset && enabled && (asset.kind === 'audio' || asset.kind === 'video')
  const [p, setP] = useState<Peaks | null>(() => (ok ? (peaks.get(asset!.id) ?? null) : null))
  useEffect(() => {
    if (!ok) return
    let alive = true
    void getPeaks(asset!).then((r) => alive && setP(r))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asset?.id, ok])
  return p
}
