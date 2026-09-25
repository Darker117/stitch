// Local voice engines. Stitch keeps one managed Python 3.12 env under
// <userData>/voice-engine — a shared runtime (PyTorch, CUDA 12.8 when an NVIDIA GPU
// is present) plus each engine's own packages, installed on demand:
//   qwen3   Qwen3-TTS  — cloning, preset speakers, voice design (GPU)
//   kokoro  Kokoro-82M — 54 preset voices in 9 languages (GPU, CPU fallback)
//   pocket  Pocket TTS — Kyutai's 100M CPU model with voice cloning (CPU)
// All of them run inside resources/voice-server/server.py; weights live in voice-engine/hf.
import { app } from 'electron'
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { basename, extname, join } from 'node:path'
import { promisify } from 'node:util'
import type { DetectResult, VoiceEngineId, VoiceEngineStatus } from '@shared/ipc'
import type { Asset, VoiceConnector, VoiceKind } from '@shared/types'
import { emit } from '../../ipc'
import { getSecret } from '../../settings'
import { db } from '../../store'
import { voiceGpu } from '../gpu'
import { detectFfmpeg, detectGpus, detectStabilityMatrix } from '../system'

const run = promisify(execFile)

export const TORCH_INDEX = 'https://download.pytorch.org/whl/cu128'
const TORCH_CPU_INDEX = 'https://download.pytorch.org/whl/cpu'
const DEFAULT_PORT = 7862
const MAX_LOG = 1200
const EN_CORE_WEB_SM = 'en_core_web_sm @ https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl'

// ─── Engines ─────────────────────────────────────────────────────────────────

export type LocalEngineId = 'qwen3' | 'kokoro' | 'pocket'

export interface LocalEngineDef {
  id: LocalEngineId
  name: string
  kind: VoiceKind
  /** Connector created for the engine when none exists. */
  connectorId: string
  license: string
  supportsCloning: boolean
  device: 'gpu' | 'cpu'
  description: string
  homepage: string
  /** `uv pip install` specs, on top of the shared runtime. */
  packages: string[]
  /** Module imported to verify the install, and its distribution name (for the version). */
  module: string
  dist: string
  /** Hugging Face repos whose cached weights belong to this engine. */
  repos: string[]
  /** Rough size of a fresh install: packages + default weights. */
  downloadBytes: number
}

const MB = 1024 * 1024

export const LOCAL_ENGINES: Record<LocalEngineId, LocalEngineDef> = {
  qwen3: {
    id: 'qwen3',
    name: 'Qwen3-TTS',
    kind: 'local-qwen',
    connectorId: 'voice-local',
    license: 'Apache-2.0',
    supportsCloning: true,
    device: 'gpu',
    description: 'Clone any voice from a few seconds, preset speakers and voice design — on your GPU.',
    homepage: 'https://github.com/QwenLM/Qwen3-TTS',
    packages: ['qwen-tts'],
    module: 'qwen_tts',
    dist: 'qwen-tts',
    repos: [
      'Qwen/Qwen3-TTS-12Hz-1.7B-Base',
      'Qwen/Qwen3-TTS-12Hz-0.6B-Base',
      'Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice',
      'Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice',
      'Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign'
    ],
    downloadBytes: 700 * MB
  },
  kokoro: {
    id: 'kokoro',
    name: 'Kokoro',
    kind: 'local-kokoro',
    connectorId: 'voice-kokoro',
    license: 'Apache-2.0',
    supportsCloning: false,
    device: 'gpu',
    description: '82M-parameter TTS with 54 preset voices in 9 languages — fast and light.',
    homepage: 'https://huggingface.co/hexgrad/Kokoro-82M',
    // misaki[en] = English G2P (+ espeak-ng via espeakng-loader for es/fr/hi/it/pt); [zh] = Mandarin.
    // spaCy's English model is installed up front: misaki would otherwise try `pip install` at runtime.
    packages: ['kokoro>=0.9.4', 'misaki[en,zh]>=0.9.4', EN_CORE_WEB_SM, 'soundfile'],
    module: 'kokoro',
    dist: 'kokoro',
    repos: ['hexgrad/Kokoro-82M'],
    downloadBytes: 740 * MB
  },
  pocket: {
    id: 'pocket',
    name: 'Pocket TTS',
    kind: 'local-pocket',
    connectorId: 'voice-pocket',
    license: 'MIT (code) · CC-BY-4.0 (weights)',
    supportsCloning: true,
    device: 'cpu',
    description: "Kyutai's 100M-parameter TTS that runs faster than real time on the CPU, with voice cloning.",
    homepage: 'https://github.com/kyutai-labs/pocket-tts',
    packages: ['pocket-tts'],
    module: 'pocket_tts',
    dist: 'pocket-tts',
    repos: ['kyutai/pocket-tts', 'kyutai/pocket-tts-without-voice-cloning', 'kyutai/tts-voices'],
    downloadBytes: 350 * MB
  }
}

export const LOCAL_ENGINE_IDS = Object.keys(LOCAL_ENGINES) as LocalEngineId[]

export function engineOfKind(kind: VoiceKind): LocalEngineId | undefined {
  return LOCAL_ENGINE_IDS.find((id) => LOCAL_ENGINES[id].kind === kind)
}

export interface EngineModel {
  id: string
  repo: string
  label: string
  engine: LocalEngineId
  /** Pocket TTS language (config name). */
  language?: string
}

export const POCKET_LANGUAGES = ['english', 'french', 'german', 'portuguese', 'italian', 'spanish', 'dutch']

/** Qwen3-TTS models surfaced in the UI (the server also knows custom-0.6b). */
export const ENGINE_MODELS: EngineModel[] = [
  { id: 'base-1.7b', repo: 'Qwen/Qwen3-TTS-12Hz-1.7B-Base', label: 'Voice cloning · 1.7B', engine: 'qwen3' },
  { id: 'custom-1.7b', repo: 'Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice', label: 'Preset speakers · 1.7B', engine: 'qwen3' },
  { id: 'design-1.7b', repo: 'Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign', label: 'Voice design · 1.7B', engine: 'qwen3' },
  { id: 'base-0.6b', repo: 'Qwen/Qwen3-TTS-12Hz-0.6B-Base', label: 'Voice cloning · 0.6B (lighter)', engine: 'qwen3' }
]
const KOKORO_MODEL: EngineModel = { id: 'kokoro-82m', repo: 'hexgrad/Kokoro-82M', label: 'Kokoro 82M · all voices', engine: 'kokoro' }
const POCKET_MODELS: EngineModel[] = POCKET_LANGUAGES.map((l) => ({
  id: `pocket-${l}`,
  repo: 'kyutai/pocket-tts-without-voice-cloning',
  label: `Pocket TTS · ${l[0].toUpperCase()}${l.slice(1)}`,
  engine: 'pocket',
  language: l
}))
const ALL_MODELS: EngineModel[] = [
  ...ENGINE_MODELS,
  { id: 'custom-0.6b', repo: 'Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice', label: 'Preset speakers · 0.6B', engine: 'qwen3' },
  KOKORO_MODEL,
  ...POCKET_MODELS
]

