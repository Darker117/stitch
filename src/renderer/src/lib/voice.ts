// Voice helpers shared by the Voice studio, VoicePicker and the engine card.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { create } from 'zustand'
import type { SpeakRequest, VoiceEngineId, VoiceEngineInfo, VoiceEngineStatus, VoiceInfo } from '@shared/ipc'
import type { Asset, CharacterVoice, ID, VoiceConnector, VoiceKind } from '@shared/types'
import { errorText, invoke, on } from './api'
import { db, useCollection } from '@/stores/db'
import { useSettings } from '@/stores/settings'

export const VOICE_KIND_LABEL: Record<VoiceKind, string> = {
  'local-qwen': 'Qwen3-TTS',
  'local-kokoro': 'Kokoro',
  'local-pocket': 'Pocket TTS',
  elevenlabs: 'ElevenLabs',
  'openai-tts': 'OpenAI',
  azure: 'Azure',
  device: 'This phone'
}

export const VOICE_KIND_TAGLINE: Record<VoiceKind, string> = {
  'local-qwen': 'Local · Qwen3-TTS · clone & design',
  'local-kokoro': 'Local · Kokoro 82M · 49 preset voices',
  'local-pocket': 'Local · Pocket TTS · CPU, voice cloning',
  elevenlabs: 'Cloud · voice library & instant cloning',
  'openai-tts': 'Cloud · steerable gpt-4o-mini-tts',
  azure: 'Cloud · 400+ neural voices & styles',
  device: 'On-device · runs on your phone'
}

