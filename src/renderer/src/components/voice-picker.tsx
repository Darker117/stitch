// Reusable voice chooser for characters, narrators and the Voice studio.
// Pick a provider, then a voice — or, locally, clone from a sample or design one.
import { useId, useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { AnimatePresence, motion } from 'motion/react'
import { AudioLines, Check, Cloud, Cpu, FolderOpen, Mic, RefreshCw, Sparkles, Square, Wand2, X } from 'lucide-react'
import type { VoiceInfo } from '@shared/ipc'
import type { Asset, CharacterVoice, ID, VoiceConnector } from '@shared/types'
import { errorText, fileUrl, invoke } from '@/lib/api'
import { cn } from '@/lib/utils'
import { ease, spring, springSoft } from '@/lib/motion'
import {
  DEFAULT_PREVIEW_LINE,
  DESIGN_IDEAS,
  READ_ALOUD,
  VOICE_KIND_LABEL,
  VOICE_LANGUAGES,
  describeVoice,
  presetMeta,
  speak,
  useResolvedConnector,
  useVoiceConnectors,
  useVoicePresets,
  useVoices,
  voiceFromPreset
} from '@/lib/voice'
import { useDoc } from '@/stores/db'
import { toast, useToasts } from '@/stores/toast'
import { AssetPicker, DropZone } from './media'
import { EqBars, LiveWave, WavePlayer, playPreview, stopPreview, usePreviewKey, useRecorder } from './audio'
import { Button, IconButton } from './ui/button'
import { Input, SearchField, Textarea } from './ui/input'
import { Segmented } from './ui/controls'
import { Badge, Field, Skeleton, Spinner } from './ui/misc'
import { Select } from './ui/overlay'

// ─── Preview ─────────────────────────────────────────────────────────────────

function useNotifyEngine(): (err: unknown, title?: string) => void {
  const navigate = useNavigate()
  return (err, title = 'Preview failed') => {
    const body = errorText(err)
    if (/not installed|voice engine|Connectors/i.test(body)) {
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
            <span className="relative">{c.name || VOICE_KIND_LABEL[c.kind]}</span>
          </button>
        )
      })}
    </div>
  )
}

function VoiceRow({ v, active, layoutGroup, onSelect, preview }: { v: VoiceInfo; active: boolean; layoutGroup: string; onSelect: () => void; preview: ReactNode }): React.JSX.Element {
  const chips = [v.labels?.gender, v.labels?.accent ?? v.labels?.locale, v.labels?.age, v.cloned ? 'custom' : undefined].filter(Boolean).slice(0, 3) as string[]
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
  className?: string
}

export function VoicePicker({ value, onChange, previewText, name: nameProp, characterName, characterIds, lab = true, className }: VoicePickerProps): React.JSX.Element {
  const name = nameProp ?? characterName
  const connectors = useVoiceConnectors()
  const current = useResolvedConnector(value)
  const navigate = useNavigate()
  const sample = useDoc('assets', value?.sampleAssetId)
  const summary = describeVoice(value, sample?.name)
  const set = (patch: Partial<CharacterVoice>): void => onChange({ ...(value ?? {}), connectorId: current?.id, ...patch })

  if (!connectors.length) {
    return (
      <div className={cn('flex flex-col items-center gap-3 rounded-2xl border border-dashed border-line-strong px-5 py-8 text-center', className)}>
        <AudioLines className="size-5 text-fg-3" />
        <div className="text-[13px] font-medium">No voice providers yet</div>
        <p className="max-w-xs text-[12px] text-fg-3">Install the local Stitch Voice engine or add ElevenLabs, OpenAI or Azure in Connectors.</p>
        <Button size="sm" onClick={() => navigate('/connectors')}>
          Open Connectors
        </Button>
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
            {current ? current.name || VOICE_KIND_LABEL[current.kind] : '—'}
            {summary.kind !== 'none' && ` · ${summary.kind === 'clone' ? 'cloned' : summary.kind === 'design' ? 'designed' : 'voice'}`}
            {value?.language && ` · ${value.language}`}
          </div>
        </div>
        <VoicePreviewButton voice={value} connectorId={current?.id} text={previewText} characterIds={characterIds} size="md" />
      </div>

      {connectors.length > 1 && <ProviderChips connectors={connectors} value={current?.id} onChange={(id) => onChange({ ...(value ?? {}), connectorId: id, voiceId: undefined })} />}

      {current && (
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={current.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.24, ease }}>
            {current.kind === 'local-qwen' ? (
              <LocalBody connector={current} value={value} set={set} lab={lab} name={name} characterIds={characterIds} />
            ) : (
              <CloudBody connector={current} value={value} set={set} lab={lab} name={name} previewText={previewText} />
            )}
          </motion.div>
        </AnimatePresence>
      )}
    </div>
  )
}
