// Voice helpers shared by the Voice studio, VoicePicker and the engine card.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { create } from 'zustand'
import type { SpeakRequest, VoiceEngineStatus, VoiceInfo } from '@shared/ipc'
import type { Asset, CharacterVoice, ID, VoiceConnector, VoiceKind } from '@shared/types'
import { errorText, invoke, on } from './api'
import { db, useCollection } from '@/stores/db'
import { useSettings } from '@/stores/settings'

export const VOICE_KIND_LABEL: Record<VoiceKind, string> = {
  'local-qwen': 'Stitch Voice',
  elevenlabs: 'ElevenLabs',
  'openai-tts': 'OpenAI',
  azure: 'Azure'
}

export const VOICE_KIND_TAGLINE: Record<VoiceKind, string> = {
  'local-qwen': 'Local · Qwen3-TTS · clone & design',
  elevenlabs: 'Cloud · voice library & instant cloning',
  'openai-tts': 'Cloud · steerable gpt-4o-mini-tts',
  azure: 'Cloud · 400+ neural voices & styles'
}

/** Models offered per provider (first = default). */
export const VOICE_MODELS: Record<VoiceKind, { value: string; label: string; hint?: string }[]> = {
  'local-qwen': [
    { value: 'qwen3-tts-1.7b', label: 'Qwen3-TTS 1.7B', hint: 'Best likeness' },
    { value: 'qwen3-tts-0.6b', label: 'Qwen3-TTS 0.6B', hint: 'Faster, lighter' }
  ],
  elevenlabs: [
    { value: 'eleven_multilingual_v2', label: 'Multilingual v2', hint: 'Stable, lifelike' },
    { value: 'eleven_v3', label: 'Eleven v3', hint: 'Most expressive · audio tags' },
    { value: 'eleven_flash_v2_5', label: 'Flash v2.5', hint: 'Fast & cheap' }
  ],
  'openai-tts': [
    { value: 'gpt-4o-mini-tts', label: 'gpt-4o-mini-tts', hint: 'Follows delivery notes' },
    { value: 'tts-1-hd', label: 'tts-1-hd', hint: 'Classic, high quality' }
  ],
  azure: [{ value: 'neural', label: 'Neural', hint: 'Styles from delivery notes' }]
}

export const VOICE_LANGUAGES = ['Auto', 'English', 'Chinese', 'Japanese', 'Korean', 'German', 'French', 'Russian', 'Portuguese', 'Spanish', 'Italian']

/** Lines that are pleasant to read aloud and cover a wide range of sounds. */
export const READ_ALOUD = [
  'The old lighthouse keeper watched the storm roll in, counting every flash of lightning over the grey, restless sea.',
  'I never expected the key to fit, but the lock turned with a soft click, and the door swung open onto a garden I had never seen.',
  'Quick, before the lanterns go out! We follow the river north until the mountains swallow the moon.'
]

export const DEFAULT_PREVIEW_LINE = 'Hello there. This is how I sound when I tell the story — steady, clear, and ready for adventure.'

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

const KIND_ORDER: VoiceKind[] = ['local-qwen', 'elevenlabs', 'openai-tts', 'azure']

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

export function useVoices(connectorId: ID | undefined): { voices: VoiceInfo[]; loading: boolean; error?: string; refresh: () => void } {
  const [voices, setVoices] = useState<VoiceInfo[]>(() => (connectorId ? (voiceCache.get(connectorId) ?? []) : []))
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const load = useCallback(
    async (force: boolean) => {
      if (!connectorId) return
      if (!force && voiceCache.has(connectorId)) {
        setVoices(voiceCache.get(connectorId)!)
        return
      }
      setLoading(true)
      setError(undefined)
      try {
        const list = await invoke('voice:voices', connectorId)
        voiceCache.set(connectorId, list)
        setVoices(list)
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
  }, [connectorId, load])
  return { voices, loading, error, refresh: () => void load(true) }
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

/** Short human description of a voice for chips and summaries. */
export function describeVoice(v: CharacterVoice | undefined, sampleName?: string): { title: string; kind: 'clone' | 'design' | 'voice' | 'none' } {
  if (!v) return { title: 'No voice yet', kind: 'none' }
  if (v.sampleAssetId && v.design) return { title: v.design.length > 60 ? `${v.design.slice(0, 58)}…` : v.design, kind: 'design' }
  if (v.sampleAssetId) return { title: sampleName ? `Cloned from “${sampleName}”` : 'Cloned from a sample', kind: 'clone' }
  if (v.voiceId?.startsWith('clone:')) return { title: 'Cloned voice', kind: 'clone' }
  if (v.voiceId) return { title: v.voiceId.replace(/_/g, ' '), kind: 'voice' }
  if (v.design) return { title: v.design.length > 60 ? `${v.design.slice(0, 58)}…` : v.design, kind: 'design' }
  return { title: 'Default voice', kind: 'none' }
}

/** ~155 words per minute. */
export function estimateSpeechSeconds(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length
  return words / 2.6
}
