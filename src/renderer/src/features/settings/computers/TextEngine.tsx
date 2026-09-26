// Settings → Computers → Text engine: Stitch's llama.cpp, with layers spread over this PC's GPUs and
// linked PCs' GPUs. The running server appears in every model picker as "llama.cpp".
import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Check, Download, FolderOpen, MessageSquareText, Play, RefreshCw, ScrollText, Search, Square, Zap } from 'lucide-react'
import type { GgufFile, LlamaDevice } from '@shared/ipc'
import { errorText, invoke, on } from '@/lib/api'
import { cn, formatBytes } from '@/lib/utils'
import { ease, spring } from '@/lib/motion'
import { isPhone } from '@/lib/platform'
import { Button, IconButton } from '@/components/ui/button'
import { SwitchRow } from '@/components/ui/controls'
import { Input } from '@/components/ui/input'
import { Badge, Field, ProgressBar, SectionTitle, Spinner, StatusDot } from '@/components/ui/misc'
import { Dialog, Select } from '@/components/ui/overlay'
import { useLlama } from '@/stores/cluster'
import { useAppSettings, useSettings } from '@/stores/settings'
import { toast } from '@/stores/toast'

const CONTEXTS = [2048, 4096, 8192, 16384, 32768, 65536, 131072]

/** Split preview: one segment per device, sized by its share of the layers. */
function SplitBar({ parts }: { parts: { key: string; label: string; share: number }[] }): React.JSX.Element {
  return (
    <div className="space-y-1.5">
      <div className="flex h-2 overflow-hidden rounded-full bg-white/[0.06]">
        {parts.map((p, i) => (
          <motion.div
            key={p.key}
            layout
            transition={spring}
            className="h-full border-r border-bg last:border-r-0"
            style={{ flexGrow: p.share, flexBasis: 0, background: i % 2 ? 'var(--accent-2)' : 'var(--accent)', opacity: 0.55 + 0.45 * ((i + 1) / parts.length) }}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-fg-3">
        {parts.map((p) => (
          <span key={p.key} className="tabular-nums">
            {p.label} {Math.round(p.share * 100)}%
          </span>
        ))}
      </div>
    </div>
  )
}

function HfDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }): React.JSX.Element {
  const [repo, setRepo] = useState('Qwen/Qwen2.5-1.5B-Instruct-GGUF')
  const [files, setFiles] = useState<{ path: string; size: number }[] | null>(null)
  const [busy, setBusy] = useState(false)
  const search = async (): Promise<void> => {
    setBusy(true)
    try {
      setFiles(await invoke('llama:hfFiles', repo))
    } catch (err) {
      toast.error('Hugging Face', errorText(err))
      setFiles(null)
    } finally {
      setBusy(false)
    }
  }
  const get = async (path: string): Promise<void> => {
    try {
      await invoke('llama:download', repo, path)
      toast.success('Downloading', `${path.split('/').pop()} — it appears in the model list when it's done.`)
      onOpenChange(false)
    } catch (err) {
      toast.error('Download', errorText(err))
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Get a model from Hugging Face" description="Any repo with GGUF files works. Smaller quantisations (Q4_K_M) load faster and fit more GPUs." width={560}>
      <div className="space-y-4 p-5 max-md:px-4">
        <div className="flex gap-2">
          <Input value={repo} onChange={(e) => setRepo(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void search()} placeholder="owner/repo-GGUF" className="flex-1 font-mono text-[12px]" icon={<Search className="size-3.5" />} />
          <Button loading={busy} onClick={() => void search()}>
            Find files
          </Button>
        </div>
        {files && (
          <div className="max-h-[46vh] space-y-1 overflow-y-auto">
            {files.length === 0 && <div className="py-6 text-center text-[12.5px] text-fg-3">No GGUF files in this repo.</div>}
            {files.map((f) => (
              <div key={f.path} className="flex items-center gap-3 rounded-lg px-2.5 py-2 hover:bg-white/[0.05]">
                <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{f.path}</span>
                <span className="text-[11.5px] text-fg-3 tabular-nums">{formatBytes(f.size)}</span>
                <Button size="sm" icon={<Download className="size-3.5" />} onClick={() => void get(f.path)} className="max-md:h-9">
                  Get
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </Dialog>
  )
}

export function TextEngine(): React.JSX.Element {
  const settings = useAppSettings()
  const update = useSettings((s) => s.update)
  const llama = useLlama()
  const cfg = settings.llama
  const [models, setModels] = useState<GgufFile[]>([])
  const [devices, setDevices] = useState<LlamaDevice[]>([])
  const [hf, setHf] = useState(false)
  const [logs, setLogs] = useState<string[] | null>(null)
  const [busy, setBusy] = useState(false)

  const loadModels = (refresh = false): void => void invoke('llama:models', refresh).then(setModels)
  useEffect(() => {
    loadModels(true)
    void invoke('llama:devices').then(setDevices)
    const t = setInterval(() => void invoke('llama:devices').then(setDevices), 5000)
    // A finished GGUF download shows up in the list.
    const off = on('download:progress', (d) => d.status === 'done' && d.folder === 'llm' && loadModels(true))
    return () => {
      clearInterval(t)
      off()
    }
  }, [])

  const running = llama?.state === 'running'
  const working = llama?.state === 'starting' || llama?.state === 'installing'
  const chosen = devices.filter((d) => cfg.devices.includes(d.key))
  const custom = !!cfg.split && Object.values(cfg.split).some((v) => v > 0)
  const preview = useMemo(() => {
    const w = chosen.map((d) => {
      const c = cfg.split?.[d.key]
      return c && c > 0 ? c : Math.max(0.5, d.memFree / 2 ** 30)
    })
    const sum = w.reduce((a, b) => a + b, 0) || 1
    return chosen.map((d, i) => ({ key: d.key, label: `${d.label}${d.pc === 'This PC' ? '' : ` (${d.pc})`}`, share: w[i] / sum }))
  }, [chosen, cfg.split])
  const shown = running && llama?.devices?.length ? llama.devices.map((d) => ({ key: d.key, label: d.label, share: d.split })) : preview

  const toggle = (key: string): void => void update({ llama: { devices: cfg.devices.includes(key) ? cfg.devices.filter((k) => k !== key) : [...cfg.devices, key] } })
  const setWeight = (key: string, v: number): void => void update({ llama: { split: { [key]: v } } })
  const autoSplit = (): void => void update({ llama: { split: Object.fromEntries(Object.keys(cfg.split ?? {}).map((k) => [k, 0])) } })

  const start = async (): Promise<void> => {
    setBusy(true)
    try {
      await invoke('llama:start')
      toast.success('Text engine running', 'Pick “llama.cpp” in any model picker.')
    } catch (err) {
      toast.error('Text engine', errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const browse = async (): Promise<void> => {
    const [p] = await invoke('sys:pickFiles', { title: 'Choose a GGUF model', filters: [{ name: 'GGUF model', extensions: ['gguf'] }] })
    if (p) {
      await update({ llama: { model: p } })
      loadModels(true)
    }
  }

  const modelOptions = models.map((m) => ({ value: m.path, label: m.name, hint: `${formatBytes(m.size)} · ${m.where}` }))
  if (cfg.model && !models.some((m) => m.path === cfg.model)) modelOptions.unshift({ value: cfg.model, label: cfg.model.split(/[\\/]/).pop()!.replace(/\.gguf$/i, ''), hint: 'Chosen file' })

  return (
    <div className="space-y-4">
      <SectionTitle icon={<MessageSquareText />}>Text engine · llama.cpp</SectionTitle>
      <p className="-mt-2 text-[12.5px] text-fg-3">Run a GGUF model with its layers spread over this PC’s GPUs and your linked PCs’. Linked GPUs join through Stitch’s authenticated link — llama.cpp’s own RPC port is never opened to the network.</p>

      <div className="glass hairline space-y-5 rounded-2xl p-4 max-md:p-3.5">
        <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
          <StatusDot state={running ? 'online' : working ? 'busy' : llama?.state === 'error' ? 'warn' : 'offline'} />
          <span className="font-medium">
            {running ? 'Running' : llama?.state === 'installing' ? 'Installing llama.cpp' : llama?.state === 'starting' ? 'Starting' : llama?.state === 'error' ? 'Stopped with an error' : llama?.state === 'missing' ? 'Not installed yet' : 'Stopped'}
          </span>
          {llama?.installed && <Badge tone="outline">{`${llama.installed.tag} · ${llama.installed.flavor.replace('cuda', 'CUDA ')}`}</Badge>}
          <AnimatePresence>
            {running && llama?.tokensPerSecond !== undefined && (
              <motion.span initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} transition={spring}>
                <Badge tone="accent">
                  <Zap className="size-3" /> {llama.tokensPerSecond.toFixed(1)} tok/s
                </Badge>
              </motion.span>
            )}
          </AnimatePresence>
          <div className="ml-auto flex items-center gap-1.5 max-md:ml-0 max-md:w-full">
            <Button size="sm" variant="ghost" className="max-md:h-9" icon={<ScrollText className="size-3.5" />} onClick={async () => setLogs(await invoke('llama:logs'))}>
              Log
            </Button>
            {running || working ? (
              <Button size="sm" className="max-md:ml-auto max-md:h-9" icon={<Square className="size-3" />} onClick={() => void invoke('llama:stop')}>
                Stop
              </Button>
            ) : (
              <Button size="sm" variant="primary" className="max-md:ml-auto max-md:h-9" loading={busy} disabled={!cfg.model} icon={<Play className="size-3" />} onClick={() => void start()}>
                Start
              </Button>
            )}
          </div>
        </div>

        <AnimatePresence initial={false}>
          {(working && llama?.step) || (llama?.state === 'error' && llama.error) ? (
            <motion.div key="step" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.25, ease }} className="space-y-2">
              {working && llama?.step && (
                <>
                  <div className="flex items-center gap-2 text-[12px] text-fg-2">
                    <Spinner className="size-3.5" /> {llama.step.label}
                    {llama.step.progress !== undefined && <span className="tabular-nums text-fg-3">{Math.round(llama.step.progress * 100)}%</span>}
                  </div>
                  <ProgressBar value={llama.step.progress} />
                </>
              )}
              {llama?.state === 'error' && llama.error && <div className="rounded-xl border border-danger/25 bg-danger/[0.07] px-3 py-2.5 text-[12px] text-danger">{llama.error}</div>}
            </motion.div>
          ) : null}
        </AnimatePresence>

        <Field label="Model">
          <div className="flex gap-2 max-md:flex-wrap">
            <Select value={cfg.model} onChange={(model) => void update({ llama: { model } })} options={modelOptions} placeholder={models.length ? 'Choose a GGUF…' : 'No GGUF models found yet'} className="flex-1 max-md:basis-full" />
            <IconButton label="Rescan" variant="secondary" className="size-9 max-md:size-10" onClick={() => loadModels(true)}>
              <RefreshCw className="size-3.5" />
            </IconButton>
            {!isPhone && (
              <Button icon={<FolderOpen className="size-3.5" />} className="max-md:h-10 max-md:flex-1" onClick={() => void browse()}>
                Browse
              </Button>
            )}
            <Button icon={<Download className="size-3.5" />} className="max-md:h-10 max-md:flex-1" onClick={() => setHf(true)}>
              Hugging Face
            </Button>
          </div>
        </Field>

        <Field label="Context" help="Tokens the model keeps in mind. Larger contexts use more VRAM.">
          <Select value={String(cfg.ctx)} onChange={(v) => void update({ llama: { ctx: Number(v) } })} options={CONTEXTS.map((c) => ({ value: String(c), label: `${c >= 1024 ? `${c / 1024}k` : c} tokens` }))} className="w-48 max-md:w-full" />
        </Field>

        <div className="space-y-2">
          <div className="label-caps">Devices that hold layers</div>
          <div className="grid gap-2 sm:grid-cols-2">
            {devices.map((d) => {
              const on = cfg.devices.includes(d.key)
              return (
                <motion.button
                  key={d.key}
                  whileTap={{ scale: 0.985 }}
                  onClick={() => toggle(d.key)}
                  className={cn(
                    'relative flex items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-[border-color,background] duration-300',
                    on ? 'border-[color-mix(in_oklab,var(--accent)_50%,transparent)] bg-[color-mix(in_oklab,var(--accent)_8%,transparent)]' : 'border-line bg-white/[0.02] hover:bg-white/[0.04]',
                    !d.online && 'opacity-50'
                  )}
                >
                  <span className={cn('grid size-5 shrink-0 place-items-center rounded-md border transition-all duration-300', on ? 'border-transparent bg-grad text-white' : 'border-line-strong')}>{on && <Check className="size-3" strokeWidth={3} />}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] font-medium">{d.label}</span>
                    <span className="block truncate text-[11px] text-fg-3">
                      {d.pc} · {formatBytes(d.memFree)} free of {formatBytes(d.memTotal)}
                      {!d.online && ' · offline'}
                    </span>
                  </span>
                </motion.button>
              )
            })}
          </div>
          {!chosen.length && <p className="text-[11.5px] text-fg-3">No GPU selected — the model runs on this PC’s CPU.</p>}
        </div>

        {shown.length > 1 && (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <div className="label-caps">Layer split</div>
              <span className="text-[11px] text-fg-3">{running ? 'in use now' : custom ? 'your weights' : 'by free VRAM'}</span>
              {custom && (
                <button className="ml-auto text-[11px] font-semibold tracking-wide text-accent uppercase hover:brightness-125" onClick={autoSplit}>
                  Automatic
                </button>
              )}
            </div>
            <SplitBar parts={shown} />
            <div className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
              {chosen.map((d) => (
                <label key={d.key} className="flex items-center gap-2 text-[11.5px] text-fg-2">
                  <span className="min-w-0 flex-1 truncate">
                    {d.label} <span className="text-fg-3">· {d.pc}</span>
                  </span>
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    value={cfg.split?.[d.key] || ''}
                    placeholder="auto"
                    onChange={(e) => setWeight(d.key, Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
                    className="h-7.5 w-20 text-right font-mono text-[12px] max-md:h-9"
                  />
                </label>
              ))}
            </div>
          </div>
        )}

        <SwitchRow label="Start with Stitch" help="Load the model when Stitch opens (after linked PCs connect). Chats also start it on demand." checked={cfg.autoStart} onChange={(autoStart) => void update({ llama: { autoStart } })} />
        {running && <p className="text-[11.5px] text-fg-3">Changes apply the next time the engine starts.</p>}
      </div>

      <HfDialog open={hf} onOpenChange={setHf} />
      <Dialog open={!!logs} onOpenChange={(o) => !o && setLogs(null)} title="llama.cpp · log" width={860}>
        <pre className="selectable max-h-[60vh] overflow-auto p-5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-fg-2">{logs?.join('\n') || 'No output yet.'}</pre>
      </Dialog>
    </div>
  )
}
