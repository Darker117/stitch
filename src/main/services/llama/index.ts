// The llama.cpp text engine: llama-server on 127.0.0.1 with a GGUF model, its layers split across
// this PC's GPUs and GPUs on linked nodes. Each node GPU runs llama.cpp's rpc-server on the node's
// loopback; llama-server reaches it through a local tunnel over the authenticated link (rpc-server
// itself has no authentication, so it is never exposed to the network). The running server is the
// `llamacpp` text connector (OpenAI-compatible), so it shows up in every model picker.
import { app } from 'electron'
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { GgufFile, LlamaDevice, LlamaStatus } from '@shared/ipc'
import type { LlmConnector, LlmModelInfo } from '@shared/types'
import { emit, handle } from '../../ipc'
import { getSecret, getSettings, setSecret } from '../../settings'
import { db } from '../../store'
import { linkedNodes, nodeLink, onClusterChange } from '../../cluster'
import { gpuStats } from '../../cluster/hardware'
import { HF_ORIGIN, hfToken } from '../models/hf'
import { startHubFile } from '../models/downloads'
import { modelsHome } from '../models/home'
import { ensureLlama, exe, installedLlama, llamaRoot, type LlamaInstall } from './install'

const run = promisify(execFile)
export const LLAMA_CONNECTOR = 'llamacpp'
const MAX_LOG = 800

// Filled in by registerLlama(): userData isn't final (dev profiles) until the app has started.
let status: LlamaStatus = { state: 'stopped', connectorId: 'llamacpp' }
let proc: ChildProcess | null = null
let starting: Promise<LlamaStatus> | null = null
let usedNodes: { node: string; gpu: number }[] = []
const logs: string[] = []

function initialStatus(): LlamaStatus {
  const inst = installedLlama()
  return { state: inst ? 'stopped' : 'missing', installed: inst ? { tag: inst.tag, flavor: inst.flavor } : undefined, connectorId: LLAMA_CONNECTOR }
}

function set(patch: Partial<LlamaStatus>): void {
  status = { ...status, ...patch }
  emit('llama:status', status)
}

function log(line: string): void {
  logs.push(line)
  if (logs.length > MAX_LOG) logs.splice(0, logs.length - MAX_LOG)
}

export function llamaRunning(): boolean {
  return status.state === 'running' && !!proc
}

// ─── Devices ─────────────────────────────────────────────────────────────────

const short = (name: string): string => name.replace(/NVIDIA GeForce /i, '').replace(/NVIDIA /i, '')

/** GPUs that can hold layers: every GPU on this PC plus the shared GPUs of linked nodes. */
export async function llamaDevices(): Promise<LlamaDevice[]> {
  const out: LlamaDevice[] = (await gpuStats()).map((g) => ({ key: `local:${g.index}`, label: short(g.name), pc: 'This PC', memTotal: g.memTotal, memFree: Math.max(0, g.memTotal - g.memUsed), online: true }))
  for (const l of linkedNodes()) {
    for (const g of l.hw?.gpus ?? []) {
      if (g.shared === false) continue
      out.push({ key: `${l.id}:${g.index}`, label: short(g.name), pc: l.rec.name, memTotal: g.memTotal, memFree: Math.max(0, g.memTotal - g.memUsed), online: l.online })
    }
  }
  return out
}

interface Parsed {
  key: string
  node?: string
  gpu: number
}

function parseKey(key: string): Parsed | null {
  const m = /^(.+):(\d+)$/.exec(key)
  if (!m) return null
  return m[1] === 'local' ? { key, gpu: Number(m[2]) } : { key, node: m[1], gpu: Number(m[2]) }
}

/** `llama-server --list-devices` → device names in llama.cpp's order (CUDA0…, RPC…). */
async function listDevices(inst: LlamaInstall, env: NodeJS.ProcessEnv, rpc: string): Promise<{ name: string; desc: string }[]> {
  // --list-devices acts as soon as it's parsed, so the RPC servers must come first.
  const args = rpc ? ['--rpc', rpc, '--list-devices'] : ['--list-devices']
  const { stdout, stderr } = await run(join(inst.dir, exe('llama-server')), args, { cwd: inst.dir, env, windowsHide: true, timeout: 90_000 })
  const out: { name: string; desc: string }[] = []
  let inList = false
  for (const line of `${stdout}\n${stderr}`.split(/\r?\n/)) {
    if (/available devices/i.test(line)) {
      inList = true
      continue
    }
    const m = /^\s+([A-Za-z]+[\w[\]:.-]*?):\s+(.*)$/.exec(line)
    if (inList && m) out.push({ name: m[1], desc: m[2] })
  }
  return out
}

