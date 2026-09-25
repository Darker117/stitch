// Reusable voice chooser for characters, narrators and the Voice studio.
// Pick an engine (Qwen3-TTS, Kokoro, Pocket TTS, ElevenLabs, OpenAI, Azure), then a
// voice — preset voices, a clone from a sample, a designed voice or a library voice.
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { AnimatePresence, motion } from 'motion/react'
import { AudioLines, Check, Cloud, Cpu, Download, ExternalLink, Feather, FolderOpen, HardDrive, KeyRound, Library, Mic, Plus, RefreshCw, Sparkles, Square, Trash2, UserRound, Wand2, X, Zap } from 'lucide-react'
import type { VoiceEngineInfo, VoiceInfo } from '@shared/ipc'
import type { Asset, CharacterVoice, ID, VoiceConnector } from '@shared/types'
import { errorText, fileUrl, invoke } from '@/lib/api'
import { cn } from '@/lib/utils'
import { ease, spring, springSoft } from '@/lib/motion'
import {
  DEFAULT_PREVIEW_LINE,
  DESIGN_IDEAS,
  approxSize,
  sizeLabel,
  KOKORO_LANGUAGES,
  POCKET_LANGUAGES,
  READ_ALOUD,
  VOICE_KIND_LABEL,
  VOICE_LANGUAGES,
  describeVoice,
  engineProgress,
  forgetVoices,
  presetMeta,
  previewLine,
  speak,
  useResolvedConnector,
  useVoiceConnectors,
  useVoiceEngine,
  useVoiceEngines,
  useVoicePresets,
  useVoices,
  voiceFromPreset
} from '@/lib/voice'
import { useDoc } from '@/stores/db'
import { toast, useToasts } from '@/stores/toast'
import { AssetPicker, DropZone } from './media'
import { EqBars, LiveWave, WavePlayer, playPreview, stopPreview, usePreviewKey, useRecorder } from './audio'
import { Button, Chip, IconButton } from './ui/button'
import { Input, SearchField, Textarea } from './ui/input'
import { Segmented } from './ui/controls'
import { Badge, Field, ProgressBar, Skeleton, Spinner } from './ui/misc'
import { Dialog, Select } from './ui/overlay'

// ─── Preview ─────────────────────────────────────────────────────────────────

/** Toast for voice errors, with a shortcut to wherever the fix is (engine install or Connectors). */
export function useNotifyEngine(): (err: unknown, title?: string) => void {
  const navigate = useNavigate()
  return (err, title = 'Preview failed') => {
    const body = errorText(err)
    if (/Generate → Voice|still installing/i.test(body)) {
      useToasts.getState().push({ title, body, tone: 'error', ms: 8000, action: { label: 'Open Voice engines', run: () => navigate('/generate/voice') } })
    } else if (/not installed|voice engine|Connectors|API key/i.test(body)) {
      useToasts.getState().push({ title, body, tone: 'error', ms: 8000, action: { label: 'Open Connectors', run: () => navigate('/connectors') } })
    } else toast.error(title, body)
  }
}

/** ▶ that speaks a short line with a voice (cached per voice + line) or plays a provider sample. */
export function VoicePreviewButton({
  voice,
  connectorId,
  text = DEFAULT_PREVIEW_LINE,
  previewUrl,
  characterIds,
  size = 'sm',
  label,
  className
}: {
  voice: CharacterVoice | undefined
  connectorId?: ID
  text?: string
  previewUrl?: string
  characterIds?: ID[]
  size?: 'xs' | 'sm' | 'md'
  label?: string
  className?: string
}): React.JSX.Element {
  const key = useMemo(() => `${connectorId}|${JSON.stringify(voice ?? {})}|${previewUrl ?? text}`, [connectorId, voice, text, previewUrl])
  const playing = usePreviewKey() === key
  const [loading, setLoading] = useState(false)
  const notify = useNotifyEngine()
  const run = async (e: React.MouseEvent): Promise<void> => {
    e.stopPropagation()
    if (playing) return stopPreview()
    try {
      let url = previewUrl
      if (!url) {
        setLoading(true)
        const asset = await speak({ connectorId, text, voice: { ...(voice ?? {}), connectorId }, preview: true, characterIds })
        url = fileUrl(asset.path)
      }
      setLoading(false)
      await playPreview(url, key)
    } catch (err) {
      notify(err)
    } finally {
      setLoading(false)
    }
  }
  const dims = { xs: 'size-6', sm: 'size-7.5', md: 'size-9' }[size]
  const body = loading ? <Spinner className="size-3.5" /> : playing ? <EqBars className="h-3" /> : <PlayGlyph />
  if (label) {
    return (
      <Button size={size === 'md' ? 'md' : 'sm'} variant={playing ? 'primary' : 'secondary'} onClick={run} icon={body} className={className}>
        {playing ? 'Playing' : loading ? 'Synthesizing…' : label}
      </Button>
    )
  }
  return (
    <motion.button
      whileTap={{ scale: 0.88 }}
      transition={spring}
      onClick={run}
      aria-label={playing ? 'Stop preview' : 'Preview voice'}
      title={playing ? 'Stop' : 'Preview'}
      className={cn(
        'grid shrink-0 place-items-center rounded-full transition-[background,box-shadow,color] duration-200',
        dims,
        playing ? 'bg-grad text-white shadow-[0_4px_16px_-4px_color-mix(in_oklab,var(--accent)_80%,transparent)]' : 'border border-line bg-white/[0.05] text-fg-2 hover:bg-white/[0.1] hover:text-fg',
        className
      )}
    >
      {body}
    </motion.button>
  )
}

function PlayGlyph(): React.JSX.Element {
  return (
    <svg viewBox="0 0 12 12" className="size-2.5 translate-x-[1px]">
      <path d="M2.5 1.4v9.2a.6.6 0 0 0 .9.5l7.6-4.6a.6.6 0 0 0 0-1L3.4.9a.6.6 0 0 0-.9.5z" fill="currentColor" />
    </svg>
  )
}

// ─── Sample (clone) input ────────────────────────────────────────────────────

function fmtSecs(s: number): string {
  return `0:${String(Math.floor(s)).padStart(2, '0')}`
}

