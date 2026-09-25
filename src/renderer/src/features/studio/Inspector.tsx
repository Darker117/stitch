// Right column: properties of the selected clip(s), or the timeline itself.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { AlignVerticalJustifyCenter, AudioLines, Copy, Film, ImageIcon, Layers, Scissors, SlidersHorizontal, Trash2, Type, Volume2 } from 'lucide-react'
import type { ID, Timeline, TimelineClip } from '@shared/types'
import { cn } from '@/lib/utils'
import { ease, spring } from '@/lib/motion'
import { useDoc } from '@/stores/db'
import { Button } from '@/components/ui/button'
import { Input, Textarea } from '@/components/ui/input'
import { Segmented, Slider, Switch } from '@/components/ui/controls'
import { Tooltip } from '@/components/ui/overlay'
import { AspectGlyph } from './common'
import { deleteSelection, duplicateSelection, splitAtPlayhead } from './actions'
import { editor, useEditor } from './store'
import { RES_PRESETS, carve, parseTime, clipDur, clipEnd, clipKind, presetFor, shortDuration, sourceLength, timecode, timelineDuration } from './model'

// ─── Live edits: slider drags and typing collapse into one undo step ─────────

let liveFinalize: ((tl: Timeline) => Timeline) | undefined

function liveEdit(fn: (tl: Timeline) => Timeline, finalize?: (tl: Timeline) => Timeline): void {
  if (!editor.gestureBase) {
    editor.begin()
    const end = (): void => {
      window.removeEventListener('pointerup', end)
      window.removeEventListener('keyup', end)
      const f = liveFinalize
      liveFinalize = undefined
      editor.end(f)
    }
    window.addEventListener('pointerup', end)
    window.addEventListener('keyup', end)
  }
  liveFinalize = finalize
  editor.preview(fn)
}

function patchClip(id: ID, patch: Partial<TimelineClip> | ((c: TimelineClip) => Partial<TimelineClip>), live = false): void {
  const fn = (tl: Timeline): Timeline => ({ ...tl, clips: tl.clips.map((c) => (c.id === id ? { ...c, ...(typeof patch === 'function' ? patch(c) : patch) } : c)) })
  if (live) liveEdit(fn)
  else editor.commit(fn)
}

/** Timing edits overwrite whatever they now overlap on the track. */
function retime(id: ID, patch: (c: TimelineClip) => Partial<TimelineClip>, live = false): void {
  const apply = (tl: Timeline): Timeline => ({ ...tl, clips: tl.clips.map((c) => (c.id === id ? { ...c, ...patch(c) } : c)) })
  const settle = (tl: Timeline): Timeline => {
    const c = tl.clips.find((x) => x.id === id)
    return c ? { ...tl, clips: carve(tl.clips, c.trackId, c.start, clipEnd(c), new Set([id])) } : tl
  }
  if (live) liveEdit(apply, settle)
  else editor.commit((tl) => settle(apply(tl)))
}

// ─── Small controls ──────────────────────────────────────────────────────────

function Section({ title, icon, children, action }: { title: string; icon?: ReactNode; children: ReactNode; action?: ReactNode }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2.5 border-t border-line px-4 py-3.5 first:border-t-0">
      <div className="flex items-center gap-1.5">
        {icon && <span className="text-fg-3 [&>svg]:size-3">{icon}</span>}
        <span className="label-caps">{title}</span>
        <div className="flex-1" />
        {action}
      </div>
      {children}
    </div>
  )
}