function freePort(prefer: number): Promise<number> {
  const tryPort = (port: number): Promise<number> =>
    new Promise((resolve, reject) => {
      const s = createServer()
      s.once('error', reject)
      s.listen(port, '127.0.0.1', () => {
        const p = (s.address() as { port: number }).port
        s.close(() => resolve(p))
      })
    })
  return tryPort(prefer).catch(() => tryPort(0))
}

// ─── Start / stop ────────────────────────────────────────────────────────────

export function startLlama(): Promise<LlamaStatus> {
  if (llamaRunning()) return Promise.resolve(status)
  starting ??= doStart().finally(() => (starting = null))
  return starting
}

let keyFile: string | undefined

function writeKeyFile(): string {
  let key = getSecret(LLAMA_CONNECTOR)
  if (!key) {
    key = randomBytes(24).toString('base64url')
    setSecret(LLAMA_CONNECTOR, key)
  }
  const dir = llamaRoot()
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `llama-key-${randomBytes(6).toString('hex')}.txt`)
  writeFileSync(file, key + '\n', { mode: 0o600 })
  return file
}

function removeKeyFile(): void {
  if (keyFile) rmSync(keyFile, { force: true })
  keyFile = undefined
}

async function doStart(): Promise<LlamaStatus> {
  const cfg = getSettings().llama
  try {
    if (!cfg.model || !existsSync(cfg.model)) throw new Error('Pick a GGUF model for the text engine first (Settings → Computers).')
    logs.length = 0
    set({ state: 'starting', step: { label: 'Preparing llama.cpp' }, error: undefined, tokensPerSecond: undefined, promptPerSecond: undefined })
    const inst = await ensureLlama((label, progress) => set({ state: 'installing', step: { label, progress } }))
    set({ state: 'starting', installed: { tag: inst.tag, flavor: inst.flavor }, step: { label: 'Preparing devices' } })

    const devices = cfg.devices.map(parseKey).filter((d): d is Parsed => !!d)
    const available = await llamaDevices()
    const free = (key: string): number => available.find((d) => d.key === key)?.memFree ?? 0

    // Nodes: start rpc-server on each GPU (installing the same llama.cpp build there first).
    const rpc: { key: string; port: number; node: string; gpu: number }[] = []
    usedNodes = []
    for (const d of devices.filter((x) => x.node)) {
      const link = nodeLink(d.node!)
      if (!link) throw new Error('A PC in the text engine’s devices is no longer linked — update the devices.')
      if (!link.online) throw new Error(`${link.rec.name} is offline — start Stitch there or remove its GPU from the text engine.`)
      set({ step: { label: `Getting ${link.rec.name} ready` } })
      const t = setInterval(() => {
        const svc = link.service('rpc', d.gpu)
        if (svc?.state === 'installing') set({ step: { label: `${link.rec.name}: downloading llama.cpp`, progress: svc.progress } })
      }, 700)
      try {
        await link.call('rpc.start', { gpu: d.gpu, tag: inst.tag }, 30 * 60_000)
      } finally {
        clearInterval(t)
      }
      const port = await link.tunnel('rpc', d.gpu)
      rpc.push({ key: d.key, port, node: d.node!, gpu: d.gpu })
      usedNodes.push({ node: d.node!, gpu: d.gpu })
      log(`[stitch] ${link.rec.name} GPU ${d.gpu} → rpc via 127.0.0.1:${port}`)
    }

    const localGpus = devices.filter((x) => !x.node).map((x) => x.gpu).sort((a, b) => a - b)
    const env: NodeJS.ProcessEnv = { ...process.env, CUDA_DEVICE_ORDER: 'PCI_BUS_ID', CUDA_VISIBLE_DEVICES: localGpus.length ? localGpus.join(',') : '-1' }
    const rpcArg = rpc.map((r) => `127.0.0.1:${r.port}`).join(',')

    // Name every device the way llama.cpp does, then pin the order: node GPUs first (llama.cpp's own
    // default), this PC last so it holds the output layer.
    set({ step: { label: 'Checking devices' } })
    const listed = inst.flavor === 'cpu' && !rpc.length ? [] : await listDevices(inst, env, rpcArg)
    log(`[stitch] llama.cpp devices: ${listed.map((d) => `${d.name} (${d.desc})`).join('; ') || 'CPU only'}`)
    const rpcListed = listed.filter((d) => /^RPC/i.test(d.name))
    const order: { key: string; name: string; label: string }[] = []
    rpc.forEach((r, i) => {
      const hit = rpcListed.find((d) => d.name.includes(`:${r.port}`) || d.desc.includes(`:${r.port}`)) ?? rpcListed[i]
      if (!hit) throw new Error(`llama.cpp couldn't reach the GPU on ${nodeLink(r.node)?.rec.name ?? 'a linked PC'} — see the log`)
      order.push({ key: r.key, name: hit.name, label: `${nodeLink(r.node)?.rec.name ?? 'Node'} · ${available.find((a) => a.key === r.key)?.label ?? `GPU ${r.gpu}`}` })
    })
    localGpus.forEach((g, j) => {
      const name = `CUDA${j}`
      if (!listed.some((d) => d.name === name)) throw new Error(`llama.cpp doesn't see GPU ${g} on this PC (${inst.flavor} build) — see the log`)
      order.push({ key: `local:${g}`, name, label: `This PC · ${available.find((a) => a.key === `local:${g}`)?.label ?? `GPU ${g}`}` })
    })

    const weights = order.map((o) => {
      const w = cfg.split?.[o.key]
      return w && w > 0 ? w : Math.max(0.5, free(o.key) / 2 ** 30)
    })
    const sum = weights.reduce((a, b) => a + b, 0) || 1
    const port = await freePort(cfg.port)
    const alias = basename(cfg.model).replace(/(-\d{5}-of-\d{5})?\.gguf$/i, '')
    // RPC servers first: llama.cpp resolves --device names while parsing.
    const args = rpcArg ? ['--rpc', rpcArg] : []
    // Loopback only, and an API key: llama-server allows every browser origin, so without one any web page
    // could use the model. The key lives in the encrypted secrets (the connector sends it); llama-server
    // reads it from a file that is removed once it's up, so it never shows on a command line.
    keyFile = writeKeyFile()
    args.push('-m', cfg.model, '--host', '127.0.0.1', '--port', String(port), '-c', String(cfg.ctx), '--alias', alias, '--jinja', '--no-webui', '--api-key-file', keyFile)
    if (order.length) {
      args.push('-ngl', '999', '--device', order.map((o) => o.name).join(','))
      if (order.length > 1) args.push('--tensor-split', weights.map((w) => (w / sum).toFixed(3)).join(','))
    } else args.push('-ngl', '0', '--device', 'none')

    set({ step: { label: 'Loading the model' }, devices: order.map((o, i) => ({ key: o.key, label: o.label, split: weights[i] / sum })) })
    log(`[stitch] llama-server ${args.join(' ')}`)
    const child = spawn(join(inst.dir, exe('llama-server')), args, { cwd: inst.dir, env, windowsHide: true })
    proc = child
    const onData = (b: Buffer): void => {
      for (const line of b.toString('utf8').split(/\r?\n/)) {
        if (!line.trim()) continue
        log(line)
        // "… | prompt eval time = … 637.21 tokens per second)" and "… |        eval time = … 112.14 tokens per second)"
        const pe = /prompt eval time =.*?([\d.]+) tokens per second/.exec(line)
        if (pe) set({ promptPerSecond: Number(pe[1]) })
        else {
          const ev = /(?:^|\|)\s*eval time =.*?([\d.]+) tokens per second/.exec(line)
          if (ev) set({ tokensPerSecond: Number(ev[1]) })
        }
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('exit', (code) => {
      if (proc !== child) return
      proc = null
      log(`[stitch] llama-server exited with code ${code}`)
      const tail = logs.slice(-12).find((l) => /error|failed|out of memory|abort/i.test(l))
      set(status.state === 'stopped' ? { step: undefined } : { state: 'error', step: undefined, error: tail ? tail.replace(/^.*?(error|failed)/i, '$1') : `llama-server stopped (code ${code})` })
    })

    // Wait until the model is loaded (/health turns 200).
    const until = Date.now() + 15 * 60_000
    for (;;) {
      if (proc !== child) throw new Error(status.error ?? 'llama-server stopped while loading — see the log')
      if (Date.now() > until) throw new Error('The model took too long to load')
      const ok = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) })
        .then((r) => r.ok)
        .catch(() => false)
      if (ok) break
      await new Promise((r) => setTimeout(r, 500))
    }
    removeKeyFile()

    upsertConnector(port, alias, cfg.ctx)
    set({ state: 'running', step: undefined, port, model: cfg.model, error: undefined })
    return status
  } catch (err) {
    removeKeyFile()
    const message = err instanceof Error ? err.message : String(err)
    log(`[stitch] ${message}`)
    killProc()
    stopNodes()
    // Stop pressed while loading: that's not an error.
    if (status.state !== 'stopped' && status.state !== 'missing') set({ state: 'error', step: undefined, error: message })
    throw err
  }
}