// ─── Paths ───────────────────────────────────────────────────────────────────

export const engineDir = (): string => join(app.getPath('userData'), 'voice-engine')
const venvDir = (): string => join(engineDir(), 'venv')
const venvPython = (): string => join(venvDir(), process.platform === 'win32' ? 'Scripts\\python.exe' : 'bin/python')
const pythonDir = (): string => join(engineDir(), 'python')
const hfHome = (): string => join(engineDir(), 'hf')
const hubDir = (repo: string): string => join(hfHome(), 'hub', `models--${repo.replace('/', '--')}`)
const serverDest = (): string => join(engineDir(), 'server.py')
const markerFile = (): string => join(engineDir(), 'install.json')
const constraintsFile = (): string => join(engineDir(), 'constraints.txt')

function serverSource(): string | undefined {
  const candidates = [
    join(process.resourcesPath ?? '', 'voice-server', 'server.py'),
    join(app.getAppPath(), 'resources', 'voice-server', 'server.py'),
    join(__dirname, '../../resources/voice-server/server.py')
  ]
  return candidates.find((p) => existsSync(p))
}

/** Copy the bundled server next to the venv (python can't read inside app.asar). */
function syncServer(): void {
  const src = serverSource()
  if (!src) {
    if (existsSync(serverDest())) return
    throw new Error('Voice server script is missing from this build (resources/voice-server/server.py)')
  }
  const code = readFileSync(src)
  if (existsSync(serverDest()) && readFileSync(serverDest()).equals(code)) return
  mkdirSync(engineDir(), { recursive: true })
  writeFileSync(serverDest(), code)
}

// ─── Install marker ──────────────────────────────────────────────────────────

interface EngineRecord {
  version: string
  installedAt: number
  /** Distributions this engine's install added to the env (removed with it). */
  packages: string[]
  /** Bytes of those distributions. */
  pkgBytes?: number
}

interface Marker {
  installedAt: number
  python?: string
  torch?: string
  cuda?: string | null
  cuda_available?: boolean
  arch?: string[]
  devices?: string[]
  torchVariant?: 'cu128' | 'cpu'
  /** Whole env (venv + managed Python) at the last install/remove. */
  envBytes?: number
  /** Distributions of the bare runtime (PyTorch & co.) — never claimed by an engine. */
  basePackages?: string[]
  engines?: Partial<Record<LocalEngineId, EngineRecord>>
  /** Pre-1.1 installs: Qwen3-TTS was part of the runtime. */
  qwen_tts?: string
}

let markerCache: { at: number; value: Marker | null } | null = null

function readMarker(): Marker | null {
  if (markerCache && Date.now() - markerCache.at < 2000) return markerCache.value
  let value: Marker | null = null
  try {
    value = JSON.parse(readFileSync(markerFile(), 'utf8')) as Marker
    if (!value.engines) {
      // Migrate: older installs put qwen-tts in the base env.
      value.engines = value.qwen_tts ? { qwen3: { version: value.qwen_tts, installedAt: value.installedAt, packages: ['qwen-tts'] } } : {}
    }
  } catch {
    value = null
  }
  markerCache = { at: Date.now(), value }
  return value
}

function writeMarker(m: Marker): void {
  mkdirSync(engineDir(), { recursive: true })
  writeFileSync(markerFile(), JSON.stringify(m, null, 2))
  markerCache = { at: Date.now(), value: m }
}

/** PyTorch build in the shared runtime ('cpu' when no NVIDIA GPU was found or it was forced). */
export function torchVariant(): 'cu128' | 'cpu' | undefined {
  const m = readMarker()
  if (!m?.torch) return undefined
  return m.torchVariant ?? (/\+cu\d+/.test(m.torch) ? 'cu128' : 'cpu')
}

/** The shared runtime (Python + PyTorch) is in place. */
export function runtimeInstalled(): boolean {
  return existsSync(venvPython()) && !!readMarker()?.torch
}

export function engineInstalled(id: LocalEngineId): boolean {
  return runtimeInstalled() && !!readMarker()?.engines?.[id]
}

/** At least one local engine is installed (the server has something to run). */
export function isInstalled(): boolean {
  return LOCAL_ENGINE_IDS.some(engineInstalled)
}

// ─── Status ──────────────────────────────────────────────────────────────────

const st: VoiceEngineStatus = { installed: false, running: false, busy: 'idle', port: DEFAULT_PORT, log: [], models: [] }
let child: ChildProcess | null = null
let installChild: ChildProcess | null = null
let installCanceled = false
let stopping = false
let spawnedGpu: number | undefined
let startPromise: Promise<void> | null = null
let inflight = 0
let remoteModels: Record<string, boolean> | null = null
let remoteEngines: Record<string, boolean> | null = null
let pollTimer: NodeJS.Timeout | null = null
let emitTimer: NodeJS.Timeout | null = null
let downloadChain: Promise<void> = Promise.resolve()
/** Filled by index.ts: builds the `engines` list for status events (needs connectors + voices). */
let enginesProvider: (() => VoiceEngineStatus['engines']) | null = null

export function setEnginesProvider(fn: () => VoiceEngineStatus['engines']): void {
  enginesProvider = fn
}

function snapshot(): VoiceEngineStatus {
  let engines: VoiceEngineStatus['engines']
  try {
    engines = enginesProvider?.()
  } catch {
    engines = undefined
  }
  return { ...st, installed: isInstalled(), models: modelStates(), log: st.log.slice(-400), engines }
}

function changed(): void {
  if (emitTimer) return
  emitTimer = setTimeout(() => {
    emitTimer = null
    emit('voice:engine', snapshot())
  }, 120)
}

export function engineStatus(): VoiceEngineStatus {
  return snapshot()
}

/** Local engine currently being installed or removed. */
export function installingEngine(): LocalEngineId | undefined {
  return st.installing as LocalEngineId | undefined
}

const PROGRESS_RE = /(\d{1,3})%\|/

/** Append a log line. tqdm/uv progress lines replace the previous line of the same file. */
function logLine(raw: string): void {
  const line = raw.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trimEnd()
  if (!line.trim()) return
  const pct = PROGRESS_RE.exec(line)
  if (pct) {
    const prefix = line.split(':')[0]
    const last = st.log[st.log.length - 1]
    if (last && PROGRESS_RE.test(last) && last.split(':')[0] === prefix) st.log[st.log.length - 1] = line
    else st.log.push(line)
    if (st.activity?.model) st.activity = { ...st.activity, progress: Math.min(1, Number(pct[1]) / 100) }
  } else {
    st.log.push(line)
  }
  if (st.log.length > MAX_LOG) st.log.splice(0, st.log.length - MAX_LOG)
  changed()
}