/** Number field whose label can be dragged sideways to scrub the value. */
function ScrubField({
  label,
  value,
  onChange,
  step,
  min = 0,
  max = Infinity,
  format,
  parse,
  suffix
}: {
  label: string
  value: number
  onChange: (v: number, live: boolean) => void
  step: number
  min?: number
  max?: number
  format: (v: number) => string
  parse: (s: string) => number | undefined
  suffix?: string
}): React.JSX.Element {
  const [text, setText] = useState(format(value))
  const [editing, setEditing] = useState(false)
  useEffect(() => {
    if (!editing) setText(format(value))
  }, [value, editing, format])
  const clamp = (v: number): number => Math.min(max, Math.max(min, v))
  const commitText = (): void => {
    setEditing(false)
    const v = parse(text)
    if (v !== undefined && Number.isFinite(v)) onChange(clamp(v), false)
    else setText(format(value))
  }
  const onLabelDown = (e: React.PointerEvent): void => {
    e.preventDefault()
    const x0 = e.clientX
    const v0 = value
    let last = v0
    const move = (ev: PointerEvent): void => {
      const v = clamp(Math.round((v0 + ((ev.clientX - x0) / 4) * step) / step) * step)
      if (v !== last) {
        last = v
        onChange(v, true)
      }
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.style.cursor = ''
    }
    document.body.style.cursor = 'ew-resize'
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  return (
    <label className="flex h-8 items-center overflow-hidden rounded-lg border border-line bg-white/[0.03] transition-colors focus-within:border-[color-mix(in_oklab,var(--accent)_50%,transparent)] hover:border-line-strong">
      <span onPointerDown={onLabelDown} className="flex h-full w-[38px] shrink-0 cursor-ew-resize items-center justify-center border-r border-line text-[9.5px] font-semibold tracking-wide text-fg-3 uppercase select-none hover:bg-white/[0.04] hover:text-fg-2">
        {label}
      </span>
      <input
        value={text}
        onFocus={(e) => {
          setEditing(true)
          e.target.select()
        }}
        onChange={(e) => setText(e.target.value)}
        onBlur={commitText}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'Escape') {
            setText(format(value))
            setEditing(false)
            ;(e.target as HTMLInputElement).blur()
          }
        }}
        className="h-full min-w-0 flex-1 bg-transparent px-1.5 font-mono text-[11px] text-fg tabular-nums outline-none"
      />
      {suffix && <span className="pr-1.5 text-[10px] text-fg-3">{suffix}</span>}
    </label>
  )
}

function SliderRow({ label, value, display, onChange, min, max, step }: { label: string; value: number; display: string; onChange: (v: number) => void; min: number; max: number; step: number }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-[11.5px]">
        <span className="text-fg-2">{label}</span>
        <span className="font-mono text-[11px] text-fg tabular-nums">{display}</span>
      </div>
      <Slider value={value} onChange={onChange} min={min} max={max} step={step} />
    </div>
  )
}

// ─── Panel ───────────────────────────────────────────────────────────────────

export function Inspector(): React.JSX.Element {
  const tl = useEditor((s) => s.tl)!
  const selection = useEditor((s) => s.selection)
  const clips = useMemo(() => tl.clips.filter((c) => selection.includes(c.id)), [tl.clips, selection])
  const key = clips.length === 1 ? clips[0].id : clips.length > 1 ? 'multi' : 'timeline'
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-4">
        <SlidersHorizontal className="size-3.5 text-fg-3" />
        <span className="label-caps text-fg-2">Inspector</span>
      </div>
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.div key={key} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.22, ease }}>
            {clips.length === 1 ? <ClipInspector clip={clips[0]} tl={tl} /> : clips.length > 1 ? <MultiInspector clips={clips} /> : <TimelineInspector tl={tl} />}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  )
}

