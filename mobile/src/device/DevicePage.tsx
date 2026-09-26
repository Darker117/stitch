// More → This phone: the on-device studio. Pick where models run (Qualcomm NPU via QNN, GPU or CPU),
// download models, and try them. Everything made here saves to the PC library.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { AnimatePresence, motion } from 'motion/react'
import { AudioLines, Check, Cpu, Download, Gauge, HardDrive, ImageIcon, KeyRound, Lock, MemoryStick, MessageSquare, Pause, Play, Sparkles, Star, Trash2, X, Zap } from 'lucide-react'
import type { Asset } from '@shared/types'
import { Page, PageHeader } from '@/components/shell/page'
import { Button, IconButton } from '@/components/ui/button'
import { Input, Textarea } from '@/components/ui/input'
import { Badge, EmptyState, ProgressRing, SectionTitle, Spinner } from '@/components/ui/misc'
import { Segmented, SwitchRow } from '@/components/ui/controls'
import { Select } from '@/components/ui/overlay'
import { errorText, fileUrl, invoke, streamLlm } from '@/lib/api'
import { cn } from '@/lib/utils'
import { ease, rise, spring, stagger } from '@/lib/motion'
import { useGen } from '@/stores/gen'
import { toast } from '@/stores/toast'
import type { CatalogModel } from './catalog'
import { PHONE_RECIPE } from './image'
import { PHONE_LLM_ID } from './llm'
import type { DeviceBackend, DeviceTask } from './plugin'
import {
  BACKEND_LABEL,
  backendAvailable,
  cancelDownload,
  catalogFor,
  deleteModel,
  downloadModel,
  isReady,
  readyModels,
  resolveBackend,
  setPrefs,
  sizeText,
  useDevice
} from './store'
import { PHONE_VOICE_ID, phoneVoices } from './voice'
import { tap } from '@mobile/shell/haptics'

const TASKS: { value: DeviceTask; label: string; icon: React.ReactNode }[] = [
  { value: 'text', label: 'Text', icon: <MessageSquare /> },
  { value: 'image', label: 'Images', icon: <ImageIcon /> },
  { value: 'voice', label: 'Voice', icon: <AudioLines /> }
]

const BACKENDS: { id: DeviceBackend | 'auto'; label: string; icon: React.ReactNode; hint: string }[] = [
  { id: 'auto', label: 'Auto', icon: <Sparkles />, hint: 'Best here' },
  { id: 'npu', label: 'NPU', icon: <Zap />, hint: 'Qualcomm QNN' },
  { id: 'gpu', label: 'GPU', icon: <Gauge />, hint: 'Graphics chip' },
  { id: 'cpu', label: 'CPU', icon: <Cpu />, hint: 'Works everywhere' }
]

function ChipCard(): React.JSX.Element {
  const info = useDevice((s) => s.info)
  if (!info) return <div className="shimmer h-[118px] rounded-2xl" />
  const chip = info.socName ?? info.soc ?? 'Unknown chip'
  return (
    <motion.div variants={rise} className="relative overflow-hidden rounded-2xl border border-line bg-white/[0.025] p-4">
      <div className="pointer-events-none absolute -top-16 -right-10 size-48 rounded-full bg-grad opacity-[0.14] blur-3xl" />
      <div className="relative flex items-center gap-3.5">
        <div className="grid size-12 shrink-0 place-items-center rounded-2xl bg-grad text-white shadow-[0_10px_30px_-10px_var(--accent)]">
          <Cpu className="size-5" />
        </div>
        <div className="min-w-0">
          <div className="truncate text-[15px] font-semibold">{info.model.toLowerCase().startsWith(info.manufacturer.toLowerCase()) ? info.model : `${info.manufacturer} ${info.model}`}</div>
          <div className="truncate text-[12px] text-fg-2">
            {chip}
            {info.htpArch ? ` · Hexagon ${info.htpArch}` : ''} · Android {info.androidVersion}
          </div>
        </div>
      </div>
      <div className="relative mt-3.5 flex gap-4 text-[11.5px] text-fg-3">
        <span className="flex items-center gap-1.5">
          <MemoryStick className="size-3.5" /> {sizeText(info.ramBytes)} RAM
        </span>
        <span className="flex items-center gap-1.5">
          <HardDrive className="size-3.5" /> {sizeText(info.freeStorageBytes)} free
        </span>
      </div>
    </motion.div>
  )
}

