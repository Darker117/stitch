// Local voice engine: installs a Python 3.12 venv with PyTorch (CUDA 12.8) and
// Qwen3-TTS under <userData>/voice-engine, then runs resources/voice-server/server.py.
import { app } from 'electron'
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { basename, extname, join } from 'node:path'
import { promisify } from 'node:util'
import type { DetectResult, VoiceEngineStatus } from '@shared/ipc'
import type { Asset, VoiceConnector } from '@shared/types'
import { emit } from '../../ipc'
import { db } from '../../store'
import { voiceGpu } from '../gpu'
import { detectFfmpeg, detectGpus, detectStabilityMatrix } from '../system'

const run = promisify(execFile)

export const TORCH_INDEX = 'https://download.pytorch.org/whl/cu128'
const DEFAULT_PORT = 7862
const MAX_LOG = 1200

export interface EngineModel {
  id: string
  repo: string
  label: string
}

/** Models surfaced in the UI (the server also knows custom-0.6b). */
export const ENGINE_MODELS: EngineModel[] = [
  { id: 'base-1.7b', repo: 'Qwen/Qwen3-TTS-12Hz-1.7B-Base', label: 'Voice cloning · 1.7B' },
  { id: 'custom-1.7b', repo: 'Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice', label: 'Preset speakers · 1.7B' },
  { id: 'design-1.7b', repo: 'Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign', label: 'Voice design · 1.7B' },
  { id: 'base-0.6b', repo: 'Qwen/Qwen3-TTS-12Hz-0.6B-Base', label: 'Voice cloning · 0.6B (lighter)' }
]
const ALL_MODELS: EngineModel[] = [...ENGINE_MODELS, { id: 'custom-0.6b', repo: 'Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice', label: 'Preset speakers · 0.6B' }]

// ─── Paths ───────────────────────────────────────────────────────────────────

export const engineDir = (): string => join(app.getPath('userData'), 'voice-engine')
const venvDir = (): string => join(engineDir(), 'venv')
const venvPython = (): string => join(venvDir(), process.platform === 'win32' ? 'Scripts\\python.exe' : 'bin/python')
const hfHome = (): string => join(engineDir(), 'hf')
const serverDest = (): string => join(engineDir(), 'server.py')
const markerFile = (): string => join(engineDir(), 'install.json')

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

