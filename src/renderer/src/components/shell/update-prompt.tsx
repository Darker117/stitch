// "Update ready" card: slides in once an update has downloaded and asks before
// restarting. "Later" installs it on the next quit instead.
import { useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router'
import { AnimatePresence, motion } from 'motion/react'
import { ArrowUpRight, RotateCw } from 'lucide-react'
import { spring } from '@/lib/motion'
import { useGen } from '@/stores/gen'
import { useUpdate } from '@/stores/update'
import { Button } from '../ui/button'
import { LogoMark } from './logo'

export function UpdatePrompt(): React.JSX.Element {
  const state = useUpdate((s) => s.state)
  const init = useUpdate((s) => s.init)
  const install = useUpdate((s) => s.install)
  const defer = useUpdate((s) => s.defer)
  const jobs = useGen((s) => s.jobs)
  const navigate = useNavigate()
  useEffect(() => {
    void init()
  }, [init])

  const busy = useMemo(() => Object.values(jobs).filter((j) => j.status === 'queued' || j.status === 'running').length, [jobs])
  const open = state?.status === 'downloaded' && !state.deferred

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="update"
          initial={{ opacity: 0, y: 24, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 16, scale: 0.97 }}
          transition={spring}
          className="glass-strong fixed bottom-4 left-4 z-[60] w-[340px] overflow-hidden rounded-2xl shadow-[var(--shadow-pop)]"
          role="alertdialog"
          aria-label="Update ready"
        >
          <div className="pointer-events-none absolute -top-16 -left-10 size-48 rounded-full bg-grad opacity-20 blur-3xl" />
          <div className="relative flex gap-3 p-4">
            <motion.div initial={{ rotate: -12, scale: 0.7 }} animate={{ rotate: 0, scale: 1 }} transition={{ ...spring, delay: 0.1 }} className="grid size-11 shrink-0 place-items-center rounded-xl border border-line bg-white/[0.04]">
              <LogoMark size={28} />
            </motion.div>
            <div className="min-w-0 flex-1">
              <div className="label-caps text-accent">Update ready</div>
              <div className="mt-0.5 text-[14px] font-semibold">Stitch {state.version}</div>
              <p className="mt-1 text-[12px] leading-relaxed text-fg-2">
                Restart to finish updating — it takes a few seconds and Stitch reopens where you left off.
                {busy > 0 && <span className="text-warning"> {busy === 1 ? '1 generation is' : `${busy} generations are`} still running and will stop.</span>}
              </p>
              <button onClick={() => navigate('/settings?tab=updates')} className="mt-1.5 inline-flex items-center gap-1 text-[12px] font-medium text-fg-3 transition hover:text-fg">
                What’s new <ArrowUpRight className="size-3" />
              </button>
            </div>
          </div>
          <div className="relative flex justify-end gap-2 border-t border-line px-4 py-3">
            <Button variant="ghost" size="sm" onClick={() => void defer()}>
              Later
            </Button>
            <Button variant="primary" size="sm" icon={<RotateCw className="size-3.5" />} onClick={() => void install()}>
              Restart now
            </Button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
