// ElevenLabs: voice library, TTS and instant voice cloning.
import { readFileSync } from 'node:fs'
import { basename, extname } from 'node:path'
import type { VoiceInfo, VoiceLibraryQuery } from '@shared/ipc'
import type { VoiceConnector } from '@shared/types'
import { concatBytes, fetchOk, requireKey, splitForApi, type SynthArgs, type SynthOut, type VoiceProvider } from './common'

const P = 'ElevenLabs'
export const ELEVEN_DEFAULT_MODEL = 'eleven_multilingual_v2'

const base = (c: VoiceConnector): string => (c.baseUrl?.trim() || 'https://api.elevenlabs.io').replace(/\/+$/, '').replace(/\/v[12]$/, '')

interface ElevenVoice {
  voice_id: string
  name: string
  category?: string
  description?: string | null
  preview_url?: string | null
  labels?: Record<string, string>
}

const cache = new Map<string, { at: number; voices: VoiceInfo[] }>()

async function listVoices(c: VoiceConnector, key: string): Promise<VoiceInfo[]> {
  const hit = cache.get(c.id)
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.voices
  const out: VoiceInfo[] = []
  let token: string | undefined
  for (let page = 0; page < 6; page++) {
    const q = new URLSearchParams({ page_size: '100' })
    if (token) q.set('next_page_token', token)
    const res = await fetchOk(`${base(c)}/v2/voices?${q}`, { headers: { 'xi-api-key': key } }, P, 30_000)
    const j = (await res.json()) as { voices: ElevenVoice[]; has_more?: boolean; next_page_token?: string | null }
    for (const v of j.voices ?? []) {
      const labels = Object.fromEntries(Object.entries(v.labels ?? {}).filter(([, x]) => typeof x === 'string' && x))
      out.push({
        id: v.voice_id,
        name: v.name,
        description: v.description || Object.values(labels).join(' · ') || undefined,
        previewUrl: v.preview_url ?? undefined,
        labels: { ...labels, ...(v.category ? { category: v.category } : {}) },
        cloned: v.category === 'cloned' || v.category === 'generated' || v.category === 'professional'
      })
    }
    if (!j.has_more || !j.next_page_token) break
    token = j.next_page_token
  }
  cache.set(c.id, { at: Date.now(), voices: out })
  return out
}

// ─── Voice library (shared voices) ───────────────────────────────────────────

interface SharedVoice {
  public_owner_id: string
  voice_id: string
  name: string
  accent?: string
  gender?: string
  age?: string
  descriptive?: string
  use_case?: string
  category?: string
  language?: string | null
  locale?: string | null
  description?: string | null
  preview_url?: string | null
  cloned_by_count?: number
  free_users_allowed?: boolean
  is_added_by_user?: boolean | null
}

/** GET /v1/shared-voices — the public ElevenLabs voice library. */
export async function elevenLibrary(c: VoiceConnector, key: string | undefined, q: Omit<VoiceLibraryQuery, 'connectorId'>): Promise<{ voices: VoiceInfo[]; hasMore: boolean; total?: number }> {
  const k = requireKey(c, key)
  const params = new URLSearchParams({ page_size: '30', page: String(q.page ?? 0) })
  if (q.search?.trim()) params.set('search', q.search.trim())
  if (q.gender) params.set('gender', q.gender)
  if (q.age) params.set('age', q.age)
  if (q.accent) params.set('accent', q.accent)
  if (q.language) params.set('language', q.language)
  if (q.useCase) params.append('use_cases', q.useCase)
  if (q.category) params.set('category', q.category)
  if (q.sort) params.set('sort', q.sort)
  const res = await fetchOk(`${base(c)}/v1/shared-voices?${params}`, { headers: { 'xi-api-key': k } }, P, 30_000)
  const j = (await res.json()) as { voices?: SharedVoice[]; has_more?: boolean; total_count?: number }
  const voices: VoiceInfo[] = (j.voices ?? []).map((v) => {
    const labels: Record<string, string> = {}
    for (const [key_, val] of [
      ['gender', v.gender],
      ['age', v.age],
      ['accent', v.accent],
      ['language', v.language],
      ['use_case', v.use_case],
      ['descriptive', v.descriptive],
      ['category', v.category]
    ] as const) {
      if (typeof val === 'string' && val) labels[key_] = val.replace(/_/g, ' ')
    }
    if (v.cloned_by_count) labels.used = `${v.cloned_by_count.toLocaleString()} adds`
    if (v.is_added_by_user) labels.added = 'yes'
    return {
      id: v.voice_id,
      name: v.name,
      description: v.description?.trim() || [v.descriptive, v.use_case, v.accent].filter(Boolean).join(' · ').replace(/_/g, ' ') || undefined,
      previewUrl: v.preview_url ?? undefined,
      labels,
      ownerId: v.public_owner_id
    }
  })
  return { voices, hasMore: !!j.has_more, total: j.total_count }
}

