// More → This phone: the on-device studio. Small Chat / Image / Voice studios, where models run (Qualcomm NPU
// via QNN, GPU or CPU), and a browser for every model — standard and abliterated/uncensored, for every kind of
// hardware — plus models from any link or imported from the phone. Everything made here saves to the PC library.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { AnimatePresence, motion } from 'motion/react'
import {
  AlertTriangle,
  AudioLines,
  Check,
  ChevronDown,
  Cpu,
  Download,
  FolderInput,
  Gauge,
  HardDrive,
  ImageIcon,
  KeyRound,
  Link2,
  Lock,
  MemoryStick,
  MessageSquare,
  Pause,
  Play,
  Plus,
  Search,
  Smartphone,
  Sparkles,
  Star,
  Trash2,
  X,
  Zap
} from 'lucide-react'
import type { Asset, GenJob } from '@shared/types'
import { Page, PageHeader } from '@/components/shell/page'
import { AssetLightbox, AssetThumb } from '@/components/media'
import { Button, IconButton } from '@/components/ui/button'
import { Input, SearchField, Textarea } from '@/components/ui/input'
import { Badge, EmptyState, ProgressRing, SectionTitle, Spinner } from '@/components/ui/misc'
import { Segmented, Switch, SwitchRow } from '@/components/ui/controls'
import { Select } from '@/components/ui/overlay'
import { errorText, fileUrl, invoke, streamLlm } from '@/lib/api'
import { cn } from '@/lib/utils'
import { ease, rise, spring, stagger } from '@/lib/motion'
import { useDoc } from '@/stores/db'
import { isActive, useGen } from '@/stores/gen'
import { toast } from '@/stores/toast'
import { Sheet } from '@mobile/shell/Sheet'
import { tap } from '@mobile/shell/haptics'
import type { CatalogModel } from './catalog'
import { PHONE_RECIPE } from './image'
import { PHONE_LLM_ID } from './llm'
import type { DeviceBackend, DeviceTask } from './plugin'
import { importFromPhone, resolveLink, type LinkResult } from './sources'
import {
  addCustomModel,
  BACKEND_LABEL,
  backendAvailable,
  cancelDownload,
  catalogFor,
  compatibility,
  deleteModel,
  downloadModel,
  isReady,
  readyModels,
  removeCustomModel,
  resolveBackend,
  setPrefs,
  sizeText,
  useDevice
} from './store'
import { ModelTags, Tag } from './tags'
import { PHONE_VOICE_ID, phoneVoices } from './voice'

const TASKS: { value: DeviceTask; label: string; icon: React.ReactNode }[] = [
  { value: 'text', label: 'Chat', icon: <MessageSquare /> },
  { value: 'image', label: 'Images', icon: <ImageIcon /> },
  { value: 'voice', label: 'Voice', icon: <AudioLines /> }
]

const BACKENDS: { id: DeviceBackend | 'auto'; label: string; icon: React.ReactNode; hint: string }[] = [
  { id: 'auto', label: 'Auto', icon: <Sparkles />, hint: 'Best here' },
  { id: 'npu', label: 'NPU', icon: <Zap />, hint: 'Qualcomm QNN' },
  { id: 'gpu', label: 'GPU', icon: <Gauge />, hint: 'Graphics chip' },
  { id: 'cpu', label: 'CPU', icon: <Cpu />, hint: 'Works everywhere' }
]

function remember<T extends string>(key: string, value?: T): T | undefined {
  try {
    if (value !== undefined) localStorage.setItem(key, value)
    return (localStorage.getItem(key) as T | null) ?? undefined
  } catch {
    return value
  }
}