function modelLabel(id: string): string {
  return ALL_MODELS.find((m) => m.id === id)?.label ?? id
}

function modelEngine(id: string): LocalEngineId | undefined {
  return ALL_MODELS.find((m) => m.id === id)?.engine
}

/** Machine-readable "@@state <name> [detail]" lines from server.py. */
function onServerState(name: string, detail: string): void {
  switch (name) {
    case 'downloading':
      st.busy = 'loading-model'
      st.activity = { label: `Downloading ${modelLabel(detail)}`, model: detail, engine: modelEngine(detail) }
      break
    case 'loading-model':
      st.busy = 'loading-model'
      st.activity = { label: `Loading ${modelLabel(detail)}`, model: detail, engine: modelEngine(detail) }
      break
    case 'generating':
      st.busy = 'generating'
      st.activity = { label: detail ? `Generating · ${detail}` : 'Generating' }
      break
    default:
      if (st.busy !== 'installing' && st.busy !== 'starting') st.busy = inflight > 0 ? 'generating' : 'idle'
      if (!st.activity?.step) st.activity = undefined
      sizesDirty = true
  }
  changed()
}

function makeLineReader(): (chunk: Buffer) => void {
  let rest = ''
  return (chunk) => {
    const text = rest + chunk.toString('utf8')
    const parts = text.split(/\r\n|\n|\r/)
    rest = parts.pop() ?? ''
    // A lone trailing progress fragment is still worth showing.
    if (rest && PROGRESS_RE.test(rest) && rest.length > 20) {
      parts.push(rest)
      rest = ''
    }
    for (const line of parts) {
      const m = /^@@state\s+(\S+)\s*(.*)$/.exec(line.trim())
      if (m) onServerState(m[1], m[2].trim())
      else logLine(line)
    }
  }
}

// ─── Hugging Face cache (models on disk) ─────────────────────────────────────

function snapshots(repo: string): string[] {
  const base = join(hubDir(repo), 'snapshots')
  try {
    return readdirSync(base).map((s) => join(base, s))
  } catch {
    return []
  }
}

function qwenReady(repo: string): boolean {
  for (const snap of snapshots(repo)) {
    try {
      const files = readdirSync(snap)
      if (files.includes('config.json') && files.includes('speech_tokenizer') && files.some((f) => f.endsWith('.safetensors'))) return true
    } catch {
      /* partial */
    }
  }
  return false
}

/** Pocket TTS weights for a language: the gated cloning ones or the open ones. */
function pocketReady(language: string, cloningOnly = false): boolean {
  const repos = cloningOnly ? ['kyutai/pocket-tts'] : ['kyutai/pocket-tts', 'kyutai/pocket-tts-without-voice-cloning']
  return repos.some((r) => snapshots(r).some((s) => existsSync(join(s, 'languages', language, 'model.safetensors'))))
}

export function pocketCloningDownloaded(language = 'english'): boolean {
  return pocketReady(language, true)
}

export function modelDownloaded(id: string): boolean {
  if (remoteModels && id in remoteModels) return remoteModels[id]
  const m = ALL_MODELS.find((x) => x.id === id)
  if (!m) return false
  if (m.engine === 'kokoro') return snapshots(m.repo).some((s) => existsSync(join(s, 'kokoro-v1_0.pth')) && existsSync(join(s, 'config.json')))
  if (m.engine === 'pocket') return pocketReady(m.language!)
  return qwenReady(m.repo)
}

function modelStates(): VoiceEngineStatus['models'] {
  const shown = [...ENGINE_MODELS, KOKORO_MODEL, ...POCKET_MODELS.filter((m) => m.language === 'english' || modelDownloaded(m.id))]
  return shown.map((m) => ({ id: m.id, label: m.label, downloaded: modelDownloaded(m.id), engine: m.engine }))
}

export function engineWeights(id: LocalEngineId): { id: string; label: string; downloaded: boolean }[] {
  return modelStates()
    .filter((m) => m.engine === id)
    .map(({ id: mid, label, downloaded }) => ({ id: mid, label, downloaded }))
}

// ─── Sizes ───────────────────────────────────────────────────────────────────

function dirSize(p: string): number {
  let total = 0
  const stack = [p]
  while (stack.length) {
    const cur = stack.pop()!
    let st_
    try {
      st_ = lstatSync(cur)
    } catch {
      continue
    }
    if (st_.isSymbolicLink()) continue
    if (st_.isFile()) total += st_.size
    else if (st_.isDirectory()) {
      try {
        for (const f of readdirSync(cur)) stack.push(join(cur, f))
      } catch {
        /* unreadable */
      }
    }
  }
  return total
}

let sizesDirty = true
const weightBytes = new Map<LocalEngineId, number>()

function refreshSizes(): void {
  if (!sizesDirty) return
  sizesDirty = false
  for (const id of LOCAL_ENGINE_IDS) weightBytes.set(id, LOCAL_ENGINES[id].repos.reduce((n, r) => n + dirSize(hubDir(r)), 0))
}

export function markSizesDirty(): void {
  sizesDirty = true
}

/** Disk usage of a local engine: its packages + downloaded weights (the shared runtime is separate). */
export function engineDisk(id: LocalEngineId): { sizeBytes: number; path: string } {
  refreshSizes()
  const rec = readMarker()?.engines?.[id]
  const def = LOCAL_ENGINES[id]
  const main = def.repos.map(hubDir).find((p) => existsSync(p))
  return { sizeBytes: (rec?.pkgBytes ?? 0) + (weightBytes.get(id) ?? 0), path: main ?? engineDir() }
}

/** Shared runtime size: the env minus every engine's own packages. */
export function runtimeBytes(): number | undefined {
  const m = readMarker()
  if (!m?.envBytes) return undefined
  const pkgs = Object.values(m.engines ?? {}).reduce((n, e) => n + (e?.pkgBytes ?? 0), 0)
  return Math.max(0, m.envBytes - pkgs)
}

// ─── Connector / URL ─────────────────────────────────────────────────────────

export function localConnector(): VoiceConnector | undefined {
  const all = db('connectors').list().filter((c): c is VoiceConnector => c.category === 'voice' && c.kind === 'local-qwen')
  return all.find((c) => c.id === 'voice-local') ?? all[0]
}

export function engineUrl(c: VoiceConnector | undefined = localConnector()): string {
  return (c?.baseUrl || `http://127.0.0.1:${DEFAULT_PORT}`).replace(/\/+$/, '')
}

function portOf(url: string): number {
  try {
    const u = new URL(url)
    return Number(u.port || (u.protocol === 'https:' ? 443 : 80))
  } catch {
    return DEFAULT_PORT
  }
}

export function isLocalUrl(url: string): boolean {
  try {
    return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(new URL(url).hostname)
  } catch {
    return true
  }
}