/** POST /v1/voices/add/{public_user_id}/{voice_id} — add a library voice to "My voices". */
export async function elevenAddShared(c: VoiceConnector, key: string | undefined, ownerId: string, voiceId: string, name: string): Promise<string> {
  const k = requireKey(c, key)
  const res = await fetchOk(
    `${base(c)}/v1/voices/add/${encodeURIComponent(ownerId)}/${encodeURIComponent(voiceId)}`,
    { method: 'POST', headers: { 'xi-api-key': k, 'content-type': 'application/json' }, body: JSON.stringify({ new_name: name || 'Library voice' }) },
    P,
    30_000
  )
  const j = (await res.json()) as { voice_id?: string }
  cache.delete(c.id)
  if (!j.voice_id) throw new Error('ElevenLabs did not return a voice id')
  return j.voice_id
}

export const ELEVEN_MODELS: { value: string; label: string; hint?: string }[] = [
  { value: 'eleven_multilingual_v2', label: 'Multilingual v2', hint: 'Stable, lifelike' },
  { value: 'eleven_v3', label: 'Eleven v3', hint: 'Most expressive · audio tags' },
  { value: 'eleven_flash_v2_5', label: 'Flash v2.5', hint: 'Fast & cheap' },
  { value: 'eleven_turbo_v2_5', label: 'Turbo v2.5', hint: 'Low latency, good quality' }
]

const modelCache = new Map<string, { at: number; models: { value: string; label: string; hint?: string }[] }>()

/** GET /v1/models — text-to-speech models this account can use (falls back to a known list). */
export async function elevenModels(c: VoiceConnector, key: string | undefined): Promise<{ value: string; label: string; hint?: string }[]> {
  const hit = modelCache.get(c.id)
  if (hit && Date.now() - hit.at < 30 * 60_000) return hit.models
  if (!key) return ELEVEN_MODELS
  try {
    const res = await fetchOk(`${base(c)}/v1/models`, { headers: { 'xi-api-key': key } }, P, 20_000)
    const list = (await res.json()) as { model_id: string; name?: string; description?: string; can_do_text_to_speech?: boolean; requires_alpha_access?: boolean; languages?: unknown[] }[]
    const known = new Map(ELEVEN_MODELS.map((m) => [m.value, m]))
    const models = list
      .filter((m) => m.can_do_text_to_speech !== false && !m.requires_alpha_access && m.model_id)
      .map((m) => ({
        value: m.model_id,
        label: known.get(m.model_id)?.label ?? m.name?.replace(/^Eleven\s*/i, '') ?? m.model_id,
        hint: known.get(m.model_id)?.hint ?? (Array.isArray(m.languages) && m.languages.length ? `${m.languages.length} languages` : undefined)
      }))
    // Known models first in our order; the rest keep the API's order (sort is stable).
    const rank = (v: string): number => {
      const i = ELEVEN_MODELS.findIndex((x) => x.value === v)
      return i < 0 ? ELEVEN_MODELS.length : i
    }
    models.sort((a, b) => rank(a.value) - rank(b.value))
    if (!models.length) return ELEVEN_MODELS
    modelCache.set(c.id, { at: Date.now(), models })
    return models
  } catch {
    return ELEVEN_MODELS
  }
}

/** eleven_v3 understands inline audio tags like [whispers] — map delivery notes onto them. */
function v3Tags(instructions: string | undefined): string {
  if (!instructions?.trim()) return ''
  return (
    instructions
      .split(/[,;]+/)
      .map((s) => s.trim().replace(/[[\]]/g, ''))
      .filter(Boolean)
      .slice(0, 3)
      .map((s) => `[${s}]`)
      .join(' ') + ' '
  )
}