/** "707 MB" / "1.2 GB" for engine sizes. */
export function sizeLabel(bytes: number | undefined): string {
  if (!bytes) return '—'
  const gb = bytes / 1024 ** 3
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`
}

/** "≈650 MB" / "≈1.2 GB" for download estimates. */
export function approxSize(bytes: number | undefined): string {
  return bytes ? `≈${sizeLabel(bytes)}` : '—'
}

/** Engine behind each connector kind (see `VoiceEngineInfo`). */
export const ENGINE_OF_KIND: Record<VoiceKind, VoiceEngineId> = {
  'local-qwen': 'qwen3',
  'local-kokoro': 'kokoro',
  'local-pocket': 'pocket',
  elevenlabs: 'elevenlabs',
  'openai-tts': 'openai',
  azure: 'azure',
  device: 'device'
}

export const isLocalKind = (kind: VoiceKind | undefined): boolean => !!kind && kind.startsWith('local-')

/** Engines that clone from a reference clip (zero-shot locally, or into the account for ElevenLabs). */
export const CLONING_KINDS: VoiceKind[] = ['local-qwen', 'local-pocket', 'elevenlabs']

/** Models offered per provider (first = default). */
export const VOICE_MODELS: Record<VoiceKind, { value: string; label: string; hint?: string }[]> = {
  'local-qwen': [
    { value: 'qwen3-tts-1.7b', label: 'Qwen3-TTS 1.7B', hint: 'Best likeness' },
    { value: 'qwen3-tts-0.6b', label: 'Qwen3-TTS 0.6B', hint: 'Faster, lighter' }
  ],
  'local-kokoro': [{ value: 'kokoro-82m', label: 'Kokoro 82M' }],
  'local-pocket': [{ value: 'pocket-tts', label: 'Pocket TTS 100M' }],
  elevenlabs: [
    { value: 'eleven_multilingual_v2', label: 'Multilingual v2', hint: 'Stable, lifelike' },
    { value: 'eleven_v3', label: 'Eleven v3', hint: 'Most expressive · audio tags' },
    { value: 'eleven_flash_v2_5', label: 'Flash v2.5', hint: 'Fast & cheap' },
    { value: 'eleven_turbo_v2_5', label: 'Turbo v2.5', hint: 'Low latency, good quality' }
  ],
  'openai-tts': [
    { value: 'gpt-4o-mini-tts', label: 'gpt-4o-mini-tts', hint: 'Follows delivery notes' },
    { value: 'tts-1-hd', label: 'tts-1-hd', hint: 'Classic, high quality' }
  ],
  azure: [{ value: 'neural', label: 'Neural', hint: 'Styles from delivery notes' }],
  // Filled at runtime from the phone's downloaded models (voice:models).
  device: []
}

export const VOICE_LANGUAGES = ['Auto', 'English', 'Chinese', 'Japanese', 'Korean', 'German', 'French', 'Russian', 'Portuguese', 'Spanish', 'Italian']

/** Pocket TTS languages (one small model per language). */
export const POCKET_LANGUAGES = ['English', 'French', 'German', 'Portuguese', 'Italian', 'Spanish', 'Dutch']

/** Kokoro languages by voice-id prefix. */
export const KOKORO_LANGUAGES: { code: string; label: string; short: string }[] = [
  { code: 'a', label: 'American English', short: 'US English' },
  { code: 'b', label: 'British English', short: 'UK English' },
  { code: 'e', label: 'Spanish', short: 'Spanish' },
  { code: 'f', label: 'French', short: 'French' },
  { code: 'h', label: 'Hindi', short: 'Hindi' },
  { code: 'i', label: 'Italian', short: 'Italian' },
  { code: 'p', label: 'Brazilian Portuguese', short: 'Portuguese' },
  { code: 'z', label: 'Mandarin Chinese', short: 'Mandarin' }
]

/** Lines that are pleasant to read aloud and cover a wide range of sounds. */
export const READ_ALOUD = [
  'The old lighthouse keeper watched the storm roll in, counting every flash of lightning over the grey, restless sea.',
  'I never expected the key to fit, but the lock turned with a soft click, and the door swung open onto a garden I had never seen.',
  'Quick, before the lanterns go out! We follow the river north until the mountains swallow the moon.'
]

export const DEFAULT_PREVIEW_LINE = 'Hello there. This is how I sound when I tell the story — steady, clear, and ready for adventure.'

const PREVIEW_LINES: [RegExp, string][] = [
  [/spanish|^es/i, 'Hola. Así sueno cuando cuento la historia: tranquilo, claro y listo para la aventura.'],
  [/french|^fr/i, 'Bonjour. Voici ma voix quand je raconte l’histoire : calme, claire et prête pour l’aventure.'],
  [/german|^de/i, 'Hallo. So klinge ich, wenn ich die Geschichte erzähle – ruhig, klar und bereit für das Abenteuer.'],
  [/italian|^it/i, 'Ciao. Ecco come suono quando racconto la storia: calmo, chiaro e pronto per l’avventura.'],
  [/portug|^pt/i, 'Olá. É assim que eu soo quando conto a história: calmo, claro e pronto para a aventura.'],
  [/dutch|^nl/i, 'Hallo. Zo klink ik als ik het verhaal vertel: rustig, helder en klaar voor avontuur.'],
  [/hindi|^hi/i, 'नमस्ते। कहानी सुनाते समय मेरी आवाज़ ऐसी लगती है — शांत, साफ़ और रोमांच के लिए तैयार।'],
  [/chinese|mandarin|^zh/i, '你好。这就是我讲故事时的声音——平静、清晰，随时准备冒险。'],
  [/japanese|^ja/i, 'こんにちは。物語を語るとき、私はこんな声です。'],
  [/korean|^ko/i, '안녕하세요. 이야기를 들려줄 때 저는 이런 목소리예요.']
]

/** A preview line in the voice's language (English otherwise). */
export function previewLine(language?: string): string {
  if (!language) return DEFAULT_PREVIEW_LINE
  return PREVIEW_LINES.find(([re]) => re.test(language))?.[1] ?? DEFAULT_PREVIEW_LINE
}

export const DELIVERY_PRESETS: { label: string; value: string }[] = [
  { label: 'Narrator', value: 'calm, measured storyteller' },
  { label: 'Whisper', value: 'whispering, intimate' },
  { label: 'Excited', value: 'excited, energetic' },
  { label: 'Menacing', value: 'menacing, low and slow' },
  { label: 'Warm', value: 'warm, gentle and kind' },
  { label: 'Sad', value: 'sad, quiet, holding back tears' },
  { label: 'Afraid', value: 'afraid, breathless' },
  { label: 'Commanding', value: 'commanding, confident, loud' }
]

export const DESIGN_IDEAS: { label: string; text: string }[] = [
  { label: 'Sea captain', text: 'A gravelly old sea captain, slow and warm, with a hint of a laugh' },
  { label: 'Elven scout', text: 'A young, bright-eyed elven scout — quick, light and curious' },
  { label: 'Silky villain', text: 'A cold, silky villain who never raises his voice' },
  { label: 'Innkeeper', text: 'A cheerful middle-aged innkeeper, round and booming' },
  { label: 'Noir detective', text: 'A tired detective in a noir film, low and smoky' },
  { label: 'Oracle', text: 'An ancient, whispery oracle who speaks in slow riddles' }
]

// ─── Connectors ──────────────────────────────────────────────────────────────

const KIND_ORDER: VoiceKind[] = ['local-qwen', 'local-kokoro', 'local-pocket', 'elevenlabs', 'openai-tts', 'azure']

export function useVoiceConnectors(): VoiceConnector[] {
  const all = useCollection('connectors')
  return useMemo(
    () =>
      all
        .filter((c): c is VoiceConnector => c.category === 'voice' && c.enabled)
        .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.createdAt - b.createdAt),
    [all]
  )
}

/** The connector a voice resolves to — same order as the main process. */
export function useResolvedConnector(voice: CharacterVoice | undefined): VoiceConnector | undefined {
  const connectors = useVoiceConnectors()
  const def = useSettings((s) => s.settings?.defaultVoice?.connectorId)
  return (
    connectors.find((c) => c.id === voice?.connectorId) ??
    connectors.find((c) => c.id === def) ??
    connectors.find((c) => c.kind === 'local-qwen') ??
    connectors[0]
  )
}

// ─── Engine status ───────────────────────────────────────────────────────────

const useEngineStore = create<{ status: VoiceEngineStatus | null }>(() => ({ status: null }))
let engineSubscribed = false

export function useVoiceEngine(): VoiceEngineStatus | null {
  useEffect(() => {
    if (engineSubscribed) return
    engineSubscribed = true
    on('voice:engine', (status) => useEngineStore.setState({ status }))
    void invoke('voice:engineStatus').then((status) => useEngineStore.setState({ status }))
  }, [])
  return useEngineStore((s) => s.status)
}

// ─── Engines (voice:engines) ─────────────────────────────────────────────────

const useEnginesStore = create<{ engines: VoiceEngineInfo[] | null }>(() => ({ engines: null }))
let enginesSubscribed = false

/** Every voice engine with install state; refreshed by each `voice:engine` event. */
export function useVoiceEngines(): VoiceEngineInfo[] | null {
  useEffect(() => {
    if (enginesSubscribed) return
    enginesSubscribed = true
    on('voice:engine', (status) => {
      if (status.engines) useEnginesStore.setState({ engines: status.engines })
    })
    void refreshVoiceEngines()
  }, [])
  return useEnginesStore((s) => s.engines)
}

export async function refreshVoiceEngines(): Promise<void> {
  try {
    useEnginesStore.setState({ engines: await invoke('voice:engines') })
  } catch {
    /* main not ready */
  }
}

/** Install/removal progress for one engine, from the shared engine status. */
export function engineProgress(s: VoiceEngineStatus | null, id: VoiceEngineId): { label: string; value?: number } | undefined {
  if (!s || s.installing !== id || !s.activity) return undefined
  const a = s.activity
  const value = a.steps ? Math.min(0.98, ((a.step ?? 1) - 1 + (a.progress ?? 0.35)) / a.steps) : a.progress
  return { label: a.label, value }
}

export function engineStateLabel(s: VoiceEngineStatus | null): { label: string; tone: 'online' | 'offline' | 'busy' | 'warn' } {
  if (!s) return { label: 'Checking…', tone: 'offline' }
  if (s.busy === 'installing') return { label: 'Installing', tone: 'busy' }
  if (s.busy === 'starting') return { label: 'Starting', tone: 'busy' }
  if (s.busy === 'loading-model') return { label: s.activity?.label?.startsWith('Downloading') ? 'Downloading model' : 'Loading model', tone: 'busy' }
  if (s.busy === 'generating') return { label: 'Generating', tone: 'busy' }
  if (s.error && !s.running) return { label: 'Needs attention', tone: 'warn' }
  if (s.running) return { label: 'Running', tone: 'online' }
  if (s.installed) return { label: 'Ready · starts on demand', tone: 'offline' }
  return { label: 'Not installed', tone: 'offline' }
}

// ─── Voice lists ─────────────────────────────────────────────────────────────

const voiceCache = new Map<string, VoiceInfo[]>()
const voiceInflight = new Map<string, Promise<VoiceInfo[]>>()
/** Bumped by forgetVoices so every open list for that connector reloads. */
const useVoiceListVersion = create<Record<string, number>>(() => ({}))

/** Drop a connector's cached voice list (after cloning / adding a library voice); open lists reload. */
export function forgetVoices(connectorId: ID): void {
  voiceCache.delete(connectorId)
  useVoiceListVersion.setState((v) => ({ [connectorId]: (v[connectorId] ?? 0) + 1 }))
}

function fetchVoices(connectorId: ID): Promise<VoiceInfo[]> {
  const pending = voiceInflight.get(connectorId)
  if (pending) return pending
  const p = invoke('voice:voices', connectorId)
    .then((list) => {
      voiceCache.set(connectorId, list)
      return list
    })
    .finally(() => voiceInflight.delete(connectorId))
  voiceInflight.set(connectorId, p)
  return p
}

export function useVoices(connectorId: ID | undefined): { voices: VoiceInfo[]; loading: boolean; error?: string; refresh: () => void } {
  const [voices, setVoices] = useState<VoiceInfo[]>(() => (connectorId ? (voiceCache.get(connectorId) ?? []) : []))
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const version = useVoiceListVersion((v) => (connectorId ? (v[connectorId] ?? 0) : 0))
  const load = useCallback(
    async (force: boolean) => {
      if (!connectorId) return
      if (!force && voiceCache.has(connectorId)) {
        setVoices(voiceCache.get(connectorId)!)
        return
      }
      if (force) voiceCache.delete(connectorId)
      setLoading(true)
      setError(undefined)
      try {
        setVoices(await fetchVoices(connectorId))
      } catch (err) {
        setError(errorText(err))
      } finally {
        setLoading(false)
      }
    },
    [connectorId]
  )
  useEffect(() => {
    setVoices(connectorId ? (voiceCache.get(connectorId) ?? []) : [])
    void load(false)
  }, [connectorId, load, version])
  return { voices, loading, error, refresh: () => void load(true) }
}

/** Models for a connector: ElevenLabs lists the account's models live, the rest use VOICE_MODELS. */
export function useVoiceModels(connector: VoiceConnector | undefined): { value: string; label: string; hint?: string }[] {
  const fallback = connector ? VOICE_MODELS[connector.kind] : []
  const [live, setLive] = useState<{ id: string; list: { value: string; label: string; hint?: string }[] } | null>(null)
  const id = connector?.kind === 'elevenlabs' && connector.hasKey ? connector.id : undefined
  useEffect(() => {
    if (!id) return
    let alive = true
    invoke('voice:models', id)
      .then((list) => alive && list.length && setLive({ id, list }))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [id])
  return live && live.id === id ? live.list : fallback
}

// ─── Presets (saved voices live on their sample asset) ───────────────────────

export interface VoicePresetMeta {
  name?: string
  sampleText?: string
  design?: string
  language?: string
}

export function presetMeta(a: Asset): VoicePresetMeta | undefined {
  if (!a.tags?.includes('voice-preset')) return undefined
  return (a.params?.voicePreset as VoicePresetMeta | undefined) ?? {}
}

export function useVoicePresets(): Asset[] {
  const assets = useCollection('assets')
  return useMemo(() => assets.filter((a) => a.kind === 'audio' && a.tags?.includes('voice-preset')), [assets])
}

export async function saveVoicePreset(asset: Asset, meta: VoicePresetMeta): Promise<void> {
  const tags = [...new Set([...(asset.tags ?? []), 'voice-preset'])]
  await db.patch('assets', asset.id, { tags, params: { ...(asset.params ?? {}), voicePreset: meta }, name: meta.name || asset.name })
}

export function voiceFromPreset(asset: Asset, connectorId?: ID): CharacterVoice {
  const p = presetMeta(asset) ?? {}
  return { connectorId, sampleAssetId: asset.id, sampleText: p.sampleText, design: p.design, language: p.language }
}

// ─── Speaking ────────────────────────────────────────────────────────────────

export function speak(req: SpeakRequest): Promise<Asset> {
  return invoke('voice:speak', req)
}

/** Readable name for a provider voice id when the voice list isn't at hand (Kokoro "bf_emma" → "Emma"). */
export function prettyVoiceId(id: string): string {
  const one = id.split(',')[0]
  const bare = /^[a-z]{2}_[a-z0-9_]+$/.test(one) ? one.slice(3) : one
  return bare
    .split('_')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ')
}

/** Short human description of a voice for chips and summaries. */
export function describeVoice(v: CharacterVoice | undefined, sampleName?: string, voiceName?: string): { title: string; kind: 'clone' | 'design' | 'voice' | 'none' } {
  if (!v) return { title: 'No voice yet', kind: 'none' }
  if (v.voiceId && voiceName && !v.voiceId.startsWith('clone:')) return { title: voiceName, kind: 'voice' }
  if (v.sampleAssetId && v.design) return { title: v.design.length > 60 ? `${v.design.slice(0, 58)}…` : v.design, kind: 'design' }
  if (v.sampleAssetId) return { title: sampleName ? `Cloned from “${sampleName}”` : 'Cloned from a sample', kind: 'clone' }
  if (v.voiceId?.startsWith('clone:')) return { title: voiceName ?? 'Cloned voice', kind: 'clone' }
  if (v.voiceId) return { title: prettyVoiceId(v.voiceId), kind: 'voice' }
  if (v.design) return { title: v.design.length > 60 ? `${v.design.slice(0, 58)}…` : v.design, kind: 'design' }
  return { title: 'Default voice', kind: 'none' }
}

/** ~155 words per minute. */
export function estimateSpeechSeconds(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length
  return words / 2.6
}