function BackendPicker({ task }: { task: DeviceTask }): React.JSX.Element {
  const pref = useDevice((s) => s.prefs.backends[task])
  const info = useDevice((s) => s.info)
  return (
    <div>
      <div className="label-caps mb-2">Run on</div>
      <div className="grid grid-cols-4 gap-1.5">
        {BACKENDS.map((o) => {
          const available = o.id === 'auto' || backendAvailable(task, o.id)
          const note = o.id === 'auto' ? o.hint : (info?.backends[task]?.find((x) => x.id === o.id)?.note ?? o.hint)
          const active = pref === o.id
          return (
            <button
              key={o.id}
              disabled={!available}
              onClick={() => {
                tap()
                void setPrefs({ backends: { ...useDevice.getState().prefs.backends, [task]: o.id } })
              }}
              className={cn('relative flex flex-col items-center gap-1 rounded-xl border px-1 py-2.5 text-center transition-colors', active ? 'border-transparent text-fg' : 'border-line text-fg-2', !available && 'opacity-35')}
              title={note}
            >
              {active && <motion.span layoutId={`backend-${task}`} className="absolute inset-0 rounded-xl border border-[color-mix(in_oklab,var(--accent)_55%,transparent)] bg-[color-mix(in_oklab,var(--accent)_12%,transparent)]" transition={spring} />}
              <span className={cn('relative [&>svg]:size-4', active && 'text-accent')}>{o.icon}</span>
              <span className="relative text-[12px] font-semibold">{o.label}</span>
              <span className="relative line-clamp-1 w-full px-0.5 text-[10px] text-fg-3">{available ? note : 'Not here'}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function ModelCard({ m, index }: { m: CatalogModel; index: number }): React.JSX.Element {
  const dl = useDevice((s) => s.downloads[m.id])
  const st = useDevice((s) => s.status[m.id])
  const token = useDevice((s) => s.prefs.hfToken)
  const [confirm, setConfirm] = useState(false)
  const ready = isReady(m)
  const downloading = dl?.state === 'downloading' || st?.downloading
  const pct = dl && dl.totalBytes ? dl.receivedBytes / dl.totalBytes : undefined
  const runsOn = ready ? resolveBackend(m.task, m) : undefined
  const system = m.format === 'tts-system'
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease, delay: index * 0.04 }}
      className={cn('relative overflow-hidden rounded-2xl border p-3.5', ready ? 'border-line-strong bg-white/[0.04]' : 'border-line bg-white/[0.02]')}
    >
      {downloading && <motion.div className="absolute inset-y-0 left-0 bg-[color-mix(in_oklab,var(--accent)_10%,transparent)]" animate={{ width: `${Math.round((pct ?? 0) * 100)}%` }} transition={{ duration: 0.4, ease }} />}
      <div className="relative flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[13.5px] font-semibold">{m.name}</span>
            {m.recommended && (
              <Badge tone="accent">
                <Star className="size-2.5 fill-current" /> Pick
              </Badge>
            )}
            {m.gated && <Badge tone="outline">{token ? 'Gated' : <><Lock className="size-2.5" /> Token</>}</Badge>}
          </div>
          <p className="mt-1 line-clamp-2 text-[12px] leading-snug text-fg-2">{m.description}</p>
          <div className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-fg-3">
            <span className="font-medium text-fg-2">{m.family}</span>
            {!system && <span>· {sizeText(m.sizeBytes)}</span>}
            <span>· {m.backends.filter((b) => backendAvailable(m.task, b)).map((b) => b.toUpperCase()).join(' / ') || m.backends.map((b) => b.toUpperCase()).join(' / ')}</span>
            {ready && runsOn && (
              <span className="ml-1 rounded-full bg-success/12 px-2 py-0.5 font-medium text-success">Runs on {BACKEND_LABEL[runsOn]}</span>
            )}
          </div>
          {dl?.state === 'error' && <div className="mt-2 text-[11.5px] text-danger">{dl.error}</div>}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {system ? (
            <Badge tone="success">
              <Check className="size-3" /> Built in
            </Badge>
          ) : downloading ? (
            <>
              <div className="relative grid size-9 place-items-center">
                <ProgressRing value={pct} size={34} />
                <span className="absolute text-[9.5px] font-semibold tabular-nums">{pct !== undefined ? Math.round(pct * 100) : ''}</span>
              </div>
              <IconButton label="Cancel download" size="sm" onClick={() => void cancelDownload(m)}>
                <X className="size-3.5" />
              </IconButton>
            </>
          ) : ready ? (
            <AnimatePresence mode="wait" initial={false}>
              {confirm ? (
                <motion.div key="c" initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} className="flex gap-1">
                  <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>
                    Keep
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => void deleteModel(m).then(() => setConfirm(false))}>
                    Delete
                  </Button>
                </motion.div>
              ) : (
                <motion.div key="r" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex items-center gap-1">
                  <Badge tone="success">
                    <Check className="size-3" /> Ready
                  </Badge>
                  <IconButton label="Delete from phone" size="sm" onClick={() => setConfirm(true)}>
                    <Trash2 className="size-3.5" />
                  </IconButton>
                </motion.div>
              )}
            </AnimatePresence>
          ) : (
            <Button
              size="sm"
              variant={m.recommended ? 'primary' : 'secondary'}
              icon={<Download className="size-3.5" />}
              onClick={() => {
                tap()
                if (m.gated && !token) {
                  toast.info('This model needs a Hugging Face token', 'Accept its license on huggingface.co, then add a token below.')
                  return
                }
                void downloadModel(m).catch((err) => toast.error(`Couldn't download ${m.name}`, errorText(err)))
              }}
            >
              Get
            </Button>
          )}
        </div>
      </div>
    </motion.div>
  )
}

function TryText(): React.JSX.Element {
  const models = readyModels('text')
  const [model, setModel] = useState(models[0]?.id)
  const [prompt, setPrompt] = useState('Describe a harbour city built inside a volcano in two sentences.')
  const [out, setOut] = useState('')
  const [busy, setBusy] = useState(false)
  const [stats, setStats] = useState<string>()
  const abort = useRef<(() => void) | null>(null)
  useEffect(() => {
    if (!model && models[0]) setModel(models[0].id)
  }, [models, model])
  if (!models.length) return <Hint>Download a text model above, then try it here — or pick “This phone” in any chat's model menu.</Hint>
  const run = (): void => {
    setBusy(true)
    setOut('')
    setStats(undefined)
    const t0 = performance.now()
    let first = 0
    const h = streamLlm({ connectorId: PHONE_LLM_ID, model: model!, messages: [{ role: 'user', content: prompt }], maxTokens: 320, temperature: 0.8 }, (full) => {
      if (!first) first = performance.now()
      setOut(full)
    })
    abort.current = h.abort
    void h.done
      .then((r) => {
        const secs = (performance.now() - (first || t0)) / 1000
        const toks = Math.max(1, Math.round(r.text.length / 4))
        setStats(`≈${(toks / Math.max(0.1, secs)).toFixed(1)} tok/s · first token ${((first - t0) / 1000).toFixed(1)}s`)
      })
      .catch((err) => toast.error('On-device reply failed', errorText(err)))
      .finally(() => setBusy(false))
  }
  return (
    <div className="space-y-2.5">
      {models.length > 1 && <Select value={model ?? ''} onChange={setModel} options={models.map((m) => ({ value: m.id, label: m.name }))} />}
      <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={2} />
      <div className="flex items-center gap-2">
        {busy ? (
          <Button onClick={() => abort.current?.()} icon={<X className="size-3.5" />}>
            Stop
          </Button>
        ) : (
          <Button variant="primary" onClick={run} icon={<Sparkles className="size-3.5" />}>
            Ask the phone
          </Button>
        )}
        {stats && <span className="text-[11.5px] text-fg-3">{stats}</span>}
      </div>
      <AnimatePresence>
        {(out || busy) && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.3, ease }} className="overflow-hidden">
            <div className="selectable rounded-xl border border-line bg-white/[0.03] p-3 font-serif text-[13.5px] leading-relaxed whitespace-pre-wrap">
              {out || <Spinner className="size-4" />}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function TryImage(): React.JSX.Element {
  const models = readyModels('image')
  const submit = useGen((s) => s.submit)
  const navigate = useNavigate()
  const [prompt, setPrompt] = useState('a lantern market inside a volcanic caldera, dusk, cinematic')
  if (!models.length) return <Hint>Download an image model above. It also appears in Create → Image under “On this phone”.</Hint>
  const m = models[0]
  return (
    <div className="space-y-2.5">
      <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={2} />
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          icon={<Sparkles className="size-3.5" />}
          onClick={() => void submit({ recipeId: PHONE_RECIPE + m.id, params: { prompt, aspect: '1:1', backend: 'auto', steps: m.steps, cfg: m.guidance, seed: -1 }, label: `${m.name} · phone` })}
        >
          Generate on phone
        </Button>
        <Button onClick={() => navigate('/generate/image')}>Open Create</Button>
      </div>
    </div>
  )
}

function TryVoice(): React.JSX.Element {
  const voices = phoneVoices()
  const [voice, setVoice] = useState(voices[0]?.id)
  const [text, setText] = useState('The ash falls like slow snow over the harbour.')
  const [busy, setBusy] = useState(false)
  const [clip, setClip] = useState<Asset | null>(null)
  const [playing, setPlaying] = useState(false)
  const audio = useRef<HTMLAudioElement>(null)
  if (!voices.length) return <Hint>Download a voice above, or use a system voice. Phone voices appear in every voice picker as “This phone”.</Hint>
  const speak = async (): Promise<void> => {
    setBusy(true)
    try {
      const a = (await invoke('voice:speak', { connectorId: PHONE_VOICE_ID, text, voice: { connectorId: PHONE_VOICE_ID, voiceId: voice }, preview: true })) as Asset
      setClip(a)
      requestAnimationFrame(() => void audio.current?.play())
    } catch (err) {
      toast.error('On-device speech failed', errorText(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space-y-2.5">
      <Select value={voice ?? ''} onChange={setVoice} options={voices.map((v) => ({ value: v.id, label: `${v.name} · ${v.labels?.model ?? ''}` }))} />
      <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} />
      <div className="flex items-center gap-2">
        <Button variant="primary" loading={busy} icon={<AudioLines className="size-3.5" />} onClick={() => void speak()}>
          Speak on phone
        </Button>
        {clip && (
          <Button icon={playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />} onClick={() => (playing ? audio.current?.pause() : void audio.current?.play())}>
            {playing ? 'Pause' : 'Play'}
          </Button>
        )}
      </div>
      {clip && <audio ref={audio} src={fileUrl(clip.path)} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} />}
    </div>
  )
}

function Hint({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="rounded-xl border border-dashed border-line px-3.5 py-4 text-[12px] leading-relaxed text-fg-3">{children}</div>
}

function TokenField(): React.JSX.Element {
  const token = useDevice((s) => s.prefs.hfToken)
  const [value, setValue] = useState(token ?? '')
  const [open, setOpen] = useState(false)
  return (
    <div className="rounded-2xl border border-line bg-white/[0.02] p-3.5">
      <button className="flex w-full items-center gap-2 text-left text-[12.5px] font-medium" onClick={() => setOpen((o) => !o)}>
        <KeyRound className="size-4 text-fg-3" />
        <span className="flex-1">Hugging Face token</span>
        <span className="text-[11.5px] text-fg-3">{token ? 'Saved' : 'For gated models'}</span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.3, ease }} className="overflow-hidden">
            <div className="flex gap-2 pt-3">
              <Input type="password" value={value} onChange={(e) => setValue(e.target.value)} placeholder="hf_…" className="flex-1 font-mono" />
              <Button
                onClick={() => {
                  void setPrefs({ hfToken: value.trim() || undefined })
                  toast.success(value.trim() ? 'Token saved on this phone' : 'Token removed')
                }}
              >
                Save
              </Button>
            </div>
            <p className="mt-2 text-[11.5px] text-fg-3">Stored only on this phone. Some models (like Gemma) ask you to accept their license on huggingface.co first.</p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export function DevicePage(): React.JSX.Element {
  const [params, setParams] = useSearchParams()
  const task = (TASKS.find((t) => t.value === params.get('task'))?.value ?? 'text') as DeviceTask
  const native = useDevice((s) => s.native)
  const ready = useDevice((s) => s.ready)
  const error = useDevice((s) => s.error)
  const enabled = useDevice((s) => s.prefs.enabled)
  useDevice((s) => s.status)
  useDevice((s) => s.systemVoices)
  const models = useMemo(() => catalogFor(task), [task, ready])
  const counts = useMemo(() => Object.fromEntries(TASKS.map((t) => [t.value, readyModels(t.value).length])) as Record<DeviceTask, number>, [ready, useDevice.getState().status])

  if (!native) {
    return (
      <Page>
        <PageHeader icon={<Cpu />} title="This phone" subtitle="On-device text, images and voice." />
        <EmptyState icon={<Cpu />} title="Needs the Android app" body="On-device generation runs inside Stitch for Android — on the Qualcomm NPU (QNN), the GPU or the CPU." className="py-16" />
      </Page>
    )
  }

  return (
    <Page>
      <PageHeader icon={<Cpu />} title="This phone" subtitle="Make text, images and voice right here — on the Qualcomm NPU (QNN), the GPU or the CPU. Everything you make saves to your PC." />
      <motion.div variants={stagger(0.05, 0.04)} initial="initial" animate="animate" className="space-y-5 px-8 pb-10 max-md:px-4">
        <ChipCard />
        {error && <div className="rounded-xl border border-danger/25 bg-danger/10 p-3 text-[12px] text-danger">{error}</div>}
        <motion.div variants={rise}>
          <Segmented value={task} onChange={(t) => setParams({ task: t }, { replace: true })} items={TASKS.map((t) => ({ ...t, count: counts[t.value] || undefined }))} className="w-full [&>button]:flex-1 [&>button]:justify-center" />
        </motion.div>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={task} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.28, ease }} className="space-y-5">
            <BackendPicker task={task} />
            {task !== 'image' && (
              <SwitchRow
                label={task === 'text' ? 'Offer in model pickers' : 'Offer in voice pickers'}
                help={task === 'text' ? '“This phone” appears next to your PC models in chats and stories.' : '“This phone” appears as a voice provider for characters and narration.'}
                checked={enabled[task]}
                onChange={(v) => void setPrefs({ enabled: { ...enabled, [task]: v } })}
              />
            )}
            <div className="space-y-2">
              <SectionTitle>Models</SectionTitle>
              {!ready ? (
                <div className="space-y-2">
                  <div className="shimmer h-24 rounded-2xl" />
                  <div className="shimmer h-24 rounded-2xl" />
                </div>
              ) : models.length ? (
                models.map((m, i) => <ModelCard key={m.id} m={m} index={i} />)
              ) : (
                <Hint>No models for this chip yet.</Hint>
              )}
            </div>
            <div className="space-y-2.5">
              <SectionTitle>Try it</SectionTitle>
              {task === 'text' && <TryText />}
              {task === 'image' && <TryImage />}
              {task === 'voice' && <TryVoice />}
            </div>
          </motion.div>
        </AnimatePresence>
        <TokenField />
      </motion.div>
    </Page>
  )
}
