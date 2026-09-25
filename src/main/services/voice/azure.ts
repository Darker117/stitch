// Azure AI Speech neural TTS over REST with SSML (styles via mstts:express-as).
import type { VoiceConnector } from '@shared/types'
import { concatBytes, escapeXml, fetchOk, requireKey, splitForApi, type SynthArgs, type SynthOut, type VoiceProvider } from './common'

const P = 'Azure Speech'
export const AZURE_DEFAULT_VOICE = 'en-US-AvaMultilingualNeural'

interface AzureVoice {
  ShortName: string
  DisplayName: string
  LocalName?: string
  Gender?: string
  Locale: string
  LocaleName?: string
  StyleList?: string[]
  VoiceType?: string
  Status?: string
}

function host(c: VoiceConnector): string {
  if (c.region?.trim()) return `https://${c.region.trim()}.tts.speech.microsoft.com`
  if (c.baseUrl?.trim()) return c.baseUrl.trim().replace(/\/+$/, '').replace(/\/cognitiveservices.*$/, '')
  throw new Error(`${c.name}: set the Azure region (e.g. eastus) in Connectors`)
}

const cache = new Map<string, { at: number; raw: AzureVoice[] }>()

async function rawVoices(c: VoiceConnector, key: string): Promise<AzureVoice[]> {
  const hit = cache.get(c.id)
  if (hit && Date.now() - hit.at < 30 * 60_000) return hit.raw
  const res = await fetchOk(`${host(c)}/cognitiveservices/voices/list`, { headers: { 'Ocp-Apim-Subscription-Key': key } }, P, 30_000)
  const raw = ((await res.json()) as AzureVoice[]).filter((v) => v.VoiceType !== 'Standard' && v.Status !== 'Deprecated')
  cache.set(c.id, { at: Date.now(), raw })
  return raw
}

// Delivery words → Azure speaking styles, most specific first.
const STYLE_MAP: [RegExp, string[]][] = [
  [/whisper/i, ['whispering']],
  [/shout|yell|scream/i, ['shouting']],
  [/terrif|horrif|panic/i, ['terrified', 'fearful']],
  [/afraid|scared|fear|nervous|anxious/i, ['fearful', 'terrified']],
  [/angry|furious|rage|\bmad\b/i, ['angry']],
  [/sad|sorrow|grief|mourn|melanchol|tearful/i, ['sad', 'depressed']],
  [/excit|thrill|energetic|hype/i, ['excited', 'cheerful']],
  [/happy|cheer|joy|upbeat|bright/i, ['cheerful', 'friendly']],
  [/hope/i, ['hopeful']],
  [/calm|sooth|relax|serene/i, ['calm', 'narration-relaxed']],
  [/gentle|soft|tender|loving/i, ['gentle', 'affectionate']],
  [/warm|friendly|kind/i, ['friendly', 'affectionate']],
  [/menac|threat|cold|hostile|unfriendly|sinister/i, ['unfriendly', 'serious']],
  [/serious|stern|grave/i, ['serious']],
  [/sarcas|grumpy|annoyed/i, ['disgruntled']],
  [/embarrass|shy|awkward/i, ['embarrassed']],
  [/empath|compassion|comfort/i, ['empathetic']],
  [/narrat|storytell/i, ['narration-professional', 'narration-relaxed']],
  [/news|announce/i, ['newscast']],
  [/poem|poetry|lyric/i, ['poetry-reading', 'lyrical']]
]

function pickStyle(instructions: string | undefined, styles: string[] | undefined): string | undefined {
  if (!instructions || !styles?.length) return undefined
  for (const [re, wanted] of STYLE_MAP) {
    if (!re.test(instructions)) continue
    const hit = wanted.find((w) => styles.includes(w))
    if (hit) return hit
  }
  return undefined
}

function rateFor(instructions: string | undefined): string | undefined {
  if (!instructions) return undefined
  if (/very slow/i.test(instructions)) return '-25%'
  if (/slow|unhurried|measured/i.test(instructions)) return '-12%'
  if (/very fast/i.test(instructions)) return '+25%'
  if (/fast|quick|hurr|rushed|rapid/i.test(instructions)) return '+12%'
  return undefined
}

function ssml(text: string, voice: string, locale: string, style?: string, rate?: string): string {
  let inner = escapeXml(text).replace(/\n{2,}/g, '<break time="450ms"/>')
  if (rate) inner = `<prosody rate="${rate}">${inner}</prosody>`
  if (style) inner = `<mstts:express-as style="${style}">${inner}</mstts:express-as>`
  return (
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${locale}">` +
    `<voice name="${escapeXml(voice)}">${inner}</voice></speak>`
  )
}

export const azureProvider: VoiceProvider = {
  async voices(c, key) {
    const raw = await rawVoices(c, requireKey(c, key))
    return raw.map((v) => ({
      id: v.ShortName,
      name: v.LocalName && v.LocalName !== v.DisplayName ? `${v.DisplayName} (${v.LocalName})` : v.DisplayName,
      description: [v.Gender, v.LocaleName ?? v.Locale, v.StyleList?.length ? `${v.StyleList.length} styles` : ''].filter(Boolean).join(' · '),
      labels: { locale: v.Locale, ...(v.Gender ? { gender: v.Gender.toLowerCase() } : {}), ...(v.StyleList?.length ? { styles: v.StyleList.join(',') } : {}) }
    }))
  },

  async speak(a: SynthArgs): Promise<SynthOut> {
    const key = requireKey(a.c, a.key)
    const voice = a.voice.voiceId && !a.voice.voiceId.startsWith('clone:') ? a.voice.voiceId : AZURE_DEFAULT_VOICE
    const locale = /^([a-z]{2,3}-[A-Z]{2})/.exec(voice)?.[1] ?? 'en-US'
    let styles: string[] | undefined
    if (a.instructions) {
      try {
        styles = (await rawVoices(a.c, key)).find((v) => v.ShortName === voice)?.StyleList
      } catch {
        styles = undefined
      }
    }
    const style = pickStyle(a.instructions, styles)
    const rate = rateFor(a.instructions)
    const parts: Uint8Array[] = []
    for (const chunk of splitForApi(a.text, 3000)) {
      const res = await fetchOk(
        `${host(a.c)}/cognitiveservices/v1`,
        {
          method: 'POST',
          headers: {
            'Ocp-Apim-Subscription-Key': key,
            'Content-Type': 'application/ssml+xml',
            'X-Microsoft-OutputFormat': 'audio-24khz-96kbitrate-mono-mp3',
            'User-Agent': 'Stitch'
          },
          body: ssml(chunk, voice, locale, style, rate)
        },
        P,
        300_000
      )
      parts.push(new Uint8Array(await res.arrayBuffer()))
    }
    return { bytes: concatBytes(parts), ext: 'mp3', model: style ? `neural · ${style}` : 'neural', voiceId: voice, kbps: 96 }
  },

  async test(c, key) {
    cache.delete(c.id)
    const raw = await rawVoices(c, requireKey(c, key))
    return `Connected — ${raw.length} neural voices in ${c.region ?? 'your region'}`
  }
}
