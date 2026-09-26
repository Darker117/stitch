// Install / start / stop / status for Stitch Voice — the local voice server and its
// engines (Qwen3-TTS, Kokoro, Pocket TTS), with per-engine install/remove and weights.
import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { AlertTriangle, Check, ChevronDown, Copy, Cpu, Download, Feather, Globe, HardDrive, Mic, Play, Power, RotateCcw, Sparkles, Trash2, Wand2 } from 'lucide-react'
import type { VoiceEngineInfo, VoiceEngineStatus } from '@shared/ipc'
import { errorText, invoke } from '@/lib/api'
import { cn } from '@/lib/utils'
import { ease, spring, springSoft } from '@/lib/motion'
import { approxSize, engineProgress, engineStateLabel, sizeLabel, useVoiceEngine, useVoiceEngines } from '@/lib/voice'
import { ProviderIcon, RemoveEngineDialog, engineStatusText } from '@/components/voice-picker'
import { toast } from '@/stores/toast'
import { Orb, type OrbState } from '@/components/ui/orb'
import { Button, IconButton } from '@/components/ui/button'
import { Badge, ProgressBar, ProgressRing, StatusDot } from '@/components/ui/misc'
import { Menu, MenuItem } from '@/components/ui/overlay'

const STEPS = ['Find uv', 'Python 3.12', 'PyTorch', 'Engine', 'Verify']

const MODEL_INFO: Record<string, { size: string; purpose: string; icon: React.JSX.Element }> = {
  'base-1.7b': { size: '≈4 GB', purpose: 'Clones any voice from a short sample', icon: <Mic /> },
  'custom-1.7b': { size: '≈4 GB', purpose: '9 preset speakers that follow delivery notes', icon: <Sparkles /> },
  'design-1.7b': { size: '≈4 GB', purpose: 'Invents a voice from a description', icon: <Wand2 /> },
  'base-0.6b': { size: '≈2 GB', purpose: 'Lighter, faster cloning for small GPUs', icon: <Mic /> },
  'kokoro-82m': { size: '≈355 MB', purpose: 'Kokoro model + all 49 preset voices', icon: <Feather /> },
  'pocket-english': { size: '≈230 MB', purpose: 'English model + preset voices', icon: <Globe /> }
}

const POCKET_INFO = { size: '≈230 MB', purpose: 'Another language for Pocket TTS', icon: <Globe /> }

function orbState(s: VoiceEngineStatus | null): OrbState {
  if (!s) return 'idle'
  if (s.busy === 'generating') return 'generating'
  if (s.busy === 'installing' || s.busy === 'loading-model' || s.busy === 'starting') return 'thinking'
  return s.running ? 'listening' : 'idle'
}

function lineTone(l: string): string {
  if (l.startsWith('▸')) return 'text-accent'
  if (l.startsWith('✓')) return 'text-success'
  if (l.startsWith('✗') || /\b(error|traceback|failed)\b/i.test(l)) return 'text-danger'
  if (/warn/i.test(l)) return 'text-warning'
  if (l.startsWith('$ ')) return 'text-fg-3'
  return 'text-fg-2'
}

