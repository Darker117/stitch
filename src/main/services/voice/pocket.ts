// Local Pocket TTS provider (kyutai-labs/pocket-tts — MIT code, CC-BY-4.0 weights).
// A 100M-parameter model that runs on the CPU: preset voices in 7 languages and
// zero-shot cloning from a short clip (the cloning weights are gated on Hugging Face).
import type { VoiceInfo } from '@shared/ipc'
import type { Asset } from '@shared/types'
import { db } from '../../store'
import { getAsset } from '../assets'
import type { SynthArgs, SynthOut, VoiceProvider } from './common'
import { engineAudio, engineSummary, pocketToken, refAudio } from './engine'
import { presetOf } from './local'

export const POCKET_LANGUAGE_NAMES: Record<string, string> = {
  english: 'English',
  french: 'French',
  german: 'German',
  portuguese: 'Portuguese',
  italian: 'Italian',
  spanish: 'Spanish',
  dutch: 'Dutch'
}

// [id, gender, native language, description]
const RAW: [string, 'female' | 'male', string, string][] = [
  ['alba', 'female', 'English', 'Relaxed, conversational — the default voice'],
  ['marius', 'male', 'English', 'Easygoing, natural and close'],
  ['javert', 'male', 'English', 'Firm, grounded and serious'],
  ['jean', 'male', 'English', 'Calm, clear storyteller'],
  ['cosette', 'female', 'English', 'Light and wondering'],
  ['fantine', 'female', 'English', 'Soft and gentle'],
  ['eponine', 'female', 'English', 'Bright and direct'],
  ['azelma', 'female', 'English', 'Youthful and quick'],
  ['anna', 'female', 'English', 'Crisp British reader'],
  ['vera', 'female', 'English', 'Poised and precise'],
  ['mary', 'female', 'English', 'Warm, even narrator'],
  ['jane', 'female', 'English', 'Clear and friendly'],
  ['eve', 'female', 'English', 'Smooth and measured'],
  ['caro_davy', 'female', 'English', 'Expressive, theatrical'],
  ['charles', 'male', 'English', 'Measured British gentleman'],
  ['paul', 'male', 'English', 'Plain-spoken and steady'],
  ['george', 'male', 'English', 'Low and reassuring'],
  ['michael', 'male', 'English', 'Bright, upbeat narrator'],
  ['bill_boerst', 'male', 'English', 'Seasoned, gravelly character voice'],
  ['peter_yearsley', 'male', 'English', 'Classic audiobook narrator'],
  ['stuart_bell', 'male', 'English', 'Rich, resonant storyteller'],
  ['estelle', 'female', 'French', 'Native French speaker'],
  ['juergen', 'male', 'German', 'Native German speaker'],
  ['giovanni', 'male', 'Italian', 'Native Italian speaker'],
  ['lola', 'female', 'Spanish', 'Native Spanish speaker'],
  ['rafael', 'male', 'Portuguese', 'Native Portuguese speaker'],
  ['daan', 'male', 'Dutch', 'Native Dutch speaker']
]

export const POCKET_VOICES: VoiceInfo[] = RAW.map(([id, gender, language, description]) => ({
  id,
  name: id
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' '),
  description,
  labels: { gender, language }
}))

const KNOWN = new Set(POCKET_VOICES.map((v) => v.id))

/** Stitch language name / code → Pocket TTS config language (undefined = unsupported). */
export function pocketLanguage(language: string | undefined): string | undefined {
  if (!language || language === 'Auto') return 'english'
  const l = language.toLowerCase()
  const codes: Record<string, string> = { en: 'english', fr: 'french', de: 'german', pt: 'portuguese', it: 'italian', es: 'spanish', nl: 'dutch' }
  const base = l.split(/[-_ (]/)[0]
  if (codes[base]) return codes[base]
  return Object.keys(POCKET_LANGUAGE_NAMES).find((k) => l.startsWith(k))
}

export const pocketProvider: VoiceProvider = {
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
          labels: { ...(p.language ? { language: p.language } : {}), source: 'cloned' }
        }
      })
    return [...presets, ...POCKET_VOICES]
  },

  async speak(a: SynthArgs): Promise<SynthOut> {
    const { voice } = a
    const notes: string[] = []
    let language = pocketLanguage(voice.language)
    if (!language) {
      notes.push(`Pocket TTS doesn't speak ${voice.language} — used English.`)
      language = 'english'
    }
    const body: Record<string, unknown> = { text: a.text, language, hf_token: pocketToken() }

    let sampleId = voice.sampleAssetId
    if (!sampleId && voice.voiceId?.startsWith('clone:')) sampleId = voice.voiceId.slice(6)
    const preset = voice.voiceId && KNOWN.has(voice.voiceId) ? voice.voiceId : undefined
    if (sampleId && !preset) {
      const sample: Asset = getAsset(sampleId)
      Object.assign(body, await refAudio(sample))
    } else {
      body.voice = preset
      if (voice.voiceId && !preset && !voice.voiceId.startsWith('clone:')) notes.push(`“${voice.voiceId}” isn't a Pocket TTS voice — used the default.`)
    }
    if (a.instructions) notes.push('Pocket TTS takes its delivery from the voice itself — clone a sample spoken the way you want.')
    const { bytes, info } = await engineAudio('/tts', body, `pocket-${language}`, 'pocket')
    const voiceName = info.speaker ? POCKET_VOICES.find((v) => v.id === info.speaker)?.name : undefined
    return { bytes, ext: 'wav', model: info.model ?? 'Pocket TTS', voiceId: info.speaker, voiceName, note: notes.join(' ') || undefined }
  },

  async clone(_c, _key, _name, sample) {
    // Zero-shot like Qwen3-TTS: validate the clip converts now so errors surface early.
    await refAudio(sample)
    return `clone:${sample.id}`
  },

  async test() {
    const s = await engineSummary('pocket')
    if (!s.ok) throw new Error(s.message)
    return s.message
  }
}
