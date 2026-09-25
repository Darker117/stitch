// Program-monitor playback engine. Imperative on purpose: a pool of <video>,
// <audio>, <img> and title elements is driven straight from the clock's rAF so
// playback and scrubbing never go through React.
//
// Every clip under the playhead gets an element; clips about to start are
// preloaded and parked on their first frame so cuts are gapless. Visual layers
// stack by track; audio from video and audio clips plays from the same elements.
// Drift against the clock is corrected with gentle playbackRate nudges, and with
// a hard seek when it gets large.
import type { Asset, ID, Timeline, TimelineClip } from '@shared/types'
import { fileUrl } from '@/lib/api'
import { clock } from './clock'
import { clipEnd, fadeGain, trackLayer } from './model'
import { onProxyReady, previewPath } from './proxy'

type SlotType = 'video' | 'audio' | 'image' | 'text'

interface Slot {
  type: SlotType
  el: HTMLElement
  clipId: ID | null
  src: string
  pending: number | null
  lastSeek: number
  stallSince: number | null
  freedAt: number
  cache: Record<string, string>
}

interface Plan {
  clip: TimelineClip
  asset?: Asset
  type: SlotType
  visual: boolean
  audible: boolean
  layer: number
}

const MAX_FREE = 3

export class Engine {
  private stage: HTMLDivElement | null = null
  private slots: Slot[] = []
  private byClip = new Map<ID, Slot>()
  private plans: Plan[] = []
  private fps = 30
  private frameH = 1080
  private offs: (() => void)[] = []
  /** Master monitor volume 0..1 (does not affect export). */
  volume = 1
  muted = false

  attach(stage: HTMLDivElement): void {
    this.stage = stage
    this.offs.push(clock.onTime((t) => this.render(t)))
    this.offs.push(clock.onState(() => this.render(clock.time)))
    this.offs.push(onProxyReady(() => this.render(clock.time)))
  }

  detach(): void {
    for (const off of this.offs) off()
    this.offs = []
    for (const s of this.slots) this.destroy(s)
    this.slots = []
    this.byClip.clear()
    this.stage = null
  }

  setTimeline(tl: Timeline, getAsset: (id: ID) => Asset | undefined): void {
    this.fps = tl.fps
    this.frameH = tl.height
    const plans: Plan[] = []
    for (const clip of tl.clips) {
      const track = tl.tracks.find((t) => t.id === clip.trackId)
      if (!track) continue
      const layer = trackLayer(tl.tracks, track.id)
      if (clip.text) {
        if (!track.hidden) plans.push({ clip, type: 'text', visual: true, audible: false, layer })
        continue
      }
      const asset = getAsset(clip.assetId)
      if (!asset) continue
      const audible = !track.muted && !clip.muted && clip.volume > 0
      if (asset.kind === 'video') {
        if (track.hidden && !audible) continue
        plans.push({ clip, asset, type: 'video', visual: !track.hidden, audible, layer })
      } else if (asset.kind === 'image') {
        if (!track.hidden) plans.push({ clip, asset, type: 'image', visual: true, audible: false, layer })
      } else if (audible) {
        plans.push({ clip, asset, type: 'audio', visual: false, audible: true, layer })
      }
    }
    this.plans = plans
    this.render(clock.time)
  }

  setMonitorVolume(volume: number, muted: boolean): void {
    this.volume = volume
    this.muted = muted
    this.render(clock.time)
  }

  // ─── Frame ─────────────────────────────────────────────────────────────────

