// Voice service: one IPC surface over the local engines (Qwen3-TTS, Kokoro, Pocket TTS —
// all served by the Stitch Voice server) and the cloud providers (ElevenLabs, OpenAI, Azure).
// Every synthesis is saved as an asset.
import { app } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SpeakRequest, VoiceEngineId, VoiceEngineInfo } from '@shared/ipc'
import type { Asset, CharacterVoice, VoiceConnector, VoiceKind } from '@shared/types'
import { handle } from '../../ipc'
import { getSecret, getSettings } from '../../settings'
import { db } from '../../store'
import { getAsset, saveBytes } from '../assets'
import { registerTester } from '../connectors'
import { wavDuration, type VoiceProvider } from './common'
import { elevenAddShared, elevenLibrary, elevenModels, elevenlabsProvider } from './elevenlabs'
import {
  LOCAL_ENGINES,
  LOCAL_ENGINE_IDS,
  downloadModel,
  engineDisk,
  engineInstalled,
  engineStatus,
  engineWeights,
  initEngine,
  installEngine,
  installingEngine,
  torchVariant as installedTorch,
  pocketCloningDownloaded,
  POCKET_LANGUAGES as POCKET_LANGS,
  removeEngine,
  runtimeBytes,
  setEnginesProvider,
  shutdownEngine,
  startEngine,
  stopEngine,
  type LocalEngineId
} from './engine'
import { azureProvider } from './azure'
import { KOKORO_VOICES, kokoroProvider } from './kokoro'
import { LOCAL_SPEAKERS, designVoice, localProvider } from './local'
import { openaiProvider } from './openai'
import { POCKET_VOICES, pocketProvider } from './pocket'

const PROVIDERS: Record<VoiceKind, VoiceProvider> = {
  'local-qwen': localProvider,
  'local-kokoro': kokoroProvider,
  'local-pocket': pocketProvider,
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

// ─── Engine connectors ───────────────────────────────────────────────────────

const LOCAL_CONNECTOR_NAME: Record<LocalEngineId, string> = { qwen3: 'Stitch Voice (Qwen3-TTS)', kokoro: 'Kokoro (local)', pocket: 'Pocket TTS (local)' }

/** Make sure a local engine has an enabled connector (routing goes through connectors). */
function ensureEngineConnector(id: LocalEngineId): VoiceConnector {
  const def = LOCAL_ENGINES[id]
  const existing = voiceConnectors().filter((c) => c.kind === def.kind)
  const c = existing.find((x) => x.id === def.connectorId) ?? existing[0]
  if (c) return c.enabled ? c : (db('connectors').patch(c.id, { enabled: true }) as VoiceConnector)
  return db('connectors').put({ id: def.connectorId, name: LOCAL_CONNECTOR_NAME[id], category: 'voice', kind: def.kind, hasKey: false, enabled: true, createdAt: Date.now() }) as VoiceConnector
}

/** Kokoro and Pocket TTS connectors appear once for existing profiles; deleting them afterwards sticks. */
function seedEngineConnectors(): void {
  const flag = join(app.getPath('userData'), 'voice-engines-seeded.json')
  let seeded: string[] = []
  try {
    seeded = JSON.parse(readFileSync(flag, 'utf8')) as string[]
  } catch {
    /* first run */
  }
  const todo = (['kokoro', 'pocket'] as LocalEngineId[]).filter((id) => !seeded.includes(id))
  if (!todo.length) return
  for (const id of todo) {
    if (!voiceConnectors().some((c) => c.kind === LOCAL_ENGINES[id].kind)) ensureEngineConnector(id)
  }
  try {
    writeFileSync(flag, JSON.stringify([...seeded, ...todo]))
  } catch {
    /* read-only profile */
  }
}

// ─── Engines list (voice:engines) ────────────────────────────────────────────

const LOCAL_VOICES: Record<LocalEngineId, VoiceEngineInfo['voices']> = { qwen3: LOCAL_SPEAKERS, kokoro: KOKORO_VOICES, pocket: POCKET_VOICES }

const CLOUD: { id: VoiceEngineId; name: string; kind: VoiceKind; supportsCloning: boolean; license: string; description: string; homepage: string }[] = [
  {
    id: 'elevenlabs',
    name: 'ElevenLabs',
    kind: 'elevenlabs',
    supportsCloning: true,
    license: 'Commercial API',
    description: 'Studio-grade voices, the public voice library and instant cloning.',
    homepage: 'https://elevenlabs.io'
  },
  { id: 'openai', name: 'OpenAI', kind: 'openai-tts', supportsCloning: false, license: 'Commercial API', description: 'Steerable gpt-4o-mini-tts voices.', homepage: 'https://platform.openai.com' },
  { id: 'azure', name: 'Azure Speech', kind: 'azure', supportsCloning: false, license: 'Commercial API', description: '400+ neural voices with speaking styles.', homepage: 'https://azure.microsoft.com/products/ai-services/text-to-speech' }
]

export function listEngines(): VoiceEngineInfo[] {
  const busy = installingEngine()
  const connectors = voiceConnectors()
  const shared = runtimeBytes()
  const local: VoiceEngineInfo[] = LOCAL_ENGINE_IDS.map((id) => {
    const def = LOCAL_ENGINES[id]
    const installed = engineInstalled(id)
    const disk = engineDisk(id)
    const conn = connectors.find((c) => c.kind === def.kind && c.id === def.connectorId && c.enabled) ?? connectors.find((c) => c.kind === def.kind && c.enabled)
    return {
      id,
      name: def.name,
      kind: 'local',
      installed,
      installing: busy === id || undefined,
      sizeBytes: installed || disk.sizeBytes ? disk.sizeBytes : undefined,
      path: disk.path,
      license: def.license,
      supportsCloning: def.supportsCloning,
      voices: LOCAL_VOICES[id],
      connectorKind: def.kind,
      connectorId: conn?.id,
      description: def.description,
      device: def.device === 'gpu' && installedTorch() === 'cpu' ? 'cpu' : def.device,
      downloadBytes: def.downloadBytes,
      weights: engineWeights(id),
      runtimeBytes: shared,
      homepage: def.homepage,
      cloningReady: id === 'pocket' ? POCKET_LANGS.some((l) => pocketCloningDownloaded(l)) : undefined
    }
  })
  const cloud: VoiceEngineInfo[] = CLOUD.map((e) => {
    const all = connectors.filter((c) => c.kind === e.kind)
    const conn = all.find((c) => c.enabled && c.hasKey && (e.kind !== 'azure' || !!c.region || !!c.baseUrl)) ?? all.find((c) => c.enabled)
    const ready = !!conn?.enabled && !!conn.hasKey
    return {
      id: e.id,
      name: e.name,
      kind: 'cloud',
      installed: ready,
      license: e.license,
      supportsCloning: e.supportsCloning,
      connectorKind: e.kind,
      connectorId: conn?.id,
      needsKey: !ready,
      description: e.description,
      device: 'cloud',
      homepage: e.homepage
    }
  })
  return [...local, ...cloud]
}

function localId(id: VoiceEngineId): LocalEngineId {
  if (id in LOCAL_ENGINES) return id as LocalEngineId
  const cloud = CLOUD.find((c) => c.id === id)
  if (cloud) throw new Error(`${cloud.name} is a cloud service — add your API key in Connectors instead.`)
  throw new Error(`Unknown voice engine '${id}'`)
}

async function install(id: LocalEngineId): Promise<void> {
  await installEngine(id)
  ensureEngineConnector(id)
}

// ─── Speaking ────────────────────────────────────────────────────────────────

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
      .update(JSON.stringify({ c: c.id, k: c.kind, v: voiceKey(voice), t: text, i: req.instructions?.trim() || '', m: req.model ?? c.model ?? '' }))
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
      voiceName: out.voiceName,
      note: out.note,
      previewKey
    }
  })
}

