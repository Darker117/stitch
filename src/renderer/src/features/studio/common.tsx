// Studio building blocks shared by the home grid and the editor.
import { useEffect, useState } from 'react'
import { motion } from 'motion/react'
import { Clapperboard, Film } from 'lucide-react'
import type { Asset, ID, Timeline } from '@shared/types'
import { cn } from '@/lib/utils'
import { spring } from '@/lib/motion'
import { db, useCollection } from '@/stores/db'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog } from '@/components/ui/overlay'
import { Segmented } from '@/components/ui/controls'
import { Field } from '@/components/ui/misc'
import { RES_PRESETS, newTimeline } from './model'
import { posterUrl, timelinePoster } from './helpers'

// ─── Glyphs ──────────────────────────────────────────────────────────────────

export function AspectGlyph({ w, h, size = 26, active }: { w: number; h: number; size?: number; active?: boolean }): React.JSX.Element {
  const k = size / Math.max(w, h)
  return (
    <span className="grid place-items-center" style={{ width: size, height: size }}>
      <span
        className={cn('block rounded-[4px] border-[1.5px] transition-colors duration-300', active ? 'border-transparent bg-grad' : 'border-fg-3/80')}
        style={{ width: Math.round(w * k), height: Math.round(h * k) }}
      />
    </span>
  )
}

// ─── Posters ─────────────────────────────────────────────────────────────────

export function PosterFallback({ className, small }: { className?: string; small?: boolean }): React.JSX.Element {
  return (
    <div className={cn('relative grid size-full place-items-center overflow-hidden bg-[color-mix(in_oklab,var(--panel-solid)_55%,black)]', className)}>
      <div className="absolute inset-0 bg-grad opacity-[0.16]" />
      <div className="absolute -inset-1/2 bg-[radial-gradient(circle_at_30%_30%,color-mix(in_oklab,var(--accent-2)_35%,transparent),transparent_55%)]" />
      <Clapperboard className={cn('relative text-fg-2/70', small ? 'size-3.5' : 'size-7')} strokeWidth={1.5} />
    </div>
  )
}

export function TimelineThumb({ tl, assets, className, small }: { tl: Timeline; assets: Map<ID, Asset>; className?: string; small?: boolean }): React.JSX.Element {
  const poster = timelinePoster(tl, assets)
  const url = posterUrl(poster)
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [url])
  return url && !failed ? (
    <img src={url} alt="" draggable={false} onError={() => setFailed(true)} className={cn('size-full object-cover', className)} />
  ) : poster?.kind === 'video' ? (
    <div className={cn('grid size-full place-items-center bg-black/40 text-fg-3', className)}>
      <Film className={small ? 'size-3.5' : 'size-6'} />
    </div>
  ) : (
    <PosterFallback className={className} small={small} />
  )
}

// ─── Dialogs ─────────────────────────────────────────────────────────────────

export function NewTimelineDialog({
  open,
  onClose,
  onCreated,
  projectId
}: {
  open: boolean
  onClose: () => void
  onCreated: (tl: Timeline) => void
  projectId?: ID
}): React.JSX.Element {
  const timelines = useCollection('timelines')
  const [name, setName] = useState('')
  const [preset, setPreset] = useState(RES_PRESETS[0].id)
  const [fps, setFps] = useState<'24' | '30'>('30')
  useEffect(() => {
    if (open) setName(`Timeline ${timelines.length + 1}`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  const create = async (): Promise<void> => {
    const p = RES_PRESETS.find((x) => x.id === preset)!
    const tl = newTimeline(name.trim() || 'Untitled timeline', p.w, p.h, Number(fps), projectId)
    await db.put('timelines', tl)
    onClose()
    onCreated(tl)
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="New timeline"
      description="Pick a frame and frame rate — you can change them later."
      width={540}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void create()}>
            Create timeline
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5 p-5">
        <Field label="Name">
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void create()} />
        </Field>
        <Field label="Frame">
          <div className="grid grid-cols-4 gap-2">
            {RES_PRESETS.map((p) => {
              const active = p.id === preset
              return (
                <motion.button
                  key={p.id}
                  whileTap={{ scale: 0.97 }}
                  onClick={() => setPreset(p.id)}
                  className={cn(
                    'relative flex flex-col items-center gap-2 rounded-xl border px-2 pt-4 pb-3 text-center transition-colors duration-200',
                    active ? 'border-transparent text-fg' : 'border-line bg-white/[0.03] text-fg-2 hover:bg-white/[0.06]'
                  )}
                >
                  {active && (
                    <motion.span
                      layoutId="res-preset"
                      className="absolute inset-0 rounded-xl border border-[color-mix(in_oklab,var(--accent)_50%,transparent)] bg-[color-mix(in_oklab,var(--accent)_10%,transparent)]"
                      transition={spring}
                    />
                  )}
                  <span className="relative">
                    <AspectGlyph w={p.w} h={p.h} size={34} active={active} />
                  </span>
                  <span className="relative text-[12px] font-semibold">{p.label}</span>
                  <span className="relative -mt-1.5 text-[10.5px] text-fg-3 tabular-nums">{p.hint.split(' · ')[0]}</span>
                </motion.button>
              )
            })}
          </div>
        </Field>
        <Field label="Frame rate">
          <Segmented
            value={fps}
            onChange={setFps}
            items={[
              { value: '24', label: '24 fps · cinematic' },
              { value: '30', label: '30 fps · smooth' }
            ]}
          />
        </Field>
      </div>
    </Dialog>
  )
}

export function RenameDialog({ open, initial, onClose, onSave, title = 'Rename timeline' }: { open: boolean; initial: string; onClose: () => void; onSave: (name: string) => void; title?: string }): React.JSX.Element {
  const [name, setName] = useState(initial)
  useEffect(() => {
    if (open) setName(initial)
  }, [open, initial])
  const save = (): void => {
    if (name.trim()) onSave(name.trim())
    onClose()
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={title}
      width={420}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <div className="p-5">
        <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} onFocus={(e) => e.target.select()} />
      </div>
    </Dialog>
  )
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  body,
  confirm = 'Delete'
}: {
  open: boolean
  onClose: () => void
  onConfirm: () => void
  title: string
  body?: string
  confirm?: string
}): React.JSX.Element {
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={title}
      width={420}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              onConfirm()
              onClose()
            }}
          >
            {confirm}
          </Button>
        </>
      }
    >
      {body ? <p className="p-5 text-[12.5px] text-fg-2">{body}</p> : <div className="h-2" />}
    </Dialog>
  )
}