function upsertConnector(port: number, alias: string, ctx: number): void {
  const col = db('connectors')
  const prev = col.get(LLAMA_CONNECTOR)
  const next: LlmConnector = {
    id: LLAMA_CONNECTOR,
    name: 'llama.cpp',
    category: 'llm',
    kind: 'llamacpp',
    baseUrl: `http://127.0.0.1:${port}/v1`,
    hasKey: true,
    enabled: prev?.enabled ?? true,
    createdAt: prev?.createdAt ?? Date.now(),
    models: [{ id: alias, name: alias, contextLength: ctx }]
  }
  col.put(next)
}

function killProc(): void {
  const p = proc
  proc = null
  if (!p || p.exitCode !== null) return
  if (process.platform === 'win32' && p.pid) execFile('taskkill', ['/pid', String(p.pid), '/T', '/F'], () => {})
  else p.kill()
}

function stopNodes(): void {
  for (const u of usedNodes) {
    const l = nodeLink(u.node)
    if (!l) continue
    l.closeTunnel('rpc', u.gpu)
    if (l.online) void l.call('rpc.stop', { gpu: u.gpu }).catch(() => {})
  }
  usedNodes = []
}

export function stopLlama(): LlamaStatus {
  set({ state: installedLlama() ? 'stopped' : 'missing', step: undefined })
  killProc()
  stopNodes()
  return status
}

