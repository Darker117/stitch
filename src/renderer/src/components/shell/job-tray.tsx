// Floating queue of generations with live latent previews.
import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { AlertTriangle, Check, ChevronDown, Layers, X } from 'lucide-react'
import type { GenJob } from '@shared/types'
import { cn, formatEta } from '@/lib/utils'
import { ease, spring } from '@/lib/motion'
import { useCollection } from '@/stores/db'
import { isActive, useGen } from '@/stores/gen'
import { AssetLightbox, AssetThumb } from '../media'
import { ProgressBar, ProgressRing } from '../ui/misc'

export function JobRow({ job, onOpen }: { job: GenJob; onOpen: (id: string) => void }): React.JSX.Element {
  const recipes = useGen((s) => s.recipes)
  const cancel = useGen((s) => s.cancel)
  const assets = useCollection('assets')
  const recipe = recipes.find((r) => r.id === job.recipeId)
  const output = assets.find((a) => a.id === job.outputs[0])
  const pct = job.progress && job.progress.max ? job.progress.value / job.progress.max : undefined
  const elapsed = job.startedAt ? (Date.now() - job.startedAt) / 1000 : 0
  const eta = recipe?.estSeconds && job.status === 'running' ? Math.max(1, recipe.estSeconds - elapsed) : undefined
  return (
    <motion.div layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: 20 }} transition={spring} className="flex items-center gap-3 rounded-xl p-2 transition hover:bg-white/[0.04]">
      <div className="relative size-12 shrink-0 overflow-hidden rounded-lg bg-white/[0.05] ring-1 ring-line">
        {output ? (
          <AssetThumb asset={output} className="size-full" rounded="rounded-lg" onClick={() => onOpen(output.id)} />
        ) : job.preview ? (
          <img src={job.preview} className="size-full object-cover" />
        ) : (
          <div className="shimmer size-full" />
        )}
        {job.status === 'error' && (
          <div className="absolute inset-0 grid place-items-center bg-danger/20 text-danger">
            <AlertTriangle className="size-4" />
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[12.5px] font-medium">{job.label ?? recipe?.name ?? 'Generation'}</span>
          {job.status === 'done' && <Check className="size-3.5 text-success" />}
        </div>
        <div className="truncate text-[11px] text-fg-3" title={job.error}>
          {job.status === 'queued' && 'Waiting in queue…'}
          {job.status === 'running' && (pct !== undefined ? `Step ${job.progress!.value}/${job.progress!.max}` : 'Loading models…') + (eta ? ` · ${formatEta(eta)} left` : '')}
          {job.status === 'done' && `${recipe?.name ?? 'Done'}`}
          {job.status === 'error' && job.error}
          {job.status === 'canceled' && 'Canceled'}
        </div>
        {isActive(job) && <ProgressBar value={pct} className="mt-1.5" />}
      </div>
      {isActive(job) && (
        <button onClick={() => void cancel(job.id)} className="grid size-6 place-items-center rounded-md text-fg-3 transition hover:bg-white/10 hover:text-fg" title="Cancel">
          <X className="size-3.5" />
        </button>
      )}
    </motion.div>
  )
}

export function JobTray(): React.JSX.Element | null {
  const jobs = useGen((s) => s.jobs)
  const clear = useGen((s) => s.clearFinished)
  const [open, setOpen] = useState(false)
  const [lightbox, setLightbox] = useState<string | null>(null)
  const list = useMemo(() => Object.values(jobs).sort((a, b) => b.createdAt - a.createdAt).slice(0, 30), [jobs])
  const active = list.filter(isActive)
  const recent = list.filter((j) => !isActive(j) && Date.now() - (j.finishedAt ?? j.createdAt) < 10 * 60_000)
  const running = active.find((j) => j.status === 'running')
  const pct = running?.progress?.max ? running.progress.value / running.progress.max : undefined

  // Pop open briefly when something new starts.
  const lastCount = useRef(active.length)
  useEffect(() => {
    if (active.length > lastCount.current && !open) {
      setOpen(true)
      const t = setTimeout(() => setOpen(false), 2600)
      lastCount.current = active.length
      return () => clearTimeout(t)
    }
    lastCount.current = active.length
    return undefined
  }, [active.length, open])

  if (!active.length && !recent.length) return null

  return (
    <>
      <motion.div layout transition={spring} className="glass-strong fixed right-4 bottom-4 z-40 overflow-hidden rounded-2xl shadow-[var(--shadow-pop)]" style={{ width: open ? 360 : 'auto' }}>
        <button onClick={() => setOpen((o) => !o)} className="flex h-11 w-full items-center gap-2.5 px-3 text-left">
          {active.length ? <ProgressRing value={pct} size={22} /> : <Layers className="size-4 text-fg-2" />}
          <span className="text-[12.5px] font-medium whitespace-nowrap">
            {active.length ? `${active.length} generating` : `${recent.length} finished`}
          </span>
          {running?.preview && !open && <img src={running.preview} className="size-7 rounded-md object-cover ring-1 ring-line" />}
          <ChevronDown className={cn('ml-auto size-3.5 text-fg-3 transition-transform duration-300', !open && 'rotate-180')} />
        </button>
        <AnimatePresence initial={false}>
          {open && (
            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.3, ease }}>
              <div className="max-h-[50vh] overflow-y-auto border-t border-line p-1.5">
                <AnimatePresence initial={false}>
                  {[...active, ...recent].map((j) => (
                    <JobRow key={j.id} job={j} onOpen={setLightbox} />
                  ))}
                </AnimatePresence>
              </div>
              {recent.length > 0 && (
                <div className="flex justify-end border-t border-line px-3 py-2">
                  <button onClick={() => void clear()} className="text-[11.5px] font-medium text-fg-3 hover:text-fg">
                    Clear finished
                  </button>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
      <AssetLightbox assetId={lightbox} onClose={() => setLightbox(null)} />
    </>
  )
}
