// Local Kokoro-82M provider (hexgrad/Kokoro-82M, Apache-2.0): preset voices in 9 languages.
import type { VoiceInfo } from '@shared/ipc'
import type { SynthArgs, SynthOut, VoiceProvider } from './common'
import { engineAudio, engineSummary } from './engine'

/** Kokoro language codes — the first letter of every voice id. */
export const KOKORO_LANGS: Record<string, string> = {
  a: 'American English',
  b: 'British English',
  e: 'Spanish',
  f: 'French',
  h: 'Hindi',
  i: 'Italian',
  j: 'Japanese',
  p: 'Brazilian Portuguese',
  z: 'Mandarin Chinese'
}

/** Languages whose text frontend Stitch installs (Japanese needs an extra pack Stitch doesn't ship). */
const SUPPORTED_LANGS = new Set(['a', 'b', 'e', 'f', 'h', 'i', 'p', 'z'])

// [id, overall grade from VOICES.md, note]
const RAW: [string, string, string?][] = [
  ['af_heart', 'A', 'Warm and bright — the flagship voice'],
  ['af_bella', 'A-', 'Lively, polished and expressive'],
  ['af_nicole', 'B-', 'Soft, close-mic ASMR delivery'],
  ['af_aoede', 'C+'],
  ['af_kore', 'C+'],
  ['af_sarah', 'C+'],
  ['af_alloy', 'C'],
  ['af_nova', 'C'],
  ['af_sky', 'C-'],
  ['af_jessica', 'D'],
  ['af_river', 'D'],
  ['am_fenrir', 'C+', 'Deep and steady'],
  ['am_michael', 'C+', 'Clear, friendly narrator'],
  ['am_puck', 'C+', 'Playful and quick'],
  ['am_echo', 'D'],
  ['am_eric', 'D'],
  ['am_liam', 'D'],
  ['am_onyx', 'D'],
  ['am_santa', 'D-'],
  ['am_adam', 'F+'],
  ['bf_emma', 'B-', 'Composed British storyteller'],
  ['bf_isabella', 'C'],
  ['bf_alice', 'D'],
  ['bf_lily', 'D'],
  ['bm_fable', 'C', 'Warm British narrator'],
  ['bm_george', 'C', 'Mature British gentleman'],
  ['bm_lewis', 'D+'],
  ['bm_daniel', 'D'],
  ['ef_dora', 'C'],
  ['em_alex', 'C'],
  ['em_santa', 'C'],
  ['ff_siwis', 'B-'],
  ['hf_alpha', 'C'],
  ['hf_beta', 'C'],
  ['hm_omega', 'C'],
  ['hm_psi', 'C'],
  ['if_sara', 'C'],
  ['im_nicola', 'C'],
  ['pf_dora', 'C'],
  ['pm_alex', 'C'],
  ['pm_santa', 'C'],
  ['zf_xiaobei', 'D'],
  ['zf_xiaoni', 'D'],
  ['zf_xiaoxiao', 'D'],
  ['zf_xiaoyi', 'D'],
  ['zm_yunjian', 'D'],
  ['zm_yunxi', 'D'],
  ['zm_yunxia', 'D'],
  ['zm_yunyang', 'D']
]

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export const KOKORO_VOICES: VoiceInfo[] = RAW.filter(([id]) => SUPPORTED_LANGS.has(id[0])).map(([id, grade, note]) => {
  const lang = KOKORO_LANGS[id[0]]
  const gender = id[1] === 'f' ? 'female' : 'male'
  return {
    id,
    name: titleCase(id.slice(3)),
    description: note ?? `${lang} ${gender} voice`,
    labels: { language: lang, lang: id[0], gender, grade }
  }
})

const DEFAULT_VOICE: Record<string, string> = { a: 'af_heart', b: 'bf_emma', e: 'ef_dora', f: 'ff_siwis', h: 'hf_alpha', i: 'if_sara', p: 'pf_dora', z: 'zf_xiaoxiao' }

/** Map a Stitch/Qwen language name or code onto a Kokoro language letter. */
function langFrom(language: string | undefined): string | undefined {
  if (!language) return undefined
  const l = language.toLowerCase()
  if (/brit|en-gb|uk/.test(l)) return 'b'
  if (/^en|english/.test(l)) return 'a'
  if (/^es|spanish/.test(l)) return 'e'
  if (/^fr|french/.test(l)) return 'f'
  if (/^hi|hindi/.test(l)) return 'h'
  if (/^it|italian/.test(l)) return 'i'
  if (/^pt|portug/.test(l)) return 'p'
  if (/^zh|chinese|mandarin/.test(l)) return 'z'
  return undefined
}

const KNOWN = new Set(KOKORO_VOICES.map((v) => v.id))

/** Kokoro has no delivery control beyond pace — read speed hints from the direction. */
function speedFrom(instructions: string | undefined): number | undefined {
  if (!instructions) return undefined
  const s = instructions.toLowerCase()
  if (/\b(slow|slowly|measured|calm|deliberate|drawl)\b/.test(s)) return 0.9
  if (/\b(fast|quick|quickly|rapid|hurried|urgent|excited|breathless|energetic)\b/.test(s)) return 1.12
  return undefined
}

export const kokoroProvider: VoiceProvider = {
  async voices() {
    return KOKORO_VOICES
  },

  async speak(a: SynthArgs): Promise<SynthOut> {
    const notes: string[] = []
    const requested = a.voice.voiceId?.split(',').map((v) => v.trim()).filter(Boolean) ?? []
    let voice = requested.filter((v) => KNOWN.has(v)).join(',')
    if (!voice) {
      const lang = langFrom(a.voice.language) ?? 'a'
      voice = DEFAULT_VOICE[lang] ?? 'af_heart'
      if (a.voice.sampleAssetId) notes.push("Kokoro can't clone voices — used a preset voice. Pick Qwen3-TTS or Pocket TTS to clone.")
      else if (requested.length) notes.push(`“${requested.join(', ')}” isn't a Kokoro voice — used ${voice}.`)
    }
    const speed = speedFrom(a.instructions)
    if (a.instructions && speed === undefined) notes.push('Kokoro follows delivery notes only as pace (slow / fast).')
    const { bytes, info } = await engineAudio('/tts', { text: a.text, voice, speed }, 'kokoro-82m', 'kokoro')
    const used = info.speaker ?? voice
    const voiceName = used
      .split(',')
      .map((id) => KOKORO_VOICES.find((v) => v.id === id)?.name ?? id)
      .join(' + ')
    return { bytes, ext: 'wav', model: 'Kokoro-82M', voiceId: used, voiceName, note: notes.join(' ') || undefined }
  },

  async test() {
    const s = await engineSummary('kokoro')
    if (!s.ok) throw new Error(s.message)
    return s.message
  }
}