// ─── Header cards ────────────────────────────────────────────────────────────

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
      <div className="relative mt-3.5 flex flex-wrap items-center gap-x-4 gap-y-2 text-[11.5px] text-fg-3">
        <span className="flex items-center gap-1.5">
          <MemoryStick className="size-3.5" /> {sizeText(info.ramBytes)} RAM
        </span>
        <span className="flex items-center gap-1.5">
          <HardDrive className="size-3.5" /> {sizeText(info.freeStorageBytes)} free
        </span>
        <span className="flex gap-1">
          {(['npu', 'gpu', 'cpu'] as DeviceBackend[]).map((b) => {
            const any = (['text', 'image', 'voice'] as DeviceTask[]).some((t) => backendAvailable(t, b))
            return <Tag key={b} label={b} dim={!any} title={any ? `${b.toUpperCase()} available` : `No ${b.toUpperCase()} support`} />
          })}
        </span>
      </div>
    </motion.div>
  )
}

/** "Only this phone": every generation runs on the phone's own hardware (also in Settings → Phone). */
function DeviceOnlyCard(): React.JSX.Element {
  const on = useDevice((s) => !!s.prefs.deviceOnly)
  useDevice((s) => s.status)
  const counts = { text: readyModels('text').length, image: readyModels('image').length, voice: readyModels('voice').length }
  const missing = TASKS.filter((t) => !counts[t.value]).map((t) => t.label.toLowerCase())
  return (
    <motion.div variants={rise} className={cn('rounded-2xl border p-3.5 transition-colors duration-300', on ? 'border-[color-mix(in_oklab,var(--accent)_45%,transparent)] bg-[color-mix(in_oklab,var(--accent)_8%,transparent)]' : 'border-line bg-white/[0.02]')}>
      <label className="flex items-center gap-3">
        <span className={cn('grid size-9 shrink-0 place-items-center rounded-xl transition-colors', on ? 'bg-grad text-white' : 'border border-line bg-white/[0.04] text-fg-2')}>
          <Smartphone className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13.5px] font-semibold">Only this phone</span>
          <span className="block text-[11.5px] leading-snug text-fg-3">{on ? 'Chats, images and voice run on this phone. Your PC just keeps the library.' : 'Run every generation on this phone’s own chip instead of the PC.'}</span>
        </span>
        <Switch checked={on} onChange={(v) => void invoke('phone:deviceOnly', v).then(() => tap())} />
      </label>
      <AnimatePresence initial={false}>
        {on && missing.length > 0 && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.3, ease }} className="overflow-hidden">
            <div className="mt-3 flex items-start gap-2 rounded-xl border border-warning/25 bg-warning/10 px-3 py-2 text-[11.5px] leading-snug text-warning">
              <AlertTriangle className="mt-px size-3.5 shrink-0" /> Download a {missing.join(', ')} model below — until then, those won’t work.
            </div>
          </motion.div>
        )}
      </AnimatePresence>
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

// ─── Model cards ─────────────────────────────────────────────────────────────

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
  const fit = compatibility(m)
  const remove = (): Promise<void> => (m.custom ? removeCustomModel(m) : deleteModel(m))
  return (
    <motion.div
      initial={index < 12 ? { opacity: 0, y: 10 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease, delay: Math.min(index, 12) * 0.035 }}
      className={cn('relative overflow-hidden rounded-2xl border p-3.5', ready ? 'border-line-strong bg-white/[0.045]' : 'border-line bg-white/[0.02]', !fit.ok && !ready && 'opacity-60')}
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
          <ModelTags m={m} className="mt-2" />
          <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 text-[11px] text-fg-3">
            <span className="font-medium text-fg-2">{m.family}</span>
            {ready && runsOn && <span className="ml-1 rounded-full bg-success/12 px-2 py-0.5 font-medium text-success">Runs on {BACKEND_LABEL[runsOn]}</span>}
            {!fit.ok && <span className="text-warning">· {fit.reason}</span>}
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
              <IconButton label="Cancel download" size="sm" className="max-md:size-9" onClick={() => void cancelDownload(m)}>
                <X className="size-3.5" />
              </IconButton>
            </>
          ) : ready || (m.custom && m.source === 'import') ? (
            <AnimatePresence mode="wait" initial={false}>
              {confirm ? (
                <motion.div key="c" initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} className="flex gap-1">
                  <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>
                    Keep
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => void remove().then(() => setConfirm(false))}>
                    {m.custom ? 'Remove' : 'Delete'}
                  </Button>
                </motion.div>
              ) : (
                <motion.div key="r" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex items-center gap-1">
                  {ready && (
                    <Badge tone="success">
                      <Check className="size-3" /> Ready
                    </Badge>
                  )}
                  <IconButton label="Delete from phone" size="sm" className="max-md:size-9" onClick={() => setConfirm(true)}>
                    <Trash2 className="size-3.5" />
                  </IconButton>
                </motion.div>
              )}
            </AnimatePresence>
          ) : (
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant={m.recommended && fit.ok ? 'primary' : 'secondary'}
                disabled={!fit.ok}
                icon={<Download className="size-3.5" />}
                className="max-md:h-9"
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
              {m.custom && (
                <IconButton label="Remove" size="sm" className="max-md:size-9" onClick={() => void removeCustomModel(m)}>
                  <X className="size-3.5" />
                </IconButton>
              )}
            </div>
          )}
        </div>
      </div>
    </motion.div>
  )
}

