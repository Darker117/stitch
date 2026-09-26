// "This phone" as a voice connector: on-device TTS voices (and the phone's system voices) for
// characters, narration and Create → Voice. Clips are saved to the PC library like any voice line.
import type { SpeakRequest, VoiceEngineInfo, VoiceInfo } from '@shared/ipc'
import type { VoiceConnector } from '@shared/types'
import { useSettings } from '@/stores/settings'
import { override, merge, PASS } from '@mobile/bridge/router'
import type { CatalogModel } from './catalog'
import { sendToPc } from './outbox'
import { StitchDevice } from './plugin'
import { BACKEND_LABEL, catalogFor, isReady, modelById, readyModels, resolveBackend, useDevice } from './store'

export const PHONE_VOICE_ID = 'phone-voice'
/** Voice ids are `<modelId>/<speakerId>`; system voices use the `system` model. */
const SYSTEM = 'system-tts'

export function phoneVoiceConnector(): VoiceConnector {
  const first = readyModels('voice')[0]
  return {
    id: PHONE_VOICE_ID,
    name: 'This phone',
    category: 'voice',
    kind: 'device',
    enabled: useDevice.getState().prefs.enabled.voice,
    hasKey: false,
    createdAt: 0,
    model: first?.id
  }
}

function voicesOf(m: CatalogModel): VoiceInfo[] {
  if (m.format === 'tts-system') {
    return useDevice.getState().systemVoices.map((v) => ({
      id: `${m.id}/${v.id}`,
      name: v.name,
      description: `System voice · ${v.language}`,
      labels: { language: v.language, model: m.name, ...(v.network ? { network: 'online' } : {}) }
    }))
  }
  return (m.voices ?? []).map((v) => ({
    id: `${m.id}/${v.id}`,
    name: v.name,
    description: m.name,
    labels: { ...(v.gender ? { gender: v.gender } : {}), ...(v.language ? { language: v.language } : {}), model: m.name }
  }))
}

export function phoneVoices(): VoiceInfo[] {
  return readyModels('voice').flatMap(voicesOf)
}

export function phoneVoiceEngine(): VoiceEngineInfo {
  const models = catalogFor('voice')
  const ready = models.filter(isReady)
  return {
    id: 'device',
    name: 'This phone',
    kind: 'local',
    installed: ready.length > 0,
    supportsCloning: false,
    voices: ready.flatMap(voicesOf),
    connectorKind: 'device',
    connectorId: PHONE_VOICE_ID,
    description: 'Speech made on your phone — no PC or internet needed.',
    device: 'cpu',
    weights: models.map((m) => ({ id: m.id, label: m.name, downloaded: isReady(m) }))
  }
}

function targetsPhone(req: SpeakRequest): boolean {
  if (req.connectorId) return req.connectorId === PHONE_VOICE_ID
  if (req.voice?.connectorId) return req.voice.connectorId === PHONE_VOICE_ID
  return useSettings.getState().settings?.defaultVoice?.connectorId === PHONE_VOICE_ID
}

async function speak(req: SpeakRequest): Promise<unknown> {
  const [modelPart, speaker] = (req.voice?.voiceId ?? '').split('/')
  const m = modelById(req.model && req.model !== 'default' ? req.model : modelPart) ?? modelById(modelPart) ?? readyModels('voice')[0] ?? modelById(SYSTEM)
  if (!m) throw new Error('No on-device voice yet — get one in More → This phone.')
  const st = useDevice.getState().status[m.id]
  if (m.format !== 'tts-system' && !st?.ready) throw new Error(`${m.name} isn't downloaded yet — get it in More → This phone.`)
  const voice = speaker || m.voices?.[0]?.id || useDevice.getState().systemVoices[0]?.id
  const res = await StitchDevice.speak({
    modelId: m.id,
    backend: resolveBackend('voice', m),
    dir: st?.dir ?? '',
    format: m.format,
    text: req.text,
    voice,
    config: m.config
  })
  const asset = await sendToPc(res.path, 'audio', 'wav', {
    source: 'voice',
    name: req.name ?? (req.text.length > 40 ? `${req.text.slice(0, 40)}…` : req.text),
    prompt: req.text,
    characterIds: req.characterIds,
    projectId: req.projectId,
    origin: req.origin,
    duration: res.duration,
    tags: req.preview ? ['voice-preview'] : undefined,
    params: { voice: req.voice?.voiceId, model: m.id, backend: res.backend, device: useDevice.getState().info?.model }
  })
  if (asset) return asset
  // PC unreachable: hand back the phone copy (it uploads on the next connection).
  return { id: `phone-${Date.now().toString(36)}`, kind: 'audio', path: res.path, name: req.text.slice(0, 40), createdAt: Date.now(), source: 'voice', duration: res.duration }
}

export function installVoice(): void {
  override('voice:voices', ([id]) => (id === PHONE_VOICE_ID ? phoneVoices() : PASS))
  override('voice:models', ([id]) =>
    id === PHONE_VOICE_ID ? readyModels('voice').map((m) => ({ value: m.id, label: m.name, hint: BACKEND_LABEL[resolveBackend('voice', m)] })) : PASS
  )
  override('voice:speak', ([r]) => (targetsPhone(r as SpeakRequest) ? speak(r as SpeakRequest) : PASS))
  override('voice:clone', ([r]) => {
    if ((r as { connectorId?: string }).connectorId !== PHONE_VOICE_ID) return PASS
    throw new Error("Phone voices can't clone yet — pick a PC voice engine for cloning.")
  })
  merge('voice:engines', (list) => (useDevice.getState().native ? [...(list as VoiceEngineInfo[]), phoneVoiceEngine()] : list))
  override('voice:installEngine', ([id]) => {
    if (id !== 'device') return PASS
    location.hash = '#/phone?task=voice'
    return undefined
  })
  override('voice:removeEngine', ([id]) => {
    if (id !== 'device') return PASS
    location.hash = '#/phone?task=voice'
    return undefined
  })
}
