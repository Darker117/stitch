// Timeline export: turns a Timeline into an ffmpeg filter graph and renders an MP4.
//
// Video: a black `color` base, then every visible video/image clip (lower tracks
// first) scaled + padded to the frame, trimmed to its in/out, shifted to its
// timeline start and overlaid while it is on screen. Text clips are burned in
// with drawtext. Audio: every audible clip is trimmed, faded, gain-adjusted and
// delayed to its start, then mixed over a silent bed of the full duration.
import { spawn, type ChildProcess } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { nanoid } from 'nanoid'
import type { MediaProbe } from '@shared/ipc'
import type { Asset, ID, Timeline, TimelineClip } from '@shared/types'
import { emit, handle } from '../ipc'
import { getSettings } from '../settings'
import { db } from '../store'
import { newAssetPath, probeMedia, registerAsset } from './assets'
import { detectFfmpeg } from './system'

// ─── Filter graph ────────────────────────────────────────────────────────────

/** Escape a value for a filter option, then for the filter graph (two levels). */
function fv(value: string): string {
  const opt = value.replace(/[\\':]/g, (c) => `\\${c}`)
  return opt.replace(/[\\'[\],;]/g, (c) => `\\${c}`)
}

/** Seconds with fixed precision (no exponent notation in the graph). */
function n(v: number): string {
  return (Math.round(v * 1e6) / 1e6).toFixed(6).replace(/\.?0+$/, '') || '0'
}

function hexColor(c: string | undefined): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(c ?? '')
  if (m) return `0x${m[1]}`
  const s = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(c ?? '')
  if (s) return `0x${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`
  return '0xffffff'
}

export function clipDuration(c: TimelineClip): number {
  return Math.max(0, c.out - c.in)
}

export function timelineDuration(tl: Timeline): number {
  let end = 0
  for (const c of tl.clips) end = Math.max(end, c.start + clipDuration(c))
  return end
}

function pickFont(): string | undefined {
  const dir = process.env.WINDIR ? join(process.env.WINDIR, 'Fonts') : 'C:/Windows/Fonts'
  for (const f of ['segoeuib.ttf', 'segoeui.ttf', 'arialbd.ttf', 'arial.ttf']) {
    const p = join(dir, f)
    if (existsSync(p)) return p.replace(/\\/g, '/')
  }
  for (const p of ['/System/Library/Fonts/Supplemental/Arial Bold.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf']) if (existsSync(p)) return p
  return undefined
}

export interface ExportPlan {
  args: string[]
  graph: string
  duration: number
  /** Text files drawtext reads (written next to the graph). */
  files: { path: string; content: string }[]
}

/**
 * Build the ffmpeg invocation for a timeline. `workDir` receives the graph and
 * drawtext text files; `outFile` is the MP4 to write.
 */
export async function planExport(
  tl: Timeline,
  getAsset: (id: ID) => Asset | undefined,
  workDir: string,
  outFile: string,
  probe: (path: string) => Promise<MediaProbe> = probeMedia
): Promise<ExportPlan> {
  const W = Math.max(2, Math.round(tl.width / 2) * 2)
  const H = Math.max(2, Math.round(tl.height / 2) * 2)
  const fps = tl.fps || 30
  const total = timelineDuration(tl)
  if (total <= 0) throw new Error('The timeline is empty — add a clip first')

  const inputs: string[][] = []
  const chains: string[] = []
  const files: ExportPlan['files'] = []
  const probes = new Map<string, Promise<MediaProbe>>()
  const probeOnce = (p: string): Promise<MediaProbe> => {
    let pr = probes.get(p)
    if (!pr) probes.set(p, (pr = probe(p)))
    return pr
  }
  const fit = `scale=${W}:${H}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1`

  const tracks = tl.tracks
  const videoTracks = tracks.filter((t) => t.kind === 'video')
  const byStart = (a: TimelineClip, b: TimelineClip): number => a.start - b.start
  // clip id → input index, so a video clip's audio reuses its input
  const inputOf = new Map<ID, number>()

  const addMediaInput = (clip: TimelineClip, asset: Asset): number => {
    const dur = clipDuration(clip)
    const idx = inputs.length
    if (asset.kind === 'image' && /\.gif$/i.test(asset.path)) inputs.push(['-stream_loop', '-1', '-t', n(dur), '-i', asset.path])
    else if (asset.kind === 'image') inputs.push(['-loop', '1', '-framerate', String(fps), '-t', n(dur), '-i', asset.path])
    else inputs.push(['-ss', n(Math.max(0, clip.in)), '-t', n(dur), '-i', asset.path])
    inputOf.set(clip.id, idx)
    return idx
  }

  // ── Video layers, bottom track first ──
  let last = 'base'
  chains.push(`color=c=black:s=${W}x${H}:r=${fps}:d=${n(total)},format=yuv420p[base]`)
  let layer = 0
  for (const track of videoTracks) {
    if (track.hidden) continue
    for (const clip of tl.clips.filter((c) => c.trackId === track.id).sort(byStart)) {
      const asset = getAsset(clip.assetId)
      if (!asset || (asset.kind !== 'video' && asset.kind !== 'image') || !existsSync(asset.path)) continue
      const dur = clipDuration(clip)
      if (dur <= 0) continue
      const s = clip.start
      const e = s + dur
      const idx = addMediaInput(clip, asset)
      const fi = Math.min(clip.fadeIn ?? 0, dur / 2)
      const fo = Math.min(clip.fadeOut ?? 0, dur / 2)
      const f: string[] = []
      if (asset.kind === 'video') f.push(`trim=duration=${n(dur)}`, 'setpts=PTS-STARTPTS', `fps=${fps}`)
      f.push(fit)
      if (fi > 0 || fo > 0) {
        f.push('format=yuva420p')
        if (fi > 0) f.push(`fade=t=in:st=0:d=${n(fi)}:alpha=1`)
        if (fo > 0) f.push(`fade=t=out:st=${n(dur - fo)}:d=${n(fo)}:alpha=1`)
      }
      f.push(`setpts=PTS-STARTPTS+${n(s)}/TB`)
      chains.push(`[${idx}:v]${f.join(',')}[v${layer}]`)
      chains.push(`[${last}][v${layer}]overlay=enable=${fv(`between(t,${n(s)},${n(e)})`)}:eof_action=pass[c${layer}]`)
      last = `c${layer}`
      layer++
    }
  }

  // ── Titles ──
  const font = pickFont()
  const k = H / 1080
  let ti = 0
  for (const track of tracks.filter((t) => t.kind === 'text')) {
    if (track.hidden) continue
    for (const clip of tl.clips.filter((c) => c.trackId === track.id).sort(byStart)) {
      const text = clip.text
      if (!text || !text.content.trim()) continue
      const dur = clipDuration(clip)
      if (dur <= 0) continue
      const s = clip.start
      const e = s + dur
      const file = join(workDir, `title-${ti}.txt`).replace(/\\/g, '/')
      files.push({ path: file, content: text.content.replace(/\r\n?/g, '\n') })
      const fi = Math.min(clip.fadeIn ?? 0, dur / 2)
      const fo = Math.min(clip.fadeOut ?? 0, dur / 2)
      let alpha = '1'
      if (fi > 0 || fo > 0) {
        const inPart = fi > 0 ? `if(lt(t,${n(s + fi)}),(t-${n(s)})/${n(fi)},1)` : '1'
        const outPart = fo > 0 ? `if(gt(t,${n(e - fo)}),(${n(e)}-t)/${n(fo)},1)` : '1'
        alpha = `max(0,min(${inPart},${outPart}))`
      }
      const x = Math.min(1, Math.max(0, text.x ?? 0.5))
      const y = Math.min(1, Math.max(0, text.y ?? 0.5))
      const shadow = Math.max(1, Math.round(3 * k))
      const opts = [
        font ? `fontfile=${fv(font)}` : 'font=Sans',
        `textfile=${fv(file)}`,
        'expansion=none',
        'text_align=C',
        `fontsize=${Math.max(4, Math.round(text.size || 72))}`,
        `fontcolor=${hexColor(text.color)}`,
        `x=${fv(`w*${n(x)}-text_w/2`)}`,
        `y=${fv(`h*${n(y)}-text_h/2`)}`,
        'shadowcolor=black@0.55',
        `shadowx=${shadow}`,
        `shadowy=${shadow}`,
        `alpha=${fv(alpha)}`,
        `enable=${fv(`between(t,${n(s)},${n(e)})`)}`
      ]
      chains.push(`[${last}]drawtext=${opts.join(':')}[t${ti}]`)
      last = `t${ti}`
      ti++
    }
  }
  chains.push(`[${last}]format=yuv420p[vout]`)

  // ── Audio ──
  const audioLabels: string[] = []
  let ai = 0
  for (const track of tracks) {
    if (track.muted || track.kind === 'text') continue
    for (const clip of tl.clips.filter((c) => c.trackId === track.id).sort(byStart)) {
      if (clip.muted || !(clip.volume > 0)) continue
      const asset = getAsset(clip.assetId)
      if (!asset || asset.kind === 'image' || !existsSync(asset.path)) continue
      const dur = clipDuration(clip)
      if (dur <= 0) continue
      if (asset.kind === 'video' && !(await probeOnce(asset.path)).hasAudio) continue
      const idx = inputOf.get(clip.id) ?? addMediaInput(clip, asset)
      const fi = Math.min(clip.fadeIn ?? 0, dur / 2)
      const fo = Math.min(clip.fadeOut ?? 0, dur / 2)
      const delay = Math.max(0, Math.round(clip.start * 1000))
      const f = [`atrim=duration=${n(dur)}`, 'asetpts=PTS-STARTPTS', 'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo']
      if (fi > 0) f.push(`afade=t=in:st=0:d=${n(fi)}`)
      if (fo > 0) f.push(`afade=t=out:st=${n(dur - fo)}:d=${n(fo)}`)
      f.push(`volume=${n(Math.min(4, clip.volume))}`, `adelay=${delay}|${delay}`)
      chains.push(`[${idx}:a]${f.join(',')}[a${ai}]`)
      audioLabels.push(`[a${ai}]`)
      ai++
    }
  }
  if (audioLabels.length) {
    chains.push(`anullsrc=r=48000:cl=stereo:d=${n(total)}[abed]`)
    chains.push(`[abed]${audioLabels.join('')}amix=inputs=${audioLabels.length + 1}:normalize=0:duration=first:dropout_transition=0[aout]`)
  } else {
    chains.push(`anullsrc=r=48000:cl=stereo:d=${n(total)}[aout]`)
  }

  const graph = chains.join(';\n')
  const graphFile = join(workDir, 'graph.txt')
  files.push({ path: graphFile, content: graph })
  const args = [
    '-y', '-hide_banner', '-nostdin', '-v', 'error', '-stats',
    ...inputs.flat(),
    '-/filter_complex', graphFile,
    '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(fps),
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    '-movflags', '+faststart',
    '-t', n(total),
    outFile
  ]
  return { args, graph, duration: total, files }
}

// ─── Running ffmpeg ──────────────────────────────────────────────────────────

function parseTime(line: string): number | undefined {
  let t: number | undefined
  for (const m of line.matchAll(/time=\s*(-?\d+):(\d+):(\d+(?:\.\d+)?)/g)) t = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
  return t
}

export interface RenderHandle {
  done: Promise<void>
  cancel: () => void
}

/** Render a timeline to `outFile`, reporting progress 0..1. */
export function renderTimeline(
  ffmpeg: string,
  tl: Timeline,
  getAsset: (id: ID) => Asset | undefined,
  outFile: string,
  onProgress: (p: number) => void
): RenderHandle {
  let proc: ChildProcess | null = null
  let canceled = false
  const workDir = join(tmpdir(), `stitch-export-${nanoid(8)}`)
  const done = (async () => {
    mkdirSync(workDir, { recursive: true })
    mkdirSync(dirname(outFile), { recursive: true })
    try {
      const plan = await planExport(tl, getAsset, workDir.replace(/\\/g, '/'), outFile)
      for (const f of plan.files) writeFileSync(f.path, f.content, 'utf8')
      if (canceled) throw new Error('canceled')
      await new Promise<void>((resolvePromise, reject) => {
        const p = spawn(ffmpeg, plan.args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
        proc = p
        const tail: string[] = []
        let buf = ''
        let best = 0
        let lastEmit = 0
        p.stderr!.setEncoding('utf8')
        p.stderr!.on('data', (chunk: string) => {
          buf += chunk
          const parts = buf.split(/[\r\n]+/)
          buf = parts.pop() ?? ''
          for (const line of parts) {
            const t = parseTime(line)
            if (t !== undefined) {
              best = Math.max(best, t)
              const now = Date.now()
              if (now - lastEmit > 120) {
                lastEmit = now
                onProgress(Math.min(0.99, best / plan.duration))
              }
            } else if (line.trim()) {
              tail.push(line.trim())
              if (tail.length > 12) tail.shift()
            }
          }
        })
        p.on('error', reject)
        p.on('close', (code) => {
          proc = null
          if (canceled) reject(new Error('canceled'))
          else if (code === 0) resolvePromise()
          else reject(new Error(tail.slice(-4).join('\n') || `ffmpeg exited with code ${code}`))
        })
      })
      onProgress(1)
    } catch (err) {
      try {
        if (existsSync(outFile)) unlinkSync(outFile)
      } catch {
        /* locked */
      }
      throw err
    } finally {
      try {
        rmSync(workDir, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  })()
  return {
    done,
    cancel: () => {
      canceled = true
      proc?.kill()
    }
  }
}

// ─── Preview proxies ─────────────────────────────────────────────────────────
// Generated videos usually have one keyframe every ~8–10 s, so every seek in
// the editor decodes seconds of video. A short-GOP, ≤720p copy makes scrubbing
// and cuts instant; exports always read the originals.

const proxies = new Map<string, Promise<string | null>>()
const proxyQueue: (() => void)[] = []
let proxyBusy = 0

function withProxySlot<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const start = (): void => {
      proxyBusy++
      fn()
        .then(resolvePromise, reject)
        .finally(() => {
          proxyBusy--
          proxyQueue.shift()?.()
        })
    }
    if (proxyBusy < 2) start()
    else proxyQueue.push(start)
  })
}

export function ensureProxy(assetId: ID): Promise<string | null> {
  const asset = db('assets').get(assetId)
  if (!asset || asset.kind !== 'video' || !existsSync(asset.path)) return Promise.resolve(null)
  const dir = join(getSettings().libraryDir, '.proxies')
  const file = join(dir, `${asset.id}-${Math.round(statSync(asset.path).mtimeMs)}.mp4`)
  const hit = proxies.get(file)
  if (hit) return hit
  if (existsSync(file)) {
    const done = Promise.resolve(file)
    proxies.set(file, done)
    return done
  }
  const job = withProxySlot(async () => {
    const ffmpeg = await detectFfmpeg()
    if (!ffmpeg) return null
    mkdirSync(dir, { recursive: true })
    const tmp = `${file}.part.mp4`
    const args = [
      '-y', '-hide_banner', '-nostdin', '-v', 'error', '-i', asset.path,
      '-map', '0:v:0', '-map', '0:a:0?',
      '-vf', "scale=-2:'min(720,ih)':flags=bicubic",
      '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'fastdecode', '-crf', '21', '-g', '6', '-bf', '0', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '160k',
      '-movflags', '+faststart', tmp
    ]
    const ok = await new Promise<boolean>((res) => {
      const p = spawn(ffmpeg, args, { windowsHide: true, stdio: 'ignore' })
      p.on('error', () => res(false))
      p.on('close', (code) => res(code === 0))
    })
    if (!ok || !existsSync(tmp)) {
      try {
        if (existsSync(tmp)) unlinkSync(tmp)
      } catch {
        /* ignore */
      }
      return null
    }
    renameSync(tmp, file)
    return file
  }).catch(() => null)
  proxies.set(file, job)
  // failed jobs may be retried later
  void job.then((r) => r === null && proxies.delete(file))
  return job
}

// ─── IPC ─────────────────────────────────────────────────────────────────────

const running = new Map<string, RenderHandle>()

export function registerEditor(): void {
  handle('editor:export', async (timelineId, outPath) => {
    const tl = db('timelines').get(timelineId)
    if (!tl) throw new Error('Timeline not found')
    if (timelineDuration(tl) <= 0) throw new Error('The timeline is empty — add a clip first')
    const ffmpeg = await detectFfmpeg()
    if (!ffmpeg) throw new Error('ffmpeg was not found. Install it (winget install Gyan.FFmpeg) or set its path in Settings.')

    const exportId = nanoid(10)
    const name = tl.name || 'timeline'
    const { id: assetId, path } = newAssetPath('video', '.mp4', name)
    const assets = db('assets')
    const job = renderTimeline(ffmpeg, tl, (id) => assets.get(id) ?? undefined, path, (progress) =>
      emit('editor:export', { exportId, timelineId, progress, done: false })
    )
    running.set(exportId, job)
    emit('editor:export', { exportId, timelineId, progress: 0, done: false })

    void job.done
      .then(async () => {
        const asset = await registerAsset(assetId, path, 'video', {
          name,
          source: 'edited',
          origin: { type: 'timeline', id: tl.id },
          projectId: tl.projectId
        })
        let finalPath = asset.path
        if (outPath && resolve(outPath) !== resolve(path)) {
          mkdirSync(dirname(outPath), { recursive: true })
          copyFileSync(path, outPath)
          finalPath = outPath
        }
        emit('editor:export', { exportId, timelineId, progress: 1, done: true, path: finalPath, assetId: asset.id })
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        const canceled = message === 'canceled'
        if (!canceled) console.error('[editor] export failed:', message)
        emit('editor:export', { exportId, timelineId, progress: 0, done: true, canceled, error: canceled ? 'Export canceled' : message })
      })
      .finally(() => running.delete(exportId))

    return { exportId }
  })

  handle('editor:cancelExport', (exportId) => {
    running.get(exportId)?.cancel()
  })

  handle('editor:proxy', (assetId) => ensureProxy(assetId))
}