// ─── Browser ─────────────────────────────────────────────────────────────────

type Variant = 'all' | 'standard' | 'abliterated' | 'uncensored'

function FilterChip({ active, onClick, children, count }: { active: boolean; onClick: () => void; children: React.ReactNode; count?: number }): React.JSX.Element {
  return (
    <button
      onClick={() => {
        tap()
        onClick()
      }}
      className={cn('relative flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[12px] font-medium whitespace-nowrap transition-colors duration-200', active ? 'border-transparent text-fg' : 'border-line text-fg-2')}
    >
      {active && <motion.span layoutId={undefined} className="absolute inset-0 rounded-full border border-[color-mix(in_oklab,var(--accent)_45%,transparent)] bg-white/[0.08]" transition={spring} />}
      <span className="relative flex items-center gap-1.5">
        {children}
        {count !== undefined && <span className="text-fg-3 tabular-nums">{count}</span>}
      </span>
    </button>
  )
}

const PAGE = 14

function ModelBrowser({ task }: { task: DeviceTask }): React.JSX.Element {
  const ready = useDevice((s) => s.ready)
  const custom = useDevice((s) => s.custom)
  const info = useDevice((s) => s.info)
  useDevice((s) => s.status)
  const [q, setQ] = useState('')
  const [hw, setHw] = useState<'all' | DeviceBackend>('all')
  const [variant, setVariant] = useState<Variant>('all')
  const [everyChip, setEveryChip] = useState(false)
  const [shown, setShown] = useState(PAGE)
  const [adding, setAdding] = useState(false)
  useEffect(() => setShown(PAGE), [task, q, hw, variant, everyChip])

  const all = useMemo(() => catalogFor(task, true), [task, custom, info]) // eslint-disable-line react-hooks/exhaustive-deps
  const matchesText = (m: CatalogModel): boolean => !q.trim() || `${m.name} ${m.family} ${m.description} ${(m.tags ?? []).join(' ')} ${m.variant ?? ''}`.toLowerCase().includes(q.trim().toLowerCase())
  const inScope = all.filter((m) => matchesText(m) && (everyChip || compatibility(m).ok || isReady(m)))
  const count = (fn: (m: CatalogModel) => boolean): number => inScope.filter(fn).length
  const filtered = inScope.filter((m) => (hw === 'all' || m.backends.includes(hw)) && (variant === 'all' || (m.variant ?? 'standard') === variant))
  const mine = filtered.filter((m) => isReady(m) || m.custom || useDevice.getState().downloads[m.id])
  const rest = filtered.filter((m) => !mine.includes(m)).sort((a, b) => Number(!!b.recommended) - Number(!!a.recommended) || Number(compatibility(b).ok) - Number(compatibility(a).ok) || a.sizeBytes - b.sizeBytes)
  const variants: Variant[] = task === 'voice' ? [] : (['standard', 'abliterated', 'uncensored'] as Variant[]).filter((v) => count((m) => (m.variant ?? 'standard') === v) > 0)
  const incompatible = all.filter((m) => !compatibility(m).ok && !isReady(m)).length

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <SectionTitle className="flex-1">Models</SectionTitle>
        {task !== 'voice' && (
          <Button size="sm" icon={<Plus className="size-3.5" />} className="max-md:h-9" onClick={() => setAdding(true)}>
            Add model
          </Button>
        )}
      </div>
      <SearchField value={q} onChange={setQ} placeholder={task === 'text' ? 'Search Qwen, Gemma, abliterated…' : task === 'image' ? 'Search realistic, anime, turbo…' : 'Search voices, languages…'} className="w-full" />
      <div className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-0.5 [scrollbar-width:none]">
        <FilterChip active={hw === 'all'} onClick={() => setHw('all')} count={inScope.length}>
          All hardware
        </FilterChip>
        {(['npu', 'gpu', 'cpu'] as DeviceBackend[]).map((b) => {
          const n = count((m) => m.backends.includes(b))
          if (!n) return null
          return (
            <FilterChip key={b} active={hw === b} onClick={() => setHw(b)} count={n}>
              <Tag label={b} />
            </FilterChip>
          )
        })}
      </div>
      {variants.length > 1 && (
        <div className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-0.5 [scrollbar-width:none]">
          <FilterChip active={variant === 'all'} onClick={() => setVariant('all')}>
            Any
          </FilterChip>
          {variants.map((v) => (
            <FilterChip key={v} active={variant === v} onClick={() => setVariant(v)} count={count((m) => (m.variant ?? 'standard') === v)}>
              <Tag label={v} />
            </FilterChip>
          ))}
        </div>
      )}

      {!ready ? (
        <div className="space-y-2">
          <div className="shimmer h-24 rounded-2xl" />
          <div className="shimmer h-24 rounded-2xl" />
        </div>
      ) : (
        <>
          {mine.length > 0 && (
            <div className="space-y-2">
              <div className="label-caps pt-1">On this phone</div>
              {mine.map((m, i) => (
                <ModelCard key={m.id} m={m} index={i} />
              ))}
            </div>
          )}
          <div className="space-y-2">
            {mine.length > 0 && rest.length > 0 && <div className="label-caps pt-2">More to download</div>}
            {rest.slice(0, shown).map((m, i) => (
              <ModelCard key={m.id} m={m} index={i} />
            ))}
            {rest.length > shown && (
              <Button variant="ghost" className="w-full" icon={<ChevronDown className="size-3.5" />} onClick={() => setShown((n) => n + PAGE * 2)}>
                Show more ({rest.length - shown})
              </Button>
            )}
            {!mine.length && !rest.length && <Hint>No models match. {q && 'Try another search.'}</Hint>}
          </div>
          {incompatible > 0 && (
            <button onClick={() => setEveryChip((v) => !v)} className="w-full py-2 text-center text-[12px] font-medium text-fg-3 transition hover:text-fg-2">
              {everyChip ? 'Hide models for other phones' : `Show ${incompatible} model${incompatible === 1 ? '' : 's'} for other chips and bigger phones`}
            </button>
          )}
        </>
      )}
      <AddModelSheet open={adding} onClose={() => setAdding(false)} task={task} />
    </div>
  )
}