  render(t: number): void {
    if (!this.stage) return
    const playing = clock.playing && clock.rate > 0
    const lookahead = playing ? 2.5 : 0.6
    const now = performance.now()

    const need = new Map<ID, { plan: Plan; active: boolean }>()
    for (const p of this.plans) {
      const s = p.clip.start
      const e = clipEnd(p.clip)
      if (t >= s - 1e-6 && t < e - 1e-6) need.set(p.clip.id, { plan: p, active: true })
      else if (p.type !== 'text' && s > t && s - t <= lookahead) need.set(p.clip.id, { plan: p, active: false })
    }

    for (const [id, slot] of this.byClip) if (!need.has(id)) this.release(slot, now)
    for (const [id, n] of need) if (!this.byClip.has(id)) this.acquire(n.plan)
    this.trim()

    for (const [id, n] of need) {
      const slot = this.byClip.get(id)
      if (slot) this.update(slot, n.plan, t, n.active, playing, now)
    }
  }

  private srcFor(p: Plan): string {
    if (p.type === 'text') return ''
    return fileUrl(previewPath(p.asset!))
  }

  private create(type: SlotType): Slot {
    let el: HTMLElement
    if (type === 'video' || type === 'audio') {
      const m = document.createElement(type)
      m.preload = 'auto'
      if (m instanceof HTMLVideoElement) {
        m.playsInline = true
        m.disablePictureInPicture = true
      }
      el = m
    } else if (type === 'image') {
      const img = document.createElement('img')
      img.decoding = 'async'
      img.draggable = false
      el = img
    } else {
      el = document.createElement('div')
    }
    if (type === 'text') {
      el.style.cssText =
        'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);white-space:pre;width:max-content;text-align:center;font-family:"Segoe UI",var(--font-sans);font-weight:700;line-height:1.33;pointer-events:none;opacity:0;will-change:opacity;max-width:96%;'
    } else if (type !== 'audio') {
      el.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#000;opacity:0;pointer-events:none;'
    } else {
      el.style.display = 'none'
    }
    const slot: Slot = { type, el, clipId: null, src: '', pending: null, lastSeek: 0, stallSince: null, freedAt: 0, cache: {} }
    if (el instanceof HTMLMediaElement) {
      el.addEventListener('seeked', () => {
        if (slot.pending !== null) {
          const p = slot.pending
          slot.pending = null
          if (Math.abs(el.currentTime - p) > 1e-3) el.currentTime = p
        }
      })
    }
    this.stage!.appendChild(el)
    this.slots.push(slot)
    return slot
  }

  private acquire(p: Plan): void {
    const src = this.srcFor(p)
    const free = this.slots.filter((s) => s.type === p.type && s.clipId === null)
    const slot = free.find((s) => s.src === src) ?? free.sort((a, b) => a.freedAt - b.freedAt)[0] ?? this.create(p.type)
    slot.clipId = p.clip.id
    slot.pending = null
    if (slot.src !== src) {
      slot.src = src
      if (slot.el instanceof HTMLMediaElement || slot.el instanceof HTMLImageElement) slot.el.src = src
    }
    this.byClip.set(p.clip.id, slot)
  }

  private release(slot: Slot, now: number): void {
    if (slot.clipId) this.byClip.delete(slot.clipId)
    slot.clipId = null
    slot.freedAt = now
    this.css(slot, 'opacity', '0')
    if (slot.el instanceof HTMLMediaElement && !slot.el.paused) slot.el.pause()
  }

  private trim(): void {
    for (const type of ['video', 'audio', 'image', 'text'] as SlotType[]) {
      const free = this.slots.filter((s) => s.type === type && s.clipId === null).sort((a, b) => a.freedAt - b.freedAt)
      while (free.length > MAX_FREE) {
        const s = free.shift()!
        this.destroy(s)
        this.slots = this.slots.filter((x) => x !== s)
      }
    }
  }

  private destroy(s: Slot): void {
    if (s.el instanceof HTMLMediaElement) {
      s.el.pause()
      s.el.removeAttribute('src')
      s.el.load()
    }
    s.el.remove()
  }

  private css(slot: Slot, key: string, value: string): void {
    if (slot.cache[key] === value) return
    slot.cache[key] = value
    slot.el.style.setProperty(key, value)
  }

