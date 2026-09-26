// GPU layout: pick which GPUs Stitch uses (on this PC and on linked PCs) and which workload runs where.
import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { AudioLines, Check, Clapperboard, Cpu, ImageIcon, MessageSquareText, Mic2, Play, Power, ScrollText, Server, Square } from 'lucide-react'
import type { DetectResult, GpuLive } from '@shared/ipc'
import type { GpuSettings as Gpu, GpuTarget, GpuWorkload, NodeGpu } from '@shared/types'
import { errorText, invoke } from '@/lib/api'
import { cn, formatBytes } from '@/lib/utils'
import { rise, spring, stagger } from '@/lib/motion'
import { useCompact } from '@/lib/platform'
import { Button, Chip } from '@/components/ui/button'
import { SwitchRow } from '@/components/ui/controls'
import { Badge, SectionTitle, Spinner, StatusDot } from '@/components/ui/misc'
import { Dialog } from '@/components/ui/overlay'
import { useClusterLive, useLlama } from '@/stores/cluster'
import { useGen } from '@/stores/gen'
import { useAppSettings, useSettings } from '@/stores/settings'
import { toast } from '@/stores/toast'

type Work = GpuWorkload | 'text'

const WORKLOADS: { key: Work; label: string; hint: string; icon: React.ReactNode }[] = [
  { key: 'image', label: 'Images', hint: 'Krea 2, Qwen, Flux, character sheets', icon: <ImageIcon /> },
  { key: 'video', label: 'Video', hint: 'MiniMax H3 / FastH3 with audio', icon: <Clapperboard /> },
  { key: 'audio', label: 'Music & SFX', hint: 'ACE-Step, Stable Audio', icon: <AudioLines /> },
  { key: 'voice', label: 'Voice engine', hint: 'Qwen3-TTS cloning & design', icon: <Mic2 /> },
  { key: 'text', label: 'Text · llama.cpp', hint: 'Layers split across every ticked GPU', icon: <MessageSquareText /> }
]

function short(name: string): string {
  return name.replace(/NVIDIA GeForce /i, '').replace(/NVIDIA /i, '')
}

/** A column of the assignment table: a GPU on this PC or on a linked PC. */
interface Col {
  key: string
  target: number | NodeGpu
  label: string
  /** PC name for linked GPUs. */
  pc?: string
  node?: string
}

const isNode = (t: GpuTarget): t is NodeGpu => typeof t === 'object' && t !== null
const same = (a: GpuTarget, b: GpuTarget): boolean => (isNode(a) && isNode(b) ? a.node === b.node && a.gpu === b.gpu : a === b)

