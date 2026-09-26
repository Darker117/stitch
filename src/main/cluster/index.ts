// Computers: this PC as the main (links nodes and uses their GPUs) or as a node (offers its GPUs).
// See node.ts for what a node exposes and link.ts for the main's side of a link.
import { app } from 'electron'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ClusterStatus, FoundPc, LinkedNode, NodeModelGap, PcHardware } from '@shared/ipc'
import type { NodeGpu } from '@shared/types'
import { emit, handle } from '../ipc'
import { getSettings, updateSettings } from '../settings'
import { pcId } from '../remote/devices'
import { applyRemote, remotePort, remoteRunning, remoteError, setNodeEndpoints } from '../remote'
import { applyGpuLayout, refreshRemoteComfy } from '../services/comfy'
import { recipeUnmet } from '../services/comfy/jobs'
import { RECIPES } from '../services/comfy/recipes'
import { scanModelsDir } from '../services/comfy/process'
import { modelRoots } from '../services/models/home'
import { Finder, rankAddress, Responder, type Announce } from './discovery'
import { localHardware } from './hardware'
import { NodeLink } from './link'
import { closeLinkWindow, initNode, linkWindow, nodeHttp, nodeLinkStatus, nodeName, nodeServices, nodeUpgrade, openLinkWindow, revokeMain, shutdownNode, stopAllServices } from './node'
import { forgetNode, getNode, listNodes, saveNode } from './store'

const links = new Map<string, NodeLink>()
/** PCs added by address (other subnet / Tailscale), shown like discovered ones for a while. */
const probed = new Map<string, FoundPc & { at: number }>()
let hardware: PcHardware | undefined
let interestUntil = 0
let hwTimer: NodeJS.Timeout | null = null

const role = (): 'main' | 'node' => getSettings().cluster?.role ?? 'main'

// ─── Status & change events ──────────────────────────────────────────────────

let emitTimer: NodeJS.Timeout | null = null
let lastEmit = 0
function changed(): void {
  if (emitTimer) return
  const wait = Math.max(0, 600 - (Date.now() - lastEmit))
  emitTimer = setTimeout(() => {
    emitTimer = null
    lastEmit = Date.now()
    emit('cluster:changed', status())
    onNodesChanged()
  }, wait)
}

let nodesListener: () => void = () => {}
/** Comfy/llama learn about nodes coming and going. */
export function onClusterChange(fn: () => void): void {
  const prev = nodesListener
  nodesListener = () => {
    prev()
    fn()
  }
}
let lastOnline = ''
function onNodesChanged(): void {
  const sig = [...links.values()].map((l) => `${l.id}:${l.state}`).join()
  if (sig === lastOnline) return
  lastOnline = sig
  void refreshRemoteComfy().catch((err: Error) => console.warn('[cluster] remote ComfyUI refresh failed:', err.message))
  nodesListener()
}

const finder = new Finder(() => pcId(), changed)
const responder = new Responder((): Announce | null => {
  if (role() !== 'node' || !remoteRunning()) return null
  const gpus = (hardware?.gpus ?? []).filter((g) => g.shared !== false).map((g) => ({ name: g.name, memTotal: g.memTotal }))
  return { app: 'stitch', t: 'here', v: 1, id: pcId(), name: nodeName(), port: remotePort(), version: hardware?.version, gpus }
})

