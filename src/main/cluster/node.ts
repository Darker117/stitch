// This PC as a node: it answers on the phone-remote server's /api/node/* endpoints (LAN only).
//
//   POST /api/node/pair-request {mainId, mainName}      → opens the 10-minute link window; the code shows here
//   POST /api/node/pair         {code, mainId, mainName} → { token, nodeId, … }  (5 tries, per-IP lockout)
//   WS   /api/node/ws    (Authorization: Bearer <token>) → control: fixed ops + hardware/service updates
//   WS   /api/node/tcp?to=comfy|rpc&gpu=N  (Bearer)     → one TCP stream to this PC's ComfyUI / rpc-server
//   PUT  /api/node/model?folder=&name=&size=  (Bearer)  → a model file copied from the main
//
// A main gets exactly these rights: run ComfyUI workflows and llama.cpp layers on the GPUs this PC
// shares, and add model files to its models folder. It never reaches this PC's IPC channels, other
// files, or any other port. ComfyUI and rpc-server listen on 127.0.0.1 only.
import { app, Notification } from 'electron'
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { randomInt } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { connect, createServer } from 'node:net'
import { hostname } from 'node:os'
import { basename, join } from 'node:path'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import type { NodeService } from '@shared/ipc'
import type { ComfyConnector } from '@shared/types'
import { emit } from '../ipc'
import { getSettings } from '../settings'
import { db } from '../store'
import { launchComfy, processLogs, processState, scanModelsDir, stopComfy } from '../services/comfy/process'
import { destinationDir, inside, LAYOUT, MODEL_EXT } from '../services/models/home'
import { invalidateLibrary } from '../services/models/library'
import { ensureLlama, llamaRoot, rpcServer } from '../services/llama/install'
import { pcId } from '../remote/devices'
import { addMain, listMains, mainForToken, removeMain, touchMain, type StoredMain } from './store'
import { localHardware } from './hardware'
import { splice } from './tunnel'

export interface NodeCtx {
  ip: string
  limiter: { blocked: (ip: string) => boolean; fail: (ip: string) => void }
}

const MODEL_FOLDERS = ['diffusion_models', 'text_encoders', 'vae', 'loras', 'checkpoints']
const COMFY_PORT_BASE = 8290
/** After the last main disconnects: rpc-servers go soon (no main, no use), ComfyUI later (keeps its models warm). */
const RPC_IDLE_MS = 60_000
const IDLE_STOP_MS = 15 * 60_000

// ─── Who may talk to the node endpoints ──────────────────────────────────────

/** LAN, Tailscale or this PC only — and never through the public tunnel (which forwards the client IP). */
export function lanRequest(req: IncomingMessage, ip: string): boolean {
  if (req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.headers.forwarded) return false
  const v4 = ip.replace(/^::ffff:/, '')
  const [a, b] = v4.split('.').map(Number)
  if (/^\d+\.\d+\.\d+\.\d+$/.test(v4)) {
    return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
  }
  const v6 = ip.toLowerCase()
  return v6 === '::1' || v6.startsWith('fe80:') || v6.startsWith('fc') || v6.startsWith('fd')
}

function bearer(req: IncomingMessage): string | undefined {
  const h = req.headers.authorization
  return typeof h === 'string' && h.startsWith('Bearer ') ? h.slice(7).trim() : undefined
}

export const nodeName = (): string => (getSettings().cluster?.name || '').trim() || hostname().replace(/\.local$/i, '')

function shares(gpu: number): boolean {
  const s = getSettings().cluster?.share
  return !s || s.includes(gpu)
}

// ─── Services run for a main ─────────────────────────────────────────────────

interface Rpc {
  gpu: number
  port: number
  state: NodeService['state']
  proc: ChildProcess | null
  logs: string[]
  error?: string
  progress?: number
}

const rpcs = new Map<number, Rpc>()
/** ComfyUI instances this node launched for mains (gpu → connector-like record). */
const comfys = new Map<number, ComfyConnector>()