/** Hugging Face token saved on the Pocket TTS connector (unlocks Kyutai's gated cloning weights). */
export function pocketToken(): string | undefined {
  const c = db('connectors')
    .list()
    .find((x): x is VoiceConnector => x.category === 'voice' && x.kind === 'local-pocket')
  return c ? getSecret(c.id)?.trim() || undefined : undefined
}

// ─── HTTP (node:http — no fetch timeouts; long generations are fine) ─────────

interface RawResponse {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: Buffer
}

function rawRequest(url: string, method: 'GET' | 'POST', body?: unknown, timeoutMs = 0): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
    const req = (u.protocol === 'https:' ? httpsRequest : httpRequest)(
      u,
      { method, headers: payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {} },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }))
        res.on('error', reject)
      }
    )
    if (timeoutMs) req.setTimeout(timeoutMs, () => req.destroy(new Error('timed out')))
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

interface Health {
  ok: boolean
  device: string
  device_name?: string
  cuda_visible_devices?: string | null
  torch?: string
  loaded?: string[]
  state?: string
  detail?: string
  models?: Record<string, { downloaded: boolean }>
  engines?: Record<string, { available: boolean }>
}

async function health(url = engineUrl(), timeoutMs = 1500): Promise<Health | null> {
  try {
    const res = await rawRequest(`${url}/health`, 'GET', undefined, timeoutMs)
    if (res.status !== 200) return null
    const h = JSON.parse(res.body.toString('utf8')) as Health
    return h.ok ? h : null
  } catch {
    return null
  }
}

function shortGpu(name: string): string {
  return name.replace(/^NVIDIA\s+/i, '').replace(/^GeForce\s+/i, '')
}

function applyHealth(h: Health, url: string): void {
  if (h.device?.startsWith('cuda')) {
    const idx = h.cuda_visible_devices && /^\d+$/.test(h.cuda_visible_devices) ? `GPU ${h.cuda_visible_devices} · ` : ''
    st.device = `${idx}${shortGpu(h.device_name ?? 'CUDA')}`
  } else if (h.device) st.device = 'CPU'
  const remote = !isLocalUrl(url)
  remoteModels = remote && h.models ? Object.fromEntries(Object.entries(h.models).map(([k, v]) => [k, v.downloaded])) : null
  remoteEngines = remote && h.engines ? Object.fromEntries(Object.entries(h.engines).map(([k, v]) => [k, v.available])) : null
}

/** A remote voice server (another PC) reports which engines it has; local installs use the marker. */
export function engineUsable(id: LocalEngineId): boolean {
  if (!isLocalUrl(engineUrl())) return remoteEngines ? !!remoteEngines[id] : true
  return engineInstalled(id)
}

// ─── GPU choice ──────────────────────────────────────────────────────────────

let gpuCache: { at: number; list: DetectResult['gpus'] } | null = null

async function gpuList(): Promise<DetectResult['gpus']> {
  if (!gpuCache || Date.now() - gpuCache.at > 60_000) gpuCache = { at: Date.now(), list: await detectGpus() }
  return gpuCache.list
}

async function plannedGpu(): Promise<{ index: number; name: string } | undefined> {
  const list = await gpuList()
  const idx = voiceGpu(list.map((g) => g.index))
  const g = list.find((x) => x.index === idx)
  return g ? { index: g.index, name: g.name } : undefined
}

function gpuLabel(g: { index: number; name: string } | undefined): string {
  return g ? `GPU ${g.index} · ${shortGpu(g.name)}` : 'CPU'
}

function engineEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HF_HOME: hfHome(),
    HF_HUB_DISABLE_SYMLINKS_WARNING: '1',
    HF_HUB_DISABLE_TELEMETRY: '1',
    PYTHONUNBUFFERED: '1',
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    TOKENIZERS_PARALLELISM: 'false',
    CUDA_DEVICE_ORDER: 'PCI_BUS_ID',
    NO_COLOR: '1'
  }
  for (const k of ['PYTHONHOME', 'PYTHONPATH', 'VIRTUAL_ENV', 'CONDA_PREFIX', 'CUDA_VISIBLE_DEVICES', 'HF_TOKEN']) delete env[k]
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k]
    else env[k] = v
  }
  return env
}

// ─── Install ─────────────────────────────────────────────────────────────────

async function findUv(): Promise<string | undefined> {
  const exe = process.platform === 'win32' ? 'uv.exe' : 'uv'
  try {
    const { stdout } = await run(process.platform === 'win32' ? 'where' : 'which', ['uv'])
    const first = stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => l && existsSync(l))
    if (first) return first
  } catch {
    /* not on PATH */
  }
  const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
  const local = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
  const candidates = [
    join(home, '.local', 'bin', exe),
    join(home, '.cargo', 'bin', exe),
    join(local, 'uv', exe),
    join(local, 'Microsoft', 'WinGet', 'Links', exe),
    join(local, 'hermes', 'bin', exe)
  ]
  const sm = detectStabilityMatrix()
  if (sm) candidates.push(join(sm.dataDir, 'Assets', 'uv', exe))
  candidates.push('C:\\pinokio\\bin\\uv.exe', 'C:\\pinokio\\bin\\miniconda\\Scripts\\uv.exe', 'C:\\pinokio\\bin\\miniforge\\Scripts\\uv.exe')
  return candidates.find((p) => existsSync(p))
}

/** Run a command, streaming its output into the engine log. Resolves with stdout. */
function runLogged(cmd: string, args: string[], env: NodeJS.ProcessEnv, quiet = false): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!quiet) logLine(`$ ${basename(cmd)} ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`)
    const proc = spawn(cmd, args, { cwd: engineDir(), env, windowsHide: true })
    installChild = proc
    let out = ''
    const tail: string[] = []
    const reader = makeLineReader()
    proc.stdout?.on('data', (c: Buffer) => {
      out += c.toString('utf8')
      if (!quiet) reader(c)
    })
    proc.stderr?.on('data', (c: Buffer) => {
      for (const l of c.toString('utf8').split(/\r?\n/)) if (l.trim()) tail.push(l.trim())
      if (tail.length > 8) tail.splice(0, tail.length - 8)
      reader(c)
    })
    proc.on('error', (err) => reject(err))
    // 'close' (not 'exit'): stdout is fully drained, so captured output (pip list JSON) is complete.
    proc.on('close', (code) => {
      if (installChild === proc) installChild = null
      if (installCanceled) reject(new Error('Install canceled'))
      else if (code === 0) resolve(out)
      else {
        const hint = tail.filter((l) => /error|failed|not found|denied|No solution|unsatisf|because/i.test(l)).slice(-2).join(' · ')
        reject(new Error(`${basename(cmd)} exited with code ${code}${hint ? ` — ${hint}` : ''}`))
      }
    })
  })
}

