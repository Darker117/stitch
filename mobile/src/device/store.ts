// On-device state: chip info, which catalog models are downloaded, live downloads and preferences.
import { Capacitor } from '@capacitor/core'
import { Preferences } from '@capacitor/preferences'
import { create } from 'zustand'
import { CATALOG, type CatalogModel } from './catalog'
import { StitchDevice, type DeviceBackend, type DeviceInfo, type DeviceTask, type DownloadEvent, type ModelStatus, type SystemVoice } from './plugin'

export interface DevicePrefs {
  /** Preferred backend per task ('auto' = best available for the model). */
  backends: Record<DeviceTask, DeviceBackend | 'auto'>
  /** Show "This phone" as a text / voice connector across the app. */
  enabled: { text: boolean; voice: boolean }
  /** Hugging Face token for gated model downloads. */
  hfToken?: string
  /** Run every generation (text, images, voice) on this phone's own hardware instead of the PC. */
  deviceOnly?: boolean
}

interface DeviceState {
  native: boolean
  ready: boolean
  info: DeviceInfo | null
  error?: string
  status: Record<string, ModelStatus>
  downloads: Record<string, DownloadEvent>
  prefs: DevicePrefs
  systemVoices: SystemVoice[]
  /** Models the user added from a link or imported from the phone. */
  custom: CatalogModel[]
}

const PREFS_KEY = 'stitch.device.prefs'
const CUSTOM_KEY = 'stitch.device.custom'
const DEFAULT_PREFS: DevicePrefs = { backends: { text: 'auto', image: 'auto', voice: 'auto' }, enabled: { text: true, voice: true } }

export const useDevice = create<DeviceState>(() => ({
  native: Capacitor.isNativePlatform(),
  ready: false,
  info: null,
  status: {},
  downloads: {},
  prefs: DEFAULT_PREFS,
  systemVoices: [],
  custom: []
}))

type ChangeFn = (task: DeviceTask) => void
const changeListeners = new Set<ChangeFn>()
/** Called when the set of usable models for a task changes (download finished, deleted, prefs). */
export function onDeviceChange(fn: ChangeFn): () => void {
  changeListeners.add(fn)
  return () => changeListeners.delete(fn)
}
function changed(task: DeviceTask): void {
  for (const fn of changeListeners) fn(task)
}

/** The built-in catalog plus the user's own models. */
export function allModels(): CatalogModel[] {
  return [...CATALOG, ...useDevice.getState().custom]
}

/** Can this phone run the model? NPU builds are compiled for one chip; big models need the RAM. */
export function compatibility(m: CatalogModel): { ok: boolean; reason?: string } {
  const info = useDevice.getState().info
  if (m.socs?.length && !(info?.soc && m.socs.some((s) => s.toUpperCase() === info.soc!.toUpperCase()))) {
    return { ok: false, reason: `Built for ${m.socs.join(' / ')}${info?.soc ? ` — this phone is ${info.socName ?? info.soc}` : ''}` }
  }
  const ramGb = info ? info.ramBytes / 1024 ** 3 : 99
  if (m.minRamGb && m.minRamGb > ramGb + 0.5) return { ok: false, reason: `Needs about ${m.minRamGb} GB of RAM` }
  if (info && !m.backends.some((b) => backendAvailableFor(m, b))) return { ok: false, reason: `Needs ${m.backends.map((b) => b.toUpperCase()).join(' or ')}, not available here` }
  return { ok: true }
}

/** Models for a task: by default only the ones this phone can run (`all` lists every chip and size). */
export function catalogFor(task: DeviceTask, all = false): CatalogModel[] {
  const list = allModels().filter((m) => m.task === task)
  return all ? list : list.filter((m) => compatibility(m).ok)
}

export function modelById(id: string | undefined): CatalogModel | undefined {
  return id ? allModels().find((m) => m.id === id) : undefined
}

export function isReady(m: CatalogModel): boolean {
  return m.format === 'tts-system' || !!useDevice.getState().status[m.id]?.ready
}

export function readyModels(task: DeviceTask): CatalogModel[] {
  return catalogFor(task).filter(isReady)
}

export function backendAvailable(task: DeviceTask, b: DeviceBackend): boolean {
  const info = useDevice.getState().info
  return !!info?.backends[task]?.find((x) => x.id === b)?.available
}