function comfyFor(gpu: number): { id: string; port: number } | null {
  // The node user's own managed ComfyUI on that GPU is shared rather than started twice.
  const own = db('connectors').get(`comfy-gpu${gpu}`)
  if (own?.category === 'comfy' && own.managed && processState(own.id) === 'running') return { id: own.id, port: own.managed.port }
  const ours = comfys.get(gpu)
  return ours ? { id: ours.id, port: ours.managed!.port } : null
}

function startComfyFor(gpu: number): void {
  if (!shares(gpu)) throw new Error(`GPU ${gpu} isn't shared on ${nodeName()}`)
  const have = comfyFor(gpu)
  if (have && processState(have.id) !== 'stopped' && processState(have.id) !== 'crashed') return
  const c: ComfyConnector = {
    id: `node-comfy-gpu${gpu}`,
    name: `ComfyUI for linked PC · GPU ${gpu}`,
    category: 'comfy',
    url: `http://127.0.0.1:${COMFY_PORT_BASE + gpu}`,
    roles: [],
    enabled: true,
    createdAt: Date.now(),
    managed: { cudaDevice: gpu, port: COMFY_PORT_BASE + gpu }
  }
  comfys.set(gpu, c)
  launchComfy(c, () => pushServices())
}

function stopComfyFor(gpu: number): void {
  const ours = comfys.get(gpu)
  if (ours) stopComfy(ours.id)
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port
      s.close(() => resolve(port))
    })
  })
}

async function startRpc(gpu: number, tag: string): Promise<{ port: number }> {
  if (!shares(gpu)) throw new Error(`GPU ${gpu} isn't shared on ${nodeName()}`)
  if (typeof tag !== 'string' || !/^b\d+$/.test(tag)) throw new Error('Bad llama.cpp version')
  const cur = rpcs.get(gpu)
  if (cur && (cur.state === 'running' || cur.state === 'starting') && cur.proc) return { port: cur.port }
  const rpc: Rpc = { gpu, port: 0, state: 'installing', proc: null, logs: [] }
  rpcs.set(gpu, rpc)
  pushServices()
  try {
    const inst = await ensureLlama((label, progress) => {
      rpc.progress = progress
      rpc.logs.push(`[stitch] ${label}${progress !== undefined ? ` ${Math.round(progress * 100)}%` : ''}`)
      if (rpc.logs.length > 400) rpc.logs.splice(0, rpc.logs.length - 400)
      pushServices()
    }, tag)
    rpc.progress = undefined
    rpc.port = await freePort()
    rpc.state = 'starting'
    pushServices()
    const cache = join(llamaRoot(), 'rpc-cache')
    mkdirSync(cache, { recursive: true })
    // One rpc-server per GPU, bound to loopback; the main reaches it only through the link.
    const bin = rpcServer(inst.dir)
    if (!bin) throw new Error('This llama.cpp build has no RPC server')
    const child = spawn(bin, ['-H', '127.0.0.1', '-p', String(rpc.port), '-c'], {
      cwd: inst.dir,
      env: { ...process.env, CUDA_DEVICE_ORDER: 'PCI_BUS_ID', CUDA_VISIBLE_DEVICES: String(gpu), LLAMA_CACHE: cache },
      windowsHide: true
    })
    rpc.proc = child
    const log = (b: Buffer): void => {
      for (const line of b.toString('utf8').split(/\r?\n/)) if (line.trim()) rpc.logs.push(line)
      if (rpc.logs.length > 400) rpc.logs.splice(0, rpc.logs.length - 400)
    }
    child.stdout?.on('data', log)
    child.stderr?.on('data', log)
    child.on('exit', (code) => {
      if (rpc.proc !== child) return
      rpc.proc = null
      rpc.logs.push(`[stitch] rpc-server exited with code ${code}`)
      rpc.state = rpc.state === 'stopped' ? 'stopped' : 'crashed'
      pushServices()
    })
    await waitForPort(rpc.port, 30_000, () => rpc.proc === null)
    rpc.state = 'running'
    pushServices()
    return { port: rpc.port }
  } catch (err) {
    rpc.state = 'error'
    rpc.error = err instanceof Error ? err.message : String(err)
    pushServices()
    throw err
  }
}