export function registerVoice(): void {
  seedEngineConnectors()
  setEnginesProvider(listEngines)
  initEngine()

  handle('voice:voices', (connectorId) => {
    const c = connectorById(connectorId)
    return PROVIDERS[c.kind].voices(c, getSecret(c.id))
  })

  handle('voice:speak', (req) => speak(req))

  handle('voice:clone', async (req) => {
    const c = connectorById(req.connectorId)
    const provider = PROVIDERS[c.kind]
    if (!provider.clone) throw new Error(`${c.name} can't clone voices — use Qwen3-TTS, Pocket TTS or ElevenLabs`)
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
  handle('voice:engineInstall', () => install('qwen3'))
  handle('voice:engineStart', () => startEngine())
  handle('voice:engineStop', () => stopEngine())
  handle('voice:engineDownload', (id) => downloadModel(id))

  handle('voice:engines', () => listEngines())
  handle('voice:installEngine', (id) => install(localId(id)))
  handle('voice:removeEngine', (id) => removeEngine(localId(id)))

  handle('voice:library', async (q) => {
    const c = connectorById(q.connectorId)
    if (c.kind !== 'elevenlabs') throw new Error(`${c.name} has no voice library`)
    const { connectorId: _ignored, ...rest } = q
    return elevenLibrary(c, getSecret(c.id), rest)
  })
  handle('voice:addLibraryVoice', async (req) => {
    const c = connectorById(req.connectorId)
    if (c.kind !== 'elevenlabs') throw new Error(`${c.name} has no voice library`)
    return { voiceId: await elevenAddShared(c, getSecret(c.id), req.ownerId, req.voiceId, req.name) }
  })
  handle('voice:models', async (connectorId) => {
    const c = connectorById(connectorId)
    // Other providers use the renderer's built-in lists.
    return c.kind === 'elevenlabs' ? elevenModels(c, getSecret(c.id)) : []
  })

  registerTester('voice', async (conn) => {
    const c = conn as VoiceConnector
    const message = await PROVIDERS[c.kind].test(c, getSecret(c.id))
    return { ok: true, message }
  })
}

export function shutdownVoice(): void {
  shutdownEngine()
}