/** Pick, drop or record a reference clip, plus the exact words spoken in it. */
export function SampleInput({
  assetId,
  onAsset,
  transcript,
  onTranscript,
  name,
  transcriptOptional,
  className
}: {
  assetId: ID | undefined
  onAsset: (asset: Asset | undefined) => void
  transcript?: string
  onTranscript?: (text: string) => void
  name?: string
  /** Hide the "timbre only" warning (ElevenLabs doesn't need a transcript). */
  transcriptOptional?: boolean
  className?: string
}): React.JSX.Element {
  const asset = useDoc('assets', assetId)
  const rec = useRecorder(30)
  const [picker, setPicker] = useState(false)
  const [script, setScript] = useState(() => READ_ALOUD[Math.floor(Math.random() * READ_ALOUD.length)])

  const finish = async (): Promise<void> => {
    const out = await rec.stop()
    if (!out) return
    if (out.duration < 1.5) {
      toast.error('That was very short', 'Record at least a few seconds of speech.')
      return
    }
    const saved = await invoke('assets:saveBytes', out.bytes, 'audio', 'wav', { source: 'imported', name: `${name ?? 'Voice'} sample`, tags: ['voice-sample'], duration: out.duration })
    onAsset(saved)
    onTranscript?.(script)
  }

  const recording = rec.state !== 'idle'
  const tooLong = (asset?.duration ?? 0) > 25
  return (
    <div className={cn('flex flex-col gap-2.5', className)}>
      <AnimatePresence initial={false}>
        {recording && (
          <motion.div
            key="script"
            initial={{ opacity: 0, y: -6, filter: 'blur(4px)' }}
            animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            exit={{ opacity: 0, y: -4, filter: 'blur(4px)' }}
            transition={{ duration: 0.35, ease }}
            className="rounded-xl border border-line bg-white/[0.03] px-3.5 py-3"
          >
            <div className="label-caps mb-1.5 flex items-center justify-between">
              Read this aloud
              <button className="text-[10.5px] font-semibold tracking-wide text-accent hover:brightness-125" onClick={() => setScript(READ_ALOUD[(READ_ALOUD.indexOf(script) + 1) % READ_ALOUD.length])}>
                ANOTHER LINE
              </button>
            </div>
            <p className="font-serif text-[15px] leading-relaxed text-fg">{script}</p>
          </motion.div>
        )}
      </AnimatePresence>

      <DropZone kinds={['audio']} onAssets={(a) => a[0] && onAsset(a[0])} className="rounded-2xl">
        <AnimatePresence mode="wait" initial={false}>
          {recording ? (
            <motion.div
              key="rec"
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.98 }}
              transition={springSoft}
              className="glass-strong flex h-12 items-center gap-3 rounded-full pr-1.5 pl-4"
            >
              <span className="relative flex size-2.5 shrink-0">
                <span className="absolute inset-0 animate-ping rounded-full bg-danger opacity-60" />
                <span className="relative size-2.5 rounded-full bg-danger" />
              </span>
              <span className="w-[92px] shrink-0 text-[12px] font-medium text-fg-2">
                {rec.state === 'processing' ? 'Processing…' : 'Recording…'} <span className="font-mono text-fg-3 tabular-nums">{fmtSecs(rec.elapsed)}</span>
              </span>
              <LiveWave analyser={rec.analyser} className="min-w-0 flex-1" />
              <IconButton label="Discard" size="sm" onClick={rec.cancel} className="rounded-full">
                <X className="size-3.5" />
              </IconButton>
              <motion.button
                whileTap={{ scale: 0.9 }}
                onClick={() => void finish()}
                disabled={rec.state === 'processing'}
                aria-label="Stop and use"
                title="Stop and use"
                className="grid size-9 place-items-center rounded-full bg-grad text-white shadow-[0_6px_18px_-6px_color-mix(in_oklab,var(--accent)_80%,transparent)]"
              >
                {rec.state === 'processing' ? <Spinner className="size-3.5" /> : <Square className="size-3 fill-current" />}
              </motion.button>
            </motion.div>
          ) : asset ? (
            <motion.div
              key={asset.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.3, ease }}
              className="group relative rounded-2xl border border-line bg-white/[0.03] px-3 py-2.5"
            >
              <div className="mb-1.5 flex items-center gap-2 pr-7">
                <AudioLines className="size-3.5 shrink-0 text-accent" />
                <span className="truncate text-[12px] font-medium">{asset.name}</span>
                {tooLong && <Badge tone="warning">Long clip · 5–20 s is ideal</Badge>}
              </div>
              <WavePlayer src={fileUrl(asset.path)} seed={asset.id} duration={asset.duration} size="sm" height={28} />
              <div className="absolute top-2 right-2 flex gap-1 opacity-0 transition group-hover:opacity-100">
                <IconButton label="Replace" size="xs" onClick={() => setPicker(true)}>
                  <FolderOpen className="size-3" />
                </IconButton>
                <IconButton label="Remove sample" size="xs" onClick={() => onAsset(undefined)}>
                  <X className="size-3" />
                </IconButton>
              </div>
            </motion.div>
          ) : (
            <motion.div
              key="empty"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.25 }}
              className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-line-strong bg-white/[0.015] px-4 py-5 text-center"
            >
              <div className="flex gap-2">
                <Button size="sm" variant="primary" icon={<Mic className="size-3.5" />} onClick={() => void rec.start()}>
                  Record
                </Button>
                <Button size="sm" icon={<FolderOpen className="size-3.5" />} onClick={() => setPicker(true)}>
                  Choose clip
                </Button>
              </div>
              <div className="text-[11.5px] text-fg-3">or drop an audio file · 5–20 seconds of clean speech works best</div>
            </motion.div>
          )}
        </AnimatePresence>
      </DropZone>
      {rec.error && <div className="text-[11.5px] text-danger">{rec.error}</div>}

      {onTranscript && (
        <Field
          label="Transcript"
          help={
            transcriptOptional ? undefined : transcript?.trim() ? (
              'Exact words spoken in the clip — this gives the closest likeness.'
            ) : (
              <span className="text-warning/90">Without a transcript only the timbre is cloned. Type the exact words for the best match.</span>
            )
          }
        >
          <Textarea value={transcript ?? ''} onChange={(e) => onTranscript(e.target.value)} placeholder="What is said in the sample, word for word…" minRows={2} maxRows={5} />
        </Field>
      )}
      <AssetPicker open={picker} onClose={() => setPicker(false)} kinds={['audio']} onPick={(a) => a[0] && onAsset(a[0])} title="Choose a voice sample" />
    </div>
  )
}

// ─── Voice design ────────────────────────────────────────────────────────────

