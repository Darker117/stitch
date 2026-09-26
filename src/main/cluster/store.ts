// Linked PCs, in <userData>/data/cluster.json.
//   nodes — on a main: the nodes it linked. The link token is in the encrypted secrets (`cluster:<nodeId>`).
//   mains — on a node: the mains that may use it. Only SHA-256 hashes of their tokens are stored.
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { nanoid } from 'nanoid'
import { getSecret, setSecret } from '../settings'
import { dataDir } from '../store'
import { hashToken } from '../remote/devices'

export interface StoredNode {
  /** The node's PC id. */
  id: string
  name: string
  /** Addresses it answered on, best first. */
  addresses: string[]
  port: number
  version?: string
  createdAt: number
  lastSeenAt?: number
}

export interface StoredMain {
  /** Link id (also sent by the main with each connection). */
  id: string
  /** The main's PC id. */
  mainId: string
  name: string
  tokenHash: string
  createdAt: number
  lastSeenAt?: number
  lastAddress?: string
}

interface ClusterFile {
  nodes: StoredNode[]
  mains: StoredMain[]
}

const file = (): string => join(dataDir(), 'cluster.json')
let state: ClusterFile | null = null

function load(): ClusterFile {
  if (state) return state
  try {
    if (existsSync(file())) state = JSON.parse(readFileSync(file(), 'utf8')) as ClusterFile
  } catch {
    state = null
  }
  state = { nodes: state?.nodes ?? [], mains: state?.mains ?? [] }
  return state
}

function save(): void {
  if (!state) return
  const tmp = `${file()}.tmp`
  writeFileSync(tmp, JSON.stringify(state, null, 2))
  renameSync(tmp, file())
}

// ─── Main side ───────────────────────────────────────────────────────────────

export function listNodes(): StoredNode[] {
  return load().nodes
}

export function getNode(id: string): StoredNode | undefined {
  return load().nodes.find((n) => n.id === id)
}

export function saveNode(node: StoredNode, token?: string): void {
  const s = load()
  s.nodes = [...s.nodes.filter((n) => n.id !== node.id), node]
  save()
  if (token) setSecret(`cluster:${node.id}`, token)
}

export function nodeToken(id: string): string | undefined {
  return getSecret(`cluster:${id}`)
}

export function forgetNode(id: string): void {
  const s = load()
  s.nodes = s.nodes.filter((n) => n.id !== id)
  save()
  setSecret(`cluster:${id}`, null)
}

export function touchNode(id: string, patch: Partial<Pick<StoredNode, 'addresses' | 'port' | 'name' | 'version'>>): void {
  const n = load().nodes.find((x) => x.id === id)
  if (!n) return
  const changed = Object.entries(patch).some(([k, v]) => JSON.stringify(n[k as keyof StoredNode]) !== JSON.stringify(v))
  // lastSeenAt alone isn't worth a disk write every few seconds.
  const stale = Date.now() - (n.lastSeenAt ?? 0) > 60_000
  Object.assign(n, patch, { lastSeenAt: Date.now() })
  if (changed || stale) save()
}

// ─── Node side ───────────────────────────────────────────────────────────────

export function listMains(): StoredMain[] {
  return load().mains
}

export function addMain(info: { mainId: string; name: string; address?: string }): { main: StoredMain; token: string } {
  const token = randomBytes(32).toString('base64url')
  const s = load()
  // Re-linking the same main replaces its old token.
  s.mains = s.mains.filter((m) => m.mainId !== info.mainId)
  const main: StoredMain = {
    id: nanoid(10),
    mainId: info.mainId.slice(0, 40),
    name: (info.name || 'Main PC').slice(0, 60),
    tokenHash: hashToken(token),
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
    lastAddress: info.address
  }
  s.mains.push(main)
  save()
  return { main, token }
}

export function removeMain(id: string): boolean {
  const s = load()
  const before = s.mains.length
  s.mains = s.mains.filter((m) => m.id !== id)
  save()
  return before !== s.mains.length
}

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex')
  const y = Buffer.from(b, 'hex')
  return x.length === y.length && timingSafeEqual(x, y)
}

export function mainForToken(token: string | undefined | null): StoredMain | undefined {
  if (!token || token.length < 20) return undefined
  const h = hashToken(token)
  return load().mains.find((m) => sameHash(m.tokenHash, h))
}

export function touchMain(id: string, address?: string): void {
  const m = load().mains.find((x) => x.id === id)
  if (!m) return
  m.lastSeenAt = Date.now()
  if (address) m.lastAddress = address
  save()
}
