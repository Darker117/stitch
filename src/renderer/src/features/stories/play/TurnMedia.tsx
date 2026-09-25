// Media attached to a story turn: See stills, Animate clips, narration —
// plus live progress while jobs run.
import { useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Clapperboard, Eye, Maximize2, Volume2 } from 'lucide-react'
import type { Adventure, GenJob, ID, StoryAction } from '@shared/types'
import { ProgressBar } from '@/components/ui/misc'
import { WavePlayer } from '@/components/audio'
import { fileUrl } from '@/lib/api'
import { cn, formatDuration } from '@/lib/utils'
import { ease, spring } from '@/lib/motion'
import { useDoc } from '@/stores/db'
import { isActive, useGen } from '@/stores/gen'
import type { MediaPending } from './usePlay'

function Reveal({ children, className }: { children: React.ReactNode; className?: string }): React.JSX.Element {
  return (
    <motion.div
      layout
      initial={{ opacity: 0, scale: 1.015, filter: 'blur(14px)' }}
      animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
      exit={{ opacity: 0, scale: 0.98 }}
      transition={{ duration: 0.9, ease }}
      className={className}
    >
      {children}
    </motion.div>
  )
}

function Still({ id, onOpen, onAnimate, animating }: { id: ID; onOpen: (id: ID) => void; onAnimate?: () => void; animating?: boolean }): React.JSX.Element | null {
  const asset = useDoc('assets', id)
  if (!asset) return null
  return (
    <Reveal className="group/m relative overflow-hidden rounded-2xl ring-1 ring-line">
      <img src={fileUrl(asset.path)} draggable={false} onClick={() => onOpen(id)} className="aspect-video w-full cursor-zoom-in object-cover transition-transform duration-700 ease-out group-hover/m:scale-[1.015]" />
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_top,rgb(0_0_0/0.45),transparent_40%)] opacity-0 transition-opacity duration-300 group-hover/m:opacity-100" />
      <div className="absolute right-2.5 bottom-2.5 flex gap-1.5 opacity-0 transition-opacity duration-300 group-hover/m:opacity-100">
        {onAnimate && (
          <button onClick={onAnimate} disabled={animating} className="flex h-8 items-center gap-1.5 rounded-full bg-black/55 px-3 text-[12px] font-medium text-white backdrop-blur-md transition hover:bg-black/75 disabled:opacity-50">
            <Clapperboard className="size-3.5" /> Animate
          </button>
        )}
        <button onClick={() => onOpen(id)} className="grid size-8 place-items-center rounded-full bg-black/55 text-white backdrop-blur-md transition hover:bg-black/75" title="Open">
          <Maximize2 className="size-3.5" />
        </button>
      </div>
    </Reveal>
  )
}

function Clip({ id, onOpen }: { id: ID; onOpen: (id: ID) => void }): React.JSX.Element | null {
  const asset = useDoc('assets', id)
  const ref = useRef<HTMLVideoElement>(null)
  const [muted, setMuted] = useState(true)
  if (!asset) return null
  return (
    <Reveal className="group/m relative overflow-hidden rounded-2xl ring-1 ring-line">
      <video ref={ref} src={fileUrl(asset.path)} poster={asset.thumbPath ? fileUrl(asset.thumbPath) : undefined} autoPlay loop muted={muted} playsInline className="aspect-video w-full object-cover" onClick={() => onOpen(id)} />
      <div className="absolute right-2.5 bottom-2.5 flex gap-1.5 opacity-0 transition-opacity duration-300 group-hover/m:opacity-100">
        <button onClick={() => setMuted((m) => !m)} className="flex h-8 items-center gap-1.5 rounded-full bg-black/55 px-3 text-[12px] font-medium text-white backdrop-blur-md hover:bg-black/75">
          <Volume2 className="size-3.5" /> {muted ? 'Sound on' : 'Mute'}
        </button>
        <button onClick={() => onOpen(id)} className="grid size-8 place-items-center rounded-full bg-black/55 text-white backdrop-blur-md hover:bg-black/75" title="Open">
          <Maximize2 className="size-3.5" />
        </button>
      </div>
      <span className="absolute top-2.5 left-2.5 flex items-center gap-1 rounded-md bg-black/50 px-1.5 py-0.5 text-[10.5px] font-medium text-white/90 backdrop-blur">
        <Clapperboard className="size-3" /> {formatDuration(asset.duration)}
      </span>
    </Reveal>
  )
}