/** Backend support for this model's runtime (llama.cpp / stable-diffusion.cpp report their own), else the task's. */
export function backendAvailableFor(m: CatalogModel, b: DeviceBackend): boolean {
  const rt = useDevice.getState().info?.runtimes?.[m.format]
  if (rt) return !!rt.find((x) => x.id === b)?.available
  return backendAvailable(m.task, b)
}

/** The backend a model will run on: the user's choice if it can, else NPU → GPU → CPU. */
export function resolveBackend(task: DeviceTask, m: CatalogModel, requested?: DeviceBackend | 'auto'): DeviceBackend {
  const want = requested && requested !== 'auto' ? requested : useDevice.getState().prefs.backends[task]
  if (want && want !== 'auto' && m.backends.includes(want) && backendAvailableFor(m, want)) return want
  for (const b of ['npu', 'gpu', 'cpu'] as DeviceBackend[]) if (m.backends.includes(b) && backendAvailableFor(m, b)) return b
  return m.backends.includes('cpu') ? 'cpu' : m.backends[0]
}

export const BACKEND_LABEL: Record<DeviceBackend, string> = { npu: 'NPU · QNN', gpu: 'GPU', cpu: 'CPU' }

async function savePrefs(p: DevicePrefs): Promise<void> {
  await Preferences.set({ key: PREFS_KEY, value: JSON.stringify(p) })
}

export async function setPrefs(patch: Partial<DevicePrefs>): Promise<void> {
  const prev = useDevice.getState().prefs
  const next: DevicePrefs = { ...prev, ...patch, backends: { ...prev.backends, ...patch.backends }, enabled: { ...prev.enabled, ...patch.enabled } }
  useDevice.setState({ prefs: next })
  await savePrefs(next)
  if (patch.enabled?.text !== undefined || patch.backends?.text) changed('text')
  if (patch.enabled?.voice !== undefined || patch.backends?.voice) changed('voice')
  if (patch.backends?.image) changed('image')
  if (patch.deviceOnly !== undefined) for (const t of ['text', 'image', 'voice'] as DeviceTask[]) changed(t)
}

/** Every generation on this phone's hardware (Settings → Phone, or More → This phone). */
export function deviceOnly(): boolean {
  return !!useDevice.getState().prefs.deviceOnly && useDevice.getState().native
}

async function saveCustom(list: CatalogModel[]): Promise<void> {
  useDevice.setState({ custom: list })
  await Preferences.set({ key: CUSTOM_KEY, value: JSON.stringify(list) })
}

/** Remember a model the user added (a link or imported files). */
export async function addCustomModel(m: CatalogModel): Promise<void> {
  await saveCustom([...useDevice.getState().custom.filter((x) => x.id !== m.id), { ...m, custom: true }])
  await refreshStatus()
}

export async function removeCustomModel(m: CatalogModel): Promise<void> {
  await StitchDevice.deleteModel({ id: m.id }).catch(() => {})
  await saveCustom(useDevice.getState().custom.filter((x) => x.id !== m.id))
  await refreshStatus()
}

export async function refreshStatus(): Promise<void> {
  if (!useDevice.getState().native) return
  const models = allModels().filter((m) => m.files.length)
  // Two passes: the catalog lists ~30k files (every voice carries espeak-ng-data), so file lists are only sent for
  // models whose folder exists on the phone (sizes only: status never needs the URLs); the rest are answered from the
  // folder alone.
  const { models: first } = await StitchDevice.status({ ids: models.map((m) => m.id) })
  const onPhone = models.filter((m) => first.find((s) => s.id === m.id && (s.sizeBytes > 0 || s.downloading)))
  const files = Object.fromEntries(onPhone.map((m) => [m.id, m.files.map(({ path, size }) => ({ url: '', path, size }))]))
  const checked = onPhone.length ? (await StitchDevice.status({ ids: onPhone.map((m) => m.id), files })).models : []
  const list = [...first.filter((s) => !checked.some((c) => c.id === s.id)), ...checked]
  const before = useDevice.getState().status
  const status = Object.fromEntries(list.map((s) => [s.id, s]))
  useDevice.setState({ status })
  for (const task of ['text', 'image', 'voice'] as DeviceTask[]) {
    const ids = allModels().filter((m) => m.task === task).map((m) => m.id)
    if (ids.some((id) => !!before[id]?.ready !== !!status[id]?.ready)) changed(task)
  }
}