  private seek(slot: Slot, el: HTMLMediaElement, t: number, now: number): void {
    slot.lastSeek = now
    if (el.seeking) {
      slot.pending = t
      return
    }
    slot.pending = null
    el.currentTime = t
  }

  private update(slot: Slot, p: Plan, t: number, active: boolean, playing: boolean, now: number): void {
    const c = p.clip
    const fade = active ? fadeGain(c, t) : 0

    if (p.type === 'text') {
      const text = c.text!
      const el = slot.el
      if (el.textContent !== text.content) el.textContent = text.content
      this.css(slot, 'left', `${(text.x ?? 0.5) * 100}%`)
      this.css(slot, 'top', `${(text.y ?? 0.5) * 100}%`)
      this.css(slot, 'font-size', `calc(${text.size || 72}px * var(--k, 0.5))`)
      this.css(slot, 'color', text.color || '#ffffff')
      // same offset the export burns in: 3px per 1080 lines of output
      const sh = `calc(${((3 * this.frameH) / 1080).toFixed(2)}px * var(--k, 0.5))`
      this.css(slot, 'text-shadow', `${sh} ${sh} 0 rgb(0 0 0 / 0.55)`)
      this.css(slot, 'z-index', String(p.layer))
      this.css(slot, 'opacity', fade.toFixed(3))
      return
    }

    if (slot.type !== 'audio') {
      this.css(slot, 'z-index', String(p.layer))
      this.css(slot, 'opacity', p.visual && active ? fade.toFixed(3) : '0')
    }
    if (p.type === 'image') return

    const el = slot.el as HTMLMediaElement
    // swap to the proxy once it exists, but never mid-shot
    if (!(active && playing)) {
      const src = this.srcFor(p)
      if (slot.src !== src) {
        slot.src = src
        slot.pending = null
        el.src = src
      }
    }
    const len = c.out - c.in
    const target = c.in + Math.min(Math.max(0, active ? t - c.start : 0), Math.max(0, len - 0.001))

    const gain = Math.min(1, Math.max(0, c.volume * fade * this.volume))
    const silent = !p.audible || !active || this.muted
    if (el.muted !== silent) el.muted = silent
    if (Math.abs(el.volume - gain) > 0.004) el.volume = gain

    if (active && playing) {
      const rate = clock.rate
      if (el.paused) {
        if (Math.abs(el.currentTime - target) > 0.04 && !el.seeking) this.seek(slot, el, target, now)
        el.playbackRate = rate
        void el.play().catch(() => {})
        return
      }
      // Let a seek or a buffering element settle before judging drift —
      // re-seeking a stalled element only keeps it stalled.
      if (el.seeking || el.readyState < 3) {
        // a stuck element gets one nudge per second
        if (!el.seeking && now - slot.lastSeek > 1000) {
          slot.stallSince ??= now
          if (now - slot.stallSince > 900) {
            slot.stallSince = null
            this.seek(slot, el, target + 0.12 * rate, now)
          }
        }
        return
      }
      slot.stallSince = null
      const drift = el.currentTime - target
      if (Math.abs(drift) > 0.6) {
        if (now - slot.lastSeek > 1200) this.seek(slot, el, target + 0.12 * rate, now)
        el.playbackRate = rate
      } else if (Math.abs(drift) > 0.03) {
        // ease back into sync without an audible jump
        el.playbackRate = Math.max(0.25, rate * (1 - Math.max(-0.25, Math.min(0.25, drift * 0.9))))
      } else if (el.playbackRate !== rate) {
        el.playbackRate = rate
      }
      return
    }

    if (!el.paused) el.pause()
    const tol = active ? 0.5 / this.fps : 0.05
    if (Math.abs(el.currentTime - target) > tol || slot.pending !== null) {
      if (slot.pending === null || Math.abs(slot.pending - target) > 1e-4) this.seek(slot, el, target, now)
    }
  }
}
