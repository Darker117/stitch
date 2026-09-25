// OpenAI text-to-speech (and OpenAI-compatible speech servers via baseUrl).
import type { VoiceInfo } from '@shared/ipc'
import type { VoiceConnector } from '@shared/types'
import { concatBytes, concatWavs, fetchOk, isWav, splitForApi, type SynthArgs, type SynthOut, type VoiceProvider } from './common'

const P = 'OpenAI'
export const OPENAI_TTS_DEFAULT_MODEL = 'gpt-4o-mini-tts'

export const OPENAI_VOICES: VoiceInfo[] = [
  { id: 'alloy', name: 'Alloy', description: 'Neutral and balanced' },
  { id: 'ash', name: 'Ash', description: 'Clear, confident and direct' },
  { id: 'ballad', name: 'Ballad', description: 'Soft, melodic, a touch theatrical' },
  { id: 'coral', name: 'Coral', description: 'Warm and friendly' },
  { id: 'echo', name: 'Echo', description: 'Calm and resonant' },
  { id: 'fable', name: 'Fable', description: 'Expressive storyteller' },
  { id: 'nova', name: 'Nova', description: 'Bright and energetic' },
  { id: 'onyx', name: 'Onyx', description: 'Deep and authoritative' },
  { id: 'sage', name: 'Sage', description: 'Measured and thoughtful' },
  { id: 'shimmer', name: 'Shimmer', description: 'Light and airy' },
  { id: 'verse', name: 'Verse', description: 'Versatile and dramatic' },
  { id: 'marin', name: 'Marin', description: 'Natural, conversational — newest', labels: { tier: 'recommended' } },
  { id: 'cedar', name: 'Cedar', description: 'Natural, grounded — newest', labels: { tier: 'recommended' } }
]

const base = (c: VoiceConnector): string => (c.baseUrl?.trim() || 'https://api.openai.com/v1').replace(/\/+$/, '')
const isOfficial = (c: VoiceConnector): boolean => /api\.openai\.com/.test(base(c))

function headers(c: VoiceConnector, key: string | undefined): Record<string, string> {
  if (!key && isOfficial(c)) throw new Error(`${c.name} has no API key — add one in Connectors`)
  return { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) }
}

export const openaiProvider: VoiceProvider = {
  async voices() {
    return OPENAI_VOICES
  },

  async speak(a: SynthArgs): Promise<SynthOut> {
    const model = a.model ?? a.c.model ?? OPENAI_TTS_DEFAULT_MODEL
    const voice = a.voice.voiceId && !a.voice.voiceId.startsWith('clone:') ? a.voice.voiceId : 'alloy'
    const steerable = !/^tts-1/.test(model)
    const parts: Uint8Array[] = []
    for (const chunk of splitForApi(a.text, 4000)) {
      const body: Record<string, unknown> = { model, voice, input: chunk, response_format: 'mp3' }
      if (steerable && a.instructions?.trim()) body.instructions = a.instructions.trim()
      const res = await fetchOk(`${base(a.c)}/audio/speech`, { method: 'POST', headers: headers(a.c, a.key), body: JSON.stringify(body) }, P, 300_000)
      parts.push(new Uint8Array(await res.arrayBuffer()))
    }
    // OpenAI-compatible servers (Stitch Voice included) may answer with WAV whatever was asked.
    const wav = parts.every(isWav)
    return { bytes: wav ? concatWavs(parts) : concatBytes(parts), ext: wav ? 'wav' : 'mp3', model, voiceId: voice, note: !steerable && a.instructions ? `${model} ignores delivery notes — use gpt-4o-mini-tts.` : undefined }
  },

  async test(c, key) {
    const res = await fetchOk(`${base(c)}/models`, { headers: headers(c, key) }, P, 20_000)
    const j = (await res.json().catch(() => ({}))) as { data?: { id: string }[] }
    const tts = (j.data ?? []).filter((m) => /tts/i.test(m.id)).map((m) => m.id)
    return tts.length ? `Connected — ${tts.slice(0, 4).join(', ')}` : 'Connected'
  }
}