const VERIFY_RUNTIME = [
  'import json, sys, torch',
  'info = {"python": sys.version.split()[0], "torch": torch.__version__, "cuda": torch.version.cuda, "cuda_available": torch.cuda.is_available()}',
  'info["arch"] = torch.cuda.get_arch_list() if torch.cuda.is_available() else []',
  'info["devices"] = [torch.cuda.get_device_name(i) for i in range(torch.cuda.device_count())] if torch.cuda.is_available() else []',
  'print("@@verify " + json.dumps(info))'
].join('\n')

/** Imports the engine, reports its version and the size of the distributions it added. argv: module dist extra-json added-json */
const VERIFY_ENGINE = [
  'import json, sys, importlib, importlib.metadata as md',
  'mod, dist, extra, added = sys.argv[1], sys.argv[2], json.loads(sys.argv[3]), json.loads(sys.argv[4])',
  'importlib.import_module(mod)',
  'for m in extra: importlib.import_module(m)',
  'def size(name):',
  '    try:',
  '        return sum((f.size or 0) for f in (md.distribution(name).files or []))',
  '    except Exception:',
  '        return 0',
  'print("@@verify " + json.dumps({"version": md.version(dist), "bytes": sum(size(n) for n in added)}))'
].join('\n')

/** Extra imports proving an engine is usable (e.g. Kokoro's spaCy model and espeak-ng). */
const VERIFY_EXTRA: Partial<Record<LocalEngineId, string[]>> = {
  kokoro: ['en_core_web_sm', 'espeakng_loader', 'misaki.en', 'misaki.zh'],
  pocket: ['pocket_tts.models.tts_model']
}

interface RuntimeInfo {
  python: string
  torch: string
  cuda: string | null
  cuda_available: boolean
  arch: string[]
  devices: string[]
}

function parseVerify<T>(out: string): T {
  const line = out.split(/\r?\n/).find((l) => l.startsWith('@@verify '))
  if (!line) throw new Error('Could not verify the Python environment')
  return JSON.parse(line.slice(9)) as T
}

const normPkg = (n: string): string => n.toLowerCase().replace(/[-_.]+/g, '-')

/** Bytes on disk of some installed distributions. */
async function packagesBytes(names: string[]): Promise<number> {
  try {
    const code = [
      'import json, sys, importlib.metadata as md',
      't = 0',
      'for n in json.loads(sys.argv[1]):',
      '    try: t += sum((f.size or 0) for f in (md.distribution(n).files or []))',
      '    except Exception: pass',
      'print(t)'
    ].join('\n')
    const { stdout } = await run(venvPython(), ['-c', code, JSON.stringify(names)], { env: engineEnv(), windowsHide: true })
    return Number(stdout.trim()) || 0
  } catch {
    return 0
  }
}

/** Installed distributions (normalised names), or null when the listing can't be read. */
async function installedPackages(uv: string, env: NodeJS.ProcessEnv): Promise<Set<string> | null> {
  const out = await runLogged(uv, ['pip', 'list', '--python', venvPython(), '--format', 'json'], env, true)
  try {
    const list = JSON.parse(out.slice(out.indexOf('['))) as { name: string }[]
    return list.length ? new Set(list.map((p) => normPkg(p.name))) : null
  } catch {
    return null
  }
}

/** Runtime packages no engine may claim or remove (only removing the last engine deletes them, with the env). */
const PROTECTED = new Set(['torch', 'torchaudio', 'numpy', 'soundfile', 'huggingface-hub', 'pip', 'setuptools', 'wheel'])

function claimable(names: Iterable<string>, marker: Marker | null): string[] {
  const base = new Set(marker?.basePackages ?? [])
  return [...names].map(normPkg).filter((p) => !PROTECTED.has(p) && !base.has(p))
}