export function NarrationPlayer({ id, autoplay }: { id: ID; autoplay?: boolean }): React.JSX.Element | null {
  const asset = useDoc('assets', id)
  if (!asset) return null
  return (
    <Reveal className="rounded-2xl border border-line bg-[var(--panel)] px-2.5 py-1.5 backdrop-blur-xl">
      <WavePlayer src={fileUrl(asset.path)} seed={id} duration={asset.duration} bars={72} height={28} size="sm" autoPlay={autoplay} />
    </Reveal>
  )
}

function JobCard({ job, label }: { job?: GenJob; label: string }): React.JSX.Element {
  const pct = job?.progress?.max ? job.progress.value / job.progress.max : undefined
  return (
    <motion.div layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.98 }} transition={spring} className="relative aspect-video overflow-hidden rounded-2xl border border-line bg-white/[0.03]">
      <div className="shimmer absolute inset-0" />
      <AnimatePresence>{job?.preview && <motion.img key="p" src={job.preview} initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="absolute inset-0 size-full scale-105 object-cover blur-[3px]" />}</AnimatePresence>
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_60%,transparent,rgb(0_0_0/0.45))]" />
      <div className="absolute inset-x-0 bottom-0 flex flex-col gap-2 p-4">
        <div className="flex items-center gap-2 text-[12px] font-medium text-white/90">
          <motion.span animate={{ opacity: [0.5, 1, 0.5] }} transition={{ duration: 1.6, repeat: Infinity }} className="size-1.5 rounded-full bg-accent" />
          {label}
          {job?.status === 'queued' && <span className="text-white/60">· waiting in queue</span>}
          {pct !== undefined && <span className="ml-auto text-white/60 tabular-nums">{Math.round(pct * 100)}%</span>}
        </div>
        <ProgressBar value={job?.status === 'running' ? pct : undefined} className="bg-white/15" />
      </div>
    </motion.div>
  )
}

export function TurnMedia({
  adv,
  action,
  pending,
  onOpen,
  onAnimate,
  autoplay
}: {
  adv: Adventure
  action: StoryAction
  pending?: MediaPending
  onOpen: (id: ID) => void
  onAnimate: () => void
  autoplay: string | null
}): React.JSX.Element | null {
  const jobs = useGen((s) => s.jobs)
  const active = useMemo(
    () =>
      Object.values(jobs)
        .filter((j) => isActive(j) && ((j.origin?.type === 'adventure' && j.origin.id === adv.id && j.origin.sub === action.id) || (pending?.keyframeJobId && j.id === pending.keyframeJobId)))
        .sort((a, b) => a.createdAt - b.createdAt),
    [jobs, adv.id, action.id, pending?.keyframeJobId]
  )
  const media = action.media ?? []
  const visuals = media.filter((m) => m.kind !== 'audio')
  const audio = media.filter((m) => m.kind === 'audio')
  const writing = pending?.see === 'prompt' || pending?.animate === 'prompt'
  const hasAnything = visuals.length || audio.length || active.length || writing || pending?.narrate
  if (!hasAnything) return null
  const animating = !!pending?.animate || active.some((j) => j.kind === 'video')

  return (
    <motion.div layout className="mt-3 flex flex-col gap-2.5">
      <div className={cn('grid gap-2.5', visuals.length + active.length + (writing ? 1 : 0) > 1 ? 'grid-cols-2' : 'grid-cols-1')}>
        <AnimatePresence initial={false}>
          {visuals.map((m) =>
            m.kind === 'video' ? <Clip key={m.assetId} id={m.assetId} onOpen={onOpen} /> : <Still key={m.assetId} id={m.assetId} onOpen={onOpen} onAnimate={onAnimate} animating={animating} />
          )}
          {writing && <JobCard key="writing" label={pending?.animate === 'prompt' ? 'Directing the shot…' : 'Imagining the scene…'} />}
          {active.map((j) => (
            <JobCard key={j.id} job={j} label={j.kind === 'video' ? 'Animating…' : pending?.keyframeJobId === j.id ? 'Painting the keyframe…' : 'Painting the scene…'} />
          ))}
        </AnimatePresence>
      </div>
      <AnimatePresence initial={false}>
        {audio.map((m) => (
          <NarrationPlayer key={m.assetId} id={m.assetId} autoplay={autoplay === m.assetId} />
        ))}
        {pending?.narrate && (
          <motion.div key="nar" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="shimmer flex h-11 items-center gap-2 rounded-full border border-line px-4 text-[12px] text-fg-2">
            <Volume2 className="size-3.5" /> Recording narration…
          </motion.div>
        )}
      </AnimatePresence>
      {!visuals.length && !active.length && !writing && action.type === 'see' && (
        <div className="flex items-center gap-2 text-[12px] text-fg-3">
          <Eye className="size-3.5" /> Nothing rendered yet.
        </div>
      )}
    </motion.div>
  )
}