function found(): FoundPc[] {
  const out = new Map<string, FoundPc>()
  for (const s of finder.list()) {
    out.set(s.id, { id: s.id, name: s.name, address: s.addresses[0], port: s.port, version: s.version, gpus: s.gpus, linked: links.has(s.id) })
  }
  for (const [id, p] of probed) {
    if (Date.now() - p.at > 15 * 60_000) probed.delete(id)
    else if (!out.has(id)) out.set(id, { ...p, linked: links.has(id) })
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export function status(): ClusterStatus {
  const { mains, online } = nodeLinkStatus()
  return {
    role: role(),
    pcId: pcId(),
    name: nodeName(),
    hardware,
    node: {
      listening: role() === 'node' && remoteRunning(),
      port: remotePort(),
      error: role() === 'node' ? (remoteError() ?? responder.error) : undefined,
      linkWindow: linkWindow(),
      mains: mains.map((m) => ({ id: m.id, name: m.name, online: online.has(m.id), createdAt: m.createdAt, lastSeenAt: m.lastSeenAt, lastAddress: m.lastAddress })),
      services: nodeServices()
    },
    found: found(),
    nodes: [...links.values()].map((l) => l.view())
  }
}

async function sampleHardware(): Promise<void> {
  const share = getSettings().cluster?.share
  const hw = await localHardware(role() === 'node' ? (g) => !share || share.includes(g) : undefined)
  const sig = (h?: PcHardware): string => JSON.stringify(h ? { ...h, at: 0, ram: { total: h.ram.total, free: Math.round(h.ram.free / 2 ** 28) } } : null)
  const moved = sig(hw) !== sig(hardware)
  hardware = hw
  if (moved) changed()
}

function ensureHwLoop(): void {
  if (hwTimer) return
  hwTimer = setInterval(() => {
    const busy = Date.now() < interestUntil || (role() === 'node' && nodeLinkStatus().online.size > 0)
    if (busy) void sampleHardware()
  }, 3000)
}

// ─── Links (main side) ───────────────────────────────────────────────────────

export function nodeLink(id: string): NodeLink | undefined {
  return links.get(id)
}

export function linkedNodes(): NodeLink[] {
  return [...links.values()]
}

export function isLinked(id: string): boolean {
  return links.has(id)
}

/** Remote ComfyUI instances the GPU layout wants, started when their node is online. */
let wantedComfy: NodeGpu[] = []
let autoStart = false

export function setWantedRemoteComfy(list: NodeGpu[], startNow: boolean): void {
  wantedComfy = list
  if (startNow) autoStart = true
  if (!autoStart) return
  for (const w of list) {
    const l = links.get(w.node)
    if (l?.online) void l.call('comfy.start', { gpu: w.gpu }).catch((err) => console.warn('[cluster] comfy.start failed:', err.message))
  }
}

function onLinkOnline(l: NodeLink): void {
  if (getSettings().comfyAutoLaunch) autoStart = true
  if (!autoStart) return
  for (const w of wantedComfy) if (w.node === l.id) void l.call('comfy.start', { gpu: w.gpu }).catch(() => {})
}

function addLink(rec: ReturnType<typeof getNode> & object): NodeLink {
  links.get(rec.id)?.close()
  const l = new NodeLink(rec, { changed, online: onLinkOnline })
  links.set(rec.id, l)
  l.connect()
  return l
}

function applyRole(): void {
  if (role() === 'node') {
    finder.stop()
    for (const l of links.values()) l.close()
    links.clear()
    responder.start()
    void sampleHardware()
  } else {
    responder.stop()
    closeLinkWindow()
    stopAllServices()
    finder.start()
    for (const rec of listNodes()) if (!links.has(rec.id)) addLink(rec)
  }
  changed()
}

async function post(addresses: string[], port: number, path: string, body: unknown): Promise<{ addr: string; data: Record<string, unknown> }> {
  let lastErr: Error | null = null
  for (const addr of [...addresses].sort((a, b) => rankAddress(a) - rankAddress(b))) {
    try {
      const res = await fetch(`http://${addr.includes(':') ? `[${addr}]` : addr}:${port}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000)
      })
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
      if (!res.ok) throw new Error(typeof data.error === 'string' ? data.error : `The PC answered ${res.status}`)
      return { addr, data }
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err))
      // A real answer (wrong code, closed window) is final; only unreachable addresses fall through.
      if (!/fetch failed|timeout|aborted|ECONN|EHOST|ENET/i.test(lastErr.message + String((err as { cause?: unknown }).cause ?? ''))) throw lastErr
    }
  }
  throw lastErr ?? new Error('That PC is not reachable')
}

function target(pcIdToFind: string): { addresses: string[]; port: number; name: string } {
  const s = finder.list().find((x) => x.id === pcIdToFind)
  if (s) return { addresses: s.addresses, port: s.port, name: s.name }
  const p = probed.get(pcIdToFind)
  if (p) return { addresses: [p.address], port: p.port, name: p.name }
  const rec = getNode(pcIdToFind)
  if (rec) return { addresses: rec.addresses, port: rec.port, name: rec.name }
  throw new Error('That PC is no longer on the network')
}

async function link(id: string, code: string): Promise<LinkedNode> {
  if (role() !== 'main') throw new Error('Switch this PC to Main to link other PCs')
  const t = target(id)
  const { addr, data } = await post(t.addresses, t.port, '/api/node/pair', { code: code.replace(/\D/g, ''), mainId: pcId(), mainName: nodeName() })
  if (data.nodeId !== id || typeof data.token !== 'string') throw new Error('That PC answered with a different identity — try again')
  const rec = { id, name: String(data.name ?? t.name), addresses: [...new Set([addr, ...t.addresses])], port: t.port, version: typeof data.version === 'string' ? data.version : undefined, createdAt: Date.now(), lastSeenAt: Date.now() }
  saveNode(rec, data.token)
  probed.delete(id)
  const l = addLink(rec)
  changed()
  return l.view()
}

async function probe(address: string): Promise<FoundPc> {
  const m = /^\s*\[?([^\]\s]+?)\]?(?::(\d+))?\s*$/.exec(address.replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
  if (!m) throw new Error('Enter an address like 192.168.1.20 or mypc:47847')
  const host = m[1]
  const port = Number(m[2] ?? 47847)
  const res = await fetch(`http://${host.includes(':') ? `[${host}]` : host}:${port}/api/hello`, { signal: AbortSignal.timeout(6000) }).catch(() => null)
  if (!res?.ok) throw new Error(`No Stitch answered at ${host}:${port}`)
  const j = (await res.json()) as { app?: string; pcId?: string; pcName?: string; nodeName?: string; version?: string; node?: boolean }
  if (j.app !== 'stitch' || !j.pcId) throw new Error(`No Stitch answered at ${host}:${port}`)
  if (j.pcId === pcId()) throw new Error("That's this PC")
  if (!j.node) throw new Error(`${j.nodeName ?? j.pcName ?? 'That PC'} isn't offering itself as a node — switch it to Node in Settings → Computers`)
  const pc: FoundPc & { at: number } = { id: j.pcId, name: j.nodeName ?? j.pcName ?? host, address: host, port, version: j.version, gpus: [], linked: links.has(j.pcId), at: Date.now() }
  probed.set(pc.id, pc)
  changed()
  return pc
}

async function unlink(id: string): Promise<void> {
  const l = links.get(id)
  if (l?.online) await l.call('unlink', {}, 5000).catch(() => {})
  l?.close()
  links.delete(id)
  forgetNode(id)
  // Drop the node from the GPU layout and the text engine.
  const s = getSettings()
  const assign = Object.fromEntries(Object.entries(s.gpu.assign).map(([k, v]) => [k, typeof v === 'object' && v && v.node === id ? 'auto' : v]))
  updateSettings({
    gpu: { remote: (s.gpu.remote ?? []).filter((r) => r.node !== id), assign: assign as typeof s.gpu.assign },
    llama: { devices: s.llama.devices.filter((d) => !d.startsWith(`${id}:`)) }
  })
  changed()
  await applyGpuLayout().catch(() => {})
}

// ─── Model gaps & copies ─────────────────────────────────────────────────────

function localModelPath(folder: string, rel: string): string | undefined {
  for (const r of modelRoots()) {
    if (r.folder !== folder) continue
    const p = join(r.dir, rel)
    if (existsSync(p)) return p
  }
  return undefined
}

function gaps(nodeId: string): NodeModelGap[] {
  const l = links.get(nodeId)
  if (!l?.models) throw new Error('That PC is offline')
  const mine: Record<string, string[]> = {}
  const out: NodeModelGap[] = []
  for (const r of RECIPES) {
    const unmet = recipeUnmet(r, l.models)
    if (!unmet.length) continue
    out.push({
      recipeId: r.id,
      recipeName: r.name,
      kind: r.kind,
      missing: unmet.map((q) => {
        mine[q.folder] ??= scanModelsDir(q.folder)
        const hit = mine[q.folder].find((f) => (q.name ? f === q.name || f.endsWith('/' + q.name) : q.match!.test(f)))
        const path = hit ? localModelPath(q.folder, hit) : undefined
        return { folder: q.folder, label: q.label, source: hit && path ? { name: hit, size: statSync(path).size } : undefined }
      })
    })
  }
  return out
}

// ─── Registration ────────────────────────────────────────────────────────────

export function registerCluster(): void {
  initNode(changed)
  setNodeEndpoints({
    http: nodeHttp,
    upgrade: nodeUpgrade,
    hello: () => ({ node: role() === 'node', nodeName: nodeName() })
  })
  ensureHwLoop()

  handle('cluster:status', () => {
    interestUntil = Date.now() + 60_000
    if (!hardware) void sampleHardware()
    finder.find()
    return status()
  })
  handle('cluster:setRole', async (r) => {
    if (r !== 'main' && r !== 'node') throw new Error('Unknown role')
    updateSettings({ cluster: { role: r } })
    await applyRemote()
    applyRole()
    return status()
  })
  handle('cluster:linkWindow', (open) => {
    if (role() !== 'node') throw new Error('Switch this PC to Node first')
    if (open) openLinkWindow()
    else closeLinkWindow()
    return status()
  })
  handle('cluster:requestLink', async (id) => {
    const t = target(id)
    await post(t.addresses, t.port, '/api/node/pair-request', { mainId: pcId(), mainName: nodeName() })
  })
  handle('cluster:link', (id, code) => link(id, code))
  handle('cluster:probe', (address) => probe(address))
  handle('cluster:unlink', (id) => unlink(id))
  handle('cluster:revokeMain', (id) => revokeMain(id))
  handle('cluster:modelGaps', (id) => gaps(id))
  handle('cluster:copyModel', (id, folder, name) => {
    const l = links.get(id)
    if (!l?.online) throw new Error('That PC is offline')
    const path = localModelPath(folder, name)
    if (!path) throw new Error(`${name} isn't on this PC`)
    l.copyModel(path, folder, name.split('/').pop()!, changed)
  })
  handle('cluster:cancelCopy', (copyId) => {
    for (const l of links.values()) l.copies.find((c) => c.id === copyId)?.abort?.()
  })
  handle('cluster:nodeLogs', async (id, kind, gpu) => {
    const l = links.get(id)
    if (!l?.online) return [`${l?.rec.name ?? 'That PC'} is offline.`]
    return l.call<string[]>(kind === 'comfy' ? 'comfy.logs' : 'rpc.logs', { gpu })
  })

  // Dev: open the link window at launch and log its code (for scripted main + node runs).
  if (!app.isPackaged && process.env.STITCH_NODE_DEV_LINK === '1' && role() === 'node') setTimeout(() => openLinkWindow('dev'), 3000)

  applyRole()
}

export function shutdownCluster(): void {
  finder.stop()
  responder.stop()
  for (const l of links.values()) l.close()
  shutdownNode()
}
