// Export: renders the timeline to MP4 through ffmpeg in the main process.
import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { AlertTriangle, Check, FileVideo, FolderOpen, Library, Play, RotateCcw } from 'lucide-react'
import type { ExportProgress } from '@shared/ipc'
import type { Timeline } from '@shared/types'
import { errorText, invoke, on } from '@/lib/api'
import { cn } from '@/lib/utils'
import { ease, spring } from '@/lib/motion'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/overlay'
import { ProgressBar, ProgressRing } from '@/components/ui/misc'
import { AspectGlyph } from './common'
import { flushSave } from './store'
import { shortDuration, timelineDuration } from './model'

type Phase = 'setup' | 'running' | 'done' | 'error'

function fmtClock(s: number): string {
  const m = Math.floor(s / 60)
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`
}

export function ExportDialog({ open, onClose, tl }: { open: boolean; onClose: () => void; tl: Timeline }): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>('setup')
  const [outPath, setOutPath] = useState<string | null>(null)
  const [progress, setProgress] = useState(0)
  const [result, setResult] = useState<ExportProgress | null>(null)
  const [error, setError] = useState('')
  const [elapsed, setElapsed] = useState(0)
  const exportId = useRef<string | null>(null)
  const started = useRef(0)
  const duration = timelineDuration(tl)

  useEffect(() => {
    if (open && phase !== 'running') {
      setPhase('setup')
      setProgress(0)
      setResult(null)
      setError('')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(
    () =>
      on('editor:export', (ev) => {
        if (ev.timelineId !== tl.id) return
        if (exportId.current && ev.exportId !== exportId.current) return
        exportId.current = ev.exportId
        if (!ev.done) {
          setProgress((p) => Math.max(p, ev.progress))
          return
        }
        if (ev.error) {
          if (ev.canceled) setPhase('setup')
          else {
            setError(ev.error)
            setPhase('error')
          }
          return
        }
        setProgress(1)
        setResult(ev)
        setPhase('done')
      }),
    [tl.id]
  )

  useEffect(() => {
    if (phase !== 'running') return
    const t = setInterval(() => setElapsed((performance.now() - started.current) / 1000), 250)
    return () => clearInterval(t)
  }, [phase])

  const choose = async (): Promise<void> => {
    const p = await invoke('sys:saveDialog', { defaultPath: `${tl.name.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'export'}.mp4`, filters: [{ name: 'MP4 video', extensions: ['mp4'] }] })
    if (p) setOutPath(p)
  }

  const start = async (): Promise<void> => {
    setError('')
    setProgress(0)
    setElapsed(0)
    exportId.current = null
    started.current = performance.now()
    setPhase('running')
    try {
      await flushSave()
      const r = await invoke('editor:export', tl.id, outPath ?? '')
      exportId.current = r.exportId
    } catch (err) {
      setError(errorText(err))
      setPhase('error')
    }
  }

  const cancel = (): void => {
    if (exportId.current) void invoke('editor:cancelExport', exportId.current)
  }

  const eta = progress > 0.03 && phase === 'running' ? (elapsed / progress) * (1 - progress) : undefined

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && phase !== 'running' && onClose()}
      title="Export video"
      description="H.264 + AAC MP4 · rendered locally with ffmpeg"
      width={500}
      hideClose={phase === 'running'}
      footer={
        phase === 'setup' ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" icon={<FileVideo className="size-4" />} disabled={duration <= 0} onClick={() => void start()}>
              Export
            </Button>
          </>
        ) : phase === 'running' ? (
          <Button variant="secondary" onClick={cancel}>
            Cancel export
          </Button>
        ) : phase === 'done' ? (
          <>
            <Button variant="ghost" icon={<FolderOpen className="size-3.5" />} onClick={() => result?.path && void invoke('sys:showInFolder', result.path)}>
              Show in folder
            </Button>
            <div className="flex-1" />
            <Button variant="secondary" icon={<Play className="size-3.5" />} onClick={() => result?.path && void invoke('sys:openPath', result.path)}>
              Play
            </Button>
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
            <Button variant="primary" icon={<RotateCcw className="size-3.5" />} onClick={() => void start()}>
              Try again
            </Button>
          </>
        )
      }
    >
      <AnimatePresence mode="wait" initial={false}>
        {phase === 'setup' && (
          <motion.div key="setup" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.2, ease }} className="flex flex-col gap-4 p-5">
            <div className="grid grid-cols-3 gap-2">
              <div className="flex flex-col items-center gap-1.5 rounded-xl border border-line bg-white/[0.03] py-3">
                <AspectGlyph w={tl.width} h={tl.height} size={22} active />
                <span className="text-[12px] font-semibold tabular-nums">
                  {tl.width}×{tl.height}
                </span>
                <span className="text-[10.5px] text-fg-3">Frame</span>
              </div>
              <div className="flex flex-col items-center justify-end gap-1.5 rounded-xl border border-line bg-white/[0.03] py-3">
                <span className="text-[20px] leading-none font-semibold tabular-nums">{tl.fps}</span>
                <span className="text-[10.5px] text-fg-3">fps</span>
              </div>
              <div className="flex flex-col items-center justify-end gap-1.5 rounded-xl border border-line bg-white/[0.03] py-3">
                <span className="text-[20px] leading-none font-semibold tabular-nums">{duration > 0 ? shortDuration(duration) : '—'}</span>
                <span className="text-[10.5px] text-fg-3">{tl.clips.length} clips</span>
              </div>
            </div>
            <div>
              <div className="label-caps mb-1.5">Save to</div>
              <div className="flex items-center gap-2 rounded-xl border border-line bg-white/[0.03] p-2 pl-3">
                <span className={cn('grid size-7 shrink-0 place-items-center rounded-lg', outPath ? 'bg-grad text-white' : 'bg-white/[0.06] text-fg-2')}>
                  {outPath ? <FileVideo className="size-3.5" /> : <Library className="size-3.5" />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12.5px] font-medium">{outPath ? outPath.split(/[\\/]/).pop() : 'Stitch library'}</div>
                  <div className="truncate text-[11px] text-fg-3" title={outPath ?? undefined}>
                    {outPath ?? 'Lands in Assets — choose a file for an extra copy'}
                  </div>
                </div>
                {outPath && (
                  <Button size="xs" variant="ghost" onClick={() => setOutPath(null)}>
                    Clear
                  </Button>
                )}
                <Button size="sm" variant="secondary" onClick={() => void choose()}>
                  Choose file…
                </Button>
              </div>
            </div>
            {duration <= 0 && <div className="text-[12px] text-warning">Add a clip to the timeline before exporting.</div>}
          </motion.div>
        )}

        {phase === 'running' && (
          <motion.div key="run" initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.98 }} transition={{ duration: 0.25, ease }} className="flex flex-col items-center gap-4 px-5 pt-7 pb-6">
            <div className="relative grid place-items-center">
              <motion.div className="absolute inset-0 rounded-full bg-grad opacity-25 blur-2xl" animate={{ scale: [0.9, 1.1, 0.9] }} transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut' }} />
              <ProgressRing value={progress} size={104} stroke={5} />
              <div className="absolute inset-0 grid place-items-center">
                <span className="text-[22px] font-semibold tabular-nums">{Math.round(progress * 100)}%</span>
              </div>
            </div>
            <div className="w-full max-w-[320px]">
              <ProgressBar value={progress} />
              <div className="mt-2 flex justify-between text-[11px] text-fg-3 tabular-nums">
                <span>Elapsed {fmtClock(elapsed)}</span>
                <span>{eta !== undefined ? `~${fmtClock(eta)} left` : 'Preparing…'}</span>
              </div>
            </div>
            <div className="text-[12px] text-fg-2">Rendering “{tl.name}”</div>
          </motion.div>
        )}

        {phase === 'done' && result && (
          <motion.div key="done" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.25, ease }} className="flex flex-col items-center gap-3 px-5 pt-7 pb-6 text-center">
            <motion.div initial={{ scale: 0.4, rotate: -30 }} animate={{ scale: 1, rotate: 0 }} transition={spring} className="grid size-16 place-items-center rounded-full bg-grad text-white shadow-[0_14px_40px_-10px_var(--accent)]">
              <motion.svg viewBox="0 0 24 24" className="size-7">
                <motion.path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.45, ease, delay: 0.15 }} />
              </motion.svg>
            </motion.div>
            <div className="text-[15px] font-semibold">Your video is ready</div>
            <div className="selectable flex max-w-full min-w-0 flex-col rounded-lg border border-line bg-white/[0.03] px-3 py-2 text-left" title={result.path}>
              <span className="truncate text-[12.5px] font-medium text-fg">{result.path?.split(/[\\/]/).pop()}</span>
              <span className="truncate font-mono text-[10.5px] text-fg-3" style={{ direction: 'rtl', textAlign: 'left' }}>
                <span dir="ltr">{result.path?.replace(/[\\/][^\\/]*$/, '')}</span>
              </span>
            </div>
            <div className="flex items-center gap-1.5 text-[11.5px] text-fg-3">
              <Check className="size-3 text-success" /> Added to your Assets library · rendered in {fmtClock(elapsed)}
            </div>
          </motion.div>
        )}

        {phase === 'error' && (
          <motion.div key="err" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.2, ease }} className="flex flex-col gap-3 p-5">
            <div className="flex items-center gap-2 text-[13px] font-semibold text-danger">
              <AlertTriangle className="size-4" /> Export failed
            </div>
            <pre className="selectable max-h-48 overflow-auto rounded-xl border border-danger/20 bg-danger/[0.05] p-3 font-mono text-[11px] whitespace-pre-wrap text-fg-2">{error}</pre>
          </motion.div>
        )}
      </AnimatePresence>
    </Dialog>
  )
}