async function waitForPort(port: number, timeoutMs: number, dead: () => boolean): Promise<void> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (dead()) throw new Error('rpc-server stopped while starting — see its log')
    const ok = await new Promise<boolean>((resolve) => {
      const s = connect(port, '127.0.0.1')
      s.once('connect', () => {
        s.destroy()
        resolve(true)
      })
      s.once('error', () => resolve(false))
    })
    if (ok) return
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error('rpc-server did not start in time')
}

function kill(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid) execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {})
  else child.kill()
}

function stopRpc(gpu: number): void {
  const r = rpcs.get(gpu)
  if (!r) return
  r.state = 'stopped'
  if (r.proc) kill(r.proc)
  r.proc = null
  pushServices()
}

export function nodeServices(): NodeService[] {
  const out: NodeService[] = []
  for (const [gpu, c] of comfys) {
    const ps = processState(c.id)
    out.push({ kind: 'comfy', gpu, state: ps === 'crashed' ? 'crashed' : ps })
  }
  // The node user's own ComfyUI that a main is sharing.
  for (const c of db('connectors').list()) {
    if (c.category !== 'comfy' || !c.managed || c.managed.cudaDevice === undefined || comfys.has(c.managed.cudaDevice)) continue
    if (processState(c.id) === 'running' && shares(c.managed.cudaDevice)) out.push({ kind: 'comfy', gpu: c.managed.cudaDevice, state: 'running' })
  }
  for (const r of rpcs.values()) out.push({ kind: 'rpc', gpu: r.gpu, state: r.state, progress: r.progress, error: r.error })
  return out.sort((a, b) => a.gpu - b.gpu || a.kind.localeCompare(b.kind))
}

function nodeModels(): Record<string, string[]> {
  return Object.fromEntries(MODEL_FOLDERS.map((f) => [f, scanModelsDir(f)]))
}

// ─── Link window & pairing ───────────────────────────────────────────────────

let window: { code: string; expiresAt: number; failures: number; requestedBy?: string } | null = null
let changed: () => void = () => {}

export function linkWindow(): { code: string; expiresAt: number; requestedBy?: string } | undefined {
  if (!window || window.expiresAt < Date.now()) return undefined
  return { code: window.code, expiresAt: window.expiresAt, requestedBy: window.requestedBy }
}

export function openLinkWindow(requestedBy?: string): void {
  if (!window || window.expiresAt < Date.now()) {
    window = { code: String(randomInt(0, 1_000_000)).padStart(6, '0'), expiresAt: Date.now() + 10 * 60_000, failures: 0 }
  }
  if (requestedBy) window.requestedBy = requestedBy.slice(0, 60)
  if (!app.isPackaged) console.log(`[cluster] link code ${window.code}${requestedBy ? ` (requested by ${requestedBy})` : ''}`)
  changed()
}

export function closeLinkWindow(): void {
  window = null
  changed()
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > 16 * 1024) throw new Error('Body too large')
    chunks.push(chunk as Buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

// ─── Control connections ─────────────────────────────────────────────────────

interface Conn {
  ws: WebSocket
  main: StoredMain
  alive: boolean
}

const conns = new Set<Conn>()
let wss: WebSocketServer | null = null
let hwTimer: NodeJS.Timeout | null = null
let idleTimer: NodeJS.Timeout | null = null
let rpcIdleTimer: NodeJS.Timeout | null = null
let lastSvc = ''
let lastModels = ''

export function onlineMainIds(): Set<string> {
  return new Set([...conns].map((c) => c.main.id))
}

function send(c: Conn, msg: unknown): void {
  if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(msg))
}

