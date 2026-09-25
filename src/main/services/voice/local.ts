// Local Qwen3-TTS provider (voice cloning, preset speakers, voice design).
import type { VoiceInfo } from '@shared/ipc'
import type { Asset } from '@shared/types'
import { db } from '../../store'
import { getAsset } from '../assets'
import { hashSeed, type SynthArgs, type SynthOut, type VoiceProvider } from './common'
import { engineAudio, engineSummary, refAudio } from './engine'

export const LOCAL_SPEAKERS: VoiceInfo[] = [
  { id: 'Ryan', name: 'Ryan', description: 'Dynamic male voice with strong rhythmic drive', labels: { language: 'English', gender: 'male' } },
  { id: 'Aiden', name: 'Aiden', description: 'Sunny American male voice with a clear midrange', labels: { language: 'English', gender: 'male' } },
  { id: 'Vivian', name: 'Vivian', description: 'Bright, slightly edgy young female voice', labels: { language: 'Chinese', gender: 'female' } },
  { id: 'Serena', name: 'Serena', description: 'Warm, gentle young female voice', labels: { language: 'Chinese', gender: 'female' } },
  { id: 'Uncle_Fu', name: 'Uncle Fu', description: 'Seasoned male voice with a low, mellow timbre', labels: { language: 'Chinese', gender: 'male' } },
  { id: 'Dylan', name: 'Dylan', description: 'Youthful Beijing male voice with a clear, natural timbre', labels: { language: 'Chinese', gender: 'male' } },
  { id: 'Eric', name: 'Eric', description: 'Lively Chengdu male voice with a slightly husky brightness', labels: { language: 'Chinese', gender: 'male' } },
  { id: 'Ono_Anna', name: 'Ono Anna', description: 'Playful Japanese female voice with a light, nimble timbre', labels: { language: 'Japanese', gender: 'female' } },
  { id: 'Sohee', name: 'Sohee', description: 'Warm Korean female voice with rich emotion', labels: { language: 'Korean', gender: 'female' } }
]

export const LANGUAGES = ['Auto', 'English', 'Chinese', 'Japanese', 'Korean', 'German', 'French', 'Russian', 'Portuguese', 'Spanish', 'Italian']

/** Saved voice presets live on their sample asset: tags include 'voice-preset', params.voicePreset holds the details. */
interface PresetMeta {
  name?: string
  sampleText?: string
  design?: string
  language?: string
}

export function presetOf(a: Asset): PresetMeta | undefined {
  if (!a.tags?.includes('voice-preset')) return undefined
  return (a.params?.voicePreset as PresetMeta | undefined) ?? {}
}

function sizeFor(model: string | undefined): '0.6B' | '1.7B' {
  return model && /0\.?6/i.test(model) ? '0.6B' : '1.7B'
}

export const localProvider: VoiceProvider = {
  async voices() {
    const presets: VoiceInfo[] = db('assets')
      .list()
      .filter((a) => a.kind === 'audio' && presetOf(a))
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((a) => {
        const p = presetOf(a)!
        return {
          id: `clone:${a.id}`,
          name: p.name || a.name,
          description: p.design || (p.sampleText ? `“${p.sampleText.slice(0, 80)}”` : 'Cloned from a sample'),
          cloned: true,
          labels: { ...(p.language ? { language: p.language } : {}), source: p.design ? 'designed' : 'cloned' }
        }
      })
    return [...presets, ...LOCAL_SPEAKERS]
  },

  async speak(a: SynthArgs): Promise<SynthOut> {
    const { voice } = a
    const size = sizeFor(a.model ?? a.c.model)
    const body: Record<string, unknown> = { text: a.text, language: voice.language, size }
    let needs: string

    let sampleId = voice.sampleAssetId
    let sampleText = voice.sampleText
    if (!sampleId && voice.voiceId?.startsWith('clone:')) {
      sampleId = voice.voiceId.slice(6)
      const asset = db('assets').get(sampleId)
      sampleText = sampleText ?? presetOf(asset ?? ({} as Asset))?.sampleText ?? (asset?.params?.sampleText as string | undefined)
    }

    if (sampleId) {
      const sample = getAsset(sampleId)
      Object.assign(body, await refAudio(sample))
      body.ref_text = sampleText?.trim() || undefined
      body.x_vector_only = !sampleText?.trim()
      needs = size === '0.6B' ? 'base-0.6b' : 'base-1.7b'
    } else if (voice.voiceId) {
      body.speaker = voice.voiceId
      body.instruct = a.instructions
      needs = size === '0.6B' ? 'custom-0.6b' : 'custom-1.7b'
    } else if (voice.design?.trim()) {
      body.design = voice.design.trim()
      body.instruct = a.instructions
      // Same description → same seed → the designed timbre stays stable between lines.
      body.seed = hashSeed(voice.design.trim())
      needs = 'design-1.7b'
    } else {
      body.instruct = a.instructions
      needs = size === '0.6B' ? 'custom-0.6b' : 'custom-1.7b'
    }

    const { bytes, info } = await engineAudio('/tts', body, needs)
    return { bytes, ext: 'wav', model: info.model, voiceId: info.speaker, note: info.note }
  },

  async clone(_c, _key, _name, sample) {
    // Cloning is per request (zero-shot); validate the clip converts now so errors surface early.
    await refAudio(sample)
    return `clone:${sample.id}`
  },

  async test() {
    const s = await engineSummary()
    if (!s.ok) throw new Error(s.message)
    return s.message
  }
}

/** Voice design: a new voice from a description, returned as WAV bytes. */
export async function designVoice(description: string, text: string, language?: string): Promise<{ bytes: Uint8Array; model?: string }> {
  const { bytes, info } = await engineAudio('/design', { text, instruct: description, language, seed: hashSeed(description.trim()) }, 'design-1.7b')
  return { bytes, model: info.model }
}
