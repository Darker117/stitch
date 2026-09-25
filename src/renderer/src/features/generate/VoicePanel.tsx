// Voice studio — the "Voice" tab of Generate. Engine cards (Qwen3-TTS, Kokoro,
// Pocket TTS, ElevenLabs…) with install status, the engine's voices, the script +
// delivery, a voice lab for designing/cloning, and the clip history on the right.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { AnimatePresence, motion } from 'motion/react'
import { AudioLines, ChevronDown, CornerUpLeft, Download, Drama, FlaskConical, FolderOpen, HardDrive, Mic, MoreHorizontal, Play, Power, Save, Trash2, UserRound, Wand2 } from 'lucide-react'
import { create } from 'zustand'
import type { VoiceEngineInfo } from '@shared/ipc'
import type { Asset, Character, CharacterVoice, ID, VoiceConnector, VoiceKind } from '@shared/types'
import { errorText, fileUrl, invoke } from '@/lib/api'
import { cn, formatDuration, timeAgo } from '@/lib/utils'
import { ease, rise, spring, springSoft, stagger } from '@/lib/motion'
import {
  DELIVERY_PRESETS,
  VOICE_KIND_LABEL,
  describeVoice,
  engineStateLabel,
  estimateSpeechSeconds,
  isLocalKind,
  prettyVoiceId,
  saveVoicePreset,
  sizeLabel,
  speak,
  useResolvedConnector,
  useVoiceConnectors,
  useVoiceEngine,
  useVoiceEngines,
  useVoiceModels
} from '@/lib/voice'
import { db, useCollection, useDoc } from '@/stores/db'
import { toast } from '@/stores/toast'
import { PendingWave, WavePlayer } from '@/components/audio'
import { DesignForm, EngineCards, ProviderIcon, RemoveEngineDialog, SampleInput, VoicePicker, useEngineForKind, useNotifyEngine } from '@/components/voice-picker'
import { Orb } from '@/components/ui/orb'
import { Button, Chip, IconButton } from '@/components/ui/button'
import { Input, SearchField, Textarea } from '@/components/ui/input'
import { Segmented } from '@/components/ui/controls'
import { Avatar, EmptyState, Kbd, ProgressBar, StatusDot } from '@/components/ui/misc'
import { Menu, MenuItem, MenuLabel, Popover, PopoverClose, Select } from '@/components/ui/overlay'

// ─── Draft state (survives tab switches and restarts) ────────────────────────

type LabMode = 'design' | 'clone'

interface StudioState {
  text: string
  instructions: string
  voice: CharacterVoice
  characterId?: ID
  models: Partial<Record<VoiceKind, string>>
  lab: LabMode
  cloneSample?: ID
  cloneText: string
  designResult?: ID
  designMeta?: { design: string; sampleText: string }
}

const DRAFT_KEY = 'stitch.voice-studio'

function loadDraft(): Partial<StudioState> {
  try {
    return JSON.parse(localStorage.getItem(DRAFT_KEY) ?? '{}') as Partial<StudioState>
  } catch {
    return {}
  }
}

const useStudio = create<StudioState>(() => ({ text: '', instructions: '', voice: {}, models: {}, lab: 'design', cloneText: '', ...loadDraft() }))
const setStudio = (p: Partial<StudioState>): void => useStudio.setState(p)

let saveTimer: number | undefined
useStudio.subscribe((s) => {
  window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(s))
    } catch {
      /* storage full / unavailable */
    }
  }, 300)
})

interface Pending {
  id: string
  text: string
  startedAt: number
  local: boolean
}

// ─── Small pieces ────────────────────────────────────────────────────────────

function CharacterFace({ c, size = 22 }: { c: Character; size?: number }): React.JSX.Element {
  const a = useDoc('assets', c.referenceAssetId ?? c.sheet?.front)
  return <Avatar src={a ? fileUrl(a.thumbPath ?? a.path) : undefined} name={c.name} size={size} />
}