function pushServices(): void {
  const services = nodeServices()
  const sig = JSON.stringify(services)
  if (sig === lastSvc) return
  lastSvc = sig
  for (const c of conns) send(c, { t: 'svc', services })
  changed()
}

async function pushHardware(): Promise<void> {
  if (!conns.size) return
  const hw = await localHardware(shares)
  for (const c of conns) send(c, { t: 'hw', hw })
  pushServices()
}

function pushModels(force = false): void {
  const models = nodeModels()
  const sig = JSON.stringify(models)
  if (!force && sig === lastModels) return
  lastModels = sig
  for (const c of conns) send(c, { t: 'models', models })
}

type Op = (main: StoredMain, a: Record<string, unknown>) => unknown

const gpuArg = (a: Record<string, unknown>): number => {
  const g = Number(a.gpu)
  if (!Number.isInteger(g) || g < 0 || g > 63) throw new Error('Bad GPU index')
  return g
}

/** Everything a main may ask of this node. */
const OPS: Record<string, Op> = {
  'comfy.start': (_m, a) => startComfyFor(gpuArg(a)),
  'comfy.stop': (_m, a) => stopComfyFor(gpuArg(a)),
  'comfy.logs': (_m, a) => {
    const c = comfyFor(gpuArg(a))
    return c ? processLogs(c.id) : []
  },
  'rpc.start': (_m, a) => startRpc(gpuArg(a), String(a.tag ?? '')),
  'rpc.stop': (_m, a) => stopRpc(gpuArg(a)),
  'rpc.logs': (_m, a) => rpcs.get(gpuArg(a))?.logs ?? [],
  models: () => nodeModels(),
  unlink: (m) => {
    revokeMain(m.id)
    return null
  }
}

function onControl(ws: WebSocket, main: StoredMain, ip: string): void {
  const conn: Conn = { ws, main, alive: true }
  conns.add(conn)
  touchMain(main.id, ip)
  if (idleTimer) clearTimeout(idleTimer)
  if (rpcIdleTimer) clearTimeout(rpcIdleTimer)
  idleTimer = rpcIdleTimer = null
  void localHardware(shares).then((hw) => send(conn, { t: 'ready', node: { id: pcId(), name: nodeName(), version: app.getVersion() }, hw, services: nodeServices(), models: nodeModels() }))
  ensureTimers()
  changed()
  ws.on('message', (data) => {
    let msg: { t?: string; id?: number; op?: string; a?: Record<string, unknown> }
    try {
      msg = JSON.parse(data.toString())
    } catch {
      return
    }
    if (msg.t !== 'call' || typeof msg.id !== 'number' || typeof msg.op !== 'string') return
    const op = Object.hasOwn(OPS, msg.op) ? OPS[msg.op] : undefined
    const id = msg.id
    void (async () => {
      try {
        if (!op) throw new Error(`Unknown request ${msg.op}`)
        const v = await op(main, msg.a && typeof msg.a === 'object' ? msg.a : {})
        send(conn, { t: 'res', id, ok: true, v: v ?? null })
      } catch (err) {
        send(conn, { t: 'res', id, ok: false, e: err instanceof Error ? err.message : String(err) })
      }
    })()
  })
  ws.on('pong', () => (conn.alive = true))
  ws.on('close', () => {
    conns.delete(conn)
    touchMain(main.id)
    if (!conns.size) {
      // Free the GPUs a while after the last main left.
      rpcIdleTimer = setTimeout(() => {
        for (const gpu of rpcs.keys()) stopRpc(gpu)
      }, RPC_IDLE_MS)
      idleTimer = setTimeout(stopAllServices, IDLE_STOP_MS)
    }
    changed()
  })
  ws.on('error', () => ws.terminate())
}

function ensureTimers(): void {
  if (hwTimer) return
  let tick = 0
  hwTimer = setInterval(() => {
    for (const c of conns) {
      if (!c.alive) {
        c.ws.terminate()
        continue
      }
      if (tick % 8 === 0) {
        c.alive = false
        try {
          c.ws.ping()
        } catch {
          /* closing */
        }
      }
    }
    void pushHardware()
    if (tick % 24 === 0) pushModels()
    tick++
  }, 2500)
}

