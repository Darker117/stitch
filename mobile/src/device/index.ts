// On-device generation wired into the app: "This phone" appears as a text connector, a voice
// connector and image recipes, answered on the phone instead of the PC.
import type { Connector, DbChange } from '@shared/types'
import { emitLocal, merge, override, PASS } from '@mobile/bridge/router'
import { installImage } from './image'
import { installLlm, phoneLlmConnector, PHONE_LLM_ID } from './llm'
import { installOutbox } from './outbox'
import { initDevice, onDeviceChange, setPrefs, useDevice } from './store'
import { installVoice, phoneVoiceConnector, PHONE_VOICE_ID } from './voice'

const PHONE_IDS = new Set([PHONE_LLM_ID, PHONE_VOICE_ID])

function phoneConnectors(): Connector[] {
  if (!useDevice.getState().native) return []
  return [phoneLlmConnector(), phoneVoiceConnector()]
}

function phoneConnector(id: string): Connector | undefined {
  return phoneConnectors().find((c) => c.id === id)
}

function announce(id: string): void {
  const doc = phoneConnector(id)
  if (doc) emitLocal('db:changed', { collection: 'connectors', id, op: 'put', doc } satisfies DbChange)
}

/** Enable/disable a phone connector from the app's own connector UI. */
async function write(id: string, doc: Partial<Connector> | null): Promise<Connector | undefined> {
  const task = id === PHONE_LLM_ID ? 'text' : 'voice'
  const enabled = doc === null ? false : doc.enabled ?? true
  await setPrefs({ enabled: { ...useDevice.getState().prefs.enabled, [task]: enabled } })
  return phoneConnector(id)
}

export function installDevice(): void {
  installLlm()
  installImage()
  installVoice()
  installOutbox()

  merge('db:list', (list, [col]) => (col === 'connectors' ? [...(list as Connector[]).filter((c) => !PHONE_IDS.has(c.id)), ...phoneConnectors()] : list))
  override('db:get', ([col, id]) => (col === 'connectors' && PHONE_IDS.has(String(id)) ? (phoneConnector(String(id)) ?? null) : PASS))
  override('db:put', ([col, doc]) => {
    const d = doc as Connector
    return col === 'connectors' && PHONE_IDS.has(d?.id) ? write(d.id, d) : PASS
  })
  override('db:patch', ([col, id, p]) => (col === 'connectors' && PHONE_IDS.has(String(id)) ? write(String(id), p as Partial<Connector>) : PASS))
  override('db:delete', ([col, id]) => (col === 'connectors' && PHONE_IDS.has(String(id)) ? write(String(id), null).then(() => undefined) : PASS))
  override('connectors:save', ([c]) => (PHONE_IDS.has((c as Connector)?.id) ? write((c as Connector).id, c as Connector) : PASS))
  override('connectors:delete', ([id]) => (PHONE_IDS.has(String(id)) ? write(String(id), null).then(() => undefined) : PASS))
  override('connectors:test', ([id]) => {
    if (!PHONE_IDS.has(String(id))) return PASS
    const c = phoneConnector(String(id))
    const n = c?.category === 'llm' ? (c.models?.length ?? 0) : c?.category === 'voice' ? 1 : 0
    return { ok: n > 0, message: n > 0 ? 'Ready on this phone' : 'Download a model in More → This phone' }
  })

  // Keep pickers and recipe lists in sync with downloads and preferences.
  onDeviceChange((task) => {
    if (task === 'text') announce(PHONE_LLM_ID)
    if (task === 'voice') announce(PHONE_VOICE_ID)
    if (task === 'image') emitLocal('models:changed', null)
  })

  void initDevice()
}