/** Text requests to the llama.cpp connector start the engine on demand. */
export async function llamaReady(): Promise<void> {
  if (llamaRunning()) return
  if (!getSettings().llama.model) throw new Error('The llama.cpp text engine has no model yet — pick one in Settings → Computers.')
  await startLlama()
}

/** Model list for the connector (the loaded GGUF). */
export function llamaModels(): LlmModelInfo[] {
  const c = db('connectors').get(LLAMA_CONNECTOR)
  if (c?.category === 'llm' && c.models?.length) return c.models
  const m = getSettings().llama.model
  if (!m) return []
  const alias = basename(m).replace(/(-\d{5}-of-\d{5})?\.gguf$/i, '')
  return [{ id: alias, name: alias, contextLength: getSettings().llama.ctx }]
}

// ─── GGUF files ──────────────────────────────────────────────────────────────

const llmDir = (): string => join(app.getPath('userData'), 'models', 'llm')

function ggufDirs(): { dir: string; where: string }[] {
  const home = modelsHome().path
  const out: { dir: string; where: string }[] = [
    { dir: llmDir(), where: 'Stitch' },
    { dir: join(home, 'LLM'), where: 'Models folder' },
    { dir: join(home, 'llm'), where: 'Models folder' },
    { dir: join(homedir(), '.lmstudio', 'models'), where: 'LM Studio' },
    { dir: join(homedir(), '.cache', 'lm-studio', 'models'), where: 'LM Studio' }
  ]
  const m = getSettings().llama.model
  if (m) out.push({ dir: dirname(m), where: 'Chosen folder' })
  return out
}

let ggufCache: { at: number; files: GgufFile[] } | null = null

export function listGguf(refresh = false): GgufFile[] {
  if (!refresh && ggufCache && Date.now() - ggufCache.at < 30_000) return ggufCache.files
  const files = new Map<string, GgufFile>()
  const walk = (dir: string, where: string, depth: number): void => {
    if (depth > 4 || !existsSync(dir)) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p, where, depth + 1)
      else if (/\.gguf$/i.test(e.name) && !/mmproj/i.test(e.name) && !/-000(0[2-9]|[1-9]\d)-of-\d{5}\.gguf$/i.test(e.name)) {
        try {
          files.set(p.toLowerCase(), { path: p, name: e.name.replace(/\.gguf$/i, ''), size: statSync(p).size, where })
        } catch {
          /* unreadable */
        }
      }
    }
  }
  for (const d of ggufDirs()) walk(d.dir, d.where, 0)
  const list = [...files.values()].sort((a, b) => a.name.localeCompare(b.name))
  ggufCache = { at: Date.now(), files: list }
  return list
}

