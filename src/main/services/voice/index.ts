// Voice service: one IPC surface over the local Qwen3-TTS engine and the cloud
// providers (ElevenLabs, OpenAI, Azure). Every synthesis is saved as an asset.
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import type { SpeakRequest } from '@shared/ipc'
import type { Asset, CharacterVoice, VoiceConnector, VoiceKind } from '@shared/types'
import { handle } from '../../ipc'
import { getSecret, getSettings } from '../../settings'
import { db } from '../../store'
import { getAsset, saveBytes } from '../assets'
import { registerTester } from '../connectors'
import { wavDuration, type VoiceProvider } from './common'
import { elevenlabsProvider } from './elevenlabs'
import { downloadModel, engineStatus, initEngine, installEngine, shutdownEngine, startEngine, stopEngine } from './engine'
import { azureProvider } from './azure'
import { designVoice, localProvider } from './local'
import { openaiProvider } from './openai'

const PROVIDERS: Record<VoiceKind, VoiceProvider> = {
  'local-qwen': localProvider,
  elevenlabs: elevenlabsProvider,
  'openai-tts': openaiProvider,
  azure: azureProvider
}

function voiceConnectors(): VoiceConnector[] {
  return db('connectors')
    .list()
    .filter((c): c is VoiceConnector => c.category === 'voice')
}

/** req.connectorId → voice.connectorId → settings.defaultVoice → the local engine → any enabled voice connector. */
export function resolveVoiceConnector(...ids: (string | undefined)[]): VoiceConnector {
  const all = voiceConnectors()
  for (const id of ids) {
    if (!id) continue
    const c = all.find((x) => x.id === id)
    if (!c) continue
    if (!c.enabled) throw new Error(`${c.name} is turned off — enable it in Connectors`)
    return c
  }
  const def = getSettings().defaultVoice?.connectorId
  const pick =
    all.find((c) => c.id === def && c.enabled) ??
    all.find((c) => c.kind === 'local-qwen' && c.enabled) ??
    all.find((c) => c.enabled)
  if (!pick) throw new Error('No voice provider is set up — add one in Connectors')
  return pick
}

function connectorById(id: string): VoiceConnector {
  const c = voiceConnectors().find((x) => x.id === id)
  if (!c) throw new Error('Voice connector not found')
  return c
}

function titleFrom(text: string): string {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').slice(0, 7).join(' ')
  return words.length > 48 ? `${words.slice(0, 46)}…` : words || 'Voice clip'
}

/** Keep only the fields that change the sound, so equivalent voices share a preview. */
function voiceKey(v: CharacterVoice): CharacterVoice {
  return { voiceId: v.voiceId, sampleAssetId: v.sampleAssetId, sampleText: v.sampleText?.trim() || undefined, design: v.design?.trim() || undefined, language: v.language }
}

async function saveClip(bytes: Uint8Array, ext: 'mp3' | 'wav', kbps: number | undefined, meta: Partial<Asset>): Promise<Asset> {
  const wavSecs = ext === 'wav' ? wavDuration(bytes) : undefined
  const asset = await saveBytes(bytes, 'audio', ext, { ...meta, ...(wavSecs ? { duration: wavSecs } : {}) })
  if (!asset.duration && kbps) {
    // No ffprobe: estimate from the constant bitrate the provider returns.
    return db('assets').patch(asset.id, { duration: (bytes.length * 8) / (kbps * 1000) })
  }
  return asset
}

async function speak(req: SpeakRequest): Promise<Asset> {
  const text = req.text?.trim()
  if (!text) throw new Error('Nothing to say — the text is empty')
  const c = resolveVoiceConnector(req.connectorId, req.voice?.connectorId)
  const voice = req.voice ?? {}

  let previewKey: string | undefined
  if (req.preview) {
    previewKey = createHash('sha1')
      .update(JSON.stringify({ c: c.id, v: voiceKey(voice), t: text, i: req.instructions?.trim() || '', m: req.model ?? c.model ?? '' }))
      .digest('hex')
    const hit = db('assets')
      .list()
      .find((a) => a.params?.previewKey === previewKey && existsSync(a.path))
    if (hit) return hit
  }

  const out = await PROVIDERS[c.kind].speak({ c, key: getSecret(c.id), text, voice, instructions: req.instructions?.trim() || undefined, model: req.model })
  return saveClip(out.bytes, out.ext, out.kbps, {
    source: 'voice',
    name: req.name ?? (req.preview ? `Preview · ${titleFrom(text)}` : titleFrom(text)),
    prompt: text,
    origin: req.origin,
    projectId: req.projectId,
    characterIds: req.characterIds,
    tags: req.preview ? ['voice-preview'] : undefined,
    params: {
      connectorId: c.id,
      provider: c.kind,
      voice: { ...voice, connectorId: voice.connectorId ?? c.id },
      instructions: req.instructions?.trim() || undefined,
      model: out.model,
      resolvedVoice: out.voiceId,
      note: out.note,
      previewKey
    }
  })
}

export function registerVoice(): void {
  initEngine()

  handle('voice:voices', (connectorId) => {
    const c = connectorById(connectorId)
    return PROVIDERS[c.kind].voices(c, getSecret(c.id))
  })

  handle('voice:speak', (req) => speak(req))

  handle('voice:clone', async (req) => {
    const c = connectorById(req.connectorId)
    const provider = PROVIDERS[c.kind]
    if (!provider.clone) throw new Error(`${c.name} can't clone voices — use Stitch Voice (local) or ElevenLabs`)
    const sample = getAsset(req.sampleAssetId)
    if (sample.kind !== 'audio') throw new Error('Pick an audio clip to clone from')
    return { voiceId: await provider.clone(c, getSecret(c.id), req.name, sample, req.sampleText) }
  })

  handle('voice:design', async (req) => {
    const description = req.description?.trim()
    const text = req.text?.trim()
    if (!description) throw new Error('Describe the voice first')
    if (!text) throw new Error('Add a line for the voice to say')
    const { bytes, model } = await designVoice(description, text, req.language)
    const local = voiceConnectors().find((c) => c.kind === 'local-qwen')
    return saveClip(bytes, 'wav', undefined, {
      source: 'voice',
      name: req.name?.trim() || 'Designed voice',
      prompt: text,
      characterIds: req.characterIds,
      tags: ['voice-design'],
      params: {
        connectorId: local?.id,
        provider: 'local-qwen',
        design: description,
        sampleText: text,
        language: req.language,
        model,
        voice: { connectorId: local?.id, design: description, sampleText: text, language: req.language }
      }
    })
  })

  handle('voice:engineStatus', () => engineStatus())
  handle('voice:engineInstall', () => installEngine())
  handle('voice:engineStart', () => startEngine())
  handle('voice:engineStop', () => stopEngine())
  handle('voice:engineDownload', (id) => downloadModel(id))

  registerTester('voice', async (conn) => {
    const c = conn as VoiceConnector
    const message = await PROVIDERS[c.kind].test(c, getSecret(c.id))
    return { ok: true, message }
  })
}

export function shutdownVoice(): void {
  shutdownEngine()
}