function safeName(s: string): string {
  return s.replace(/[<>:"/\\|?*\u0000-\u001f“”]/g, '').trim().slice(0, 60) || 'voice'
}

async function saveVoiceToCharacter(c: Character, voice: CharacterVoice): Promise<void> {
  await db.update('characters', c.id, (cur) => ({ ...cur, voice, updatedAt: Date.now() }))
  toast.success(`Saved to ${c.name}`, 'This voice is now used for their dialogue and video.')
}

function useNotify(): (title: string, err: unknown) => void {
  const notify = useNotifyEngine()
  return (title, err) => notify(err, title)
}

/** "Use / Save to character / Keep as preset" for a designed or cloned sample. */
function ResultActions({ asset, voice, defaultName, onUse }: { asset: Asset; voice: CharacterVoice; defaultName: string; onUse: () => void }): React.JSX.Element {
  const characters = useCollection('characters')
  const [name, setName] = useState(defaultName)
  const isPreset = asset.tags?.includes('voice-preset')
  return (
    <>
      <Button size="sm" variant="primary" icon={<AudioLines className="size-3.5" />} onClick={onUse}>
        Use this voice
      </Button>
      <Menu
        trigger={
          <Button size="sm" icon={<UserRound className="size-3.5" />} iconRight={<ChevronDown className="size-3 text-fg-3" />}>
            Save to character
          </Button>
        }
      >
        <MenuLabel>Give this voice to</MenuLabel>
        {characters.length ? (
          characters.map((c) => (
            <MenuItem key={c.id} icon={<CharacterFace c={c} size={16} />} hint={c.voice ? 'replaces voice' : undefined} onSelect={() => void saveVoiceToCharacter(c, voice)}>
              {c.name}
            </MenuItem>
          ))
        ) : (
          <MenuItem disabled>No characters yet</MenuItem>
        )}
      </Menu>
      <Popover
        align="start"
        trigger={
          <Button size="sm" variant="ghost" icon={<Save className="size-3.5" />}>
            {isPreset ? 'Saved preset' : 'Keep as preset'}
          </Button>
        }
      >
        <div className="flex w-64 flex-col gap-2 p-2">
          <span className="label-caps">Preset name</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          <PopoverClose asChild>
            <Button
              size="sm"
              variant="primary"
              disabled={!name.trim()}
              onClick={async () => {
                await saveVoicePreset(asset, { name: name.trim(), sampleText: voice.sampleText, design: voice.design, language: voice.language })
                toast.success('Preset saved', 'Find it under Stitch Voice → Voices.')
              }}
            >
              Save preset
            </Button>
          </PopoverClose>
        </div>
      </Popover>
    </>
  )
}

// ─── Left column ─────────────────────────────────────────────────────────────

function SpeakingAs({ character }: { character?: Character }): React.JSX.Element {
  const characters = useCollection('characters')
  return (
    <Menu
      trigger={
        <button className="flex h-7.5 items-center gap-1.5 rounded-full border border-line bg-white/[0.04] pr-2.5 pl-1 text-[12px] font-medium text-fg-2 transition hover:border-line-strong hover:text-fg">
          {character ? (
            <CharacterFace c={character} size={22} />
          ) : (
            <span className="grid size-5.5 place-items-center rounded-full bg-white/[0.06] text-fg-3">
              <UserRound className="size-3" />
            </span>
          )}
          {character ? character.name : 'Speaking as…'}
          <ChevronDown className="size-3 text-fg-3" />
        </button>
      }
    >
      <MenuLabel>Character</MenuLabel>
      <MenuItem icon={<UserRound />} onSelect={() => setStudio({ characterId: undefined })}>
        No character
      </MenuItem>
      {characters.map((c) => (
        <MenuItem
          key={c.id}
          icon={<CharacterFace c={c} size={16} />}
          hint={c.voice ? 'has a voice' : 'no voice yet'}
          onSelect={() => setStudio({ characterId: c.id, ...(c.voice ? { voice: c.voice } : {}) })}
        >
          {c.name}
        </MenuItem>
      ))}
    </Menu>
  )
}

function deliveryHint(kind: VoiceKind | undefined, voice: CharacterVoice, model: string | undefined, instructions: string): string | undefined {
  if (!instructions.trim()) return undefined
  if (kind === 'local-qwen' && voice.sampleAssetId) return 'Cloned voices take their delivery from the sample — delivery notes steer preset speakers and designed voices.'
  if (kind === 'local-kokoro') return 'Kokoro reads delivery notes only as pace — “slow” or “fast”.'
  if (kind === 'local-pocket') return 'Pocket TTS takes its delivery from the voice — clone a sample spoken the way you want.'
  if (kind === 'elevenlabs' && !/v3/.test(model ?? '')) return 'ElevenLabs follows delivery notes with Eleven v3 (as audio tags).'
  if (kind === 'openai-tts' && /^tts-1/.test(model ?? '')) return 'tts-1 ignores delivery notes — pick gpt-4o-mini-tts.'
  if (kind === 'azure') return 'Azure maps delivery notes to speaking styles the voice supports.'
  return undefined
}

function ScriptCard({ busy, onGenerate, character, kind, model, blocked }: { busy: boolean; onGenerate: () => void; character?: Character; kind?: VoiceKind; model?: string; blocked?: string }): React.JSX.Element {
  const text = useStudio((s) => s.text)
  const instructions = useStudio((s) => s.instructions)
  const voice = useStudio((s) => s.voice)
  const secs = estimateSpeechSeconds(text)
  const hint = blocked ?? deliveryHint(kind, voice, model, instructions)
  return (
    <div className="glass hairline glow-border rounded-[20px]" data-active={busy}>
      <div className="flex items-center gap-2 px-4 pt-3.5">
        <SpeakingAs character={character} />
        <div className="flex-1" />
        <AnimatePresence>
          {text.trim() && (
            <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="text-[11px] text-fg-3 tabular-nums">
              {text.length.toLocaleString()} chars · ~{secs < 60 ? `${Math.max(1, Math.round(secs))} s` : formatDuration(secs)}
            </motion.span>
          )}
        </AnimatePresence>
      </div>
      <Textarea
        bare
        value={text}
        onChange={(e) => setStudio({ text: e.target.value })}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault()
            onGenerate()
          }
        }}
        minRows={6}
        maxRows={18}
        placeholder="Write the lines to speak… Narration, dialogue, a whole chapter — blank lines become natural pauses."
        className="px-4 pt-2.5 pb-3 font-serif text-[15px] leading-[1.75] placeholder:font-serif"
      />
      <div className="flex flex-wrap items-center gap-1.5 border-t border-line px-3.5 pt-3 pb-2">
        <span className="label-caps mr-1 flex items-center gap-1.5">
          <Drama className="size-3" /> Delivery
        </span>
        {DELIVERY_PRESETS.map((p) => (
          <Chip key={p.label} active={instructions === p.value} onClick={() => setStudio({ instructions: instructions === p.value ? '' : p.value })} className="h-7 rounded-full">
            {p.label}
          </Chip>
        ))}
      </div>
      <div className="flex items-center gap-2 px-3.5 pb-3.5">
        <Input value={instructions} onChange={(e) => setStudio({ instructions: e.target.value })} placeholder="…or direct it: “hushed and urgent, a little out of breath”" className="min-w-0 flex-1" />
        <span className="hidden items-center gap-0.5 lg:flex">
          <Kbd>Ctrl</Kbd>
          <Kbd>↵</Kbd>
        </span>
        <Button variant="primary" size="lg" icon={<AudioLines className="size-4" />} disabled={!text.trim() || !!blocked} onClick={onGenerate} className="rounded-xl">
          Generate
        </Button>
      </div>
      <AnimatePresence initial={false}>
        {hint && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.25, ease }} className="overflow-hidden">
            <div className={cn('px-4 pb-3 text-[11px]', blocked ? 'text-warning/90' : 'text-fg-3')}>{hint}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function LabCard({ character, onUse, engine }: { character?: Character; onUse: (voice: CharacterVoice) => void; engine: VoiceConnector }): React.JSX.Element {
  const labMode = useStudio((s) => s.lab)
  const cloneSample = useStudio((s) => s.cloneSample)
  const cloneText = useStudio((s) => s.cloneText)
  const designResult = useStudio((s) => s.designResult)
  const designMeta = useStudio((s) => s.designMeta)
  const language = useStudio((s) => s.voice.language)
  const connectors = useVoiceConnectors()
  const local = connectors.find((c) => c.kind === 'local-qwen')
  const eleven = connectors.find((c) => c.kind === 'elevenlabs')
  const designed = useDoc('assets', designResult)
  const sample = useDoc('assets', cloneSample)
  const [cloning, setCloning] = useState(false)
  const notify = useNotify()
  const baseName = character ? `${character.name}` : 'New voice'
  // Design is Qwen3-TTS only; Pocket TTS and ElevenLabs clone.
  const canDesign = engine.kind === 'local-qwen'
  const lab: LabMode = canDesign ? labMode : 'clone'
  const cloneTarget = engine.kind === 'local-pocket' || engine.kind === 'local-qwen' ? engine : local
  const needsTranscript = engine.kind === 'local-qwen'

  const cloneVoice: CharacterVoice = { connectorId: cloneTarget?.id, sampleAssetId: cloneSample, sampleText: needsTranscript ? cloneText.trim() || undefined : undefined, language }
  const designVoice: CharacterVoice | undefined = designed && designMeta ? { connectorId: local?.id, sampleAssetId: designed.id, sampleText: designMeta.sampleText, design: designMeta.design, language } : undefined

  const cloneToEleven = async (): Promise<void> => {
    if (!eleven || !cloneSample) return
    setCloning(true)
    try {
      const { voiceId } = await invoke('voice:clone', { connectorId: eleven.id, name: baseName, sampleAssetId: cloneSample, sampleText: cloneText })
      onUse({ connectorId: eleven.id, voiceId, sampleAssetId: cloneSample, sampleText: cloneText.trim() || undefined })
      toast.success('Cloned into ElevenLabs', 'The new voice is selected.')
    } catch (err) {
      notify('Cloning failed', err)
    } finally {
      setCloning(false)
    }
  }

  return (
    <section className="glass hairline rounded-[20px] p-4">
      <div className="mb-3.5 flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-[14px] font-semibold tracking-tight">
          <FlaskConical className="size-4 text-accent" /> Voice lab
          <span className="text-[11.5px] font-normal text-fg-3">· {engine.kind === 'elevenlabs' ? 'ElevenLabs' : VOICE_KIND_LABEL[cloneTarget?.kind ?? 'local-qwen']}</span>
        </h2>
        {canDesign ? (
          <Segmented<LabMode>
            size="sm"
            value={lab}
            onChange={(v) => setStudio({ lab: v })}
            items={[
              { value: 'design', label: 'Design a voice', icon: <Wand2 /> },
              { value: 'clone', label: 'Clone from sample', icon: <Mic /> }
            ]}
          />
        ) : (
          <span className="flex items-center gap-1.5 text-[12px] font-medium text-fg-2">
            <Mic className="size-3.5 text-fg-3" /> Clone from sample
          </span>
        )}
      </div>
      <AnimatePresence mode="wait" initial={false}>
        {lab === 'design' ? (
          <motion.div key="design" initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 8 }} transition={{ duration: 0.25, ease }}>
            <DesignForm
              initial={designMeta?.design}
              language={language}
              name={character?.name}
              characterIds={character ? [character.id] : undefined}
              result={designed}
              onDesigned={(asset, meta) => setStudio({ designResult: asset.id, designMeta: meta })}
              actions={(asset) => designVoice && <ResultActions asset={asset} voice={designVoice} defaultName={designMeta?.design.split(/[,.—]/)[0].slice(0, 40) ?? baseName} onUse={() => onUse(designVoice)} />}
            />
          </motion.div>
        ) : (
          <motion.div key="clone" initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -8 }} transition={{ duration: 0.25, ease }} className="flex flex-col gap-3">
            <SampleInput
              assetId={cloneSample}
              onAsset={(a) => setStudio({ cloneSample: a?.id })}
              transcript={needsTranscript ? cloneText : undefined}
              onTranscript={needsTranscript ? (t) => setStudio({ cloneText: t }) : undefined}
              name={character?.name}
            />
            <AnimatePresence>
              {sample && (
                <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.25, ease }} className="flex flex-wrap gap-2">
                  {engine.kind !== 'elevenlabs' && <ResultActions asset={sample} voice={cloneVoice} defaultName={baseName} onUse={() => onUse(cloneVoice)} />}
                  {eleven && (
                    <Button size="sm" variant={engine.kind === 'elevenlabs' ? 'primary' : 'ghost'} loading={cloning} icon={<ProviderIcon kind="elevenlabs" className="size-3.5" />} onClick={() => void cloneToEleven()}>
                      Clone into ElevenLabs
                    </Button>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  )
}

