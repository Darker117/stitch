// GPU layout: pick which GPUs Stitch uses and which workload runs where.
import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { AudioLines, Check, Clapperboard, Cpu, ImageIcon, Mic2, Play, Power, ScrollText, Square } from 'lucide-react'
import type { DetectResult } from '@shared/ipc'
import type { GpuSettings as Gpu, GpuWorkload } from '@shared/types'
import { errorText, invoke } from '@/lib/api'
import { cn, formatBytes } from '@/lib/utils'
import { rise, spring, stagger } from '@/lib/motion'
import { useCompact } from '@/lib/platform'
import { Button } from '@/components/ui/button'
import { Segmented, SwitchRow } from '@/components/ui/controls'
import { Badge, SectionTitle, Spinner, StatusDot } from '@/components/ui/misc'
import { Dialog } from '@/components/ui/overlay'
import { useGen } from '@/stores/gen'
import { useAppSettings, useSettings } from '@/stores/settings'
import { toast } from '@/stores/toast'

const WORKLOADS: { key: GpuWorkload; label: string; hint: string; icon: React.ReactNode }[] = [
  { key: 'image', label: 'Images', hint: 'Krea 2, Qwen, Flux, character sheets', icon: <ImageIcon /> },
  { key: 'video', label: 'Video', hint: 'MiniMax H3 / FastH3 with audio', icon: <Clapperboard /> },
  { key: 'audio', label: 'Music & SFX', hint: 'ACE-Step, Stable Audio', icon: <AudioLines /> },
  { key: 'voice', label: 'Voice engine', hint: 'Qwen3-TTS cloning & design', icon: <Mic2 /> }
]

function short(name: string): string {
  return name.replace(/NVIDIA GeForce /i, '').replace(/NVIDIA /i, '')
}