/** Describe a voice → generate a sample with Qwen3-TTS VoiceDesign. */
export function DesignForm({
  initial,
  language,
  name,
  characterIds,
  onDesigned,
  result,
  actions,
  className
}: {
  initial?: string
  language?: string
  name?: string
  characterIds?: ID[]
  onDesigned: (asset: Asset, meta: { design: string; sampleText: string }) => void
  /** The most recent designed sample to show with a player. */
  result?: Asset
  actions?: (asset: Asset) => ReactNode
  className?: string
}): React.JSX.Element {
  const [desc, setDesc] = useState(initial ?? '')
  const [line, setLine] = useState(DEFAULT_PREVIEW_LINE)
  const [busy, setBusy] = useState(false)
  const [justMade, setJustMade] = useState<ID>()
  const notify = useNotifyEngine()
  const generate = async (): Promise<void> => {
    if (!desc.trim()) return
    setBusy(true)
    try {
      const asset = await invoke('voice:design', { description: desc.trim(), text: line.trim() || DEFAULT_PREVIEW_LINE, language, name: name ? `${name} voice` : undefined, characterIds })
      setJustMade(asset.id)
      onDesigned(asset, { design: desc.trim(), sampleText: line.trim() || DEFAULT_PREVIEW_LINE })
    } catch (err) {
      notify(err, 'Voice design failed')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <Field label="Describe the voice">
        <Textarea
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          placeholder="Age, gender, accent, texture, pace, mood — e.g. a husky, amused woman in her fifties with a slow Southern drawl"
          minRows={2}
          maxRows={6}
        />
      </Field>
      <div className="-mt-1 flex flex-wrap gap-1.5">
        {DESIGN_IDEAS.map((idea) => (
          <button
            key={idea.label}
            title={idea.text}
            onClick={() => setDesc(idea.text)}
            className={cn(
              'rounded-full border px-2.5 py-1 text-[11px] transition',
              desc === idea.text ? 'border-[color-mix(in_oklab,var(--accent)_45%,transparent)] bg-[color-mix(in_oklab,var(--accent)_12%,transparent)] text-fg' : 'border-line bg-white/[0.03] text-fg-2 hover:border-line-strong hover:bg-white/[0.07] hover:text-fg'
            )}
          >
            {idea.label}
          </button>
        ))}
      </div>
      <Field label="Sample line" help="Becomes the reference clip — the voice is cloned from it everywhere after.">
        <Input value={line} onChange={(e) => setLine(e.target.value)} />
      </Field>
      <Button variant="primary" icon={<Wand2 className="size-3.5" />} loading={busy} disabled={!desc.trim()} onClick={() => void generate()}>
        {busy ? 'Designing voice…' : result ? 'Design again' : 'Design voice'}
      </Button>
      <AnimatePresence mode="wait">
        {result && (
          <motion.div
            key={result.id}
            initial={{ opacity: 0, y: 8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4 }}
            transition={springSoft}
            className="rounded-2xl border border-[color-mix(in_oklab,var(--accent)_30%,transparent)] bg-[color-mix(in_oklab,var(--accent)_6%,transparent)] p-3"
          >
            <WavePlayer src={fileUrl(result.path)} seed={result.id} duration={result.duration} autoPlay={result.id === justMade} />
            {actions && <div className="mt-2.5 flex flex-wrap gap-2">{actions(result)}</div>}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ─── Pieces ──────────────────────────────────────────────────────────────────

export function ProviderIcon({ kind, className }: { kind: VoiceConnector['kind']; className?: string }): React.JSX.Element {
  if (kind === 'local-qwen') return <Cpu className={className} />
  if (kind === 'local-kokoro') return <Feather className={className} />
  if (kind === 'local-pocket') return <Zap className={className} />
  if (kind === 'elevenlabs')
    return (
      <svg viewBox="0 0 16 16" className={className} fill="currentColor">
        <rect x="4.2" y="2" width="2.4" height="12" rx="1" />
        <rect x="9.4" y="2" width="2.4" height="12" rx="1" />
      </svg>
    )
  if (kind === 'openai-tts') return <Sparkles className={className} />
  return <Cloud className={className} />
}

function ProviderChips({ connectors, value, onChange }: { connectors: VoiceConnector[]; value: ID | undefined; onChange: (id: ID) => void }): React.JSX.Element {
  const id = useId()
  return (
    <div className="flex flex-wrap gap-1.5">
      {connectors.map((c) => {
        const active = c.id === value
        return (
          <button
            key={c.id}
            onClick={() => onChange(c.id)}
            className={cn('relative flex h-8 items-center gap-1.5 rounded-full px-3 text-[12px] font-medium transition-colors duration-200', active ? 'text-fg' : 'text-fg-3 hover:text-fg-2')}
          >
            {active && (
              <motion.span
                layoutId={`prov-${id}`}
                transition={spring}
                className="absolute inset-0 rounded-full border border-[color-mix(in_oklab,var(--accent)_45%,transparent)] bg-[color-mix(in_oklab,var(--accent)_13%,transparent)]"
              />
            )}
            {!active && <span className="absolute inset-0 rounded-full border border-line bg-white/[0.03]" />}
            <ProviderIcon kind={c.kind} className={cn('relative size-3.5', active && 'text-accent')} />
            <span className="relative">{c.kind.startsWith('local-') ? VOICE_KIND_LABEL[c.kind] : c.name || VOICE_KIND_LABEL[c.kind]}</span>
          </button>
        )
      })}
    </div>
  )
}

function VoiceRow({
  v,
  active,
  layoutGroup,
  onSelect,
  preview,
  chips: chipsProp
}: {
  v: VoiceInfo
  active: boolean
  layoutGroup: string
  onSelect: () => void
  preview: ReactNode
  chips?: (string | undefined)[]
}): React.JSX.Element {
  const chips = (chipsProp ?? [v.labels?.gender, v.labels?.accent ?? v.labels?.locale, v.labels?.age, v.cloned ? 'custom' : undefined]).filter(Boolean).slice(0, 3) as string[]
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onSelect()}
      className={cn('group relative flex w-full cursor-default items-center gap-3 rounded-[10px] px-2.5 py-2 text-left outline-none', !active && 'hover:bg-white/[0.04]')}
    >
      {active && (
        <motion.span
          layoutId={layoutGroup}
          transition={spring}
          className="absolute inset-0 rounded-[10px] border border-[color-mix(in_oklab,var(--accent)_35%,transparent)] bg-[color-mix(in_oklab,var(--accent)_9%,transparent)]"
        />
      )}
      <span className={cn('relative grid size-4 shrink-0 place-items-center rounded-full border transition-colors', active ? 'border-transparent bg-grad' : 'border-line-strong')}>
        {active && <Check className="size-2.5 text-white" strokeWidth={3.5} />}
      </span>
      <div className="relative min-w-0 flex-1">
        <div className="truncate text-[12.5px] font-medium">{v.name}</div>
        {v.description && <div className="truncate text-[11px] text-fg-3">{v.description}</div>}
      </div>
      <div className="relative hidden shrink-0 gap-1 sm:flex">
        {chips.map((c) => (
          <Badge key={c} className="capitalize">
            {c}
          </Badge>
        ))}
      </div>
      <span className="relative">{preview}</span>
    </div>
  )
}

function ListSkeleton(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5 p-1">
      {Array.from({ length: 5 }, (_, i) => (
        <Skeleton key={i} className="h-10" />
      ))}
    </div>
  )
}

// ─── Provider bodies ─────────────────────────────────────────────────────────

function CloudBody({
  connector,
  value,
  set,
  lab,
  name,
  previewText
}: {
  connector: VoiceConnector
  value: CharacterVoice | undefined
  set: (patch: Partial<CharacterVoice>) => void
  lab: boolean
  name?: string
  previewText?: string
}): React.JSX.Element {
  const { voices, loading, error, refresh } = useVoices(connector.id)
  const [q, setQ] = useState('')
  const [cloneOpen, setCloneOpen] = useState(false)
  const [cloneSample, setCloneSample] = useState<ID | undefined>(value?.sampleAssetId)
  const [cloneName, setCloneName] = useState(name ?? '')
  const [cloning, setCloning] = useState(false)
  const group = useId()
  const needle = q.trim().toLowerCase()
  const filtered = useMemo(
    () =>
      voices
        .filter((v) => !needle || `${v.name} ${v.id} ${v.description ?? ''} ${Object.values(v.labels ?? {}).join(' ')}`.toLowerCase().includes(needle))
        .slice(0, 160),
    [voices, needle]
  )
  const isEleven = connector.kind === 'elevenlabs'
  const orphanSample = isEleven && value?.sampleAssetId && !value.voiceId

  const clone = async (): Promise<void> => {
    if (!cloneSample) return
    setCloning(true)
    try {
      const { voiceId } = await invoke('voice:clone', { connectorId: connector.id, name: cloneName.trim() || name || 'Stitch voice', sampleAssetId: cloneSample })
      set({ voiceId, sampleAssetId: cloneSample })
      refresh()
      setCloneOpen(false)
      toast.success('Voice cloned', `Added to your ElevenLabs voices`)
    } catch (err) {
      toast.error('Cloning failed', errorText(err))
    } finally {
      setCloning(false)
    }
  }

  return (
    <div className="flex flex-col gap-2.5">
      {orphanSample && !cloneOpen && (
        <div className="flex items-center gap-3 rounded-xl border border-warning/25 bg-warning/[0.07] px-3 py-2 text-[12px] text-fg-2">
          <span className="flex-1">This voice has a local sample. Clone it into ElevenLabs to use it here.</span>
          <Button size="xs" variant="secondary" onClick={() => setCloneOpen(true)}>
            Clone it
          </Button>
        </div>
      )}
      <div className="flex gap-2">
        <SearchField value={q} onChange={setQ} placeholder={`Search ${voices.length || ''} voices`} className="flex-1" />
        <IconButton label="Refresh voices" variant="secondary" onClick={refresh}>
          <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
        </IconButton>
      </div>
      {error && <div className="rounded-xl border border-danger/25 bg-danger/[0.07] px-3 py-2 text-[12px] text-danger">{error}</div>}
      <div className="scroll-fade max-h-[292px] overflow-y-auto rounded-xl border border-line bg-white/[0.02] p-1">
        {loading && !voices.length ? (
          <ListSkeleton />
        ) : filtered.length ? (
          filtered.map((v) => (
            <VoiceRow
              key={v.id}
              v={v}
              layoutGroup={`row-${group}`}
              active={value?.voiceId === v.id}
              onSelect={() => set({ voiceId: v.id })}
              preview={<VoicePreviewButton size="xs" voice={{ ...value, voiceId: v.id }} connectorId={connector.id} previewUrl={v.previewUrl} text={previewText} />}
            />
          ))
        ) : (
          <div className="px-3 py-8 text-center text-[12px] text-fg-3">{voices.length ? 'No voices match' : 'No voices yet'}</div>
        )}
      </div>
      {isEleven && lab && (
        <div className="rounded-xl border border-line bg-white/[0.02]">
          <button onClick={() => setCloneOpen((o) => !o)} className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-[12.5px] font-medium text-fg-2 hover:text-fg">
            <Mic className="size-3.5 text-accent" />
            <span className="flex-1">Clone a voice into ElevenLabs</span>
            <motion.span animate={{ rotate: cloneOpen ? 45 : 0 }} transition={spring} className="text-fg-3">
              +
            </motion.span>
          </button>
          <AnimatePresence initial={false}>
            {cloneOpen && (
              <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.3, ease }} className="overflow-hidden">
                <div className="flex flex-col gap-2.5 border-t border-line p-3">
                  <SampleInput assetId={cloneSample} onAsset={(a) => setCloneSample(a?.id)} name={name} transcriptOptional />
                  <div className="flex gap-2">
                    <Input value={cloneName} onChange={(e) => setCloneName(e.target.value)} placeholder="Voice name" className="flex-1" />
                    <Button variant="primary" disabled={!cloneSample} loading={cloning} onClick={() => void clone()}>
                      Clone
                    </Button>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}
      {!isEleven && value?.sampleAssetId && (
        <div className="text-[11px] text-fg-3">The saved voice sample is kept for video voice references.</div>
      )}
    </div>
  )
}

type LocalMode = 'clone' | 'design' | 'library'

function LocalBody({
  connector,
  value,
  set,
  lab,
  name,
  characterIds
}: {
  connector: VoiceConnector
  value: CharacterVoice | undefined
  set: (patch: Partial<CharacterVoice>) => void
  lab: boolean
  name?: string
  characterIds?: ID[]
}): React.JSX.Element {
  const initial: LocalMode = !lab ? 'library' : value?.sampleAssetId ? (value.design ? 'design' : 'clone') : value?.design ? 'design' : value?.voiceId ? 'library' : 'clone'
  const [mode, setMode] = useState<LocalMode>(initial)
  const { voices, loading } = useVoices(connector.id)
  const speakers = voices.filter((v) => !v.id.startsWith('clone:'))
  const presets = useVoicePresets()
  const sample = useDoc('assets', value?.sampleAssetId)
  const group = useId()

  return (
    <div className="flex flex-col gap-3">
      {lab && (
        <Segmented<LocalMode>
          value={mode}
          onChange={setMode}
          size="sm"
          className="self-start"
          items={[
            { value: 'clone', label: 'Clone', icon: <Mic /> },
            { value: 'design', label: 'Design', icon: <Wand2 /> },
            { value: 'library', label: 'Voices', icon: <AudioLines /> }
          ]}
        />
      )}
      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={mode} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.22, ease }}>
          {mode === 'clone' && (
            <SampleInput
              assetId={value?.sampleAssetId}
              onAsset={(a) => set({ sampleAssetId: a?.id, voiceId: undefined, design: undefined, sampleText: a ? value?.sampleText : undefined })}
              transcript={value?.sampleText}
              onTranscript={(t) => set({ sampleText: t })}
              name={name}
            />
          )}
          {mode === 'design' && (
            <DesignForm
              initial={value?.design}
              language={value?.language}
              name={name}
              characterIds={characterIds}
              result={value?.design && sample ? sample : undefined}
              onDesigned={(asset, meta) => set({ sampleAssetId: asset.id, sampleText: meta.sampleText, design: meta.design, voiceId: undefined })}
            />
          )}
          {mode === 'library' && (
            <div className="scroll-fade flex max-h-[320px] flex-col gap-1 overflow-y-auto rounded-xl border border-line bg-white/[0.02] p-1">
              {presets.length > 0 && <div className="label-caps px-2.5 pt-2 pb-1">Saved voices</div>}
              {presets.map((a) => {
                const p = presetMeta(a) ?? {}
                const v: VoiceInfo = { id: `clone:${a.id}`, name: p.name || a.name, description: p.design || (p.sampleText ? `“${p.sampleText}”` : 'Cloned voice'), cloned: true }
                const pv = voiceFromPreset(a, connector.id)
                return (
                  <VoiceRow
                    key={a.id}
                    v={v}
                    layoutGroup={`row-${group}`}
                    active={value?.sampleAssetId === a.id}
                    onSelect={() => set({ ...pv, voiceId: undefined })}
                    preview={<VoicePreviewButton size="xs" voice={pv} connectorId={connector.id} />}
                  />
                )
              })}
              <div className="label-caps px-2.5 pt-2 pb-1">Built-in speakers</div>
              {loading && !speakers.length ? (
                <ListSkeleton />
              ) : (
                speakers.map((v) => (
                  <VoiceRow
                    key={v.id}
                    v={v}
                    layoutGroup={`row-${group}`}
                    active={!value?.sampleAssetId && value?.voiceId === v.id}
                    onSelect={() => set({ voiceId: v.id, sampleAssetId: undefined, sampleText: undefined, design: undefined })}
                    preview={<VoicePreviewButton size="xs" voice={{ voiceId: v.id, language: value?.language }} connectorId={connector.id} />}
                  />
                ))
              )}
            </div>
          )}
        </motion.div>
      </AnimatePresence>
      <div className="flex items-center gap-3">
        <span className="label-caps shrink-0">Language</span>
        <Select
          size="sm"
          className="w-40"
          value={value?.language ?? 'Auto'}
          onChange={(l) => set({ language: l === 'Auto' ? undefined : l })}
          options={VOICE_LANGUAGES.map((l) => ({ value: l, label: l === 'Auto' ? 'Auto-detect' : l }))}
        />
      </div>
    </div>
  )
}

// ─── Engines ─────────────────────────────────────────────────────────────────

const ENGINE_BLURB: Record<string, string> = {
  qwen3: 'Clone · design · 10 langs',
  kokoro: '49 voices · 8 languages',
  pocket: 'CPU · cloning · 7 languages',
  elevenlabs: 'Voice library · cloning',
  openai: '13 steerable voices',
  azure: '400+ neural voices'
}

/** Engine info for a connector kind (from `voice:engines`). */
export function useEngineForKind(kind: VoiceConnector['kind'] | undefined): VoiceEngineInfo | undefined {
  const engines = useVoiceEngines()
  return kind ? engines?.find((e) => e.connectorKind === kind) : undefined
}

async function installEngine(engine: VoiceEngineInfo): Promise<void> {
  try {
    await invoke('voice:installEngine', engine.id)
    toast.success(`${engine.name} installed`, 'Voice weights download the first time you use it.')
  } catch (err) {
    const msg = errorText(err)
    if (msg !== 'Install canceled') toast.error(`Couldn't install ${engine.name}`, msg)
  }
}

/** Status line for an engine: ready / installing 40% / install / needs API key. */
export function engineStatusText(engine: VoiceEngineInfo, progress?: { label: string; value?: number }): { text: string; tone: 'ready' | 'busy' | 'idle' | 'warn' } {
  if (engine.installing || progress) return { text: progress?.value !== undefined ? `Installing · ${Math.round(progress.value * 100)}%` : 'Installing…', tone: 'busy' }
  if (engine.kind === 'cloud') return engine.installed ? { text: 'Connected', tone: 'ready' } : { text: engine.connectorId ? 'Needs API key' : 'Not connected', tone: 'warn' }
  if (engine.installed) return { text: engine.device === 'cpu' ? 'Ready · CPU' : 'Ready · GPU', tone: 'ready' }
  return { text: `Install · ${approxSize(engine.downloadBytes)}`, tone: 'idle' }
}

/** Install prompt for a local engine that isn't installed yet (or the key prompt for a cloud one). */
export function EngineGate({ engine, className }: { engine: VoiceEngineInfo; className?: string }): React.JSX.Element {
  const status = useVoiceEngine()
  const engines = useVoiceEngines()
  const navigate = useNavigate()
  const [pending, setPending] = useState(false)
  const progress = engineProgress(status, engine.id)
  const runtimeReady = !!engines?.some((e) => e.kind === 'local' && e.installed)
  const queued = pending && !progress && status?.busy === 'installing'
  const install = async (): Promise<void> => {
    setPending(true)
    await installEngine(engine)
    setPending(false)
  }
  const kind = engine.connectorKind
  return (
    <div className={cn('relative overflow-hidden rounded-2xl border border-[color-mix(in_oklab,var(--accent)_22%,transparent)] bg-[color-mix(in_oklab,var(--accent)_4%,transparent)] p-4', className)}>
      <div className="pointer-events-none absolute -top-16 -right-10 size-44 rounded-full bg-grad opacity-[0.08] blur-3xl" />
      <div className="relative flex items-start gap-3">
        <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-grad-soft ring-1 ring-line">
          <ProviderIcon kind={kind} className="size-4 text-fg" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold tracking-tight">
            {engine.kind === 'cloud' ? `Connect ${engine.name}` : progress ? `Installing ${engine.name}…` : `${engine.name} isn't installed yet`}
          </div>
          <p className="mt-0.5 text-[12px] text-fg-3">{engine.description}</p>
          {engine.kind === 'local' && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Badge tone="outline">
                <HardDrive className="size-3" /> {approxSize(engine.downloadBytes)}
                {!runtimeReady && ' + shared runtime'}
              </Badge>
              <Badge tone="outline">{engine.device === 'cpu' ? 'Runs on the CPU' : 'Runs on your voice GPU'}</Badge>
              {engine.license && <Badge tone="outline">{engine.license}</Badge>}
              {engine.supportsCloning && <Badge tone="accent">Voice cloning</Badge>}
            </div>
          )}
        </div>
      </div>
      <div className="relative mt-3.5">
        <AnimatePresence mode="wait" initial={false}>
          {engine.kind === 'cloud' ? (
            <motion.div key="key" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex items-center gap-3">
              <Button size="sm" variant="primary" icon={<KeyRound className="size-3.5" />} onClick={() => navigate('/connectors')}>
                Add API key
              </Button>
              <span className="text-[11.5px] text-fg-3">Keys are stored encrypted on this PC.</span>
            </motion.div>
          ) : progress || queued ? (
            <motion.div key="progress" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.25, ease }} className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-3 text-[11.5px] text-fg-2">
                <motion.span key={progress?.label} initial={{ opacity: 0, x: -4 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.25, ease }} className="truncate">
                  {progress?.label ?? 'Waiting for another install to finish…'}
                </motion.span>
                {progress?.value !== undefined && <span className="shrink-0 font-mono tabular-nums">{Math.round(progress.value * 100)}%</span>}
              </div>
              <ProgressBar value={progress?.value} />
            </motion.div>
          ) : (
            <motion.div key="install" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex flex-wrap items-center gap-3">
              <Button size="sm" variant="primary" icon={<Download className="size-3.5" />} loading={pending} onClick={() => void install()}>
                Install {engine.name}
              </Button>
              <span className="text-[11.5px] text-fg-3">
                {runtimeReady ? 'Adds to Stitch’s voice environment — weights download on first use.' : 'First local engine: also sets up Stitch’s Python + PyTorch runtime (≈3 GB with CUDA).'}
              </span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}

/** Confirm, then delete a local engine's Stitch-managed files (`voice:removeEngine`). */
export function RemoveEngineDialog({ engine, open, onOpenChange }: { engine: VoiceEngineInfo; open: boolean; onOpenChange: (open: boolean) => void }): React.JSX.Element {
  const engines = useVoiceEngines()
  const [removing, setRemoving] = useState(false)
  const notify = useNotifyEngine()
  const lastLocal = (engines ?? []).filter((e) => e.kind === 'local' && e.installed).length === 1
  const remove = async (): Promise<void> => {
    setRemoving(true)
    try {
      await invoke('voice:removeEngine', engine.id)
      toast.success(`${engine.name} removed`, lastLocal ? 'Its files and the shared voice runtime were deleted.' : 'Its packages and downloaded voices were deleted.')
      onOpenChange(false)
    } catch (err) {
      notify(err, `Couldn't remove ${engine.name}`)
    } finally {
      setRemoving(false)
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !removing && onOpenChange(o)}
      title={`Remove ${engine.name}?`}
      width={440}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={removing}>
            Cancel
          </Button>
          <Button variant="danger" icon={<Trash2 className="size-3.5" />} loading={removing} onClick={() => void remove()}>
            Remove
          </Button>
        </>
      }
    >
      <div className="space-y-3 p-5 text-[12.5px] text-fg-2">
        <p>
          Deletes {engine.name}’s packages and downloaded voices from Stitch’s folder — about <span className="font-medium text-fg">{sizeLabel(engine.sizeBytes)}</span>. Clips you already generated stay in your library, and you can reinstall any time.
        </p>
        {lastLocal && (
          <p className="rounded-xl border border-warning/25 bg-warning/[0.07] px-3 py-2 text-[12px]">
            This is the last local voice engine, so Stitch’s shared Python runtime{engine.runtimeBytes ? ` (${sizeLabel(engine.runtimeBytes)})` : ''} is removed too.
          </p>
        )}
      </div>
    </Dialog>
  )
}