export function isInstalled(): boolean {
  return existsSync(venvPython()) && existsSync(markerFile())
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
let pollTimer: NodeJS.Timeout | null = null
let emitTimer: NodeJS.Timeout | null = null
let downloadChain: Promise<void> = Promise.resolve()

function snapshot(): VoiceEngineStatus {
  return { ...st, installed: isInstalled(), models: modelStates(), log: st.log.slice(-400) }
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

/** Machine-readable "@@state <name> [detail]" lines from server.py. */
function onServerState(name: string, detail: string): void {
  switch (name) {
    case 'downloading':
      st.busy = 'loading-model'
      st.activity = { label: `Downloading ${modelLabel(detail)}`, model: detail }
      break
    case 'loading-model':
      st.busy = 'loading-model'
      st.activity = { label: `Loading ${modelLabel(detail)} into VRAM`, model: detail }
      break
    case 'generating':
      st.busy = 'generating'
      st.activity = { label: detail ? `Generating · ${detail}` : 'Generating' }
      break
    default:
      if (st.busy !== 'installing' && st.busy !== 'starting') st.busy = inflight > 0 ? 'generating' : 'idle'
      if (!st.activity?.step) st.activity = undefined
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

function snapshotReady(repo: string): boolean {
  const base = join(hfHome(), 'hub', `models--${repo.replace('/', '--')}`, 'snapshots')
  if (!existsSync(base)) return false
  try {
    for (const snap of readdirSync(base)) {
      const files = readdirSync(join(base, snap))
      if (files.includes('config.json') && files.includes('speech_tokenizer') && files.some((f) => f.endsWith('.safetensors'))) return true
    }
  } catch {
    /* partial */
  }
  return false
}

export function modelDownloaded(id: string): boolean {
  if (remoteModels && id in remoteModels) return remoteModels[id]
  const m = ALL_MODELS.find((x) => x.id === id)
  return !!m && snapshotReady(m.repo)
}

function modelStates(): VoiceEngineStatus['models'] {
  return ENGINE_MODELS.map((m) => ({ id: m.id, label: m.label, downloaded: modelDownloaded(m.id) }))
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
  remoteModels = !isLocalUrl(url) && h.models ? Object.fromEntries(Object.entries(h.models).map(([k, v]) => [k, v.downloaded])) : null
}

// ─── GPU choice ──────────────────────────────────────────────────────────────

let gpuCache: { at: number; list: DetectResult['gpus'] } | null = null

async function plannedGpu(): Promise<{ index: number; name: string } | undefined> {
  if (!gpuCache || Date.now() - gpuCache.at > 60_000) gpuCache = { at: Date.now(), list: await detectGpus() }
  const idx = voiceGpu(gpuCache.list.map((g) => g.index))
  const g = gpuCache.list.find((x) => x.index === idx)
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
  for (const k of ['PYTHONHOME', 'PYTHONPATH', 'VIRTUAL_ENV', 'CONDA_PREFIX', 'CUDA_VISIBLE_DEVICES']) delete env[k]
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
function runLogged(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    logLine(`$ ${basename(cmd)} ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`)
    const proc = spawn(cmd, args, { cwd: engineDir(), env, windowsHide: true })
    installChild = proc
    let out = ''
    const tail: string[] = []
    const reader = makeLineReader()
    proc.stdout?.on('data', (c: Buffer) => {
      out += c.toString('utf8')
      reader(c)
    })
    proc.stderr?.on('data', (c: Buffer) => {
      for (const l of c.toString('utf8').split(/\r?\n/)) if (l.trim()) tail.push(l.trim())
      if (tail.length > 8) tail.splice(0, tail.length - 8)
      reader(c)
    })
    proc.on('error', (err) => reject(err))
    proc.on('exit', (code) => {
      if (installChild === proc) installChild = null
      if (installCanceled) reject(new Error('Install canceled'))
      else if (code === 0) resolve(out)
      else {
        const hint = tail.filter((l) => /error|failed|not found|denied|No solution|unsatisf/i.test(l)).slice(-2).join(' · ')
        reject(new Error(`${basename(cmd)} exited with code ${code}${hint ? ` — ${hint}` : ''}`))
      }
    })
  })
}

const VERIFY = [
  'import json, importlib.metadata as md, torch',
  'info = {"python": __import__("sys").version.split()[0], "torch": torch.__version__, "cuda": torch.version.cuda, "cuda_available": torch.cuda.is_available()}',
  'info["arch"] = torch.cuda.get_arch_list() if torch.cuda.is_available() else []',
  'info["devices"] = [torch.cuda.get_device_name(i) for i in range(torch.cuda.device_count())] if torch.cuda.is_available() else []',
  'import qwen_tts',
  'info["qwen_tts"] = md.version("qwen-tts")',
  'print("@@verify " + json.dumps(info))'
].join('\n')

interface VerifyInfo {
  python: string
  torch: string
  cuda: string | null
  cuda_available: boolean
  arch: string[]
  devices: string[]
  qwen_tts: string
}

async function verify(env: NodeJS.ProcessEnv): Promise<VerifyInfo> {
  const out = await runLogged(venvPython(), ['-c', VERIFY], env)
  const line = out.split(/\r?\n/).find((l) => l.startsWith('@@verify '))
  if (!line) throw new Error('Could not verify the Python environment')
  return JSON.parse(line.slice(9)) as VerifyInfo
}

let installPromise: Promise<void> | null = null

/** Install (or repair) the engine. Concurrent calls share one run. */
export function installEngine(): Promise<void> {
  if (!installPromise) {
    installPromise = doInstall().finally(() => {
      installPromise = null
    })
  }
  return installPromise
}

async function doInstall(): Promise<void> {
  if (child) await stopEngine()
  installCanceled = false
  st.busy = 'installing'
  st.error = undefined
  st.log = []
  const steps = 5
  const step = (n: number, label: string): void => {
    st.activity = { label, step: n, steps }
    logLine(`▸ ${label}`)
  }
  try {
    const dir = engineDir()
    mkdirSync(dir, { recursive: true })
    step(1, 'Finding uv')
    const uv = await findUv()
    if (!uv) throw new Error("Couldn't find uv. Install it (https://docs.astral.sh/uv/) or Stability Matrix, then try again.")
    logLine(`Using ${uv}`)
    const env = engineEnv({ UV_PYTHON_INSTALL_DIR: join(dir, 'python'), UV_NO_PROGRESS: '1' })

    step(2, 'Creating a Python 3.12 environment')
    let venvOk = false
    if (existsSync(venvPython())) {
      try {
        const { stdout } = await run(venvPython(), ['-c', 'import sys; print(sys.version_info[:2] == (3, 12))'], { env, windowsHide: true })
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
    const py = venvPython()

    step(3, 'Installing PyTorch for CUDA 12.8 (≈3 GB, first time only)')
    await runLogged(uv, ['pip', 'install', '--python', py, 'torch', 'torchaudio', '--index-url', TORCH_INDEX], env)

    step(4, 'Installing Qwen3-TTS')
    // No global -U here: upgrading everything would swap the CUDA torch for PyPI's CPU build.
    await runLogged(uv, ['pip', 'install', '--python', py, 'qwen-tts', 'soundfile', 'numpy', 'huggingface_hub'], env)

    step(5, 'Checking the GPU build')
    let info = await verify(env)
    if (!/\+cu\d+/.test(info.torch)) {
      logLine(`PyTorch ${info.torch} is a CPU build — reinstalling the CUDA 12.8 build`)
      await runLogged(uv, ['pip', 'install', '--python', py, '--reinstall-package', 'torch', '--reinstall-package', 'torchaudio', 'torch', 'torchaudio', '--index-url', TORCH_INDEX], env)
      info = await verify(env)
    }
    logLine(`Python ${info.python} · torch ${info.torch} · CUDA ${info.cuda ?? 'n/a'} · qwen-tts ${info.qwen_tts}`)
    if (info.devices.length) logLine(`GPUs: ${info.devices.join(', ')} · kernels ${info.arch.join(' ')}`)
    else logLine('Warning: PyTorch sees no CUDA GPU — the engine will run on the CPU (slow).')

    syncServer()
    writeFileSync(markerFile(), JSON.stringify({ installedAt: Date.now(), ...info }, null, 2))
    logLine('✓ Stitch Voice is installed. Models download on first use — or fetch them now below.')
  } catch (err) {
    st.error = err instanceof Error ? err.message : String(err)
    logLine(`✗ ${st.error}`)
    throw err
  } finally {
    installChild = null
    st.busy = 'idle'
    st.activity = undefined
    changed()
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
  if (st.busy === 'installing') throw new Error('The voice engine is still installing')
  if (!isInstalled()) throw new Error('The local voice engine is not installed yet — open Connectors → Stitch Voice and click Install.')
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
    st.busy = 'idle'
    st.activity = undefined
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
  st.busy = 'idle'
  st.activity = undefined
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
  const url = engineUrl()
  if (!isLocalUrl(url)) {
    await engineJson('/download', { model: id })
    return
  }
  if (!isInstalled()) throw new Error('Install the voice engine first')
  syncServer()
  const prevBusy = st.busy
  if (prevBusy === 'idle') st.busy = 'loading-model'
  st.activity = { label: `Downloading ${model.label}`, model: id, progress: 0 }
  logLine(`▸ Downloading ${model.repo}`)
  changed()
  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(venvPython(), [serverDest(), '--download', id], { cwd: engineDir(), env: engineEnv(), windowsHide: true })
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

/** POST to the engine and return audio bytes plus X-Stitch-* info headers. */
export async function engineAudio(path: string, body: Record<string, unknown>, needs?: string): Promise<{ bytes: Uint8Array; info: Record<string, string> }> {
  await ensureEngine()
  if (needs && !modelDownloaded(needs)) await downloadModel(needs)
  inflight++
  if (st.busy === 'idle') st.busy = 'generating'
  changed()
  try {
    const res = await rawRequest(`${engineUrl()}${path}`, 'POST', body)
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

export async function engineSummary(): Promise<{ ok: boolean; message: string }> {
  const url = engineUrl()
  const h = await health(url)
  if (h) {
    applyHealth(h, url)
    return { ok: true, message: `Running on ${st.device ?? h.device}${h.loaded?.length ? ` · ${h.loaded.length} model(s) in VRAM` : ''}` }
  }
  if (!isLocalUrl(url)) return { ok: false, message: `No voice server answering at ${url}` }
  if (!isInstalled()) return { ok: false, message: 'Not installed yet — click Install on the Stitch Voice card' }
  const gpu = await plannedGpu()
  return { ok: true, message: `Installed · starts on first use on ${gpuLabel(gpu)}` }
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