export function GpuSettings(): React.JSX.Element {
  const settings = useAppSettings()
  const update = useSettings((s) => s.update)
  const comfy = useGen((s) => s.comfy)
  const [gpus, setGpus] = useState<DetectResult['gpus']>([])
  const [draft, setDraft] = useState<Gpu>(settings.gpu)
  const [applying, setApplying] = useState(false)
  const [logs, setLogs] = useState<{ id: string; lines: string[] } | null>(null)
  const compact = useCompact()

  useEffect(() => {
    void invoke('gpu:list').then(setGpus)
  }, [])
  useEffect(() => setDraft(settings.gpu), [settings.gpu])

  const enabled = draft.enabled.length ? draft.enabled : gpus.slice(0, 1).map((g) => g.index)
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings.gpu)
  const managed = comfy.filter((c) => c.managed)

  const assign = (w: GpuWorkload, v: number | 'auto'): void => setDraft((d) => ({ ...d, assign: { ...d.assign, [w]: v } }))
  const toggleGpu = (i: number): void =>
    setDraft((d) => {
      const cur = d.enabled.length ? d.enabled : gpus.slice(0, 1).map((g) => g.index)
      const next = cur.includes(i) ? cur.filter((x) => x !== i) : [...cur, i].sort()
      return { ...d, enabled: next.length ? next : cur }
    })

  const apply = async (): Promise<void> => {
    setApplying(true)
    try {
      await update({ gpu: { ...draft, enabled: enabled } })
      await invoke('gpu:apply')
      toast.success(draft.managed ? 'GPU layout applied' : 'Using your own ComfyUI', draft.managed ? 'Stitch is starting ComfyUI on the selected GPUs.' : undefined)
    } catch (err) {
      toast.error('Could not apply', errorText(err))
    } finally {
      setApplying(false)
    }
  }

  const plan = useMemo(() => {
    // Mirror of main/services/gpu.ts for the live preview.
    return enabled.map((g) => ({
      gpu: g,
      work: WORKLOADS.filter((w) => {
        const a = draft.assign[w.key]
        return a === 'auto' || a === g || (typeof a === 'number' && !enabled.includes(a))
      }).map((w) => w.key)
    }))
  }, [enabled, draft.assign])

  return (
    <div className="space-y-8">
      <div>
        <SectionTitle icon={<Cpu />}>Graphics cards</SectionTitle>
        <p className="mt-1 text-[12.5px] text-fg-3">Choose which GPUs Stitch may use. Each selected GPU gets its own ComfyUI so image and video jobs can run at the same time.</p>
        <motion.div variants={stagger(0.05)} initial="initial" animate="animate" className="mt-4 grid grid-cols-2 gap-3 max-md:grid-cols-1 max-md:gap-2.5">
          {gpus.map((g) => {
            const on = enabled.includes(g.index)
            const live = comfy.find((c) => c.managed && c.connectorId === `comfy-gpu${g.index}`)
            return (
              <motion.button
                key={g.index}
                variants={rise}
                whileTap={{ scale: 0.985 }}
                onClick={() => toggleGpu(g.index)}
                className={cn('relative overflow-hidden rounded-2xl border p-4 text-left transition-[border-color,background] duration-300', on ? 'border-[color-mix(in_oklab,var(--accent)_50%,transparent)] bg-[color-mix(in_oklab,var(--accent)_7%,transparent)]' : 'border-line bg-white/[0.02] hover:bg-white/[0.04]')}
              >
                {on && <div className="pointer-events-none absolute -top-16 -right-16 size-40 rounded-full bg-grad opacity-20 blur-2xl" />}
                <div className="relative flex items-start justify-between gap-3">
                  <div>
                    <div className="font-mono text-[10px] tracking-[0.18em] text-fg-3">GPU {g.index}</div>
                    <div className="mt-1 text-[16px] font-semibold tracking-tight">{short(g.name)}</div>
                    <div className="mt-0.5 text-[12px] text-fg-3">{formatBytes(g.memoryMB * 1024 * 1024)} VRAM</div>
                  </div>
                  <span className={cn('grid size-6 place-items-center rounded-full border transition-all duration-300', on ? 'border-transparent bg-grad text-white' : 'border-line-strong')}>{on && <Check className="size-3.5" strokeWidth={3} />}</span>
                </div>
                <div className="relative mt-3 flex min-h-6 flex-wrap gap-1.5">
                  <AnimatePresence>
                    {on &&
                      plan
                        .find((p) => p.gpu === g.index)
                        ?.work.map((w) => {
                          const meta = WORKLOADS.find((x) => x.key === w)!
                          return (
                            <motion.span key={w} layout initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.8 }} transition={spring}>
                              <Badge className="[&>svg]:size-3">
                                {meta.icon} {meta.label}
                              </Badge>
                            </motion.span>
                          )
                        })}
                  </AnimatePresence>
                </div>
                {live && (
                  <div className="relative mt-3 flex items-center gap-2 text-[11.5px] text-fg-3">
                    <StatusDot state={live.online ? 'online' : live.processState === 'starting' ? 'busy' : 'offline'} />
                    ComfyUI {live.online ? 'running' : live.processState}
                    {live.vramFree !== undefined && live.online && <span>· {formatBytes(live.vramFree)} free</span>}
                  </div>
                )}
              </motion.button>
            )
          })}
          {!gpus.length && <div className="col-span-2 rounded-2xl border border-line p-4 text-[12.5px] text-fg-3">No NVIDIA GPUs detected (nvidia-smi not found).</div>}
        </motion.div>
      </div>

      <div>
        <SectionTitle>Workload assignment</SectionTitle>
        <p className="mt-1 text-[12.5px] text-fg-3">Pin each part of Stitch to a GPU, or let it balance automatically across the selected ones.</p>
        {compact ? (
          // Phone: one card per workload with a gliding GPU picker instead of the radio table.
          <div className="mt-4 space-y-2.5">
            {WORKLOADS.map((w) => {
              const cur = draft.assign[w.key]
              const value = typeof cur === 'number' && enabled.includes(cur) ? String(cur) : 'auto'
              return (
                <div key={w.key} className="space-y-3 rounded-2xl border border-line bg-white/[0.02] p-3.5">
                  <div className="flex items-center gap-3">
                    <span className="grid size-9 shrink-0 place-items-center rounded-xl border border-line bg-white/[0.04] text-fg-2 [&>svg]:size-4">{w.icon}</span>
                    <div className="min-w-0">
                      <div className="text-[13px] font-medium">{w.label}</div>
                      <div className="text-[11.5px] text-fg-3">{w.hint}</div>
                    </div>
                  </div>
                  <Segmented
                    value={value}
                    onChange={(v) => assign(w.key, v === 'auto' ? 'auto' : Number(v))}
                    items={[{ value: 'auto', label: 'Auto' }, ...enabled.map((g) => ({ value: String(g), label: short(gpus.find((x) => x.index === g)?.name ?? `GPU ${g}`) }))]}
                    className="flex w-full [&>button]:h-9 [&>button]:min-w-0 [&>button]:flex-1 [&>button]:justify-center [&>button]:px-1.5 [&>button>span]:min-w-0 [&>button>span]:overflow-hidden"
                  />
                </div>
              )
            })}
          </div>
        ) : (
          <div className="mt-4 overflow-hidden rounded-2xl border border-line">
            <div className="grid border-b border-line bg-white/[0.03] text-[11px] font-semibold tracking-wide text-fg-3 uppercase" style={{ gridTemplateColumns: `1.6fr repeat(${enabled.length + 1}, 1fr)` }}>
              <div className="px-4 py-2.5">Workload</div>
              <div className="px-2 py-2.5 text-center">Auto</div>
              {enabled.map((g) => (
                <div key={g} className="truncate px-2 py-2.5 text-center">
                  {short(gpus.find((x) => x.index === g)?.name ?? `GPU ${g}`)}
                </div>
              ))}
            </div>
            {WORKLOADS.map((w) => (
              <div key={w.key} className="grid items-center border-b border-line last:border-b-0" style={{ gridTemplateColumns: `1.6fr repeat(${enabled.length + 1}, 1fr)` }}>
                <div className="flex items-center gap-3 px-4 py-3">
                  <span className="grid size-8 place-items-center rounded-lg border border-line bg-white/[0.04] text-fg-2 [&>svg]:size-4">{w.icon}</span>
                  <div>
                    <div className="text-[13px] font-medium">{w.label}</div>
                    <div className="text-[11px] text-fg-3">{w.hint}</div>
                  </div>
                </div>
                {(['auto', ...enabled] as (number | 'auto')[]).map((opt) => {
                  const cur = draft.assign[w.key]
                  const active = cur === opt || (opt === 'auto' && typeof cur === 'number' && !enabled.includes(cur))
                  return (
                    <div key={String(opt)} className="flex justify-center py-3">
                      <button onClick={() => assign(w.key, opt)} className={cn('relative grid size-6 place-items-center rounded-full border transition-colors duration-300', active ? 'border-transparent' : 'border-line-strong hover:border-white/30')}>
                        {active && <motion.span layoutId={`gpu-${w.key}`} className="absolute inset-0 rounded-full bg-grad" transition={spring} />}
                        {active && <Check className="relative size-3.5 text-white" strokeWidth={3} />}
                      </button>
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="space-y-4 rounded-2xl border border-line p-4">
        <SwitchRow
          label="Stitch runs ComfyUI"
          help={draft.managed ? 'Stitch launches one ComfyUI per selected GPU (ports 8190+) from your Stability Matrix install and routes jobs by the table above.' : "Stitch uses a ComfyUI you start yourself (e.g. from Stability Matrix on port 8188). GPU pinning then only applies to the voice engine."}
          checked={draft.managed}
          onChange={(v) => setDraft((d) => ({ ...d, managed: v }))}
        />
        <SwitchRow label="Start with Stitch" help="Launch the managed ComfyUI instances automatically when Stitch opens." checked={settings.comfyAutoLaunch} onChange={(v) => void update({ comfyAutoLaunch: v })} disabled={!draft.managed} />
        <div className="flex items-center justify-end gap-2 pt-1 max-md:justify-between">
          {dirty && <span className="text-[12px] text-fg-3">Unsaved changes</span>}
          <Button variant="primary" className="max-md:ml-auto" loading={applying} icon={<Power className="size-3.5" />} onClick={() => void apply()}>
            Apply layout
          </Button>
        </div>
      </div>

      {managed.length > 0 && (
        <div>
          <SectionTitle>Managed ComfyUI instances</SectionTitle>
          <div className="mt-3 space-y-2">
            {managed.map((c) => (
              <div key={c.connectorId} className="glass hairline flex items-center gap-3 rounded-xl px-4 py-3 max-md:flex-wrap max-md:px-3.5">
                <StatusDot state={c.online ? 'online' : c.processState === 'starting' ? 'busy' : c.processState === 'crashed' ? 'warn' : 'offline'} />
                <div className="min-w-0 flex-1 max-md:basis-[calc(100%-2rem)]">
                  <div className="text-[13px] font-medium">{c.name}</div>
                  <div className="text-[11.5px] text-fg-3">
                    {c.url} · {c.online ? `running · ${c.queueRemaining} queued` : c.processState}
                  </div>
                </div>
                {c.processState === 'starting' && <Spinner className="size-3.5 text-fg-3" />}
                <Button size="sm" variant="ghost" className="max-md:ml-auto max-md:h-9" icon={<ScrollText className="size-3.5" />} onClick={async () => setLogs({ id: c.name, lines: await invoke('comfy:logs', c.connectorId) })}>
                  Logs
                </Button>
                {c.processState === 'running' || c.processState === 'starting' ? (
                  <Button size="sm" className="max-md:h-9" icon={<Square className="size-3" />} onClick={() => void invoke('comfy:stop', c.connectorId)}>
                    Stop
                  </Button>
                ) : (
                  <Button size="sm" className="max-md:h-9" icon={<Play className="size-3" />} onClick={() => invoke('comfy:launch', c.connectorId).catch((e) => toast.error('Could not start', errorText(e)))}>
                    Start
                  </Button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <Dialog open={!!logs} onOpenChange={(o) => !o && setLogs(null)} title={`${logs?.id ?? ''} · log`} width={820}>
        <pre className="selectable max-h-[60vh] overflow-auto p-5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-fg-2">{logs?.lines.join('\n') || 'No output yet.'}</pre>
      </Dialog>
    </div>
  )
}