/** Engine cards: the obvious "which engine speaks" choice, with install / key status. */
export function EngineCards({
  value,
  onSelect,
  className
}: {
  /** Connector kind currently in use. */
  value: VoiceConnector['kind'] | undefined
  onSelect: (engine: VoiceEngineInfo) => void
  className?: string
}): React.JSX.Element {
  const engines = useVoiceEngines()
  const status = useVoiceEngine()
  const group = useId()
  const shown = (engines ?? []).filter((e) => e.kind === 'local' || e.id === 'elevenlabs' || e.connectorId)
  if (!engines) {
    return (
      <div className={cn('grid grid-cols-2 gap-2 sm:grid-cols-4', className)}>
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-[92px] rounded-2xl" />
        ))}
      </div>
    )
  }
  return (
    <div className={cn('grid gap-2', shown.length > 4 ? 'grid-cols-2 sm:grid-cols-3' : 'grid-cols-2 sm:grid-cols-4', className)}>
      {shown.map((e) => {
        const active = e.connectorKind === value
        const progress = engineProgress(status, e.id)
        const st = engineStatusText(e, progress)
        return (
          <motion.button
            key={e.id}
            data-engine={e.id}
            layout
            whileTap={{ scale: 0.98 }}
            transition={spring}
            onClick={() => onSelect(e)}
            className={cn('group relative flex min-w-0 flex-col gap-2 overflow-hidden rounded-2xl p-3 text-left transition-colors duration-200', !active && 'hover:bg-white/[0.035]')}
          >
            {active ? (
              <motion.span
                layoutId={`engine-${group}`}
                transition={spring}
                className="absolute inset-0 rounded-2xl border border-[color-mix(in_oklab,var(--accent)_50%,transparent)] bg-[color-mix(in_oklab,var(--accent)_10%,transparent)] shadow-[0_10px_30px_-18px_color-mix(in_oklab,var(--accent)_90%,transparent)]"
              />
            ) : (
              <span className="absolute inset-0 rounded-2xl border border-line bg-white/[0.02]" />
            )}
            <div className="relative flex items-center gap-2">
              <span className={cn('grid size-7 shrink-0 place-items-center rounded-lg ring-1 ring-line transition-colors', active ? 'bg-grad text-white ring-transparent' : 'bg-white/[0.05] text-fg-2')}>
                <ProviderIcon kind={e.connectorKind} className="size-3.5" />
              </span>
              <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold tracking-tight">{e.name}</span>
              <span className="shrink-0 text-[9.5px] font-semibold tracking-[0.08em] text-fg-3 uppercase">{e.kind === 'local' ? 'Local' : 'Cloud'}</span>
            </div>
            <div className="relative truncate text-[11px] text-fg-3">{ENGINE_BLURB[e.id] ?? e.description}</div>
            <div className="relative flex items-center gap-1.5 text-[10.5px] font-medium">
              <span
                className={cn(
                  'size-1.5 shrink-0 rounded-full',
                  st.tone === 'ready' && 'bg-success',
                  st.tone === 'busy' && 'animate-pulse bg-accent',
                  st.tone === 'warn' && 'bg-warning',
                  st.tone === 'idle' && 'bg-fg-3'
                )}
              />
              <span className={cn('truncate', st.tone === 'ready' ? 'text-fg-2' : st.tone === 'warn' ? 'text-warning/90' : st.tone === 'busy' ? 'text-accent' : 'text-fg-3')}>{st.text}</span>
            </div>
            {progress?.value !== undefined && (
              <motion.div className="absolute inset-x-3 bottom-0 h-[2px] origin-left rounded-full bg-grad" initial={{ scaleX: 0 }} animate={{ scaleX: progress.value }} transition={{ duration: 0.4, ease }} />
            )}
          </motion.button>
        )
      })}
    </div>
  )
}