// ─── Right column ────────────────────────────────────────────────────────────

function EngineStrip(): React.JSX.Element | null {
  const status = useVoiceEngine()
  const connectors = useVoiceConnectors()
  const navigate = useNavigate()
  const [pending, setPending] = useState(false)
  if (!connectors.some((c) => isLocalKind(c.kind))) return null
  const state = engineStateLabel(status)
  const act = async (fn: 'voice:engineStart' | 'voice:engineStop'): Promise<void> => {
    setPending(true)
    try {
      await invoke(fn)
    } catch (err) {
      toast.error('Voice engine', errorText(err))
    } finally {
      setPending(false)
    }
  }
  return (
    <div className="px-3 pt-3">
      <div className="relative overflow-hidden rounded-xl border border-line bg-white/[0.03] px-3 py-2.5">
        <div className="flex items-center gap-2.5">
          <StatusDot state={state.tone} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12px] font-medium">
              Local voice engine <span className="font-normal text-fg-3">· {state.label}</span>
            </div>
            <AnimatePresence mode="wait" initial={false}>
              <motion.div key={status?.activity?.label ?? status?.device ?? ''} initial={{ opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -3 }} transition={{ duration: 0.18 }} className="truncate text-[10.5px] text-fg-3">
                {status?.activity?.label ?? (status?.installed ? status.device : 'Install Qwen3-TTS, Kokoro or Pocket TTS on the left')}
              </motion.div>
            </AnimatePresence>
          </div>
          {!status?.installed ? (
            <Button size="xs" variant="secondary" onClick={() => navigate('/connectors')}>
              Details
            </Button>
          ) : status.running ? (
            <IconButton label="Stop engine (frees VRAM)" size="xs" onClick={() => void act('voice:engineStop')} disabled={pending || status.busy === 'generating'}>
              <Power className="size-3" />
            </IconButton>
          ) : (
            <IconButton label="Start engine" size="xs" onClick={() => void act('voice:engineStart')} disabled={pending || status.busy !== 'idle'}>
              <Play className="size-3 fill-current" />
            </IconButton>
          )}
        </div>
        {status?.activity?.progress !== undefined && (
          <motion.div className="absolute inset-x-0 bottom-0 h-[2px] origin-left bg-grad" animate={{ scaleX: status.activity.progress }} transition={{ duration: 0.4, ease }} />
        )}
      </div>
    </div>
  )
}

