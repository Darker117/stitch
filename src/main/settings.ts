import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DeepPartial } from '@shared/ipc'
import type { AppSettings } from '@shared/types'
import { SUNSET } from '@shared/theme'
import { emit } from './ipc'
import { dataDir } from './store'

function defaults(): AppSettings {
  return {
    libraryDir: join(app.getPath('documents'), 'Stitch'),
    gpu: { enabled: [], assign: { image: 'auto', video: 'auto', audio: 'auto', voice: 'auto' }, managed: false },
    comfyAutoLaunch: false,
    theme: {
      background: { type: 'gradient', dim: 0.35, blur: 0 },
      accentMode: 'auto',
      accent: SUNSET.accent,
      accent2: SUNSET.accent2,
      tint: SUNSET.tint
    },
    userName: 'Storyteller',
    onboardingDone: false,
    civitai: { hideNsfw: true },
    updates: { autoDownload: true },
    remote: { enabled: false, port: 47847 },
    web: { enabled: true, safeSearch: 1, maxResults: 6 },
    cluster: { role: 'main' },
    llama: { ctx: 8192, devices: [], port: 8480, autoStart: false }
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function merge<T>(base: T, patch: unknown): T {
  if (!isObject(base) || !isObject(patch)) return (patch === undefined ? base : patch) as T
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    out[k] = isObject(v) && isObject(out[k]) ? merge(out[k], v) : v
  }
  return out as T
}

let current: AppSettings | null = null
const file = (): string => join(dataDir(), 'settings.json')

export function getSettings(): AppSettings {
  if (current) return current
  let stored: unknown = {}
  if (existsSync(file())) {
    try {
      stored = JSON.parse(readFileSync(file(), 'utf8'))
    } catch {
      stored = {}
    }
  }
  current = merge(defaults(), stored)
  // Screenshot/test runs skip the first-run welcome unless asked for.
  if (!app.isPackaged && process.env.STITCH_CAPTURE && process.env.STITCH_ONBOARDING !== '1') current.onboardingDone = true
  mkdirSync(current.libraryDir, { recursive: true })
  return current
}

export function updateSettings(patch: DeepPartial<AppSettings>): AppSettings {
  current = merge(getSettings(), patch)
  mkdirSync(current.libraryDir, { recursive: true })
  const tmp = `${file()}.tmp`
  writeFileSync(tmp, JSON.stringify(current, null, 2))
  renameSync(tmp, file())
  emit('settings:changed', current)
  return current
}

// ─── Secrets (API keys) — encrypted with the OS keychain via safeStorage ────

type SecretFile = Record<string, string>
const secretsFile = (): string => join(dataDir(), 'secrets.json')

function readSecrets(): SecretFile {
  if (!existsSync(secretsFile())) return {}
  try {
    return JSON.parse(readFileSync(secretsFile(), 'utf8')) as SecretFile
  } catch {
    return {}
  }
}

export function setSecret(id: string, value: string | null): void {
  const all = readSecrets()
  if (value === null || value === '') delete all[id]
  else {
    all[id] = safeStorage.isEncryptionAvailable()
      ? 'enc:' + safeStorage.encryptString(value).toString('base64')
      : 'raw:' + Buffer.from(value, 'utf8').toString('base64')
  }
  writeFileSync(secretsFile(), JSON.stringify(all))
}

export function getSecret(id: string): string | undefined {
  const v = readSecrets()[id]
  if (!v) return undefined
  const data = Buffer.from(v.slice(4), 'base64')
  try {
    return v.startsWith('enc:') ? safeStorage.decryptString(data) : data.toString('utf8')
  } catch {
    return undefined
  }
}
