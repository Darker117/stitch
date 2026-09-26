// Generations on the phone: a slim "now rendering" bar docked above the tab bar (like a mini player; in the
// full-screen story player it sits under the top bar, clear of the command bar),
// expanding into a sheet with the full queue and live previews.
import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Check, ChevronUp, Layers } from 'lucide-react'
import { AssetLightbox } from '@/components/media'
import { JobRow } from '@/components/shell/job-tray'
import { ProgressRing } from '@/components/ui/misc'
import { fileUrl } from '@/lib/api'
import { ease, spring } from '@/lib/motion'
import { useCollection } from '@/stores/db'
import { isActive, useGen } from '@/stores/gen'
import { useKeyboard } from './insets'
import { Sheet } from './Sheet'
import { success, tap } from './haptics'

export function JobDock({ floating }: { floating?: boolean }): React.JSX.Element {
  const jobs = useGen((s) => s.jobs)
  const recipes = useGen((s) => s.recipes)
  const clear = useGen((s) => s.clearFinished)
  const assets = useCollection('assets')
  const keyboard = useKeyboard((s) => s.open)
  const [open, setOpen] = useState(false)
  const [lightbox, setLightbox] = useState<string | null>(null)
  const [justDone, setJustDone] = useState<string | null>(null)

  const list = useMemo(() => Object.values(jobs).sort((a, b) => b.createdAt - a.createdAt).slice(0, 40), [jobs])
  const active = list.filter(isActive)
  const recent = list.filter((j) => !isActive(j) && Date.now() - (j.finishedAt ?? j.createdAt) < 10 * 60_000)
  const running = active.find((j) => j.status === 'running') ?? active[0]
  const pct = running?.progress?.max ? running.progress.value / running.progress.max : undefined

  // Flash the finished result for a few seconds when the queue empties.
  const prevActive = useRef(active.length)
  useEffect(() => {
    if (prevActive.current > 0 && active.length === 0) {
      const done = list.find((j) => j.status === 'done')
      if (done) {
        success()
        setJustDone(done.id)
        const t = setTimeout(() => setJustDone(null), 7000)
        prevActive.current = active.length
        return () => clearTimeout(t)
      }
    }
    prevActive.current = active.length
    return undefined
  }, [active.length, list])

  const doneJob = justDone ? jobs[justDone] : undefined
  const doneAsset = doneJob ? assets.find((a) => a.id === doneJob.outputs[0]) : undefined
  const show = !keyboard && (active.length > 0 || !!doneJob)
  const label = running ? (running.label ?? recipes.find((r) => r.id === running.recipeId)?.name ?? 'Generating') : (doneJob?.label ?? recipes.find((r) => r.id === doneJob?.recipeId)?.name ?? 'Done')

  return (
    <>
      <AnimatePresence initial={false}>
        {show && (
          <motion.div
            key="dock"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.35, ease }}
            className={floating ? 'fixed inset-x-0 top-[calc(var(--sat,0px)+52px)] z-40 px-3' : 'relative z-20 shrink-0 overflow-hidden px-3'}
          >
            <motion.button
              layout
              whileTap={{ scale: 0.98 }}
              onClick={() => {
                tap()
                if (!running && doneAsset) setLightbox(doneAsset.id)
                else setOpen(true)
              }}
              className="glass-strong hairline relative mt-1.5 flex h-[54px] w-full items-center gap-3 overflow-hidden rounded-[18px] pr-3 pl-2 text-left shadow-[0_14px_40px_-16px_rgb(0_0_0/0.9)]"
            >
              <div className="relative size-10 shrink-0 overflow-hidden rounded-xl bg-white/[0.05] ring-1 ring-line">
                {running?.preview ? (
                  <img src={running.preview} className="size-full object-cover" />
                ) : doneAsset?.kind === 'image' ? (
                  <img src={fileUrl(doneAsset.path)} className="size-full object-cover" />
                ) : running ? (
                  <div className="shimmer size-full" />
                ) : (
                  <div className="grid size-full place-items-center text-success">
                    <Check className="size-4" />
                  </div>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-[13px] font-semibold">{label}</span>
                  {!running && <Check className="size-3.5 shrink-0 text-success" />}
                </div>
                <div className="truncate text-[11.5px] text-fg-3">
                  {running
                    ? running.status === 'queued'
                      ? 'Waiting in queue…'
                      : pct !== undefined
                        ? `Step ${running.progress!.value}/${running.progress!.max}${active.length > 1 ? ` · ${active.length - 1} more queued` : ''}`
                        : 'Loading models…'
                    : 'Finished · tap to view'}
                </div>
              </div>
              {running ? <ProgressRing value={pct} size={26} /> : <ChevronUp className="size-4 text-fg-3" />}
              {running && (
                <motion.div className="absolute inset-x-0 bottom-0 h-[2px] origin-left bg-grad" animate={{ scaleX: pct ?? 0.05 }} transition={spring} />
              )}
            </motion.button>
          </motion.div>
        )}
      </AnimatePresence>

      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title={
          <div className="flex items-center gap-2">
            <Layers className="size-4 text-accent" /> Generations
            {recent.length > 0 && (
              <button onClick={() => void clear()} className="ml-auto text-[12px] font-medium text-fg-3">
                Clear finished
              </button>
            )}
          </div>
        }
      >
        <div className="px-2 pt-2 pb-4">
          <AnimatePresence initial={false}>
            {[...active, ...recent].map((j) => (
              <JobRow key={j.id} job={j} onOpen={(id) => setLightbox(id)} />
            ))}
          </AnimatePresence>
          {!active.length && !recent.length && <div className="py-10 text-center text-[12.5px] text-fg-3">Nothing rendering right now.</div>}
        </div>
      </Sheet>
      <AssetLightbox assetId={lightbox} onClose={() => setLightbox(null)} />
    </>
  )
}