// ─── Kokoro ──────────────────────────────────────────────────────────────────

function KokoroBody({ connector, value, set, previewText }: { connector: VoiceConnector; value: CharacterVoice | undefined; set: (patch: Partial<CharacterVoice>) => void; previewText?: string }): React.JSX.Element {
  const { voices, loading } = useVoices(connector.id)
  const current = value?.voiceId && /^[a-z]{2}_/.test(value.voiceId) ? value.voiceId.split(',')[0] : undefined
  const [lang, setLang] = useState(current?.[0] ?? 'a')
  const group = useId()
  const counts = useMemo(() => {
    const m: Record<string, number> = {}
    for (const v of voices) m[v.labels?.lang ?? ''] = (m[v.labels?.lang ?? ''] ?? 0) + 1
    return m
  }, [voices])
  const list = voices.filter((v) => v.labels?.lang === lang)
  const langLabel = KOKORO_LANGUAGES.find((l) => l.code === lang)?.label
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-1.5">
        {KOKORO_LANGUAGES.map((l) => (
          <Chip key={l.code} active={lang === l.code} onClick={() => setLang(l.code)} className="h-7 rounded-full">
            {l.short}
            {counts[l.code] ? <span className="text-[10.5px] text-fg-3 tabular-nums">{counts[l.code]}</span> : null}
          </Chip>
        ))}
      </div>
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={lang}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.22, ease }}
          className="scroll-fade flex max-h-[320px] flex-col gap-1 overflow-y-auto rounded-xl border border-line bg-white/[0.02] p-1"
        >
          {loading && !voices.length ? (
            <ListSkeleton />
          ) : (
            list.map((v) => (
              <VoiceRow
                key={v.id}
                v={v}
                layoutGroup={`row-${group}`}
                active={current === v.id}
                chips={[v.labels?.gender, v.labels?.grade ? `grade ${v.labels.grade}` : undefined]}
                onSelect={() => set({ voiceId: v.id, sampleAssetId: value?.sampleAssetId, design: undefined, language: undefined })}
                preview={<VoicePreviewButton size="xs" voice={{ voiceId: v.id }} connectorId={connector.id} text={previewText ?? previewLine(langLabel)} />}
              />
            ))
          )}
        </motion.div>
      </AnimatePresence>
      <p className="text-[11px] text-fg-3">Kokoro speaks the language of the voice you pick. It reads delivery notes only as pace — slow or fast.</p>
    </div>
  )
}