function PendingClip({ p }: { p: Pending }): React.JSX.Element {
  const status = useVoiceEngine()
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(t)
  }, [])
  const activity = p.local ? status?.activity : undefined
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -12, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.15 } }}
      transition={springSoft}
      className="glow-border rounded-2xl border border-[color-mix(in_oklab,var(--accent)_28%,transparent)] bg-[color-mix(in_oklab,var(--accent)_5%,transparent)] p-3"
      data-active="true"
    >
      <p className="line-clamp-2 font-serif text-[13px] leading-snug text-fg-2">{p.text}</p>
      <PendingWave className="my-2.5" height={28} />
      <div className="flex items-center justify-between text-[11px] text-fg-3">
        <span className="truncate">{activity?.label ?? 'Synthesizing…'}</span>
        <span className="font-mono tabular-nums">{Math.floor((now - p.startedAt) / 1000)}s</span>
      </div>
      {activity?.progress !== undefined && <ProgressBar value={activity.progress} className="mt-2" />}
    </motion.div>
  )
}

function ClipCard({ asset, fresh, onReuse }: { asset: Asset; fresh: boolean; onReuse: (a: Asset) => void }): React.JSX.Element {
  const character = useDoc('characters', asset.characterIds?.[0])
  const p = (asset.params ?? {}) as { provider?: VoiceKind; voice?: CharacterVoice; instructions?: string; resolvedVoice?: string; voiceName?: string; model?: string }
  const voiceTitle = p.voiceName ?? (p.resolvedVoice && !p.voice?.sampleAssetId ? prettyVoiceId(p.resolvedVoice) : describeVoice(p.voice).title)
  const download = async (): Promise<void> => {
    const ext = asset.path.split('.').pop() ?? 'wav'
    const dest = await invoke('sys:saveDialog', { defaultPath: `${safeName(asset.name)}.${ext}`, filters: [{ name: 'Audio', extensions: [ext] }] })
    if (!dest) return
    await invoke('assets:copyTo', asset.id, dest)
    toast.success('Saved', dest)
  }
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -12, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, x: 24, transition: { duration: 0.18 } }}
      transition={springSoft}
      className={cn(
        'group relative rounded-2xl border p-3 transition-[background,border-color] duration-500',
        fresh ? 'border-[color-mix(in_oklab,var(--accent)_40%,transparent)] bg-[color-mix(in_oklab,var(--accent)_7%,transparent)]' : 'border-line bg-white/[0.025] hover:border-line-strong hover:bg-white/[0.045]'
      )}
    >
      <div
        className="mb-2 flex items-start gap-2.5"
        draggable
        title="Drag into the editor timeline or a voice sample slot"
        onDragStart={(e) => {
          e.dataTransfer.setData('application/x-stitch-asset', asset.id)
          e.dataTransfer.effectAllowed = 'copy'
        }}
      >
        {character ? (
          <CharacterFace c={character} size={24} />
        ) : (
          <span className="grid size-6 shrink-0 place-items-center rounded-full bg-grad-soft ring-1 ring-line">
            {p.provider ? <ProviderIcon kind={p.provider} className="size-3 text-fg" /> : <AudioLines className="size-3" />}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 font-serif text-[13px] leading-snug text-fg">{asset.prompt ?? asset.name}</p>
          <div className="mt-1 flex h-5 min-w-0 items-center gap-1 text-[10.5px] text-fg-3">
            <span className="truncate">{character?.name ?? voiceTitle}</span>
            {p.provider && <span className="shrink-0">· {VOICE_KIND_LABEL[p.provider]}</span>}
            <span className="shrink-0">· {timeAgo(asset.createdAt)}</span>
            <div className="ml-auto flex shrink-0 translate-x-1 gap-0.5 opacity-0 transition-[opacity,transform] duration-200 group-hover:translate-x-0 group-hover:opacity-100">
              <IconButton label="Reuse script & voice" size="xs" onClick={() => onReuse(asset)}>
                <CornerUpLeft className="size-3" />
              </IconButton>
              <IconButton label="Download" size="xs" onClick={() => void download()}>
                <Download className="size-3" />
              </IconButton>
              <IconButton label="Show in folder" size="xs" onClick={() => void invoke('sys:showInFolder', asset.path)}>
                <FolderOpen className="size-3" />
              </IconButton>
              <IconButton label="Delete" size="xs" className="hover:text-danger" onClick={() => void invoke('assets:delete', asset.id, true)}>
                <Trash2 className="size-3" />
              </IconButton>
            </div>
          </div>
        </div>
      </div>
      <WavePlayer src={fileUrl(asset.path)} seed={asset.id} duration={asset.duration} size="sm" height={30} bars={56} autoPlay={fresh} />
      {p.instructions && (
        <div className="mt-2 flex">
          <span className="truncate rounded-full border border-line bg-white/[0.03] px-2 py-0.5 text-[10.5px] text-fg-2 italic">{p.instructions}</span>
        </div>
      )}
    </motion.div>
  )
}