function EngineLog({ lines, open, onToggle }: { lines: string[]; open: boolean; onToggle: () => void }): React.JSX.Element {
  const box = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  useEffect(() => {
    const el = box.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [lines, open])
  return (
    <div className="border-t border-line">
      <div className="flex items-center gap-2 px-5 py-2.5 max-md:px-4 max-md:py-1.5">
        <button onClick={onToggle} className="flex flex-1 items-center gap-2 text-left text-[12px] font-medium text-fg-2 hover:text-fg max-md:h-9">
          <motion.span animate={{ rotate: open ? 0 : -90 }} transition={spring} className="grid place-items-center">
            <ChevronDown className="size-3.5" />
          </motion.span>
          Engine log
          <span className="text-[11px] font-normal text-fg-3 tabular-nums">{lines.length ? `${lines.length} lines` : 'empty'}</span>
        </button>
        {open && lines.length > 0 && (
          <IconButton
            label="Copy log"
            size="xs"
            onClick={() => {
              void navigator.clipboard.writeText(lines.join('\n'))
              toast.success('Log copied')
            }}
          >
            <Copy className="size-3" />
          </IconButton>
        )}
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.3, ease }} className="overflow-hidden">
            <div
              ref={box}
              onScroll={(e) => {
                const el = e.currentTarget
                stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
              }}
              className="selectable mx-5 mb-4 max-h-60 overflow-y-auto rounded-xl border border-line bg-black/45 px-3.5 py-3 font-mono text-[11px] leading-[1.65] max-md:mx-4"
            >
              {lines.length ? (
                lines.map((l, i) => (
                  <div key={i} className={cn('break-all whitespace-pre-wrap', lineTone(l))}>
                    {l}
                  </div>
                ))
              ) : (
                <div className="text-fg-3">Nothing yet — output from installs, downloads and the engine appears here.</div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function Stepper({ step, label, names }: { step: number; label: string; names?: string[] }): React.JSX.Element {
  const steps = names?.length ? names : STEPS
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center">
        {steps.map((s, i) => {
          const n = i + 1
          const done = n < step
          const active = n === step
          return (
            <div key={s} className={cn('flex items-center', i < steps.length - 1 && 'flex-1')}>
              <div className="flex flex-col items-center gap-1.5">
                <motion.div
                  initial={false}
                  animate={{ scale: active ? 1.08 : 1 }}
                  transition={spring}
                  className={cn(
                    'relative grid size-7 place-items-center rounded-full border text-[11px] font-semibold transition-colors duration-300',
                    done && 'border-transparent bg-grad text-white',
                    active && 'border-[color-mix(in_oklab,var(--accent)_55%,transparent)] bg-[color-mix(in_oklab,var(--accent)_14%,transparent)] text-fg',
                    !done && !active && 'border-line-strong text-fg-3'
                  )}
                >
                  {done ? <Check className="size-3.5" strokeWidth={3} /> : active ? <ProgressRing size={26} stroke={2} className="absolute" /> : n}
                  {active && <span className="relative">{n}</span>}
                </motion.div>
                <span className={cn('text-[10.5px] whitespace-nowrap max-md:hidden', active ? 'text-fg' : done ? 'text-fg-2' : 'text-fg-3')}>{s}</span>
              </div>
              {i < steps.length - 1 && (
                <div className="relative mx-2 mb-5 h-px flex-1 overflow-hidden bg-line-strong max-md:mx-1.5 max-md:mb-0">
                  <motion.div className="absolute inset-0 origin-left bg-grad" initial={false} animate={{ scaleX: done ? 1 : 0 }} transition={{ duration: 0.5, ease }} />
                </div>
              )}
            </div>
          )
        })}
      </div>
      <div className="flex items-center gap-2 text-[12.5px] text-fg-2">
        <motion.span key={label} initial={{ opacity: 0, x: -4 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.25, ease }}>
          {label}
        </motion.span>
      </div>
      <ProgressBar value={Math.max(0.04, (step - 1) / steps.length)} />
    </div>
  )
}

function ModelTile({ m, status, installed, onDownload }: { m: VoiceEngineStatus['models'][number]; status: VoiceEngineStatus; installed: boolean; onDownload: () => void }): React.JSX.Element {
  const info = MODEL_INFO[m.id] ?? (m.id.startsWith('pocket-') ? POCKET_INFO : { size: '', purpose: '', icon: <Cpu /> })
  const downloading = status.activity?.model === m.id && /download/i.test(status.activity.label)
  const loadingThis = status.activity?.model === m.id && !downloading
  return (
    <motion.div
      layout
      className={cn(
        'relative flex items-center gap-3 overflow-hidden rounded-xl border px-3 py-2.5 transition-colors duration-300',
        m.downloaded ? 'border-line bg-white/[0.035]' : 'border-dashed border-line-strong bg-white/[0.015]'
      )}
    >
      <div className={cn('grid size-8 shrink-0 place-items-center rounded-lg [&>svg]:size-3.5', m.downloaded ? 'bg-grad-soft text-fg' : 'bg-white/[0.05] text-fg-3')}>{info.icon}</div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 truncate text-[12.5px] font-medium">
          {m.label}
          <span className="text-[10.5px] font-normal text-fg-3">{info.size}</span>
        </div>
        <div className="truncate text-[11px] text-fg-3">{downloading ? status.activity!.label : loadingThis ? 'Loading into VRAM…' : info.purpose}</div>
      </div>
      {m.downloaded ? (
        <Badge tone="success">
          <Check className="size-3" strokeWidth={3} /> On disk
        </Badge>
      ) : downloading ? (
        <div className="flex items-center gap-1.5 text-[11px] text-fg-2 tabular-nums">
          {status.activity?.progress !== undefined && `${Math.round(status.activity.progress * 100)}%`}
          <ProgressRing value={status.activity?.progress} size={22} />
        </div>
      ) : (
        <Button size="xs" variant="ghost" className="max-md:h-8 max-md:px-2.5" icon={<Download className="size-3" />} disabled={!installed || !!status.activity?.model} onClick={onDownload}>
          Get
        </Button>
      )}
      {downloading && status.activity?.progress !== undefined && (
        <motion.div className="absolute inset-x-0 bottom-0 h-[2px] origin-left bg-grad" animate={{ scaleX: status.activity.progress }} transition={{ duration: 0.4, ease }} />
      )}
    </motion.div>
  )
}

/** One local engine: status, size, install / reinstall / remove. */
function EngineTile({ engine, status }: { engine: VoiceEngineInfo; status: VoiceEngineStatus | null }): React.JSX.Element {
  const [pending, setPending] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const progress = engineProgress(status, engine.id)
  const st = engineStatusText(engine, progress)
  const install = async (): Promise<void> => {
    setPending(true)
    try {
      await invoke('voice:installEngine', engine.id)
      toast.success(`${engine.name} installed`, 'Voice weights download the first time you use it.')
    } catch (err) {
      const msg = errorText(err)
      if (msg !== 'Install canceled') toast.error(`Couldn't install ${engine.name}`, msg)
    } finally {
      setPending(false)
    }
  }
  return (
    <motion.div
      layout
      className={cn(
        'relative flex flex-col gap-2 overflow-hidden rounded-xl border px-3 py-2.5 transition-colors duration-300',
        engine.installed ? 'border-line bg-white/[0.035]' : 'border-dashed border-line-strong bg-white/[0.015]'
      )}
    >
      <div className="flex items-center gap-2.5">
        <div className={cn('grid size-8 shrink-0 place-items-center rounded-lg', engine.installed ? 'bg-grad-soft text-fg' : 'bg-white/[0.05] text-fg-3')}>
          <ProviderIcon kind={engine.connectorKind} className="size-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 truncate text-[12.5px] font-medium">
            {engine.name}
            <span className="text-[10.5px] font-normal text-fg-3">{engine.installed ? sizeLabel(engine.sizeBytes) : approxSize(engine.downloadBytes)}</span>
          </div>
          <div className={cn('truncate text-[11px]', st.tone === 'busy' ? 'text-accent' : 'text-fg-3')}>{progress?.label ?? `${engine.installed ? st.text : 'Not installed'} · ${engine.license}`}</div>
        </div>
        {engine.installed ? (
          <Menu
            align="end"
            trigger={
              <IconButton label={`${engine.name} options`} size="xs" className="max-md:size-8" disabled={status?.busy === 'installing'}>
                <ChevronDown className="size-3" />
              </IconButton>
            }
          >
            <MenuItem icon={<RotateCcw />} hint="repairs / updates" onSelect={() => void install()}>
              Reinstall {engine.name}
            </MenuItem>
            <MenuItem icon={<Trash2 />} danger onSelect={() => setConfirm(true)}>
              Remove {engine.name}…
            </MenuItem>
          </Menu>
        ) : progress ? (
          <ProgressRing value={progress.value} size={22} />
        ) : (
          <Button size="xs" variant="secondary" className="max-md:h-8 max-md:px-2.5" icon={<Download className="size-3" />} loading={pending} onClick={() => void install()}>
            Install
          </Button>
        )}
      </div>
      {progress?.value !== undefined && (
        <motion.div className="absolute inset-x-0 bottom-0 h-[2px] origin-left bg-grad" animate={{ scaleX: progress.value }} transition={{ duration: 0.4, ease }} />
      )}
      <RemoveEngineDialog engine={engine} open={confirm} onOpenChange={setConfirm} />
    </motion.div>
  )
}

export function VoiceEngineCard({ className }: { className?: string }): React.JSX.Element {
  const status = useVoiceEngine()
  const engines = useVoiceEngines()
  const local = (engines ?? []).filter((e) => e.kind === 'local')
  const installedIds = new Set(local.filter((e) => e.installed).map((e) => e.id))
  const [logOpen, setLogOpen] = useState(false)
  const [pending, setPending] = useState<'start' | 'stop' | null>(null)
  const installing = status?.busy === 'installing'
  const state = engineStateLabel(status)

  useEffect(() => {
    if (installing) setLogOpen(true)
  }, [installing])

  const act = async (kind: 'start' | 'stop'): Promise<void> => {
    setPending(kind)
    try {
      await invoke(kind === 'start' ? 'voice:engineStart' : 'voice:engineStop')
    } catch (err) {
      const msg = errorText(err)
      if (msg !== 'Install canceled') toast.error(kind === 'start' ? 'Could not start the voice engine' : 'Could not stop the engine', msg)
    } finally {
      setPending(null)
    }
  }

  const download = async (id: string): Promise<void> => {
    try {
      await invoke('voice:engineDownload', id)
    } catch (err) {
      toast.error('Download failed', errorText(err))
    }
  }

  const phase: 'loading' | 'fresh' | 'installing' | 'ready' = !status ? 'loading' : installing ? 'installing' : status.installed ? 'ready' : 'fresh'

  return (
    <motion.section layout transition={springSoft} className={cn('glass hairline relative overflow-hidden rounded-[20px]', className)}>
      {/* soft accent wash behind the orb */}
      <div className="pointer-events-none absolute -top-24 -left-16 size-64 rounded-full bg-grad opacity-[0.09] blur-3xl" />

      <div className="relative flex items-start gap-4 px-5 pt-5 pb-4 max-md:flex-wrap max-md:gap-3 max-md:px-4">
        <div className="-m-2 shrink-0">
          <Orb size={44} state={orbState(status)} density={0.55} />
        </div>
        <div className="min-w-0 flex-1 pt-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[15px] font-semibold tracking-tight">Stitch Voice</h3>
            <Badge tone="outline">Qwen3-TTS · Kokoro · Pocket TTS</Badge>
          </div>
          <p className="mt-0.5 text-[12px] text-fg-3">Local voices on your own PC — cloning and voice design, fast preset voices, and CPU-friendly cloning. Nothing leaves the machine.</p>
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            <span className="inline-flex h-6 items-center gap-1.5 rounded-full border border-line bg-white/[0.035] px-2.5 text-[11px] text-fg-2">
              <Cpu className="size-3 text-fg-3" />
              {status?.device ?? 'Detecting GPU…'}
              {status && !status.running && status.installed && <span className="text-fg-3">(planned)</span>}
            </span>
            <span className="inline-flex h-6 items-center gap-1.5 rounded-full border border-line bg-white/[0.035] px-2.5 font-mono text-[10.5px] text-fg-3">127.0.0.1:{status?.port ?? 7862}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2 max-md:basis-full max-md:justify-between">
          <span className="flex items-center gap-1.5 rounded-full border border-line bg-white/[0.035] px-2.5 py-1 text-[11.5px] font-medium text-fg-2">
            <StatusDot state={state.tone} />
            {state.label}
          </span>
          {phase === 'ready' &&
            (status!.running ? (
              <Button size="sm" variant="secondary" className="max-md:h-9 max-md:px-4" icon={<Power className="size-3.5" />} loading={pending === 'stop'} onClick={() => void act('stop')}>
                Stop
              </Button>
            ) : (
              <Button size="sm" variant="primary" className="max-md:h-9 max-md:px-4" icon={<Play className="size-3.5 fill-current" />} loading={pending === 'start' || status!.busy === 'starting'} onClick={() => void act('start')}>
                Start
              </Button>
            ))}

        </div>
      </div>

      <AnimatePresence initial={false}>
        {status?.error && !installing && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.3, ease }} className="overflow-hidden px-5 max-md:px-4">
            <div className="mb-4 flex items-start gap-2.5 rounded-xl border border-danger/25 bg-danger/[0.08] px-3.5 py-2.5 text-[12px] text-fg-2">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-danger" />
              <span className="selectable flex-1 break-words">{status.error}</span>
              <button className="shrink-0 text-[11px] font-semibold text-accent hover:brightness-125" onClick={() => setLogOpen(true)}>
                View log
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="relative px-5 pb-5 max-md:px-4 max-md:pb-4">
        <AnimatePresence mode="wait" initial={false}>
          {phase === 'fresh' && (
            <motion.div key="fresh" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.3, ease }} className="flex flex-col gap-4">
              <div className="grid grid-cols-3 gap-2 max-md:grid-cols-1">
                {local.map((e, i) => (
                  <motion.div key={e.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 + i * 0.06, duration: 0.4, ease }}>
                    <EngineTile engine={e} status={status} />
                  </motion.div>
                ))}
              </div>
              <span className="flex items-center gap-1.5 text-[11.5px] text-fg-3 max-md:items-start">
                <HardDrive className="size-3.5 shrink-0 max-md:mt-0.5" /> The first engine also sets up Stitch's Python + PyTorch runtime (≈3 GB with CUDA). Weights download on first use — all inside Stitch's folder.
              </span>
            </motion.div>
          )}

          {phase === 'installing' && status && (
            <motion.div key="installing" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.3, ease }} className="flex flex-col gap-3">
              {status.activity?.stepNames ? (
                <Stepper step={status.activity.step ?? 1} label={status.activity.label} names={status.activity.stepNames} />
              ) : (
                <div className="flex flex-col gap-2 text-[12.5px] text-fg-2">
                  {status.activity?.label ?? 'Working…'}
                  <ProgressBar />
                </div>
              )}
              <div className="flex justify-end">
                <Button size="sm" variant="ghost" onClick={() => void act('stop')}>
                  Cancel
                </Button>
              </div>
            </motion.div>
          )}

          {phase === 'ready' && status && (
            <motion.div key="ready" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.3, ease }} className="flex flex-col gap-2.5">
              <div className="flex items-center justify-between max-md:flex-wrap max-md:gap-x-3 max-md:gap-y-0.5">
                <span className="label-caps">Engines</span>
                <span className="text-[11px] text-fg-3">{!status.device ? '' : status.device === 'CPU' ? 'Everything runs on the CPU' : `GPU engines run on ${status.device}`}</span>
              </div>
              <div className="grid grid-cols-3 gap-2 max-md:grid-cols-1">
                {local.map((e) => (
                  <EngineTile key={e.id} engine={e} status={status} />
                ))}
              </div>
              <div className="mt-1.5 flex items-center justify-between max-md:flex-wrap max-md:gap-x-3 max-md:gap-y-0.5">
                <span className="label-caps">Models</span>
                <span className="text-[11px] text-fg-3">Downloaded on first use · unloaded after 10 min idle</span>
              </div>
              <div className="grid grid-cols-2 gap-2 max-md:grid-cols-1">
                {status.models
                  .filter((m) => !m.engine || installedIds.has(m.engine))
                  .map((m) => (
                    <ModelTile key={m.id} m={m} status={status} installed={!m.engine || installedIds.has(m.engine)} onDownload={() => void download(m.id)} />
                  ))}
              </div>
              <AnimatePresence>
                {status.activity && !status.activity.model && status.busy !== 'idle' && (
                  <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex items-center gap-2 pt-1 text-[11.5px] text-fg-2">
                    <ProgressBar className="w-24" />
                    {status.activity.label}
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <EngineLog lines={status?.log ?? []} open={logOpen} onToggle={() => setLogOpen((o) => !o)} />
    </motion.section>
  )
}
