// Phone-made files go to the PC's library. If the PC can't be reached, they wait here and upload on
// the next connection (the file stays on the phone until then).
import { Capacitor } from '@capacitor/core'
import { Preferences } from '@capacitor/preferences'
import type { Asset, AssetKind } from '@shared/types'
import { invoke } from '@/lib/api'
import { toast } from '@/stores/toast'
import { link } from '@mobile/bridge/connection'
import { StitchDevice } from './plugin'

interface Pending {
  path: string
  kind: AssetKind
  ext: string
  meta: Partial<Asset>
  at: number
}

const KEY = 'stitch.device.outbox'

async function load(): Promise<Pending[]> {
  try {
    const { value } = await Preferences.get({ key: KEY })
    return value ? (JSON.parse(value) as Pending[]) : []
  } catch {
    return []
  }
}

async function store(list: Pending[]): Promise<void> {
  await Preferences.set({ key: KEY, value: JSON.stringify(list) })
}

export async function readPhoneFile(path: string): Promise<Uint8Array> {
  const res = await fetch(Capacitor.convertFileSrc(path))
  if (!res.ok) throw new Error(`Couldn't read ${path}`)
  return new Uint8Array(await res.arrayBuffer())
}

/** Upload a phone file into the PC library; on failure queue it and return null. */
export async function sendToPc(path: string, kind: AssetKind, ext: string, meta: Partial<Asset>): Promise<Asset | null> {
  try {
    const bytes = await readPhoneFile(path)
    const asset = await invoke('assets:saveBytes', bytes, kind, ext, meta)
    void StitchDevice.deleteFile({ path }).catch(() => {})
    return asset
  } catch {
    const list = await load()
    list.push({ path, kind, ext, meta, at: Date.now() })
    await store(list)
    return null
  }
}

let flushing = false

export async function flushOutbox(): Promise<void> {
  if (flushing) return
  flushing = true
  try {
    const list = await load()
    if (!list.length) return
    const left: Pending[] = []
    let sent = 0
    for (const p of list) {
      try {
        const bytes = await readPhoneFile(p.path)
        await invoke('assets:saveBytes', bytes, p.kind, p.ext, p.meta)
        void StitchDevice.deleteFile({ path: p.path }).catch(() => {})
        sent++
      } catch (err) {
        // Missing file: drop it. Anything else: keep for next time.
        if (!(err instanceof Error && err.message.startsWith("Couldn't read"))) left.push(p)
      }
    }
    await store(left)
    if (sent) toast.success(`Synced ${sent} phone creation${sent === 1 ? '' : 's'} to your PC`)
  } finally {
    flushing = false
  }
}

export function installOutbox(): void {
  link.onReady(() => void flushOutbox())
}