export function revokeMain(id: string): void {
  removeMain(id)
  for (const c of conns) if (c.main.id === id) c.ws.close(4003, 'Unlinked')
  changed()
}

export function stopAllServices(): void {
  for (const gpu of comfys.keys()) stopComfyFor(gpu)
  for (const gpu of rpcs.keys()) stopRpc(gpu)
}

// ─── Endpoints (wired into the remote server) ────────────────────────────────

/** Answer /api/node/* HTTP requests. Returns false when the path isn't ours. */
export async function nodeHttp(req: IncomingMessage, res: ServerResponse, ctx: NodeCtx): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://x')
  if (!url.pathname.startsWith('/api/node/')) return false
  if (getSettings().cluster?.role !== 'node') {
    json(res, 403, { error: `${nodeName()} isn't offering itself as a node (Settings → Computers).` })
    return true
  }
  if (!lanRequest(req, ctx.ip)) {
    json(res, 403, { error: 'Linking PCs works on your local network only.' })
    return true
  }
  if (url.pathname === '/api/node/pair-request' && req.method === 'POST') {
    const body = await readJson(req)
    const from = String(body.mainName ?? 'A Stitch PC').slice(0, 60)
    const fresh = !linkWindow()
    openLinkWindow(from)
    if (fresh && Notification.isSupported()) {
      new Notification({ title: `${from} wants to use this PC's GPUs`, body: `Link code ${window!.code} — type it on ${from}. Open Settings → Computers to see it again.` }).show()
    }
    json(res, 200, { ok: true, expiresAt: window!.expiresAt, name: nodeName() })
    return true
  }
  if (url.pathname === '/api/node/pair' && req.method === 'POST') {
    if (ctx.limiter.blocked(ctx.ip)) {
      json(res, 429, { error: 'Too many attempts — wait a few minutes.' })
      return true
    }
    const body = await readJson(req)
    const w = window
    if (!w || w.expiresAt < Date.now()) {
      json(res, 403, { error: `Linking is closed on ${nodeName()}. Press "Link" again, then read the new code on that PC.` })
      return true
    }
    if (typeof body.code !== 'string' || body.code.replace(/\D/g, '') !== w.code) {
      ctx.limiter.fail(ctx.ip)
      w.failures++
      if (w.failures >= 5) closeLinkWindow()
      json(res, 403, { error: w.failures >= 5 ? 'Too many wrong codes — ask for a new one.' : 'That code is not right.' })
      return true
    }
    if (typeof body.mainId !== 'string' || !body.mainId) {
      json(res, 400, { error: 'Missing main id' })
      return true
    }
    window = null
    const { main, token } = addMain({ mainId: body.mainId, name: String(body.mainName ?? 'Main PC'), address: ctx.ip })
    changed()
    json(res, 200, { token, linkId: main.id, nodeId: pcId(), name: nodeName(), version: app.getVersion() })
    return true
  }
  if (url.pathname === '/api/node/model' && req.method === 'PUT') {
    const main = mainForToken(bearer(req))
    if (!main) {
      ctx.limiter.fail(ctx.ip)
      json(res, 401, { error: 'Not linked' })
      return true
    }
    await receiveModel(req, res, url)
    return true
  }
  json(res, 404, { error: 'Not found' })
  return true
}

const receiving = new Set<string>()