function ClipInspector({ clip, tl }: { clip: TimelineClip; tl: Timeline }): React.JSX.Element {
  const asset = useDoc('assets', clip.assetId || null)
  const kind = clipKind(clip, asset)
  const fps = tl.fps
  const frame = 1 / fps
  const dur = clipDur(clip)
  const srcLen = kind === 'video' || kind === 'audio' ? sourceLength(asset) : undefined
  const tc = (v: number): string => timecode(v, fps).slice(3)
  const secs = (v: number): string => v.toFixed(2)
  const parse = (v: string): number | undefined => parseTime(v, fps)
  const track = tl.tracks.find((t) => t.id === clip.trackId)
  const hasAudio = kind === 'video' || kind === 'audio'
  const maxFade = Math.max(0.1, Math.min(5, dur / 2))
  const icon = kind === 'video' ? <Film /> : kind === 'image' ? <ImageIcon /> : kind === 'audio' ? <AudioLines /> : <Type />
  const tone = kind === 'audio' ? 'var(--accent)' : kind === 'text' ? 'color-mix(in oklab, var(--accent) 45%, #fff)' : 'var(--accent-2)'

  return (
    <div className="flex flex-col pb-4">
      <div className="flex items-center gap-3 px-4 pt-4 pb-3">
        <span
          className="grid size-9 shrink-0 place-items-center rounded-xl [&>svg]:size-4"
          style={{ background: `color-mix(in oklab, ${tone} 18%, transparent)`, color: tone, boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${tone} 35%, transparent)` }}
        >
          {icon}
        </span>
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold">{clip.text ? 'Title' : (asset?.name ?? 'Missing media')}</div>
          <div className="truncate text-[11px] text-fg-3 capitalize">
            {kind} · {track?.name}
            {asset?.width && asset.height ? ` · ${asset.width}×${asset.height}` : ''}
            {srcLen ? ` · ${shortDuration(srcLen)} source` : ''}
          </div>
        </div>
      </div>

      {clip.text && <TitleSection clip={clip} tl={tl} />}

      <Section title="Timing" icon={<AlignVerticalJustifyCenter />}>
        <div className="grid grid-cols-2 gap-2">
          <ScrubField label="Start" value={clip.start} step={frame} format={tc} parse={parse} onChange={(v, live) => retime(clip.id, () => ({ start: Math.round(v * fps) / fps }), live)} />
          <ScrubField
            label="Dur"
            value={dur}
            step={frame}
            min={frame}
            max={srcLen !== undefined ? srcLen - clip.in : Infinity}
            format={tc} parse={parse}
            onChange={(v, live) => retime(clip.id, (c) => ({ out: c.in + Math.round(v * fps) / fps }), live)}
          />
          {srcLen !== undefined && (
            <>
              <ScrubField label="In" value={clip.in} step={frame} max={clip.out - frame} format={secs} parse={parse} suffix="s" onChange={(v, live) => retime(clip.id, (c) => ({ in: Math.round(v * fps) / fps, start: Math.max(0, c.start + (Math.round(v * fps) / fps - c.in)) }), live)} />
              <ScrubField label="Out" value={clip.out} step={frame} min={clip.in + frame} max={srcLen} format={secs} parse={parse} suffix="s" onChange={(v, live) => retime(clip.id, () => ({ out: Math.round(v * fps) / fps }), live)} />
            </>
          )}
        </div>
      </Section>

      {hasAudio && (
        <Section
          title="Audio"
          icon={<Volume2 />}
          action={
            <label className="flex items-center gap-2 text-[11.5px] text-fg-2">
              Mute
              <Switch size="sm" checked={!!clip.muted} onChange={(v) => patchClip(clip.id, { muted: v })} />
            </label>
          }
        >
          <SliderRow label="Volume" value={Math.round(clip.volume * 100)} display={`${Math.round(clip.volume * 100)}%`} min={0} max={100} step={1} onChange={(v) => patchClip(clip.id, { volume: v / 100 }, true)} />
        </Section>
      )}

      <Section title="Fades" icon={<Layers />}>
        <SliderRow label="Fade in" value={clip.fadeIn ?? 0} display={`${(clip.fadeIn ?? 0).toFixed(1)}s`} min={0} max={maxFade} step={0.1} onChange={(v) => patchClip(clip.id, { fadeIn: v }, true)} />
        <SliderRow label="Fade out" value={clip.fadeOut ?? 0} display={`${(clip.fadeOut ?? 0).toFixed(1)}s`} min={0} max={maxFade} step={0.1} onChange={(v) => patchClip(clip.id, { fadeOut: v }, true)} />
      </Section>

      <div className="flex gap-1.5 px-4 pt-2">
        <Button size="sm" variant="secondary" className="flex-1" icon={<Scissors className="size-3.5" />} onClick={splitAtPlayhead}>
          Split
        </Button>
        <Button size="sm" variant="secondary" className="flex-1" icon={<Copy className="size-3.5" />} onClick={duplicateSelection}>
          Duplicate
        </Button>
        <Tooltip content="Delete (Shift+Del ripples)">
          <Button size="sm" variant="danger" icon={<Trash2 className="size-3.5" />} onClick={(e) => deleteSelection(e.shiftKey)} aria-label="Delete" />
        </Tooltip>
      </div>
    </div>
  )
}

function resolvedAccent(name: '--accent' | '--accent-2'): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return /^#[0-9a-f]{6}$/i.test(v) ? v : name === '--accent' ? '#f08a6c' : '#8c84e6'
}

const POSITIONS = [
  { id: 'top', label: 'Top', y: 0.14 },
  { id: 'center', label: 'Center', y: 0.5 },
  { id: 'lower', label: 'Lower third', y: 0.82 }
]

function TitleSection({ clip, tl }: { clip: TimelineClip; tl: Timeline }): React.JSX.Element {
  const text = clip.text!
  const swatches = useMemo(() => ['#ffffff', '#111016', resolvedAccent('--accent'), resolvedAccent('--accent-2'), '#ffe7b0'], [])
  const setText = (patch: Partial<NonNullable<TimelineClip['text']>>, live = true): void => patchClip(clip.id, (c) => ({ text: { ...c.text!, ...patch } }), live)
  const padRef = useRef<HTMLDivElement>(null)
  const aspect = tl.width / tl.height
  const dragPad = (e: React.PointerEvent): void => {
    const el = padRef.current!
    const apply = (cx: number, cy: number): void => {
      const r = el.getBoundingClientRect()
      const x = Math.min(1, Math.max(0, (cx - r.left) / r.width))
      const y = Math.min(1, Math.max(0, (cy - r.top) / r.height))
      setText({ x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 })
    }
    apply(e.clientX, e.clientY)
    const move = (ev: PointerEvent): void => apply(ev.clientX, ev.clientY)
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  return (
    <Section title="Title" icon={<Type />}>
      <Textarea
        value={text.content}
        minRows={2}
        maxRows={6}
        onFocus={() => editor.begin()}
        onChange={(e) => editor.preview((t) => ({ ...t, clips: t.clips.map((c) => (c.id === clip.id ? { ...c, text: { ...c.text!, content: e.target.value } } : c)) }))}
        onBlur={() => editor.end()}
        className="text-[12.5px]"
        placeholder="Title text"
      />
      <SliderRow label="Size" value={text.size} display={`${text.size}px`} min={16} max={260} step={1} onChange={(v) => setText({ size: v })} />
      <div className="flex items-center gap-1.5">
        <span className="mr-1 text-[11.5px] text-fg-2">Color</span>
        {swatches.map((c) => (
          <motion.button
            key={c}
            whileTap={{ scale: 0.85 }}
            onClick={() => setText({ color: c }, false)}
            className={cn('size-5.5 rounded-full ring-1 ring-white/20 transition-shadow duration-200', text.color.toLowerCase() === c.toLowerCase() && 'ring-2 ring-white shadow-[0_0_0_3px_rgb(0_0_0/0.4)]')}
            style={{ background: c }}
            aria-label={c}
          />
        ))}
        <label className="relative ml-auto grid size-5.5 cursor-pointer place-items-center overflow-hidden rounded-full bg-[conic-gradient(red,yellow,lime,cyan,blue,magenta,red)] ring-1 ring-white/20" title="Custom colour">
          <input type="color" value={text.color} onChange={(e) => setText({ color: e.target.value })} className="absolute inset-0 cursor-pointer opacity-0" />
        </label>
      </div>
      <div className="flex gap-2">
        <div
          ref={padRef}
          onPointerDown={dragPad}
          className="relative shrink-0 cursor-crosshair overflow-hidden rounded-lg border border-line bg-black/50"
          style={{ width: aspect >= 1 ? 112 : 112 * aspect * (112 / 112), height: aspect >= 1 ? 112 / aspect : 112 }}
        >
          <div className="absolute inset-[10%] rounded-sm border border-dashed border-white/10" />
          <motion.div
            className="absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent shadow-[0_0_0_3px_color-mix(in_oklab,var(--accent)_30%,transparent),0_0_12px_var(--accent)]"
            animate={{ left: `${text.x * 100}%`, top: `${text.y * 100}%` }}
            transition={spring}
          />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {POSITIONS.map((p) => (
            <button
              key={p.id}
              onClick={() => setText({ x: 0.5, y: p.y }, false)}
              className={cn(
                'h-6.5 rounded-md border px-2 text-left text-[11px] font-medium transition-colors',
                Math.abs(text.y - p.y) < 0.02 && Math.abs(text.x - 0.5) < 0.02 ? 'border-[color-mix(in_oklab,var(--accent)_45%,transparent)] bg-[color-mix(in_oklab,var(--accent)_12%,transparent)] text-fg' : 'border-line text-fg-2 hover:bg-white/[0.05]'
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
    </Section>
  )
}

function MultiInspector({ clips }: { clips: TimelineClip[] }): React.JSX.Element {
  const withAudio = clips.filter((c) => !c.text)
  const avg = withAudio.length ? withAudio.reduce((s, c) => s + c.volume, 0) / withAudio.length : 1
  const span = Math.max(...clips.map(clipEnd)) - Math.min(...clips.map((c) => c.start))
  return (
    <div className="flex flex-col pb-4">
      <div className="px-4 pt-4 pb-3">
        <div className="text-[13px] font-semibold">{clips.length} clips selected</div>
        <div className="text-[11px] text-fg-3">Spanning {shortDuration(span)}</div>
      </div>
      {withAudio.length > 0 && (
        <Section title="Audio" icon={<Volume2 />}>
          <SliderRow
            label="Volume (all)"
            value={Math.round(avg * 100)}
            display={`${Math.round(avg * 100)}%`}
            min={0}
            max={100}
            step={1}
            onChange={(v) => {
              const ids = new Set(withAudio.map((c) => c.id))
              liveEdit((tl) => ({ ...tl, clips: tl.clips.map((c) => (ids.has(c.id) ? { ...c, volume: v / 100 } : c)) }))
            }}
          />
        </Section>
      )}
      <div className="flex gap-1.5 px-4 pt-2">
        <Button size="sm" variant="secondary" className="flex-1" icon={<Copy className="size-3.5" />} onClick={duplicateSelection}>
          Duplicate
        </Button>
        <Button size="sm" variant="danger" className="flex-1" icon={<Trash2 className="size-3.5" />} onClick={() => deleteSelection(false)}>
          Delete
        </Button>
      </div>
      <div className="px-4 pt-2">
        <Button size="sm" variant="ghost" className="w-full" onClick={() => deleteSelection(true)}>
          Ripple delete
        </Button>
      </div>
    </div>
  )
}

function TimelineInspector({ tl }: { tl: Timeline }): React.JSX.Element {
  const preset = presetFor(tl.width, tl.height)
  const [name, setName] = useState(tl.name)
  useEffect(() => setName(tl.name), [tl.name])
  const counts = useMemo(() => {
    const v = tl.tracks.filter((t) => t.kind === 'video').length
    const a = tl.tracks.filter((t) => t.kind === 'audio').length
    return { v, a, clips: tl.clips.length }
  }, [tl])
  return (
    <div className="flex flex-col pb-4">
      <Section title="Timeline">
        <Input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== tl.name && editor.commit((t) => ({ ...t, name: name.trim() }))} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} className="h-8 text-[12.5px]" />
        <div className="grid grid-cols-3 gap-1.5 text-center">
          {[
            { k: 'Length', v: shortDuration(timelineDuration(tl)) },
            { k: 'Clips', v: String(counts.clips) },
            { k: 'Tracks', v: `${counts.v}V · ${counts.a}A` }
          ].map((s) => (
            <div key={s.k} className="rounded-lg border border-line bg-white/[0.025] px-1 py-2">
              <div className="text-[12.5px] font-semibold tabular-nums">{s.v}</div>
              <div className="text-[10px] text-fg-3">{s.k}</div>
            </div>
          ))}
        </div>
      </Section>
      <Section title="Frame">
        <div className="grid grid-cols-2 gap-1.5">
          {RES_PRESETS.map((p) => {
            const active = preset?.id === p.id
            return (
              <button
                key={p.id}
                onClick={() => editor.commit((t) => ({ ...t, width: p.w, height: p.h }))}
                className={cn(
                  'flex items-center gap-2 rounded-lg border px-2 py-1.5 text-left transition-colors',
                  active ? 'border-[color-mix(in_oklab,var(--accent)_45%,transparent)] bg-[color-mix(in_oklab,var(--accent)_10%,transparent)]' : 'border-line hover:bg-white/[0.05]'
                )}
              >
                <AspectGlyph w={p.w} h={p.h} size={18} active={active} />
                <span className="min-w-0">
                  <span className="block truncate text-[11.5px] font-medium">{p.label}</span>
                  <span className="block text-[10px] whitespace-nowrap text-fg-3 tabular-nums">
                    {p.w}×{p.h}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
        <Segmented
          size="sm"
          className="w-full [&>button]:flex-1 [&>button]:justify-center"
          value={String(tl.fps) as '24' | '30'}
          onChange={(v) => editor.commit((t) => ({ ...t, fps: Number(v) }))}
          items={[
            { value: '24', label: '24 fps' },
            { value: '30', label: '30 fps' }
          ]}
        />
      </Section>
      <Section title="Shortcuts">
        <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]">
          {[
            ['Space', 'Play / pause'],
            ['J K L', 'Shuttle'],
            ['← →', 'Step a frame'],
            ['S', 'Split at playhead'],
            ['Del', 'Delete · ⇧ ripple'],
            ['Ctrl D', 'Duplicate'],
            ['I  O', 'Mark in / out'],
            ['Ctrl Z', 'Undo · ⇧ redo'],
            ['Alt', 'Drag without snapping']
          ].map(([k, v]) => (
            <div key={k} className="contents">
              <span className="font-mono text-fg-2">{k}</span>
              <span className="text-fg-3">{v}</span>
            </div>
          ))}
        </div>
      </Section>
    </div>
  )
}
