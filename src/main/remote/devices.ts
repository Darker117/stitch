// Paired phones. Only token hashes are stored; the raw token lives on the phone.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { nanoid } from 'nanoid'
import type { RemoteDevice } from '@shared/ipc'
import { dataDir } from '../store'

export interface StoredDevice {
  id: string
  name: string
  platform: string
  appVersion?: string
  createdAt: number
  lastSeenAt?: number
  lastAddress?: string
  tokenHash: string
  /** Scoped key for media URLs (file/thumbnail GETs only). */
  mediaKey: string
}

interface RemoteFile {
  pcId: string
  devices: StoredDevice[]
  /** Private relay topic + key where the PC posts its current public address (Access from anywhere). */
  rendezvous?: { topic: string; key: string }
}

const file = (): string => join(dataDir(), 'remote.json')
let state: RemoteFile | null = null

function load(): RemoteFile {
  if (state) return state
  try {
    if (existsSync(file())) state = JSON.parse(readFileSync(file(), 'utf8')) as RemoteFile
  } catch {
    state = null
  }
  if (!state?.pcId) state = { pcId: nanoid(12), devices: state?.devices ?? [] }
  state.rendezvous ??= { topic: `stitch-${randomBytes(16).toString('hex')}`, key: randomBytes(32).toString('base64') }
  save()
  return state
}

function save(): void {
  if (!state) return
  const tmp = `${file()}.tmp`
  writeFileSync(tmp, JSON.stringify(state, null, 2))
  renameSync(tmp, file())
}

export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex')

export function pcId(): string {
  return load().pcId
}

export function rendezvous(): { topic: string; key: string } {
  return load().rendezvous!
}

export function listDevices(): StoredDevice[] {
  return load().devices
}

export function addDevice(info: { name: string; platform: string; appVersion?: string; address?: string }, fixedToken?: string): { device: StoredDevice; token: string } {
  const token = fixedToken ?? randomBytes(32).toString('base64url')
  const device: StoredDevice = {
    id: nanoid(10),
    name: (info.name || 'Phone').slice(0, 60),
    platform: (info.platform || 'android').slice(0, 20),
    appVersion: info.appVersion?.slice(0, 20),
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
    lastAddress: info.address,
    tokenHash: hashToken(token),
    mediaKey: randomBytes(18).toString('base64url')
  }
  load().devices.push(device)
  save()
  return { device, token }
}

export function removeDevice(id: string): boolean {
  const s = load()
  const before = s.devices.length
  s.devices = s.devices.filter((d) => d.id !== id)
  save()
  return s.devices.length !== before
}

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex')
  const y = Buffer.from(b, 'hex')
  return x.length === y.length && timingSafeEqual(x, y)
}

export function deviceForToken(token: string | undefined | null): StoredDevice | undefined {
  if (!token || token.length < 20) return undefined
  const h = hashToken(token)
  return load().devices.find((d) => sameHash(d.tokenHash, h))
}

export function deviceForMediaKey(key: string | undefined | null): StoredDevice | undefined {
  if (!key || key.length < 16) return undefined
  return load().devices.find((d) => d.mediaKey === key)
}

export function touchDevice(id: string, patch: Partial<Pick<StoredDevice, 'lastAddress' | 'appVersion' | 'name'>>): void {
  const d = load().devices.find((x) => x.id === id)
  if (!d) return
  Object.assign(d, patch, { lastSeenAt: Date.now() })
  save()
}

export function publicDevice(d: StoredDevice, online: boolean): RemoteDevice {
  return {
    id: d.id,
    name: d.name,
    platform: d.platform,
    appVersion: d.appVersion,
    createdAt: d.createdAt,
    lastSeenAt: d.lastSeenAt,
    lastAddress: d.lastAddress,
    online
  }
}