/** Bare distribution name of a requirement spec ("misaki[en,zh]>=0.9.4" → "misaki"). */
const specName = (spec: string): string => normPkg(spec.split(/[\s@<>=[;]/)[0])

/** Which PyTorch build to install: CUDA 12.8 with an NVIDIA GPU, else CPU (override: STITCH_VOICE_TORCH=cpu|cu128). */
async function wantedTorch(): Promise<'cu128' | 'cpu'> {
  const forced = process.env.STITCH_VOICE_TORCH?.trim().toLowerCase()
  if (forced === 'cpu' || forced === 'cu128') return forced
  return (await gpuList()).length ? 'cu128' : 'cpu'
}

/** Pin torch so engine installs never swap the CUDA build for PyPI's CPU one. */
function writeConstraints(torch: string | undefined): void {
  const lines = torch ? [`torch==${torch}`] : []
  writeFileSync(constraintsFile(), lines.join('\n') + '\n')
}

let opChain: Promise<void> = Promise.resolve()
const opPending = new Map<string, Promise<void>>()

/** Serialise installs/removals; repeated calls for the same operation share one run. */
function queued(key: string, fn: () => Promise<void>): Promise<void> {
  const existing = opPending.get(key)
  if (existing) return existing
  const p = opChain.then(fn).finally(() => opPending.delete(key))
  opPending.set(key, p)
  opChain = p.catch(() => {})
  return p
}

/** Install (or repair) a local engine; the shared runtime is set up first when missing. */
export function installEngine(id: LocalEngineId = 'qwen3'): Promise<void> {
  if (!LOCAL_ENGINES[id]) return Promise.reject(new Error(`Unknown voice engine '${id}'`))
  return queued(`install:${id}`, () => doInstall(id))
}

async function stopForMaintenance(): Promise<void> {
  if (inflight > 0) throw new Error('Wait for the current voice generation to finish, then try again.')
  if (child || st.running) await stopEngine()
  await waitForChildExit()
}

async function doInstall(id: LocalEngineId): Promise<void> {
  const def = LOCAL_ENGINES[id]
  await stopForMaintenance()
  installCanceled = false
  const hadRuntime = runtimeInstalled()
  const stepNames = [...(hadRuntime ? ['Prepare'] : ['Find uv', 'Python 3.12', 'PyTorch']), def.name, 'Verify']
  st.busy = 'installing'
  st.installing = id
  st.error = undefined
  st.log = []
  let n = 0
  const step = (label: string): void => {
    n++
    st.activity = { label, step: n, steps: stepNames.length, stepNames, engine: id }
    logLine(`▸ ${label}`)
  }
  try {
    const dir = engineDir()
    mkdirSync(dir, { recursive: true })
    step(hadRuntime ? `Preparing to install ${def.name}` : 'Finding uv')
    const uv = await findUv()
    if (!uv) throw new Error("Couldn't find uv. Install it (https://docs.astral.sh/uv/) or Stability Matrix, then try again.")
    logLine(`Using ${uv}`)
    const env = engineEnv({ UV_PYTHON_INSTALL_DIR: pythonDir(), UV_NO_PROGRESS: '1' })
    const py = venvPython()
    let marker: Marker = readMarker() ?? { installedAt: Date.now(), engines: {} }

    if (!hadRuntime) {
      step('Creating a Python 3.12 environment')
      let venvOk = false
      if (existsSync(py)) {
        try {
          const { stdout } = await run(py, ['-c', 'import sys; print(sys.version_info[:2] == (3, 12))'], { env, windowsHide: true })
          venvOk = stdout.trim() === 'True'
        } catch {
          venvOk = false
        }
      }
      if (venvOk) logLine('Reusing the existing environment')
      else {
        rmSync(venvDir(), { recursive: true, force: true })
        await runLogged(uv, ['venv', '--python', '3.12', '--python-preference', 'only-managed', '--no-project', venvDir()], env)
      }

      const variant = await wantedTorch()
      const index = variant === 'cu128' ? TORCH_INDEX : TORCH_CPU_INDEX
      step(variant === 'cu128' ? 'Installing PyTorch for CUDA 12.8 (≈3 GB, first time only)' : 'Installing PyTorch for the CPU (no NVIDIA GPU found)')
      await runLogged(uv, ['pip', 'install', '--python', py, 'torch', 'torchaudio', '--index-url', index], env)
      // No global -U: upgrading everything would swap the CUDA torch for PyPI's CPU build.
      await runLogged(uv, ['pip', 'install', '--python', py, 'soundfile', 'numpy', 'huggingface_hub'], env)
      let info = parseVerify<RuntimeInfo>(await runLogged(py, ['-c', VERIFY_RUNTIME], env))
      if (variant === 'cu128' && !/\+cu\d+/.test(info.torch)) {
        logLine(`PyTorch ${info.torch} is a CPU build — reinstalling the CUDA 12.8 build`)
        await runLogged(uv, ['pip', 'install', '--python', py, '--reinstall-package', 'torch', '--reinstall-package', 'torchaudio', 'torch', 'torchaudio', '--index-url', TORCH_INDEX], env)
        info = parseVerify<RuntimeInfo>(await runLogged(py, ['-c', VERIFY_RUNTIME], env))
      }
      logLine(`Python ${info.python} · torch ${info.torch} · CUDA ${info.cuda ?? 'n/a'}`)
      if (info.devices.length) logLine(`GPUs: ${info.devices.join(', ')} · kernels ${info.arch.join(' ')}`)
      else if (variant === 'cu128') logLine('Warning: PyTorch sees no CUDA GPU — GPU engines will run on the CPU (slow).')
      const base = await installedPackages(uv, env)
      marker = { ...marker, ...info, torchVariant: variant, installedAt: marker.installedAt || Date.now(), engines: marker.engines ?? {}, basePackages: base ? [...base] : undefined }
      writeMarker(marker)
    }
    writeConstraints(marker.torch)

    step(`Installing ${def.name}`)
    const before = await installedPackages(uv, env)
    await runLogged(uv, ['pip', 'install', '--python', py, '--constraint', constraintsFile(), ...def.packages], env)
    const after = await installedPackages(uv, env)
    // What this install added (removed with the engine later). If a listing can't be read, claim only the engine's own packages.
    const added = before && after ? [...after].filter((p) => !before.has(p)) : def.packages.map(specName)
    const prev = marker.engines?.[id]?.packages ?? []
    const packages = claimable(new Set([...prev, ...added]), marker)

    step(`Checking ${def.name}`)
    const v = parseVerify<{ version: string; bytes: number }>(
      await runLogged(py, ['-c', VERIFY_ENGINE, def.module, def.dist, JSON.stringify(VERIFY_EXTRA[id] ?? []), JSON.stringify(packages)], env)
    )
    logLine(`${def.name} ${v.version} · ${packages.length} package${packages.length === 1 ? '' : 's'} (${(v.bytes / MB).toFixed(0)} MB)`)
    syncServer()
    marker = readMarker() ?? marker
    marker.engines = { ...(marker.engines ?? {}), [id]: { version: v.version, installedAt: Date.now(), packages, pkgBytes: v.bytes } }
    marker.envBytes = dirSize(venvDir()) + dirSize(pythonDir())
    writeMarker(marker)
    sizesDirty = true
    logLine(`✓ ${def.name} is installed. ${id === 'pocket' ? 'Weights (≈230 MB per language) download' : 'Weights download'} on first use — or fetch them now.`)
  } catch (err) {
    st.error = err instanceof Error ? err.message : String(err)
    logLine(`✗ ${st.error}`)
    throw err
  } finally {
    installChild = null
    st.busy = 'idle'
    st.installing = undefined
    st.activity = undefined
    changed()
  }
}

/** Delete a local engine's Stitch-managed files: its packages (unless another engine needs them) and its weights. */
export function removeEngine(id: LocalEngineId): Promise<void> {
  if (!LOCAL_ENGINES[id]) return Promise.reject(new Error(`Unknown voice engine '${id}'`))
  return queued(`remove:${id}`, () => doRemove(id))
}

async function doRemove(id: LocalEngineId): Promise<void> {
  const def = LOCAL_ENGINES[id]
  await stopForMaintenance()
  installCanceled = false
  st.busy = 'installing'
  st.installing = id
  st.error = undefined
  st.activity = { label: `Removing ${def.name}`, engine: id }
  logLine(`▸ Removing ${def.name}`)
  changed()
  try {
    const marker = readMarker()
    const others = LOCAL_ENGINE_IDS.filter((e) => e !== id && marker?.engines?.[e])
    if (!others.length) {
      // Last local engine: nothing else uses the runtime, so remove the whole managed env.
      logLine('No other local voice engine is installed — removing the shared Python runtime too')
      await rmWithRetry(engineDir())
      markerCache = null
    } else {
      const rec = marker?.engines?.[id]
      const keep = new Set(others.flatMap((e) => (marker?.engines?.[e]?.packages ?? []).map(normPkg)))
      const drop = claimable(rec?.packages ?? def.packages.map(specName), marker).filter((p) => !keep.has(p))
      const uv = await findUv()
      const env = engineEnv({ UV_PYTHON_INSTALL_DIR: pythonDir(), UV_NO_PROGRESS: '1' })
      let restored: string[] = []
      if (uv && drop.length && existsSync(venvPython())) {
        await runLogged(uv, ['pip', 'uninstall', '--python', venvPython(), ...drop], env)
        // Put back anything the remaining engines still need (a no-op when nothing was shared).
        writeConstraints(marker?.torch)
        const before = await installedPackages(uv, env)
        const specs = others.flatMap((e) => LOCAL_ENGINES[e].packages)
        await runLogged(uv, ['pip', 'install', '--python', venvPython(), '--constraint', constraintsFile(), ...specs], env)
        const after = await installedPackages(uv, env)
        restored = before && after ? claimable([...after].filter((p) => !before.has(p)), marker) : []
      }
      for (const repo of def.repos) await rmWithRetry(hubDir(repo))
      const next = readMarker() ?? marker!
      const engines = { ...(next.engines ?? {}) }
      delete engines[id]
      // Shared packages that came back now belong to a remaining engine (removed with it later).
      const heir = engines[others[0]]
      if (heir && restored.length) engines[others[0]] = { ...heir, packages: [...new Set([...heir.packages, ...restored])], pkgBytes: (heir.pkgBytes ?? 0) + (await packagesBytes(restored)) }
      writeMarker({ ...next, engines, envBytes: dirSize(venvDir()) + dirSize(pythonDir()) })
    }
    sizesDirty = true
    logLine(`✓ ${def.name} removed`)
  } catch (err) {
    st.error = err instanceof Error ? err.message : String(err)
    logLine(`✗ ${st.error}`)
    throw err
  } finally {
    installChild = null
    st.busy = 'idle'
    st.installing = undefined
    st.activity = undefined
    changed()
  }
}

async function rmWithRetry(p: string): Promise<void> {
  for (let i = 0; i < 5; i++) {
    try {
      rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 })
      return
    } catch (err) {
      if (i === 4) throw new Error(`Couldn't delete ${p} — a file is still in use (${err instanceof Error ? err.message : err})`)
      await sleep(800)
    }
  }
}