export const elevenlabsProvider: VoiceProvider = {
  voices: (c, key) => listVoices(c, requireKey(c, key)),

  async speak(a: SynthArgs): Promise<SynthOut> {
    const key = requireKey(a.c, a.key)
    let voiceId = a.voice.voiceId && !a.voice.voiceId.startsWith('clone:') ? a.voice.voiceId : undefined
    if (!voiceId) {
      if (a.voice.sampleAssetId) throw new Error('This voice is a local clone — clone it to ElevenLabs first (Voice → Clone from sample) or pick an ElevenLabs voice.')
      const voices = await listVoices(a.c, key)
      voiceId = (voices.find((v) => v.labels?.category === 'premade') ?? voices[0])?.id
      if (!voiceId) throw new Error('ElevenLabs: no voices available on this account')
    }
    const model = a.model ?? a.c.model ?? ELEVEN_DEFAULT_MODEL
    const v3 = /v3/.test(model)
    const chunks = splitForApi(a.text, v3 ? 2800 : 4500)
    const parts: Uint8Array[] = []
    for (let i = 0; i < chunks.length; i++) {
      const body: Record<string, unknown> = { text: v3 ? v3Tags(a.instructions) + chunks[i] : chunks[i], model_id: model }
      if (!v3 && chunks.length > 1) {
        if (i > 0) body.previous_text = chunks[i - 1].slice(-600)
        if (i < chunks.length - 1) body.next_text = chunks[i + 1].slice(0, 600)
      }
      const res = await fetchOk(
        `${base(a.c)}/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
        { method: 'POST', headers: { 'xi-api-key': key, 'content-type': 'application/json', accept: 'audio/mpeg' }, body: JSON.stringify(body) },
        P,
        300_000
      )
      parts.push(new Uint8Array(await res.arrayBuffer()))
    }
    const voiceName = cache.get(a.c.id)?.voices.find((v) => v.id === voiceId)?.name
    return { bytes: concatBytes(parts), ext: 'mp3', model, voiceId, voiceName, kbps: 128, note: !v3 && a.instructions ? 'Delivery notes need eleven_v3 on ElevenLabs.' : undefined }
  },

  async clone(c, key, name, sample, sampleText) {
    const k = requireKey(c, key)
    const form = new FormData()
    form.append('name', name || 'Stitch voice')
    const ext = extname(sample.path).toLowerCase().slice(1) || 'mp3'
    const type = { wav: 'audio/wav', mp3: 'audio/mpeg', flac: 'audio/flac', ogg: 'audio/ogg', m4a: 'audio/mp4', webm: 'audio/webm' }[ext] ?? 'application/octet-stream'
    form.append('files', new Blob([readFileSync(sample.path)], { type }), basename(sample.path))
    form.append('remove_background_noise', 'false')
    form.append('description', sampleText ? `Cloned in Stitch from: “${sampleText.slice(0, 200)}”` : 'Cloned in Stitch')
    const res = await fetchOk(`${base(c)}/v1/voices/add`, { method: 'POST', headers: { 'xi-api-key': k }, body: form }, P, 180_000)
    const j = (await res.json()) as { voice_id: string; requires_verification?: boolean }
    cache.delete(c.id)
    if (!j.voice_id) throw new Error('ElevenLabs did not return a voice id')
    return j.voice_id
  },

  async test(c, key) {
    const k = requireKey(c, key)
    try {
      const res = await fetchOk(`${base(c)}/v1/user/subscription`, { headers: { 'xi-api-key': k } }, P, 20_000)
      const j = (await res.json()) as { tier?: string; character_count?: number; character_limit?: number }
      if (j.character_limit) return `Connected — ${j.tier ?? 'account'} · ${(j.character_count ?? 0).toLocaleString()} / ${j.character_limit.toLocaleString()} characters used`
    } catch {
      /* scoped keys may lack user_read; fall back to listing voices */
    }
    cache.delete(c.id)
    const voices = await listVoices(c, k)
    return `Connected — ${voices.length} voice${voices.length === 1 ? '' : 's'}`
  }
}