// ─── Pocket TTS ──────────────────────────────────────────────────────────────

/** Kyutai gates Pocket TTS's cloning weights: accept the terms, then save a Hugging Face token. */
function PocketCloningNotice({ connector }: { connector: VoiceConnector }): React.JSX.Element | null {
  const engine = useEngineForKind('local-pocket')
  const [token, setToken] = useState('')
  const [saving, setSaving] = useState(false)
  if (engine?.cloningReady) return null
  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await invoke('connectors:save', connector, token.trim())
      setToken('')
      toast.success('Token saved', 'Pocket TTS fetches the cloning weights on its next clone.')
    } catch (err) {
      toast.error('Could not save the token', errorText(err))
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className="rounded-xl border border-line bg-white/[0.025] px-3.5 py-3 text-[12px] text-fg-2">
      <div className="flex items-start gap-2.5">
        <KeyRound className="mt-0.5 size-3.5 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <div className="font-medium text-fg">{connector.hasKey ? 'Hugging Face token saved' : 'Cloning needs Kyutai’s gated weights'}</div>
          <p className="mt-0.5 text-[11.5px] text-fg-3">
            {connector.hasKey
              ? 'The cloning weights download the first time you clone. If it still fails, make sure you accepted the terms for kyutai/pocket-tts with that account.'
              : 'Preset voices work right away. To clone, accept the terms for kyutai/pocket-tts on Hugging Face, then paste a read token — it’s stored encrypted on this PC.'}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button size="xs" variant="ghost" icon={<ExternalLink className="size-3" />} onClick={() => void invoke('sys:openExternal', 'https://huggingface.co/kyutai/pocket-tts')}>
              Accept terms
            </Button>
            <Button size="xs" variant="ghost" icon={<ExternalLink className="size-3" />} onClick={() => void invoke('sys:openExternal', 'https://huggingface.co/settings/tokens')}>
              Get a token
            </Button>
          </div>
          <div className="mt-2 flex gap-2">
            <Input type="password" icon={<KeyRound />} value={token} onChange={(e) => setToken(e.target.value)} placeholder={connector.hasKey ? '•••••••••• (replace token)' : 'hf_…'} className="flex-1" />
            <Button size="sm" variant="secondary" disabled={!token.trim()} loading={saving} onClick={() => void save()}>
              Save
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

type PocketMode = 'library' | 'clone'

function PocketBody({ connector, value, set, lab, name, previewText }: { connector: VoiceConnector; value: CharacterVoice | undefined; set: (patch: Partial<CharacterVoice>) => void; lab: boolean; name?: string; previewText?: string }): React.JSX.Element {
  const [mode, setMode] = useState<PocketMode>(lab && value?.sampleAssetId && !value.voiceId ? 'clone' : 'library')
  const { voices, loading } = useVoices(connector.id)
  const builtIn = voices.filter((v) => !v.id.startsWith('clone:'))
  const presets = useVoicePresets()
  const group = useId()
  const language = value?.language && POCKET_LANGUAGES.includes(value.language) ? value.language : 'English'
  const line = previewText ?? previewLine(language)
  return (
    <div className="flex flex-col gap-3">
      {lab && (
        <Segmented<PocketMode>
          value={mode}
          onChange={setMode}
          size="sm"
          className="self-start"
          items={[
            { value: 'library', label: 'Voices', icon: <AudioLines /> },
            { value: 'clone', label: 'Clone', icon: <Mic /> }
          ]}
        />
      )}
      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={mode} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.22, ease }} className="flex flex-col gap-3">
          {mode === 'clone' ? (
            <>
              <SampleInput assetId={value?.sampleAssetId} onAsset={(a) => set({ sampleAssetId: a?.id, voiceId: undefined, design: undefined, sampleText: undefined })} name={name} />
              <PocketCloningNotice connector={connector} />
            </>
          ) : (
            <div className="scroll-fade flex max-h-[320px] flex-col gap-1 overflow-y-auto rounded-xl border border-line bg-white/[0.02] p-1">
              {presets.length > 0 && <div className="label-caps px-2.5 pt-2 pb-1">Saved voices · cloned</div>}
              {presets.map((a) => {
                const p = presetMeta(a) ?? {}
                const v: VoiceInfo = { id: `clone:${a.id}`, name: p.name || a.name, description: p.design || (p.sampleText ? `“${p.sampleText}”` : 'Cloned voice'), cloned: true }
                const pv = { ...voiceFromPreset(a, connector.id), language: value?.language }
                return (
                  <VoiceRow
                    key={a.id}
                    v={v}
                    layoutGroup={`row-${group}`}
                    active={!value?.voiceId && value?.sampleAssetId === a.id}
                    onSelect={() => set({ ...pv, voiceId: undefined })}
                    preview={<VoicePreviewButton size="xs" voice={pv} connectorId={connector.id} text={line} />}
                  />
                )
              })}
              <div className="label-caps px-2.5 pt-2 pb-1">Built-in voices</div>
              {loading && !builtIn.length ? (
                <ListSkeleton />
              ) : (
                builtIn.map((v) => (
                  <VoiceRow
                    key={v.id}
                    v={v}
                    layoutGroup={`row-${group}`}
                    active={value?.voiceId === v.id}
                    chips={[v.labels?.gender, v.labels?.language !== 'English' ? v.labels?.language : undefined]}
                    onSelect={() => set({ voiceId: v.id, sampleAssetId: undefined, sampleText: undefined, design: undefined })}
                    preview={<VoicePreviewButton size="xs" voice={{ voiceId: v.id, language: value?.language }} connectorId={connector.id} text={line} />}
                  />
                ))
              )}
            </div>
          )}
        </motion.div>
      </AnimatePresence>
      <div className="flex items-center gap-3">
        <span className="label-caps shrink-0">Language</span>
        <Select size="sm" className="w-40" value={language} onChange={(l) => set({ language: l === 'English' ? undefined : l })} options={POCKET_LANGUAGES.map((l) => ({ value: l, label: l }))} />
        <span className="text-[11px] text-fg-3">Every voice can speak every language.</span>
      </div>
    </div>
  )
}

