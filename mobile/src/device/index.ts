// On-device generation wired into the app: "This phone" appears as a text connector, a voice
// connector and image recipes, answered on the phone instead of the PC. Web search can run here too (web.ts).
import type { Connector, DbChange, GenRequest, RecipeInfo } from '@shared/types'
import { emitLocal, merge, override, PASS, route } from '@mobile/bridge/router'
import { installImage, PHONE_RECIPE } from './image'
import { installLlm, phoneLlmConnector, PHONE_LLM_ID } from './llm'
import { installOutbox } from './outbox'
import { deviceOnly, initDevice, onDeviceChange, readyModels, setPrefs, useDevice } from './store'
import { installVoice, phoneVoiceConnector, PHONE_VOICE_ID } from './voice'
import { installWeb } from './web'

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

/** PC recipes seen last (so "This phone only" knows what kind a rerouted request is). */
let pcRecipes: RecipeInfo[] = []

/** The on-device image model used when a PC image recipe is rerouted: recommended first. */
function phoneImageRecipe(): string | undefined {
  const ready = readyModels('image')
  const m = ready.find((x) => x.recommended) ?? ready[0]
  return m ? PHONE_RECIPE + m.id : undefined
}

export function installDevice(): void {
  // "This phone only" reroutes PC image requests before the phone's own image queue sees them.
  override('gen:submit', ([r]) => {
    const req = r as GenRequest
    if (!deviceOnly() || req.recipeId.startsWith(PHONE_RECIPE)) return PASS
    const kind = pcRecipes.find((x) => x.id === req.recipeId)?.kind ?? 'image'
    if (kind !== 'image') throw new Error(`${kind === 'video' ? 'Video' : 'Music and sound'} can't be made on a phone. Turn off “Only this phone” in Settings → Phone to use your PC for it.`)
    const recipeId = phoneImageRecipe()
    if (!recipeId) throw new Error('Download an image model in More → This phone first (Only this phone is on).')
    const p = req.params
    return route('gen:submit', [{ ...req, recipeId, params: { prompt: p.prompt, negative: p.negative, aspect: p.aspect ?? '1:1', seed: p.seed ?? -1, backend: 'auto' } }])
  })

  installLlm()
  installImage()
  installVoice()
  installOutbox()
  installWeb()

  // "This phone only": pickers offer just this phone's models.
  merge('gen:recipes', (list) => {
    const all = list as RecipeInfo[]
    pcRecipes = all.filter((x) => !x.id.startsWith(PHONE_RECIPE))
    return deviceOnly() ? all.filter((x) => x.id.startsWith(PHONE_RECIPE)) : all
  })
  merge('db:list', (list, [col]) => {
    if (col !== 'connectors') return list
    const pc = (list as Connector[]).filter((c) => !PHONE_IDS.has(c.id) && !(deviceOnly() && (c.category === 'llm' || c.category === 'voice')))
    return [...pc, ...phoneConnectors()]
  })
  override('phone:deviceOnly', async ([v]) => {
    if (typeof v === 'boolean') {
      await setPrefs({ deviceOnly: v })
      // Pickers and recipe lists refresh with the new set of models.
      emitLocal('models:changed', null)
      for (const c of phoneConnectors()) announce(c.id)
    }
    return { deviceOnly: deviceOnly(), ready: { text: readyModels('text').length, image: readyModels('image').length, voice: readyModels('voice').length } }
  })
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