function History({ pending, fresh, onReuse }: { pending: Pending[]; fresh?: ID; onReuse: (a: Asset) => void }): React.JSX.Element {
  const assets = useCollection('assets')
  const [q, setQ] = useState('')
  const [limit, setLimit] = useState(40)
  const clips = useMemo(
    () => assets.filter((a) => a.kind === 'audio' && a.source === 'voice' && !a.tags?.includes('voice-preview')).sort((a, b) => b.createdAt - a.createdAt),
    [assets]
  )
  const needle = q.trim().toLowerCase()
  const shown = needle ? clips.filter((a) => `${a.prompt ?? ''} ${a.name}`.toLowerCase().includes(needle)) : clips
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 px-4 pt-4 pb-3">
        <span className="text-[13px] font-semibold tracking-tight">History</span>
        <span className="text-[11px] text-fg-3 tabular-nums">{clips.length}</span>
        <div className="flex-1" />
        <SearchField value={q} onChange={setQ} placeholder="Search lines" className="w-44" />
      </div>
      <div className="scroll-fade min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        <div className="flex flex-col gap-2">
          <AnimatePresence initial={false}>
            {pending.map((p) => (
              <PendingClip key={p.id} p={p} />
            ))}
            {shown.slice(0, limit).map((a) => (
              <ClipCard key={a.id} asset={a} fresh={a.id === fresh} onReuse={onReuse} />
            ))}
          </AnimatePresence>
          {!shown.length && !pending.length && (
            <EmptyState
              icon={<AudioLines />}
              title={needle ? 'No matching clips' : 'No voice clips yet'}
              body={needle ? 'Try another word from the line.' : 'Narration and dialogue you generate land here, ready to reuse in stories, the editor and video.'}
            />
          )}
          {shown.length > limit && (
            <Button size="sm" variant="ghost" onClick={() => setLimit((l) => l + 40)} className="self-center">
              Show more
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Engine details (size, weights, remove) ──────────────────────────────────

function EngineDetails({ engine }: { engine: VoiceEngineInfo }): React.JSX.Element | null {
  const status = useVoiceEngine()
  const [confirm, setConfirm] = useState(false)
  const notify = useNotify()
  if (engine.kind !== 'local' || !engine.installed) return null
  const weights = engine.weights ?? []
  const onDisk = weights.filter((w) => w.downloaded).length
  const downloading = status?.activity?.model && weights.some((w) => w.id === status.activity?.model) ? status.activity : undefined
  const busy = status?.busy === 'installing'
  const download = (id: string): void => {
    invoke('voice:engineDownload', id).catch((err) => notify('Download failed', err))
  }
  return (
    <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.25, ease }} className="flex min-h-7 flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[11.5px] text-fg-3">
      <span className="flex items-center gap-1.5">
        <HardDrive className="size-3" /> {sizeLabel(engine.sizeBytes)} on disk
      </span>
      <span className="text-fg-3/60">·</span>
      <span>{engine.license}</span>
      <span className="text-fg-3/60">·</span>
      <AnimatePresence mode="wait" initial={false}>
        <motion.span key={downloading?.label ?? onDisk} initial={{ opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -3 }} transition={{ duration: 0.18 }} className={cn('truncate', downloading && 'text-accent')}>
          {downloading
            ? `${downloading.label}${downloading.progress !== undefined ? ` · ${Math.round(downloading.progress * 100)}%` : ''}`
            : !weights.length
              ? 'Weights download on first use'
              : onDisk === weights.length
                ? weights.length > 1
                  ? `${onDisk} models on disk`
                  : 'Voices on disk'
                : onDisk
                  ? `${onDisk} of ${weights.length} models on disk`
                  : 'Weights download on first use'}
        </motion.span>
      </AnimatePresence>
      <div className="flex-1" />
      <Menu
        align="end"
        trigger={
          <IconButton label={`${engine.name} options`} size="xs" disabled={busy}>
            <MoreHorizontal className="size-3.5" />
          </IconButton>
        }
      >
        <MenuLabel>{engine.name}</MenuLabel>
        {weights
          .filter((w) => !w.downloaded)
          .map((w) => (
            <MenuItem key={w.id} icon={<Download />} onSelect={() => download(w.id)} disabled={!!status?.activity?.model}>
              Download {w.label.replace(/^.*·\s*/, '')}
            </MenuItem>
          ))}
        {engine.homepage && (
          <MenuItem icon={<FolderOpen />} onSelect={() => engine.path && void invoke('sys:showInFolder', engine.path)} disabled={!engine.path}>
            Show files
          </MenuItem>
        )}
        <MenuItem icon={<Trash2 />} danger onSelect={() => setConfirm(true)}>
          Remove {engine.name}…
        </MenuItem>
      </Menu>
      <RemoveEngineDialog engine={engine} open={confirm} onOpenChange={setConfirm} />
    </motion.div>
  )
}

// ─── Panel ───────────────────────────────────────────────────────────────────

export function VoicePanel({ className }: { className?: string }): React.JSX.Element {
  const text = useStudio((s) => s.text)
  const instructions = useStudio((s) => s.instructions)
  const voice = useStudio((s) => s.voice)
  const characterId = useStudio((s) => s.characterId)
  const models = useStudio((s) => s.models)
  const character = useDoc('characters', characterId)
  const connector = useResolvedConnector(voice)
  const kind = connector?.kind
  const engine = useEngineForKind(kind)
  const allConnectors = useCollection('connectors')
  const navigate = useNavigate()
  const modelOptions = useVoiceModels(connector)
  const model = kind ? (models[kind] ?? connector?.model ?? modelOptions[0]?.value) : undefined
  const blocked = engine && !engine.installed ? (engine.kind === 'local' ? `Install ${engine.name} above to generate with it.` : `Add your ${engine.name} API key in Connectors to generate with it.`) : undefined
  const [pending, setPending] = useState<Pending[]>([])
  const [fresh, setFresh] = useState<ID>()
  const scroller = useRef<HTMLDivElement>(null)
  const notify = useNotify()
  const engineStatus = useVoiceEngine()
  const busy = pending.length > 0

  useEffect(() => {
    if (!fresh) return
    const t = window.setTimeout(() => setFresh(undefined), 6000)
    return () => window.clearTimeout(t)
  }, [fresh])

  const generate = async (): Promise<void> => {
    const line = text.trim()
    if (!line || !connector) return
    const id = Math.random().toString(36).slice(2)
    setPending((p) => [{ id, text: line, startedAt: Date.now(), local: isLocalKind(kind) }, ...p])
    try {
      const asset = await speak({
        connectorId: connector.id,
        text: line,
        voice: { ...voice, connectorId: connector.id },
        instructions: instructions.trim() || undefined,
        model: kind === 'azure' ? undefined : model,
        characterIds: character ? [character.id] : undefined,
        name: character ? `${character.name} · ${line.split(/\s+/).slice(0, 6).join(' ')}` : undefined,
        origin: { type: 'studio', id: 'voice' }
      })
      setFresh(asset.id)
      const note = asset.params?.note as string | undefined
      if (note) toast.info('Heads up', note)
    } catch (err) {
      notify('Voice generation failed', err)
    } finally {
      setPending((p) => p.filter((x) => x.id !== id))
    }
  }

  const reuse = (a: Asset): void => {
    const p = (a.params ?? {}) as { voice?: CharacterVoice; instructions?: string }
    setStudio({ text: a.prompt ?? '', instructions: p.instructions ?? '', ...(p.voice ? { voice: p.voice } : {}), characterId: a.characterIds?.[0] })
    scroller.current?.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const useVoice = (v: CharacterVoice): void => {
    setStudio({ voice: v })
    scroller.current?.scrollTo({ top: 0, behavior: 'smooth' })
    toast.success('Voice selected', character ? `Save it to ${character.name} from the voice card.` : undefined)
  }

  /** Switch engines: keep the sample/design/language, drop the engine-specific voice id. */
  const selectEngine = async (e: VoiceEngineInfo): Promise<void> => {
    let id = e.connectorId
    if (!id) {
      const existing = allConnectors.find((c): c is VoiceConnector => c.category === 'voice' && c.kind === e.connectorKind)
      if (e.kind === 'cloud' && !existing) {
        navigate('/connectors')
        return
      }
      if (existing) {
        id = existing.id
        // Picking a turned-off engine turns its connector back on.
        if (!existing.enabled) await invoke('connectors:save', { ...existing, enabled: true }, undefined)
      } else {
        // A local engine whose connector was deleted: bring it back so speech can be routed to it.
        const saved = await invoke('connectors:save', { id: '', name: e.name, category: 'voice', kind: e.connectorKind, hasKey: false, enabled: true, createdAt: Date.now() }, undefined)
        id = saved.id
      }
    }
    if (id === connector?.id) return
    setStudio({ voice: { ...voice, connectorId: id, voiceId: undefined } })
  }

  const voiceDiffers = character && JSON.stringify(character.voice ?? {}) !== JSON.stringify({ ...voice, connectorId: voice.connectorId ?? connector?.id })
  const orbState = busy ? 'generating' : engineStatus?.busy === 'loading-model' ? 'thinking' : 'idle'

  return (
    <div className={cn('flex h-full min-h-0 w-full', className)}>
      <div ref={scroller} className="min-w-0 flex-1 overflow-y-auto">
        <motion.div variants={stagger(0.06, 0.02)} initial="initial" animate="animate" className="mx-auto flex max-w-[780px] flex-col gap-4 px-7 pt-6 pb-12">
          <motion.header variants={rise} className="flex items-center gap-3.5">
            <div className="-m-2.5 shrink-0">
              <Orb size={46} state={orbState} density={0.6} />
            </div>
            <div className="min-w-0 flex-1">
              <h1 className="display text-[22px]">
                Voice <span className="text-grad">studio</span>
              </h1>
              <p className="mt-0.5 text-[12.5px] text-fg-3">Narration, dialogue and character voices — local on your PC or from the cloud, identical everywhere they speak.</p>
            </div>
          </motion.header>

          <motion.section variants={rise} className="flex flex-col gap-2">
            <div className="flex items-center justify-between px-1">
              <span className="label-caps">Engine</span>
              <span className="text-[11px] text-fg-3">Local engines run on your PC · cloud engines use your API key</span>
            </div>
            <EngineCards value={kind} onSelect={(e) => void selectEngine(e)} />
            <AnimatePresence initial={false}>{engine && <EngineDetails key={engine.id} engine={engine} />}</AnimatePresence>
          </motion.section>

          <motion.section variants={rise} className="glass hairline rounded-[20px] p-4">
            <div className="mb-3.5 flex flex-wrap items-center justify-between gap-3">
              <h2 className="flex items-center gap-2 text-[14px] font-semibold tracking-tight">
                <AudioLines className="size-4 text-accent" /> Voice
              </h2>
              <div className="flex items-center gap-2">
                <AnimatePresence>
                  {voiceDiffers && (
                    <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }} transition={spring}>
                      <Button size="sm" variant="ghost" icon={<Save className="size-3.5" />} onClick={() => void saveVoiceToCharacter(character!, { ...voice, connectorId: voice.connectorId ?? connector?.id })}>
                        Save as {character!.name}’s voice
                      </Button>
                    </motion.div>
                  )}
                </AnimatePresence>
                {modelOptions.length > 1 && (
                  <Select
                    size="sm"
                    className="w-[196px]"
                    value={model}
                    onChange={(m) => kind && setStudio({ models: { ...models, [kind]: m } })}
                    options={modelOptions.map((m) => ({ value: m.value, label: m.label, hint: m.hint }))}
                  />
                )}
              </div>
            </div>
            <VoicePicker
              value={voice}
              onChange={(v) => setStudio({ voice: v })}
              lab={false}
              hideProviders
              name={character?.name}
              characterIds={character ? [character.id] : undefined}
              previewText={text.trim() ? text.trim().slice(0, 160) : undefined}
            />
          </motion.section>

          <motion.div variants={rise}>
            <ScriptCard busy={busy} onGenerate={() => void generate()} character={character} kind={kind} model={model} blocked={blocked} />
          </motion.div>

          <AnimatePresence initial={false}>
            {connector && (kind === 'local-qwen' || kind === 'local-pocket' || kind === 'elevenlabs') && !blocked && (
              <motion.div key="lab" variants={rise} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 6, transition: { duration: 0.18 } }} transition={springSoft}>
                <LabCard character={character} onUse={useVoice} engine={connector} />
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      </div>

      <motion.aside
        initial={{ opacity: 0, x: 16 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.45, ease, delay: 0.08 }}
        className="flex w-[380px] shrink-0 flex-col border-l border-line bg-black/[0.12]"
      >
        <EngineStrip />
        <History pending={pending} fresh={fresh} onReuse={reuse} />
      </motion.aside>
    </div>
  )
}