// ─── Process ─────────────────────────────────────────────────────────────────

function killTree(proc: ChildProcess, sync = false): void {
  if (proc.exitCode !== null || !proc.pid) return
  if (process.platform === 'win32') {
    const args = ['/pid', String(proc.pid), '/T', '/F']
    if (sync) {
      try {
        execFileSync('taskkill', args, { windowsHide: true, timeout: 4000, stdio: 'ignore' })
      } catch {
        /* already gone */
      }
    } else execFile('taskkill', args, { windowsHide: true }, () => {})
  } else proc.kill('SIGTERM')
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

let lastChild: ChildProcess | null = null

/** After a stop, wait until the server process has really exited (file locks on Windows). */
async function waitForChildExit(ms = 8000): Promise<void> {
  const proc = lastChild
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return
  await Promise.race([new Promise<void>((r) => proc.once('exit', () => r())), sleep(ms)])
  await sleep(300)
}

function startPolling(): void {
  if (pollTimer) return
  pollTimer = setInterval(async () => {
    if (!st.running) return
    const url = engineUrl()
    const h = await health(url, 4000)
    if (h) {
      applyHealth(h, url)
      changed()
    } else if (!child && inflight === 0) {
      // An attached/remote server went away.
      st.running = false
      st.busy = 'idle'
      logLine('Voice engine is no longer reachable')
      changed()
    }
  }, 5000)
}

export function startEngine(): Promise<void> {
  if (startPromise) return startPromise
  startPromise = doStart().finally(() => {
    startPromise = null
  })
  return startPromise
}

async function doStart(): Promise<void> {
  const url = engineUrl()
  st.port = portOf(url)
  if (child && st.running) return
  const existing = await health(url)
  if (existing) {
    // Already up — a previous session's server or a remote machine.
    st.running = true
    st.error = undefined
    applyHealth(existing, url)
    if (!child) logLine(`Connected to the voice engine at ${url}`)
    startPolling()
    changed()
    return
  }
  if (!isLocalUrl(url)) throw new Error(`The voice server at ${url} is not reachable`)
  if (st.busy === 'installing') throw new Error('A voice engine is still installing')
  if (!isInstalled()) throw new Error('No local voice engine is installed yet — install one in Generate → Voice (or Connectors → Stitch Voice).')
  syncServer()

  const gpu = await plannedGpu()
  st.busy = 'starting'
  st.error = undefined
  st.device = gpuLabel(gpu)
  st.activity = { label: `Starting on ${gpuLabel(gpu)}` }
  logLine(`▸ Starting Stitch Voice on ${gpuLabel(gpu)} (port ${st.port})`)
  changed()

  const env = engineEnv({ CUDA_VISIBLE_DEVICES: gpu ? String(gpu.index) : undefined })
  let proc: ChildProcess
  try {
    proc = spawn(venvPython(), [serverDest(), '--host', '127.0.0.1', '--port', String(st.port), '--idle-unload', '600'], {
      cwd: engineDir(),
      env,
      windowsHide: true
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    st.busy = 'idle'
    st.activity = undefined
    st.error = `Could not launch the voice engine (${msg}). The Python environment looks broken — try Reinstall.`
    logLine(`✗ ${st.error}`)
    changed()
    throw new Error(st.error)
  }
  child = proc
  lastChild = proc
  spawnedGpu = gpu?.index
  stopping = false
  const reader = makeLineReader()
  proc.stdout?.on('data', reader)
  proc.stderr?.on('data', reader)
  proc.on('error', (err) => {
    logLine(`✗ Could not launch the engine's Python: ${err.message}`)
    if (child !== proc) return
    // Spawn failures emit 'error' without 'exit' — release the start loop now.
    child = null
    st.running = false
    st.busy = 'idle'
    st.activity = undefined
    st.error = `Could not launch the voice engine (${err.message}). Try Reinstall.`
    changed()
  })
  proc.on('exit', (code) => {
    if (child !== proc) return
    child = null
    st.running = false
    if (st.busy !== 'installing') st.busy = 'idle'
    if (!st.installing) st.activity = undefined
    if (!stopping) {
      st.error = `The voice engine stopped unexpectedly (exit code ${code}). See the log for details.`
      logLine(`✗ Voice engine exited with code ${code}`)
    } else logLine('Voice engine stopped')
    changed()
  })

  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    if (child !== proc) {
      const last = st.log.slice(-3).join(' · ')
      throw new Error(`The voice engine failed to start. ${last}`)
    }
    const h = await health(`http://127.0.0.1:${st.port}`, 1200)
    if (h) {
      st.running = true
      st.busy = 'idle'
      st.activity = undefined
      applyHealth(h, url)
      startPolling()
      changed()
      return
    }
    await sleep(700)
  }
  killTree(proc)
  throw new Error('The voice engine did not start within 3 minutes')
}

export async function stopEngine(): Promise<void> {
  if (installChild) {
    installCanceled = true
    killTree(installChild)
  }
  const url = engineUrl()
  if (child) {
    stopping = true
    killTree(child)
  } else if (st.running && isLocalUrl(url)) {
    try {
      await rawRequest(`${url}/shutdown`, 'POST', {}, 3000)
    } catch {
      /* gone */
    }
  }
  st.running = false
  if (st.busy !== 'installing') {
    st.busy = 'idle'
    st.activity = undefined
  }
  changed()
}

/** Kill everything synchronously on app quit. */
export function shutdownEngine(): void {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
  if (installChild) {
    installCanceled = true
    killTree(installChild, true)
  }
  if (child) {
    stopping = true
    killTree(child, true)
    child = null
  }
}

/** Start lazily; restart if the voice GPU assignment changed since launch. */
export async function ensureEngine(): Promise<void> {
  if (child && st.running && inflight === 0) {
    const gpu = await plannedGpu()
    if (gpu?.index !== spawnedGpu) {
      logLine(`Voice GPU changed to ${gpuLabel(gpu)} — restarting the engine`)
      await stopEngine()
      await sleep(600)
    }
  }
  if (!st.running) await startEngine()
}

// ─── Model downloads ─────────────────────────────────────────────────────────

export function downloadModel(id: string): Promise<void> {
  const next = downloadChain.then(() => doDownload(id))
  downloadChain = next.catch(() => {})
  return next
}

async function doDownload(id: string): Promise<void> {
  const model = ALL_MODELS.find((m) => m.id === id)
  if (!model) throw new Error(`Unknown voice model '${id}'`)
  if (modelDownloaded(id)) return
  const token = model.engine === 'pocket' ? pocketToken() : undefined
  const url = engineUrl()
  if (!isLocalUrl(url)) {
    await engineJson('/download', { model: id, hf_token: token })
    return
  }
  if (!engineInstalled(model.engine)) throw new Error(`Install ${LOCAL_ENGINES[model.engine].name} first`)
  syncServer()
  const prevBusy = st.busy
  if (prevBusy === 'idle') st.busy = 'loading-model'
  st.activity = { label: `Downloading ${model.label}`, model: id, progress: 0, engine: model.engine }
  logLine(`▸ Downloading ${model.label} (${model.repo})`)
  changed()
  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(venvPython(), [serverDest(), '--download', id], { cwd: engineDir(), env: engineEnv({ HF_TOKEN: token }), windowsHide: true })
      const reader = makeLineReader()
      proc.stdout?.on('data', reader)
      proc.stderr?.on('data', reader)
      proc.on('error', reject)
      proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`Download of ${model.label} failed (exit code ${code}) — see the log`))))
    })
    logLine(`✓ ${model.label} is ready`)
  } catch (err) {
    st.error = err instanceof Error ? err.message : String(err)
    throw err
  } finally {
    if (st.busy === 'loading-model' && prevBusy === 'idle') st.busy = inflight > 0 ? 'generating' : 'idle'
    if (st.activity?.model === id) st.activity = undefined
    sizesDirty = true
    changed()
  }
}