// ─── Add a model: any link, or files on the phone ────────────────────────────

function AddModelSheet({ open, onClose, task: initial }: { open: boolean; onClose: () => void; task: DeviceTask }): React.JSX.Element {
  const [task, setTask] = useState<'text' | 'image'>(initial === 'image' ? 'image' : 'text')
  const [link, setLink] = useState('')
  const [busy, setBusy] = useState(false)
  const [importing, setImporting] = useState(false)
  const [result, setResult] = useState<LinkResult | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    if (open) setTask(initial === 'image' ? 'image' : 'text')
  }, [open, initial])
  useEffect(() => {
    setResult(null)
    setErr(null)
  }, [task])

  const find = async (): Promise<void> => {
    setBusy(true)
    setErr(null)
    setResult(null)
    try {
      setResult(await resolveLink(link, task))
    } catch (e) {
      setErr(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  const add = async (m: CatalogModel): Promise<void> => {
    await addCustomModel(m)
    toast.success(`${m.name} added`, 'Downloading now — it shows under “On this phone”.')
    void downloadModel(m).catch((e) => toast.error(`Couldn't download ${m.name}`, errorText(e)))
    onClose()
  }
  const fromPhone = async (): Promise<void> => {
    setImporting(true)
    try {
      const m = await importFromPhone(task)
      if (m) {
        toast.success(`${m.name} imported`, 'Ready to use on this phone.')
        onClose()
      }
    } catch (e) {
      toast.error("Couldn't import that", errorText(e))
    } finally {
      setImporting(false)
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title="Add a model">
      <div className="space-y-4 px-5 pt-2 pb-6">
        <Segmented
          value={task}
          onChange={setTask}
          className="w-full [&>button]:flex-1 [&>button]:justify-center"
          items={[
            { value: 'text', label: 'Chat model', icon: <MessageSquare /> },
            { value: 'image', label: 'Image model', icon: <ImageIcon /> }
          ]}
        />
        <div>
          <div className="label-caps mb-2 flex items-center gap-1.5">
            <Link2 className="size-3" /> From a link
          </div>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              void find()
            }}
          >
            <Input value={link} onChange={(e) => setLink(e.target.value)} placeholder={task === 'text' ? 'huggingface.co/… or a .gguf link' : 'Hugging Face, Civitai or a .safetensors link'} className="min-w-0 flex-1" inputMode="url" autoCapitalize="off" autoCorrect="off" />
            <Button type="submit" variant="primary" icon={busy ? <Spinner className="size-3.5" /> : <Search className="size-3.5" />} disabled={busy || !link.trim()} className="h-10">
              Find
            </Button>
          </form>
          <p className="mt-1.5 text-[11px] leading-snug text-fg-3">
            {task === 'text' ? 'Any Hugging Face repo with GGUF or LiteRT-LM files (e.g. bartowski/…-GGUF), or a direct download link.' : 'A Hugging Face repo, a Civitai checkpoint page, or a direct link to a .safetensors / .ckpt / .gguf file.'}
          </p>
          <AnimatePresence mode="wait" initial={false}>
            {err ? (
              <motion.div key="err" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="mt-3 rounded-xl border border-danger/25 bg-danger/10 px-3 py-2 text-[12px] text-danger">
                {err}
              </motion.div>
            ) : result ? (
              <motion.div key="res" variants={stagger(0.03)} initial="initial" animate="animate" exit={{ opacity: 0 }} className="mt-3 space-y-1.5">
                <div className="truncate text-[12.5px] font-semibold">{result.title}</div>
                {result.note && <div className="text-[12px] text-fg-3">{result.note}</div>}
                {result.options.map((o) => (
                  <motion.button key={o.key} variants={rise} onClick={() => void add(o.model)} className="flex w-full items-center gap-3 rounded-xl border border-line bg-white/[0.03] px-3 py-2.5 text-left transition active:scale-[0.99]">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium">{o.label}</div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {o.model.variant && <Tag label={o.model.variant} />}
                        {o.tags.map((t) => (
                          <Tag key={t} label={t} />
                        ))}
                      </div>
                    </div>
                    <span className="shrink-0 text-[12px] text-fg-2 tabular-nums">{o.sizeBytes ? sizeText(o.sizeBytes) : '—'}</span>
                    <Download className="size-4 shrink-0 text-accent" />
                  </motion.button>
                ))}
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
        <div className="border-t border-line pt-4">
          <div className="label-caps mb-2 flex items-center gap-1.5">
            <FolderInput className="size-3" /> From this phone
          </div>
          <Button className="h-11 w-full" icon={importing ? <Spinner className="size-3.5" /> : <FolderInput className="size-4" />} disabled={importing} onClick={() => void fromPhone()}>
            {importing ? 'Copying…' : task === 'text' ? 'Import a .gguf or .litertlm file' : 'Import a checkpoint (and VAE)'}
          </Button>
          <p className="mt-1.5 text-[11px] leading-snug text-fg-3">The file is copied into Stitch's model folder, so you can delete the original afterwards.</p>
        </div>
      </div>
    </Sheet>
  )
}

// ─── Studios ─────────────────────────────────────────────────────────────────

function TryText(): React.JSX.Element {
  const models = readyModels('text')
  const [model, setModel] = useState(models[0]?.id)
  const [prompt, setPrompt] = useState('Describe a harbour city built inside a volcano in two sentences.')
  const [out, setOut] = useState('')
  const [busy, setBusy] = useState(false)
  const [stats, setStats] = useState<string>()
  const abort = useRef<(() => void) | null>(null)
  useEffect(() => {
    if ((!model || !models.some((m) => m.id === model)) && models[0]) setModel(models[0].id)
  }, [models, model])
  if (!models.length) return <Hint>Download a chat model below, then try it here — or pick “This phone” in any chat's model menu.</Hint>
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
            <div className="selectable rounded-xl border border-line bg-white/[0.03] p-3 font-serif text-[13.5px] leading-relaxed whitespace-pre-wrap">{out || <Spinner className="size-4" />}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

const ASPECTS = ['1:1', '3:4', '4:3', '9:16', '16:9']

/** A phone render: the PC asset once uploaded, else the phone's own copy and live progress. */
function PhoneResult({ job, onOpen }: { job: GenJob; onOpen: (id: string) => void }): React.JSX.Element {
  const asset = useDoc('assets', job.outputs[0])
  const busy = isActive(job)
  const pct = job.progress?.max ? job.progress.value / job.progress.max : undefined
  if (asset) return <AssetThumb asset={asset} className="aspect-square" onClick={() => onOpen(asset.id)} />
  return (
    <div className="relative aspect-square overflow-hidden rounded-xl border border-line bg-white/[0.03]">
      {job.preview ? <img src={job.preview} className="absolute inset-0 size-full object-cover" /> : busy ? <div className="sheen absolute inset-0" /> : null}
      {busy && (
        <div className="absolute inset-0 grid place-items-center bg-black/25">
          <ProgressRing value={pct} size={30} />
        </div>
      )}
      {job.status === 'error' && !job.preview && <div className="absolute inset-0 grid place-items-center p-2 text-center text-[10.5px] leading-snug text-danger">{job.error}</div>}
      {job.status === 'done' && !asset && job.preview && <span className="absolute bottom-1 left-1 rounded-md bg-black/55 px-1.5 py-0.5 text-[9.5px] text-white/85 backdrop-blur">On phone</span>}
    </div>
  )
}

function ImageStudio(): React.JSX.Element {
  const models = readyModels('image')
  const submit = useGen((s) => s.submit)
  const jobs = useGen((s) => s.jobs)
  const navigate = useNavigate()
  const [model, setModel] = useState(() => remember<string>('stitch.phone.imageModel'))
  const [prompt, setPrompt] = useState('a lantern market inside a volcanic caldera, dusk, cinematic')
  const [aspect, setAspect] = useState('1:1')
  const [lightbox, setLightbox] = useState<string | null>(null)
  const m = models.find((x) => x.id === model) ?? models.find((x) => x.recommended) ?? models[0]
  const recent = useMemo(() => Object.values(jobs).filter((j) => j.id.startsWith('phone-') && j.kind === 'image').sort((a, b) => b.createdAt - a.createdAt).slice(0, 9), [jobs])
  if (!m) return <Hint>Download an image model below. It also appears in Create → Image under “On this phone”.</Hint>
  const fixed = m.config?.fixedResolution === true
  const go = (): void => {
    tap()
    void submit({ recipeId: PHONE_RECIPE + m.id, params: { prompt, aspect: fixed ? '1:1' : aspect, backend: 'auto', steps: m.steps, cfg: m.guidance, seed: -1 }, label: `${m.name} · phone` }).catch((e) => toast.error("Couldn't start", errorText(e)))
  }
  return (
    <div className="space-y-2.5">
      <Select
        value={m.id}
        onChange={(v) => setModel(remember('stitch.phone.imageModel', v))}
        options={models.map((x) => ({ value: x.id, label: x.name, hint: BACKEND_LABEL[resolveBackend('image', x)] }))}
      />
      <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={2} placeholder="What should the phone paint?" />
      {!fixed && <Segmented size="sm" value={aspect} onChange={setAspect} className="w-full [&>button]:flex-1 max-md:[&>button]:h-8" items={ASPECTS.map((a) => ({ value: a, label: a }))} />}
      <div className="flex gap-2">
        <Button variant="primary" className="flex-1" icon={<Sparkles className="size-3.5" />} disabled={!prompt.trim()} onClick={go}>
          Generate on phone
        </Button>
        <Button onClick={() => navigate('/generate/image')}>Full editor</Button>
      </div>
      {recent.length > 0 && (
        <motion.div layout className="grid grid-cols-3 gap-1.5 pt-1">
          {recent.map((j) => (
            <PhoneResult key={j.id} job={j} onOpen={setLightbox} />
          ))}
        </motion.div>
      )}
      <AssetLightbox assetId={lightbox} onClose={() => setLightbox(null)} />
    </div>
  )
}

interface Clip {
  id: string
  path: string
  text: string
  voice: string
}

function VoiceStudio(): React.JSX.Element {
  const voices = phoneVoices()
  const [voice, setVoice] = useState(() => remember<string>('stitch.phone.voice'))
  const [text, setText] = useState('The ash falls like slow snow over the harbour.')
  const [busy, setBusy] = useState(false)
  const [clips, setClips] = useState<Clip[]>([])
  const [playing, setPlaying] = useState<string | null>(null)
  const audio = useRef<HTMLAudioElement>(null)
  const v = voices.find((x) => x.id === voice) ?? voices[0]
  if (!v) return <Hint>Download a voice below, or use a system voice. Phone voices appear in every voice picker as “This phone”.</Hint>
  const play = (c: Clip): void => {
    const el = audio.current
    if (!el) return
    if (playing === c.id) {
      el.pause()
      return
    }
    el.src = fileUrl(c.path)
    void el.play()
    setPlaying(c.id)
  }
  const speak = async (): Promise<void> => {
    setBusy(true)
    try {
      const a = (await invoke('voice:speak', { connectorId: PHONE_VOICE_ID, text, voice: { connectorId: PHONE_VOICE_ID, voiceId: v.id } })) as Asset
      const clip = { id: a.id, path: a.path, text, voice: v.name }
      setClips((c) => [clip, ...c].slice(0, 6))
      requestAnimationFrame(() => play(clip))
    } catch (err) {
      toast.error('On-device speech failed', errorText(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space-y-2.5">
      <Select value={v.id} onChange={(id) => setVoice(remember('stitch.phone.voice', id))} options={voices.map((x) => ({ value: x.id, label: x.name, hint: x.labels?.model }))} />
      <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} placeholder="What should they say?" />
      <Button variant="primary" className="w-full" loading={busy} disabled={!text.trim()} icon={<AudioLines className="size-3.5" />} onClick={() => void speak()}>
        Speak on phone
      </Button>
      <AnimatePresence initial={false}>
        {clips.map((c) => (
          <motion.button
            key={c.id}
            layout
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={spring}
            onClick={() => play(c)}
            className="flex w-full items-center gap-3 rounded-xl border border-line bg-white/[0.03] px-3 py-2.5 text-left active:scale-[0.99]"
          >
            <span className={cn('grid size-8 shrink-0 place-items-center rounded-full transition-colors', playing === c.id ? 'bg-grad text-white' : 'bg-white/[0.07] text-fg-2')}>
              {playing === c.id ? <Pause className="size-3.5" /> : <Play className="size-3.5 fill-current" />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12.5px]">{c.text}</span>
              <span className="block text-[11px] text-fg-3">{c.voice}</span>
            </span>
          </motion.button>
        ))}
      </AnimatePresence>
      <audio ref={audio} onPause={() => setPlaying(null)} onEnded={() => setPlaying(null)} />
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
            <p className="mt-2 text-[11.5px] text-fg-3">Stored only on this phone and only sent to Hugging Face. Some models (like Gemma) ask you to accept their license on huggingface.co first.</p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ─── Page ────────────────────────────────────────────────────────────────────

export function DevicePage(): React.JSX.Element {
  const [params, setParams] = useSearchParams()
  const task = (TASKS.find((t) => t.value === params.get('task'))?.value ?? 'text') as DeviceTask
  const native = useDevice((s) => s.native)
  const error = useDevice((s) => s.error)
  const enabled = useDevice((s) => s.prefs.enabled)
  const status = useDevice((s) => s.status)
  useDevice((s) => s.systemVoices)
  useDevice((s) => s.custom)
  const counts = useMemo(() => Object.fromEntries(TASKS.map((t) => [t.value, readyModels(t.value).length])) as Record<DeviceTask, number>, [status]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!native) {
    return (
      <Page>
        <PageHeader icon={<Cpu />} title="This phone" subtitle="On-device text, images and voice." />
        <EmptyState icon={<Cpu />} title="Needs the Android app" body="On-device generation runs inside Stitch for Android — on the Qualcomm NPU (QNN), the GPU or the CPU." className="py-16" />
      </Page>
    )
  }

  const studio = task === 'text' ? 'Try a chat' : task === 'image' ? 'Image studio' : 'Voice studio'
  return (
    <Page>
      <PageHeader icon={<Cpu />} title="This phone" subtitle="Make text, images and voice right here — on the Qualcomm NPU (QNN), the GPU or the CPU. Everything you make saves to your PC." />
      <motion.div variants={stagger(0.05, 0.04)} initial="initial" animate="animate" className="space-y-5 px-8 pb-10 max-md:px-4">
        <ChipCard />
        <DeviceOnlyCard />
        {error && <div className="rounded-xl border border-danger/25 bg-danger/10 p-3 text-[12px] text-danger">{error}</div>}
        <motion.div variants={rise}>
          <Segmented value={task} onChange={(t) => setParams({ task: t }, { replace: true })} items={TASKS.map((t) => ({ ...t, count: counts[t.value] || undefined }))} className="w-full [&>button]:flex-1 [&>button]:justify-center" />
        </motion.div>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={task} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.28, ease }} className="space-y-5">
            <div className="glass hairline space-y-2.5 rounded-2xl p-3.5">
              <div className="flex items-center gap-2">
                <span className="grid size-7 place-items-center rounded-lg bg-grad text-white [&>svg]:size-3.5">{TASKS.find((t) => t.value === task)!.icon}</span>
                <span className="text-[13.5px] font-semibold">{studio}</span>
              </div>
              {task === 'text' && <TryText />}
              {task === 'image' && <ImageStudio />}
              {task === 'voice' && <VoiceStudio />}
            </div>
            <BackendPicker task={task} />
            {task !== 'image' && (
              <SwitchRow
                label={task === 'text' ? 'Offer in model pickers' : 'Offer in voice pickers'}
                help={task === 'text' ? '“This phone” appears next to your PC models in chats and stories.' : '“This phone” appears as a voice provider for characters and narration.'}
                checked={enabled[task]}
                onChange={(v) => void setPrefs({ enabled: { ...enabled, [task]: v } })}
              />
            )}
            <ModelBrowser task={task} />
          </motion.div>
        </AnimatePresence>
        <TokenField />
      </motion.div>
    </Page>
  )
}
