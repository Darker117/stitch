// The editor's master clock. The playhead lives here, outside React: subscribers
// (playhead line, timecodes, the playback engine) are driven straight from rAF.
import { useSyncExternalStore } from 'react'

type TimeListener = (t: number) => void

export class Clock {
  time = 0
  playing = false
  /** Signed shuttle rate: 1 = play, 2/4 = fast forward, negative = reverse. */
  rate = 1
  duration = 0
  fps = 30
  loop = false

  private timeSubs = new Set<TimeListener>()
  private stateSubs = new Set<() => void>()
  private raf = 0
  private anchorTime = 0
  private anchorWall = 0
  private version = 0

  onTime(fn: TimeListener): () => void {
    this.timeSubs.add(fn)
    fn(this.time)
    return () => this.timeSubs.delete(fn)
  }

  onState(fn: () => void): () => void {
    this.stateSubs.add(fn)
    return () => this.stateSubs.delete(fn)
  }

  getVersion = (): number => this.version

  private emitTime(): void {
    for (const fn of this.timeSubs) fn(this.time)
  }

  private emitState(): void {
    this.version++
    for (const fn of this.stateSubs) fn()
  }

  /** End of playable range (at least one frame so an empty timeline can be scrubbed). */
  get end(): number {
    return Math.max(this.duration, 0)
  }

  seek(t: number): void {
    const next = Math.min(Math.max(0, t), Math.max(this.end, 0))
    this.time = next
    this.anchorTime = next
    this.anchorWall = performance.now()
    this.emitTime()
  }

  play(rate = 1): void {
    if (this.end <= 0) return
    if (rate > 0 && this.time >= this.end - 1e-3) this.seek(0)
    this.rate = rate
    this.anchorTime = this.time
    this.anchorWall = performance.now()
    if (!this.playing) {
      this.playing = true
      this.raf = requestAnimationFrame(this.tick)
    }
    this.emitState()
  }

  pause(): void {
    if (!this.playing) return
    this.playing = false
    this.rate = 1
    cancelAnimationFrame(this.raf)
    // land on a frame boundary
    this.time = Math.round(this.time * this.fps) / this.fps
    this.emitState()
    this.emitTime()
  }

  toggle(): void {
    if (this.playing) this.pause()
    else this.play(1)
  }

  /** J/K/L shuttle. */
  shuttle(dir: -1 | 0 | 1): void {
    if (dir === 0) return this.pause()
    if (!this.playing || Math.sign(this.rate) !== dir) return this.play(dir)
    const next = Math.min(8, Math.abs(this.rate) * 2)
    this.play(dir * next)
  }

  step(frames: number): void {
    this.pause()
    const f = Math.round(this.time * this.fps) + frames
    this.seek(f / this.fps)
  }

  private tick = (now: number): void => {
    if (!this.playing) return
    let t = this.anchorTime + ((now - this.anchorWall) / 1000) * this.rate
    if (t >= this.end) {
      if (this.loop && this.rate > 0 && this.end > 0) {
        this.anchorTime = 0
        this.anchorWall = now
        t = 0
      } else {
        this.time = this.end
        this.emitTime()
        this.pause()
        return
      }
    } else if (t <= 0 && this.rate < 0) {
      this.time = 0
      this.emitTime()
      this.pause()
      return
    }
    this.time = t
    this.emitTime()
    this.raf = requestAnimationFrame(this.tick)
  }

  dispose(): void {
    cancelAnimationFrame(this.raf)
    this.playing = false
    this.timeSubs.clear()
    this.stateSubs.clear()
  }
}

/** One clock for the open editor. */
export const clock = new Clock()

export function useClockPlaying(): { playing: boolean; rate: number } {
  useSyncExternalStore(
    (fn) => clock.onState(fn),
    clock.getVersion
  )
  return { playing: clock.playing, rate: clock.rate }
}