// ─── Requests ────────────────────────────────────────────────────────────────

function errorFrom(res: RawResponse): string {
  try {
    const j = JSON.parse(res.body.toString('utf8')) as { error?: string }
    if (j.error) return j.error
  } catch {
    /* not json */
  }
  return `Voice engine error (HTTP ${res.status})`
}

async function engineJson(path: string, body: unknown): Promise<unknown> {
  await ensureEngine()
  const res = await rawRequest(`${engineUrl()}${path}`, 'POST', body)
  if (res.status !== 200) throw new Error(errorFrom(res))
  return JSON.parse(res.body.toString('utf8'))
}

/** Throw a friendly error when a local engine isn't installed yet. */
export function requireEngine(id: LocalEngineId): void {
  if (engineUsable(id)) return
  const name = LOCAL_ENGINES[id].name
  if (st.installing === id) throw new Error(`${name} is still installing — try again in a moment.`)
  throw new Error(`${name} is not installed yet — install it in Generate → Voice.`)
}

/** POST to the engine and return audio bytes plus X-Stitch-* info headers. */
export async function engineAudio(
  path: string,
  body: Record<string, unknown>,
  needs?: string,
  engine: LocalEngineId = 'qwen3'
): Promise<{ bytes: Uint8Array; info: Record<string, string> }> {
  requireEngine(engine)
  await ensureEngine()
  if (needs && !modelDownloaded(needs)) await downloadModel(needs)
  inflight++
  if (st.busy === 'idle') st.busy = 'generating'
  changed()
  try {
    const res = await rawRequest(`${engineUrl()}${path}`, 'POST', { engine, ...body })
    if (res.status !== 200) throw new Error(errorFrom(res))
    const info: Record<string, string> = {}
    for (const [k, v] of Object.entries(res.headers)) {
      if (k.startsWith('x-stitch-') && typeof v === 'string') info[k.slice(9)] = v
    }
    return { bytes: new Uint8Array(res.body), info }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/ECONNREFUSED|ECONNRESET|socket hang up/i.test(msg)) throw new Error('Lost connection to the voice engine — it may have crashed. Check the engine log.')
    throw err
  } finally {
    inflight--
    if (inflight <= 0 && st.busy === 'generating') st.busy = 'idle'
    sizesDirty = true
    changed()
  }
}

/** Reference clip for cloning: WAV path on disk (converted with ffmpeg when needed), or base64 for remote engines. */
export async function refAudio(asset: Asset): Promise<Record<string, string>> {
  let path = asset.path
  if (!existsSync(path)) throw new Error(`Voice sample file is missing: ${path}`)
  const ext = extname(path).toLowerCase()
  if (ext !== '.wav' && ext !== '.flac') {
    const ff = await detectFfmpeg()
    if (ff) {
      const out = join(engineDir(), 'cache', `ref-${asset.id}.wav`)
      if (!existsSync(out) || statSync(out).mtimeMs < statSync(path).mtimeMs) {
        mkdirSync(join(engineDir(), 'cache'), { recursive: true })
        await run(ff, ['-y', '-v', 'error', '-i', path, '-ac', '1', '-ar', '24000', out], { windowsHide: true })
      }
      path = out
    }
  }
  if (isLocalUrl(engineUrl())) return { ref_audio: path }
  return { ref_audio_b64: readFileSync(path).toString('base64'), ref_audio_ext: extname(path) }
}

export async function engineSummary(id: LocalEngineId = 'qwen3'): Promise<{ ok: boolean; message: string }> {
  const url = engineUrl()
  const name = LOCAL_ENGINES[id].name
  const h = await health(url)
  if (h) {
    applyHealth(h, url)
    if (h.engines && h.engines[id] && !h.engines[id].available) return { ok: false, message: `${name} is not installed on the voice server at ${url}` }
    return { ok: true, message: `Running on ${id === 'pocket' ? 'CPU' : (st.device ?? h.device)}${h.loaded?.length ? ` · ${h.loaded.length} model(s) loaded` : ''}` }
  }
  if (!isLocalUrl(url)) return { ok: false, message: `No voice server answering at ${url}` }
  if (!engineInstalled(id)) return { ok: false, message: `${name} is not installed yet — install it in Generate → Voice` }
  const gpu = await plannedGpu()
  return { ok: true, message: `Installed · starts on first use on ${id === 'pocket' ? 'the CPU' : gpuLabel(gpu)}` }
}

/** Seed the status (port, planned GPU) so the card has something to show before the first start. */
export function initEngine(): void {
  st.port = portOf(engineUrl())
  void plannedGpu()
    .then((g) => {
      if (!st.running) st.device = gpuLabel(g)
      changed()
    })
    .catch(() => {})
}