async function hfFiles(repo: string): Promise<{ path: string; size: number; sha256?: string }[]> {
  const clean = repo.trim().replace(/^https?:\/\/(www\.)?huggingface\.co\//, '').replace(/\/(tree|blob)\/.*$/, '').replace(/\/+$/, '')
  if (!/^[\w.-]+\/[\w.-]+$/.test(clean)) throw new Error('Enter a Hugging Face repo like Qwen/Qwen2.5-1.5B-Instruct-GGUF')
  const headers: Record<string, string> = { 'User-Agent': 'Stitch (+desktop)' }
  const token = hfToken()
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(`${HF_ORIGIN}/api/models/${clean}/tree/main?recursive=1`, { headers, signal: AbortSignal.timeout(20_000) })
  if (res.status === 401 || res.status === 403) throw new Error(`${clean} is private or gated — add a Hugging Face token under Settings → Models & storage.`)
  if (res.status === 404) throw new Error(`Hugging Face has no repo called ${clean}`)
  if (!res.ok) throw new Error(`Hugging Face answered ${res.status}`)
  const list = (await res.json()) as { type: string; path: string; size?: number; lfs?: { oid?: string; size?: number } }[]
  return list
    .filter((f) => f.type === 'file' && /\.gguf$/i.test(f.path) && !/mmproj/i.test(f.path) && !/-000(0[2-9]|[1-9]\d)-of-\d{5}\.gguf$/i.test(f.path))
    .map((f) => ({ path: f.path, size: f.lfs?.size ?? f.size ?? 0, sha256: f.lfs?.oid && /^[0-9a-f]{64}$/i.test(f.lfs.oid) ? f.lfs.oid : undefined }))
    .sort((a, b) => a.size - b.size)
}

// ─── Registration ────────────────────────────────────────────────────────────

export function registerLlama(): void {
  status = initialStatus()
  handle('llama:status', () => status)
  handle('llama:install', async () => {
    const inst = await ensureLlama((label, progress) => set({ state: 'installing', step: { label, progress } }))
    set({ state: llamaRunning() ? 'running' : 'stopped', step: undefined, installed: { tag: inst.tag, flavor: inst.flavor } })
    return status
  })
  handle('llama:models', (refresh) => listGguf(refresh))
  handle('llama:devices', () => llamaDevices())
  handle('llama:hfFiles', async (repo) => (await hfFiles(repo)).map(({ path, size }) => ({ path, size })))
  handle('llama:download', async (repo, path) => {
    const clean = repo.trim().replace(/^https?:\/\/(www\.)?huggingface\.co\//, '').replace(/\/+$/, '')
    const info = (await hfFiles(clean)).find((f) => f.path === path)
    if (!info) throw new Error(`${path} isn't in ${clean}`)
    const dest = join(llmDir(), clean.replace('/', '__'), basename(path))
    return startHubFile({ repo: clean, path, size: info.size, sha256: info.sha256, dest, folder: 'llm', label: basename(path) }, () => {
      ggufCache = null
      emit('llama:status', status)
    })
  })
  handle('llama:start', () => startLlama())
  handle('llama:stop', () => stopLlama())
  handle('llama:logs', () => [...logs])

  // A node the engine uses went away: llama-server would block on the lost RPC peer, so stop it
  // (requests then fail fast) and start again once every node it needs is back.
  let resume = false
  onClusterChange(() => {
    if (llamaRunning() && usedNodes.length) {
      const lost = usedNodes.map((u) => nodeLink(u.node)).find((l) => !l?.online)
      if (lost === undefined) return
      resume = true
      killProc()
      stopNodes()
      set({ state: 'error', step: undefined, error: `${lost?.rec.name ?? 'A linked PC'} went offline — the text engine restarts when it's back.` })
      return
    }
    if (!resume || starting || llamaRunning()) return
    const needed = getSettings().llama.devices.map(parseKey).filter((d) => d?.node)
    if (!needed.every((d) => nodeLink(d!.node!)?.online)) return
    resume = false
    void startLlama().catch((err) => console.warn('[llama] restart after a node came back failed:', err.message))
  })

  const cfg = getSettings().llama
  if (cfg.autoStart && cfg.model) {
    // Give linked nodes a moment to connect first.
    setTimeout(() => {
      const needed = cfg.devices.map(parseKey).filter((d) => d?.node)
      let tries = 0
      const tick = (): void => {
        const ready = needed.every((d) => nodeLink(d!.node!)?.online)
        if (ready || ++tries > 30) void startLlama().catch((err) => console.warn('[llama] auto-start failed:', err.message))
        else setTimeout(tick, 1000)
      }
      tick()
    }, 3000)
  }
}

export function shutdownLlama(): void {
  // Tell nodes to free their GPUs (sent before the links close on quit).
  stopNodes()
  const p = proc
  proc = null
  if (p?.pid && p.exitCode === null) {
    try {
      if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true })
      else p.kill()
    } catch {
      /* gone */
    }
  }
}