let inited: Promise<void> | null = null

export function initDevice(): Promise<void> {
  inited ??= (async () => {
    try {
      const { value } = await Preferences.get({ key: PREFS_KEY })
      if (value) {
        const p = JSON.parse(value) as Partial<DevicePrefs>
        useDevice.setState({ prefs: { ...DEFAULT_PREFS, ...p, backends: { ...DEFAULT_PREFS.backends, ...p.backends }, enabled: { ...DEFAULT_PREFS.enabled, ...p.enabled } } })
      }
    } catch {
      /* defaults */
    }
    try {
      const { value } = await Preferences.get({ key: CUSTOM_KEY })
      if (value) useDevice.setState({ custom: (JSON.parse(value) as CatalogModel[]).filter((m) => m && m.id && Array.isArray(m.files)) })
    } catch {
      /* none */
    }
    if (!useDevice.getState().native) {
      useDevice.setState({ ready: true })
      return
    }
    try {
      void StitchDevice.addListener('download', (e) => {
        useDevice.setState((s) => ({ downloads: { ...s.downloads, [e.id]: e } }))
        if (e.state !== 'downloading') {
          void refreshStatus()
          if (e.state !== 'error') setTimeout(() => useDevice.setState((s) => ({ downloads: Object.fromEntries(Object.entries(s.downloads).filter(([k]) => k !== e.id)) })), 1500)
        }
      })
      const info = await StitchDevice.info()
      useDevice.setState({ info })
      await refreshStatus()
      const { voices } = await StitchDevice.systemVoices().catch(() => ({ voices: [] as SystemVoice[] }))
      useDevice.setState({ systemVoices: voices, ready: true })
      changed('voice')
    } catch (err) {
      useDevice.setState({ ready: true, error: err instanceof Error ? err.message : String(err) })
    }
  })()
  return inited
}

/** Is every file of this model hosted on Hugging Face (so the HF token may be sent)? */
function onHuggingFace(m: CatalogModel): boolean {
  return m.files.every((f) => {
    try {
      const h = new URL(f.url).hostname
      return h === 'huggingface.co' || h.endsWith('.huggingface.co')
    } catch {
      return false
    }
  })
}

export async function downloadModel(m: CatalogModel): Promise<void> {
  // The Hugging Face token only ever goes to Hugging Face.
  const token = onHuggingFace(m) ? useDevice.getState().prefs.hfToken : undefined
  useDevice.setState((s) => ({ downloads: { ...s.downloads, [m.id]: { id: m.id, state: 'downloading', receivedBytes: 0, totalBytes: m.sizeBytes } } }))
  try {
    await StitchDevice.download({ id: m.id, files: m.files, headers: token ? { Authorization: `Bearer ${token}` } : undefined })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // Cancelling rejects with CANCELED — that's not an error to show.
    if ((err as { code?: string }).code === 'CANCELED' || /cancel/i.test(msg)) {
      useDevice.setState((s) => ({ downloads: Object.fromEntries(Object.entries(s.downloads).filter(([k]) => k !== m.id)) }))
      return
    }
    useDevice.setState((s) => ({ downloads: { ...s.downloads, [m.id]: { id: m.id, state: 'error', receivedBytes: 0, totalBytes: m.sizeBytes, error: msg } } }))
    throw err
  }
}

export async function cancelDownload(m: CatalogModel): Promise<void> {
  await StitchDevice.cancelDownload({ id: m.id })
  useDevice.setState((s) => ({ downloads: Object.fromEntries(Object.entries(s.downloads).filter(([k]) => k !== m.id)) }))
}

export async function deleteModel(m: CatalogModel): Promise<void> {
  await StitchDevice.deleteModel({ id: m.id })
  await refreshStatus()
}

export function sizeText(bytes: number | undefined): string {
  if (!bytes) return '—'
  const gb = bytes / 1024 ** 3
  return gb >= 1 ? `${gb.toFixed(gb >= 10 ? 0 : 1)} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`
}