export function GpuSettings(): React.JSX.Element {
  const settings = useAppSettings()
  const update = useSettings((s) => s.update)
  const comfy = useGen((s) => s.comfy)
  const cluster = useClusterLive()
  const llama = useLlama()
  const [gpus, setGpus] = useState<DetectResult['gpus']>([])
  const [draft, setDraft] = useState<Gpu>(settings.gpu)
  const [text, setText] = useState<string[]>(settings.llama.devices)
  const [applying, setApplying] = useState(false)
  const [logs, setLogs] = useState<{ id: string; lines: string[] } | null>(null)
  const compact = useCompact()

  useEffect(() => {
    void invoke('gpu:list').then(setGpus)
  }, [])
  useEffect(() => setDraft(settings.gpu), [settings.gpu])
  useEffect(() => setText(settings.llama.devices), [settings.llama.devices])

  const enabled = draft.enabled.length ? draft.enabled : gpus.slice(0, 1).map((g) => g.index)
  const remote = draft.remote ?? []
  // Linked PCs with their shared GPUs (last known hardware, even while offline).
  const nodes = (cluster?.role === 'main' ? cluster.nodes : []).map((n) => ({ ...n, gpus: (n.hardware?.gpus ?? []).filter((g) => g.shared !== false) }))
  const nodeGpu = (r: NodeGpu): GpuLive | undefined => nodes.find((n) => n.id === r.node)?.gpus.find((g) => g.index === r.gpu)
  const cols: Col[] = [
    ...enabled.map((g) => ({ key: `local:${g}`, target: g, label: short(gpus.find((x) => x.index === g)?.name ?? `GPU ${g}`) })),
    ...remote
      .filter((r) => nodes.some((n) => n.id === r.node))
      .map((r) => ({ key: `${r.node}:${r.gpu}`, target: r, label: short(nodeGpu(r)?.name ?? `GPU ${r.gpu}`), pc: nodes.find((n) => n.id === r.node)?.name, node: r.node }))
  ]
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings.gpu) || JSON.stringify(text) !== JSON.stringify(settings.llama.devices)
  const managed = comfy.filter((c) => c.managed)

  const assign = (w: GpuWorkload, v: GpuTarget): void => setDraft((d) => ({ ...d, assign: { ...d.assign, [w]: v } }))
  const toggleText = (key: string): void => setText((t) => (t.includes(key) ? t.filter((k) => k !== key) : [...t, key]))
  const toggleGpu = (i: number): void =>
    setDraft((d) => {
      const cur = d.enabled.length ? d.enabled : gpus.slice(0, 1).map((g) => g.index)
      const next = cur.includes(i) ? cur.filter((x) => x !== i) : [...cur, i].sort()
      return { ...d, enabled: next.length ? next : cur }
    })
  const toggleRemote = (r: NodeGpu): void =>
    setDraft((d) => {
      const cur = d.remote ?? []
      const has = cur.some((x) => same(x, r))
      // Pinned workloads fall back to automatic when their GPU leaves the pool.
      const assignNext = has ? (Object.fromEntries(Object.entries(d.assign).map(([k, v]) => [k, same(v, r) ? 'auto' : v])) as Gpu['assign']) : d.assign
      return { ...d, remote: has ? cur.filter((x) => !same(x, r)) : [...cur, r], assign: assignNext }
    })

  const apply = async (): Promise<void> => {
    setApplying(true)
    try {
      await update({ gpu: { ...draft, enabled }, llama: { devices: text } })
      await invoke('gpu:apply')
      toast.success(draft.managed || remote.length ? 'GPU layout applied' : 'Using your own ComfyUI', draft.managed || remote.length ? 'Stitch is starting ComfyUI on the selected GPUs.' : undefined)
      if (llama?.state === 'running' && JSON.stringify(text) !== JSON.stringify(settings.llama.devices)) toast.info('Text engine', 'Restart it in Settings → Computers to use the new GPUs.')
    } catch (err) {
      toast.error('Could not apply', errorText(err))
    } finally {
      setApplying(false)
    }
  }

  // Mirror of main/services/gpu.ts for the live preview.
  const plan = useMemo(() => {
    const pinned = (w: GpuWorkload): GpuTarget => {
      const a = draft.assign[w]
      return cols.some((c) => same(c.target, a)) && !(w === 'voice' && isNode(a)) ? a : 'auto'
    }
    return cols.map((c) => ({
      key: c.key,
      work: WORKLOADS.filter((w) => {
        if (w.key === 'text') return text.includes(c.key)
        if (w.key === 'voice' && c.node) return false
        const a = pinned(w.key)
        return a === 'auto' || same(a, c.target)
      }).map((w) => w.key)
    }))
  }, [cols.map((c) => c.key).join(), draft.assign, text])

  const chips = (key: string): React.ReactNode => (
    <AnimatePresence>
      {plan
        .find((p) => p.key === key)
        ?.work.map((w) => {
          const meta = WORKLOADS.find((x) => x.key === w)!
          return (
            <motion.span key={w} layout initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.8 }} transition={spring}>
              <Badge className="[&>svg]:size-3">
                {meta.icon} {w === 'text' ? 'Text' : meta.label}
              </Badge>
            </motion.span>
          )
        })}
    </AnimatePresence>
  )

  const card = (opts: { key: string; on: boolean; title: string; index: number; mem: number; onClick: () => void; live?: (typeof comfy)[number]; offline?: boolean }): React.JSX.Element => (
    <motion.button
      key={opts.key}
      variants={rise}
      whileTap={{ scale: 0.985 }}
      onClick={opts.onClick}
      className={cn(
        'relative overflow-hidden rounded-2xl border p-4 text-left transition-[border-color,background] duration-300',
        opts.on ? 'border-[color-mix(in_oklab,var(--accent)_50%,transparent)] bg-[color-mix(in_oklab,var(--accent)_7%,transparent)]' : 'border-line bg-white/[0.02] hover:bg-white/[0.04]',
        opts.offline && 'opacity-60'
      )}
    >
      {opts.on && <div className="pointer-events-none absolute -top-16 -right-16 size-40 rounded-full bg-grad opacity-20 blur-2xl" />}
      <div className="relative flex items-start justify-between gap-3">
        <div>
          <div className="font-mono text-[10px] tracking-[0.18em] text-fg-3">GPU {opts.index}</div>
          <div className="mt-1 text-[16px] font-semibold tracking-tight">{opts.title}</div>
          <div className="mt-0.5 text-[12px] text-fg-3">{formatBytes(opts.mem)} VRAM</div>
        </div>
        <span className={cn('grid size-6 place-items-center rounded-full border transition-all duration-300', opts.on ? 'border-transparent bg-grad text-white' : 'border-line-strong')}>{opts.on && <Check className="size-3.5" strokeWidth={3} />}</span>
      </div>
      <div className="relative mt-3 flex min-h-6 flex-wrap gap-1.5">{opts.on && chips(opts.key)}</div>
      {opts.live && (
        <div className="relative mt-3 flex items-center gap-2 text-[11.5px] text-fg-3">
          <StatusDot state={opts.live.online ? 'online' : opts.live.processState === 'starting' ? 'busy' : 'offline'} />
          ComfyUI {opts.live.online ? 'running' : opts.live.processState}
          {opts.live.vramFree !== undefined && opts.live.online && <span>· {formatBytes(opts.live.vramFree)} free</span>}
        </div>
      )}
    </motion.button>
  )

  const options = (w: Work): Col[] => (w === 'voice' ? cols.filter((c) => !c.node) : cols)

  return (
    <div className="space-y-8">
      <div>
        <SectionTitle icon={<Cpu />}>Graphics cards</SectionTitle>
        <p className="mt-1 text-[12.5px] text-fg-3">Choose which GPUs Stitch may use. Each selected GPU gets its own ComfyUI so image and video jobs can run at the same time.</p>
        <motion.div variants={stagger(0.05)} initial="initial" animate="animate" className="mt-4 grid grid-cols-2 gap-3 max-md:grid-cols-1 max-md:gap-2.5">
          {gpus.map((g) =>
            card({
              key: `local:${g.index}`,
              on: enabled.includes(g.index),
              title: short(g.name),
              index: g.index,
              mem: g.memoryMB * 1024 * 1024,
              onClick: () => toggleGpu(g.index),
              live: comfy.find((c) => c.managed && !c.node && c.connectorId === `comfy-gpu${g.index}`)
            })
          )}
          {!gpus.length && <div className="col-span-2 rounded-2xl border border-line p-4 text-[12.5px] text-fg-3 max-md:col-span-1">No NVIDIA GPUs detected (nvidia-smi not found).</div>}
        </motion.div>
        {nodes.map((n) => (
          <div key={n.id} className="mt-5">
            <div className="flex items-center gap-2 text-[12px] text-fg-2">
              <Server className="size-3.5 text-fg-3" />
              <span className="font-medium">On {n.name}</span>
              <StatusDot state={n.state === 'online' ? 'online' : n.state === 'connecting' ? 'busy' : 'offline'} />
              <span className="text-fg-3">{n.state === 'online' ? 'linked' : n.state}</span>
            </div>
            <motion.div variants={stagger(0.05)} initial="initial" animate="animate" className="mt-2.5 grid grid-cols-2 gap-3 max-md:grid-cols-1 max-md:gap-2.5">
              {n.gpus.map((g) =>
                card({
                  key: `${n.id}:${g.index}`,
                  on: remote.some((r) => r.node === n.id && r.gpu === g.index),
                  title: short(g.name),
                  index: g.index,
                  mem: g.memTotal,
                  offline: n.state !== 'online',
                  onClick: () => toggleRemote({ node: n.id, gpu: g.index }),
                  live: comfy.find((c) => c.node?.id === n.id && c.node.gpu === g.index)
                })
              )}
              {!n.gpus.length && <div className="col-span-2 rounded-2xl border border-dashed border-line p-4 text-[12.5px] text-fg-3 max-md:col-span-1">{n.state === 'online' ? 'This PC shares no GPUs.' : 'Hardware shows up once it connects.'}</div>}
            </motion.div>
          </div>
        ))}
      </div>

      <div>
        <SectionTitle>Workload assignment</SectionTitle>
        <p className="mt-1 text-[12.5px] text-fg-3">Pin each part of Stitch to a GPU — on this PC or a linked one — or let it balance automatically across the selected ones.</p>
        {compact ? (
          // Phone: one card per workload with GPU pills instead of the radio table.
          <div className="mt-4 space-y-2.5">
            {WORKLOADS.map((w) => {
              const cur = w.key === 'text' ? undefined : draft.assign[w.key]
              const opts = options(w.key)
              const pinned = cur !== undefined && opts.some((c) => same(c.target, cur))
              return (
                <div key={w.key} className="space-y-3 rounded-2xl border border-line bg-white/[0.02] p-3.5">
                  <div className="flex items-center gap-3">
                    <span className="grid size-9 shrink-0 place-items-center rounded-xl border border-line bg-white/[0.04] text-fg-2 [&>svg]:size-4">{w.icon}</span>
                    <div className="min-w-0">
                      <div className="text-[13px] font-medium">{w.label}</div>
                      <div className="text-[11.5px] text-fg-3">{w.hint}</div>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {w.key !== 'text' && (
                      <Chip active={!pinned} onClick={() => assign(w.key as GpuWorkload, 'auto')} className="h-9">
                        Auto
                      </Chip>
                    )}
                    {opts.map((c) => {
                      const active = w.key === 'text' ? text.includes(c.key) : pinned && same(c.target, cur!)
                      return (
                        <Chip key={c.key} active={active} icon={active && w.key === 'text' ? <Check /> : undefined} onClick={() => (w.key === 'text' ? toggleText(c.key) : assign(w.key as GpuWorkload, c.target))} className="h-9">
                          {c.label}
                          {c.pc && <span className="text-fg-3">· {c.pc}</span>}
                        </Chip>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          <div className="mt-4 overflow-x-auto rounded-2xl border border-line">
            <div className="min-w-fit">
              <div className="grid border-b border-line bg-white/[0.03] text-[11px] font-semibold tracking-wide text-fg-3 uppercase" style={{ gridTemplateColumns: `minmax(210px,1.6fr) repeat(${cols.length + 1}, minmax(88px,1fr))` }}>
                <div className="px-4 py-2.5">Workload</div>
                <div className="px-2 py-2.5 text-center">Auto</div>
                {cols.map((c) => (
                  <div key={c.key} className="min-w-0 px-2 py-2 text-center">
                    <div className="truncate">{c.label}</div>
                    {c.pc && <div className="truncate text-[10px] font-medium tracking-normal normal-case text-fg-3/80">{c.pc}</div>}
                  </div>
                ))}
              </div>
              {WORKLOADS.map((w) => (
                <div key={w.key} className="grid items-center border-b border-line last:border-b-0" style={{ gridTemplateColumns: `minmax(210px,1.6fr) repeat(${cols.length + 1}, minmax(88px,1fr))` }}>
                  <div className="flex items-center gap-3 px-4 py-3">
                    <span className="grid size-8 place-items-center rounded-lg border border-line bg-white/[0.04] text-fg-2 [&>svg]:size-4">{w.icon}</span>
                    <div>
                      <div className="text-[13px] font-medium">{w.label}</div>
                      <div className="text-[11px] text-fg-3">{w.hint}</div>
                    </div>
                  </div>
                  {w.key === 'text' ? (
                    <>
                      <div className="py-3 text-center text-[11px] text-fg-3">{text.some((k) => cols.some((c) => c.key === k)) ? '' : 'CPU'}</div>
                      {cols.map((c) => {
                        const on = text.includes(c.key)
                        return (
                          <div key={c.key} className="flex justify-center py-3">
                            <button onClick={() => toggleText(c.key)} className={cn('relative grid size-6 place-items-center rounded-md border transition-all duration-300', on ? 'border-transparent bg-grad' : 'border-line-strong hover:border-white/30')} aria-label={`${c.label} holds text layers`}>
                              {on && <Check className="relative size-3.5 text-white" strokeWidth={3} />}
                            </button>
                          </div>
                        )
                      })}
                    </>
                  ) : (
                    (['auto', ...cols] as ('auto' | Col)[]).map((opt) => {
                      const cur = draft.assign[w.key as GpuWorkload]
                      const valid = options(w.key)
                      const key = opt === 'auto' ? 'auto' : opt.key
                      if (opt !== 'auto' && !valid.includes(opt)) {
                        return (
                          <div key={key} className="py-3 text-center text-[12px] text-fg-3/60" title="The voice engine runs on this PC">
                            —
                          </div>
                        )
                      }
                      const pinned = valid.some((c) => same(c.target, cur))
                      const active = opt === 'auto' ? !pinned : same(opt.target, cur)
                      return (
                        <div key={key} className="flex justify-center py-3">
                          <button onClick={() => assign(w.key as GpuWorkload, opt === 'auto' ? 'auto' : opt.target)} className={cn('relative grid size-6 place-items-center rounded-full border transition-colors duration-300', active ? 'border-transparent' : 'border-line-strong hover:border-white/30')}>
                            {active && <motion.span layoutId={`gpu-${w.key}`} className="absolute inset-0 rounded-full bg-grad" transition={spring} />}
                            {active && <Check className="relative size-3.5 text-white" strokeWidth={3} />}
                          </button>
                        </div>
                      )
                    })
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="space-y-4 rounded-2xl border border-line p-4">
        <SwitchRow
          label="Stitch runs ComfyUI"
          help={draft.managed ? 'Stitch launches one ComfyUI per selected GPU (ports 8190+) from your Stability Matrix install and routes jobs by the table above. Linked PCs run theirs the same way.' : 'Stitch uses a ComfyUI you start yourself (e.g. from Stability Matrix on port 8188). GPU pinning then only applies to the voice engine and linked PCs.'}
          checked={draft.managed}
          onChange={(v) => setDraft((d) => ({ ...d, managed: v }))}
        />
        <SwitchRow label="Start with Stitch" help="Launch the managed ComfyUI instances automatically when Stitch opens (and on linked PCs when they connect)." checked={settings.comfyAutoLaunch} onChange={(v) => void update({ comfyAutoLaunch: v })} disabled={!draft.managed && !remote.length} />
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
                    {c.node ? `on ${c.node.name} · through the link` : c.url} · {c.online ? `running · ${c.queueRemaining} queued` : c.processState}
                  </div>
                </div>
                {c.processState === 'starting' && <Spinner className="size-3.5 text-fg-3" />}
                <Button size="sm" variant="ghost" className="max-md:ml-auto max-md:h-9" icon={<ScrollText className="size-3.5" />} onClick={async () => setLogs({ id: c.name, lines: await invoke('comfy:logs', c.connectorId) })}>
                  Logs
                </Button>
                {c.processState === 'running' || c.processState === 'starting' ? (
                  <Button size="sm" className="max-md:h-9" icon={<Square className="size-3" />} onClick={() => invoke('comfy:stop', c.connectorId).catch((e) => toast.error('Could not stop', errorText(e)))}>
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