// ─── ElevenLabs ──────────────────────────────────────────────────────────────

const LIB_LANGUAGES: { value: string; label: string }[] = [
  { value: '', label: 'Any language' },
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Spanish' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
  { value: 'it', label: 'Italian' },
  { value: 'pt', label: 'Portuguese' },
  { value: 'pl', label: 'Polish' },
  { value: 'nl', label: 'Dutch' },
  { value: 'hi', label: 'Hindi' },
  { value: 'ja', label: 'Japanese' },
  { value: 'ko', label: 'Korean' },
  { value: 'zh', label: 'Chinese' },
  { value: 'ar', label: 'Arabic' },
  { value: 'ru', label: 'Russian' },
  { value: 'tr', label: 'Turkish' },
  { value: 'sv', label: 'Swedish' }
]

type LibSort = 'trending' | 'usage_character_count_1y' | 'cloned_by_count' | 'created_date'

/** The public ElevenLabs voice library: search, audition the free samples, add a voice to the account and use it. */
function VoiceLibrary({ connector, value, set }: { connector: VoiceConnector; value: CharacterVoice | undefined; set: (patch: Partial<CharacterVoice>) => void }): React.JSX.Element {
  const [q, setQ] = useState('')
  const [gender, setGender] = useState('')
  const [language, setLanguage] = useState('')
  const [sort, setSort] = useState<LibSort>('trending')
  const [items, setItems] = useState<VoiceInfo[]>([])
  const [page, setPage] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [adding, setAdding] = useState<string>()
  const group = useId()

  const load = async (p: number, replace: boolean): Promise<void> => {
    setLoading(true)
    setError(undefined)
    try {
      const res = await invoke('voice:library', { connectorId: connector.id, search: q || undefined, gender: gender || undefined, language: language || undefined, sort, page: p })
      setItems((cur) => (replace ? res.voices : [...cur, ...res.voices.filter((v) => !cur.some((c) => c.id === v.id))]))
      setHasMore(res.hasMore)
      setPage(p)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    const t = window.setTimeout(() => void load(0, true), q ? 350 : 0)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connector.id, q, gender, language, sort])

  const use = async (v: VoiceInfo): Promise<void> => {
    if (value?.voiceId === v.id) return
    if (v.labels?.added || !v.ownerId) {
      set({ voiceId: v.id })
      return
    }
    setAdding(v.id)
    try {
      const { voiceId } = await invoke('voice:addLibraryVoice', { connectorId: connector.id, ownerId: v.ownerId, voiceId: v.id, name: v.name })
      forgetVoices(connector.id)
      setItems((cur) => cur.map((x) => (x.id === v.id ? { ...x, id: voiceId, labels: { ...x.labels, added: 'yes' } } : x)))
      set({ voiceId })
      toast.success(`${v.name} added`, 'It’s in your ElevenLabs voices now.')
    } catch (err) {
      toast.error(`Couldn't add ${v.name}`, errorText(err))
    } finally {
      setAdding(undefined)
    }
  }

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap gap-2">
        <SearchField value={q} onChange={setQ} placeholder="Search the voice library" className="min-w-[180px] flex-1" />
        <Select size="sm" className="w-[118px]" value={gender || 'any'} onChange={(g) => setGender(g === 'any' ? '' : g)} options={[{ value: 'any', label: 'Any gender' }, { value: 'female', label: 'Female' }, { value: 'male', label: 'Male' }, { value: 'neutral', label: 'Neutral' }]} />
        <Select size="sm" className="w-[128px]" value={language || 'any'} onChange={(l) => setLanguage(l === 'any' ? '' : l)} options={LIB_LANGUAGES.map((l) => ({ value: l.value || 'any', label: l.label }))} />
        <Select
          size="sm"
          className="w-[124px]"
          value={sort}
          onChange={(v) => setSort(v as LibSort)}
          options={[
            { value: 'trending', label: 'Trending' },
            { value: 'usage_character_count_1y', label: 'Most used' },
            { value: 'cloned_by_count', label: 'Most added' },
            { value: 'created_date', label: 'Newest' }
          ]}
        />
      </div>
      {error && <div className="rounded-xl border border-danger/25 bg-danger/[0.07] px-3 py-2 text-[12px] text-danger">{error}</div>}
      <div className="scroll-fade max-h-[320px] overflow-y-auto rounded-xl border border-line bg-white/[0.02] p-1">
        {loading && !items.length ? (
          <ListSkeleton />
        ) : items.length ? (
          <>
            {items.map((v) => (
              <VoiceRow
                key={v.id}
                v={v}
                layoutGroup={`lib-${group}`}
                active={value?.voiceId === v.id}
                chips={[v.labels?.gender, v.labels?.accent ?? v.labels?.language, v.labels?.age]}
                onSelect={() => void use(v)}
                preview={
                  <span className="flex items-center gap-1">
                    {v.previewUrl && <VoicePreviewButton size="xs" voice={{ voiceId: v.id }} connectorId={connector.id} previewUrl={v.previewUrl} />}
                    {adding === v.id ? (
                      <Spinner className="size-3.5 text-fg-3" />
                    ) : v.labels?.added || value?.voiceId === v.id ? null : (
                      <IconButton label="Add to my voices and use" size="xs" onClick={(e) => (e.stopPropagation(), void use(v))}>
                        <Plus className="size-3.5" />
                      </IconButton>
                    )}
                  </span>
                }
              />
            ))}
            {hasMore && (
              <div className="flex justify-center p-1.5">
                <Button size="xs" variant="ghost" loading={loading} onClick={() => void load(page + 1, false)}>
                  Show more
                </Button>
              </div>
            )}
          </>
        ) : (
          <div className="px-3 py-8 text-center text-[12px] text-fg-3">No library voices match</div>
        )}
      </div>
      <p className="text-[11px] text-fg-3">Samples play for free. Picking a voice adds it to your ElevenLabs account (library voices use a voice slot).</p>
    </div>
  )
}