/** A model file from the main: only into this PC's models folder, never over an existing file. */
async function receiveModel(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const folder = url.searchParams.get('folder') ?? ''
  const name = basename(url.searchParams.get('name') ?? '')
  const size = Number(url.searchParams.get('size'))
  if (!(folder in LAYOUT) || !MODEL_EXT.test(name) || name.startsWith('.') || /[<>:"/\\|?*\x00-\x1f]/.test(name) || !(size > 0)) {
    json(res, 400, { error: 'Only model files can be copied to a node' })
    return
  }
  const dir = destinationDir(folder)
  const dest = join(dir, name)
  if (!inside(dir, dest)) return json(res, 400, { error: 'Bad name' })
  if (existsSync(dest)) return json(res, 409, { error: `${name} is already on ${nodeName()}` })
  if (receiving.has(dest)) return json(res, 409, { error: `${name} is already being copied` })
  receiving.add(dest)
  mkdirSync(dir, { recursive: true })
  const part = `${dest}.part`
  let got = 0
  let out: ReturnType<typeof createWriteStream> | null = null
  try {
    await new Promise<void>((resolve, reject) => {
      out = createWriteStream(part)
      req.on('data', (chunk: Buffer) => {
        got += chunk.length
        if (got > size) {
          req.destroy()
          reject(new Error('More data than announced'))
        }
      })
      req.on('aborted', () => reject(new Error('The copy was interrupted')))
      req.pipe(out)
      out.on('finish', resolve)
      out.on('error', reject)
      req.on('error', reject)
    })
    if (statSync(part).size !== size) throw new Error('The copy is incomplete')
    renameSync(part, dest)
    invalidateLibrary()
    emit('models:changed', null)
    pushModels(true)
    json(res, 200, { ok: true })
  } catch (err) {
    // Close the file first — Windows won't delete an open file.
    const o = out as ReturnType<typeof createWriteStream> | null
    if (o && !o.closed) await new Promise<void>((r) => o.close(() => r()))
    try {
      unlinkSync(part)
    } catch {
      /* gone */
    }
    if (!res.headersSent) json(res, 500, { error: err instanceof Error ? err.message : String(err) })
  } finally {
    receiving.delete(dest)
  }
}

/** Handle /api/node/* WebSocket upgrades. Returns false when the path isn't ours. */
export function nodeUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, ctx: NodeCtx): boolean {
  const url = new URL(req.url ?? '/', 'http://x')
  if (!url.pathname.startsWith('/api/node/')) return false
  const refuse = (status: number, text: string): true => {
    socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    return true
  }
  if (getSettings().cluster?.role !== 'node' || !lanRequest(req, ctx.ip)) return refuse(403, 'Forbidden')
  if (ctx.limiter.blocked(ctx.ip)) return refuse(429, 'Too Many Requests')
  const main = mainForToken(bearer(req))
  if (!main) {
    ctx.limiter.fail(ctx.ip)
    return refuse(401, 'Unauthorized')
  }
  wss ??= new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 })
  if (url.pathname === '/api/node/ws') {
    wss.handleUpgrade(req, socket, head, (ws) => onControl(ws, main, ctx.ip))
    return true
  }
  if (url.pathname === '/api/node/tcp') {
    const to = url.searchParams.get('to')
    const gpu = Number(url.searchParams.get('gpu'))
    if (!Number.isInteger(gpu) || !shares(gpu)) return refuse(403, 'Forbidden')
    const port = to === 'comfy' ? comfyFor(gpu)?.port : to === 'rpc' ? (rpcs.get(gpu)?.state === 'running' ? rpcs.get(gpu)!.port : undefined) : undefined
    if (!port) return refuse(503, 'Service Unavailable')
    wss.handleUpgrade(req, socket, head, (ws) => {
      const tcp = connect(port, '127.0.0.1')
      splice(tcp, ws)
    })
    return true
  }
  return refuse(404, 'Not Found')
}

export function initNode(onChange: () => void): void {
  changed = onChange
}

export function nodeLinkStatus(): { mains: ReturnType<typeof listMains>; online: Set<string> } {
  return { mains: listMains(), online: onlineMainIds() }
}

export function shutdownNode(): void {
  if (hwTimer) clearInterval(hwTimer)
  hwTimer = null
  for (const c of conns) c.ws.close(1001, 'Stitch closed')
  conns.clear()
  for (const r of rpcs.values()) if (r.proc) kill(r.proc)
}