type ElevenMode = 'mine' | 'library'

function ElevenBody(props: { connector: VoiceConnector; value: CharacterVoice | undefined; set: (patch: Partial<CharacterVoice>) => void; lab: boolean; name?: string; previewText?: string }): React.JSX.Element {
  const [mode, setMode] = useState<ElevenMode>('mine')
  return (
    <div className="flex flex-col gap-3">
      <Segmented<ElevenMode>
        value={mode}
        onChange={setMode}
        size="sm"
        className="self-start"
        items={[
          { value: 'mine', label: 'My voices', icon: <UserRound /> },
          { value: 'library', label: 'Voice library', icon: <Library /> }
        ]}
      />
      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={mode} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.22, ease }}>
          {mode === 'mine' ? <CloudBody {...props} /> : <VoiceLibrary connector={props.connector} value={props.value} set={props.set} />}
        </motion.div>
      </AnimatePresence>
    </div>
  )
}

// ─── Picker ──────────────────────────────────────────────────────────────────

export interface VoicePickerProps {
  value: CharacterVoice | undefined
  onChange: (voice: CharacterVoice) => void
  /** Line spoken by the ▶ preview. */
  previewText?: string
  /** Character (or preset) name, used to label new samples and clones. */
  name?: string
  /** Alias of `name`. */
  characterName?: string
  characterIds?: ID[]
  /** Show clone/design tools inline (Characters, Stories). The Voice studio has its own lab. */
  lab?: boolean
  /** Hide the engine chips (the Voice studio shows engine cards instead). */
  hideProviders?: boolean
  className?: string
}

export function VoicePicker({ value, onChange, previewText, name: nameProp, characterName, characterIds, lab = true, hideProviders, className }: VoicePickerProps): React.JSX.Element {
  const name = nameProp ?? characterName
  const connectors = useVoiceConnectors()
  const current = useResolvedConnector(value)
  const engine = useEngineForKind(current?.kind)
  const navigate = useNavigate()
  const sample = useDoc('assets', value?.sampleAssetId)
  const { voices: known } = useVoices(current?.id)
  const summary = describeVoice(value, sample?.name, value?.voiceId ? known.find((v) => v.id === value.voiceId)?.name : undefined)
  const set = (patch: Partial<CharacterVoice>): void => onChange({ ...(value ?? {}), connectorId: current?.id, ...patch })
  const gate = engine && !engine.installed && (engine.kind === 'local' || engine.needsKey)

  if (!connectors.length) {
    return (
      <div className={cn('flex flex-col items-center gap-3 rounded-2xl border border-dashed border-line-strong px-5 py-8 text-center', className)}>
        <AudioLines className="size-5 text-fg-3" />
        <div className="text-[13px] font-medium">No voice providers yet</div>
        <p className="max-w-xs text-[12px] text-fg-3">Install a local engine (Qwen3-TTS, Kokoro or Pocket TTS) in Generate → Voice, or add ElevenLabs, OpenAI or Azure in Connectors.</p>
        <div className="flex gap-2">
          <Button size="sm" variant="primary" onClick={() => navigate('/generate/voice')}>
            Voice engines
          </Button>
          <Button size="sm" onClick={() => navigate('/connectors')}>
            Connectors
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <div className="flex items-center gap-3 rounded-2xl border border-line bg-white/[0.03] p-2.5 pr-3">
        <div className="relative grid size-10 shrink-0 place-items-center overflow-hidden rounded-xl bg-grad-soft ring-1 ring-line">
          {current && <ProviderIcon kind={current.kind} className="size-4 text-fg" />}
        </div>
        <div className="min-w-0 flex-1">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={summary.title} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.2, ease }} className="truncate text-[13px] font-medium">
              {summary.title}
            </motion.div>
          </AnimatePresence>
          <div className="truncate text-[11px] text-fg-3">
            {current ? (current.kind.startsWith('local-') ? `${VOICE_KIND_LABEL[current.kind]} · local` : current.name || VOICE_KIND_LABEL[current.kind]) : '—'}
            {summary.kind !== 'none' && ` · ${summary.kind === 'clone' ? 'cloned' : summary.kind === 'design' ? 'designed' : 'voice'}`}
            {value?.language && ` · ${value.language}`}
          </div>
        </div>
        <VoicePreviewButton voice={value} connectorId={current?.id} text={previewText} characterIds={characterIds} size="md" />
      </div>

      {!hideProviders && connectors.length > 1 && <ProviderChips connectors={connectors} value={current?.id} onChange={(id) => onChange({ ...(value ?? {}), connectorId: id, voiceId: undefined })} />}

      {current && (
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={current.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.24, ease }} className="flex flex-col gap-3">
            {gate && <EngineGate engine={engine} />}
            {current.kind === 'local-qwen' ? (
              <LocalBody connector={current} value={value} set={set} lab={lab} name={name} characterIds={characterIds} />
            ) : current.kind === 'local-kokoro' ? (
              <KokoroBody connector={current} value={value} set={set} previewText={previewText} />
            ) : current.kind === 'local-pocket' ? (
              <PocketBody connector={current} value={value} set={set} lab={lab} name={name} previewText={previewText} />
            ) : current.kind === 'elevenlabs' && current.hasKey ? (
              <ElevenBody connector={current} value={value} set={set} lab={lab} name={name} previewText={previewText} />
            ) : (
              <CloudBody connector={current} value={value} set={set} lab={lab} name={name} previewText={previewText} />
            )}
          </motion.div>
        </AnimatePresence>
      )}
    </div>
  )
}
