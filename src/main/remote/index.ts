// Phone remote: lets the Stitch Android app drive this PC (see server.ts for the wire protocol).
import { app } from 'electron'
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, parse, resolve } from 'node:path'
import QRCode from 'qrcode'
import type { RemoteDirListing, RemoteStatus } from '@shared/ipc'
import { emit, handle } from '../ipc'
import { getSettings, updateSettings } from '../settings'
import { Anywhere } from './anywhere'
import { listDevices, pcId, publicDevice } from './devices'
import { cleanUploads } from './files'
import { localHosts, pcName, RemoteServer, type NodeEndpoints } from './server'

let lastPublic: string | undefined
const anywhere = new Anywhere(() => {
  // A new public address: phones that are connected learn it right away; others find it via the relay.
  if (anywhere.url !== lastPublic) {
    lastPublic = anywhere.url
    server.announceEndpoints()
  }
  emit('remote:changed', status())
})

let nodeEndpoints: NodeEndpoints | null = null

const server = new RemoteServer({
  changed: () => emit('remote:changed', status()),
  paired: (d) => emit('remote:paired', publicDevice(d, false)),
  publicUrl: () => anywhere.url,
  phonesAllowed: () => getSettings().remote.enabled,
  node: () => nodeEndpoints
})

/** Settings → Computers: a node answers linked mains on this server (see src/main/cluster/node.ts). */
export function setNodeEndpoints(e: NodeEndpoints): void {
  nodeEndpoints = e
}

const nodeRole = (): boolean => getSettings().cluster?.role === 'node'

export function remoteRunning(): boolean {
  return server.running
}

export function remotePort(): number {
  return server.running ? server.port : getSettings().remote.port
}

export function remoteError(): string | undefined {
  return server.error
}

function status(): RemoteStatus {
  const s = getSettings().remote
  const online = server.onlineDeviceIds()
  return {
    enabled: s.enabled,
    running: server.running,
    port: server.running ? server.port : s.port,
    hosts: localHosts(),
    pcId: pcId(),
    pcName: pcName(),
    error: server.error,
    anywhere: anywhere.status,
    endpoints: server.running ? server.endpoints() : [],
    devices: listDevices()
      .map((d) => publicDevice(d, online.has(d.id)))
      .sort((a, b) => Number(b.online) - Number(a.online) || (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0))
  }
}

let anywhereKey = ''

/** Start or stop the server (phones allowed, or this PC is a node) and the public address. */
export function applyRemote(): Promise<void> {
  return apply()
}

async function apply(): Promise<void> {
  const s = getSettings().remote
  if (s.enabled || nodeRole()) {
    try {
      if (!server.running || server.port !== s.port) await server.start(s.port)
    } catch (err) {
      console.error('[remote] could not start:', err instanceof Error ? err.message : err)
    }
  } else if (server.running) await server.stop()
  // The public address follows the server: only while phones are allowed.
  const mode = s.enabled && server.running ? (s.anywhere?.mode ?? 'off') : 'off'
  const key = `${mode}|${server.port}|${mode === 'custom' ? (s.anywhere?.customUrl ?? '') : ''}`
  if (key !== anywhereKey) {
    anywhereKey = key
    void anywhere.apply(mode, server.port, s.anywhere?.customUrl)
  }
  emit('remote:changed', status())
}

const qrSvg = (text: string): Promise<string> =>
  QRCode.toString(text, { type: 'svg', margin: 0, errorCorrectionLevel: 'M', color: { dark: '#ffffffff', light: '#00000000' } })

function listDir(path?: string): RemoteDirListing {
  if (!path) {
    const entries: RemoteDirListing['entries'] = []
    if (process.platform === 'win32') {
      for (let c = 67; c <= 90; c++) {
        const drive = `${String.fromCharCode(c)}:\\`
        if (existsSync(drive)) entries.push({ name: drive, path: drive, dir: true })
      }
    }
    const home = homedir()
    entries.unshift(
      { name: 'Home', path: home, dir: true },
      { name: 'Documents', path: app.getPath('documents'), dir: true },
      { name: 'Stitch library', path: getSettings().libraryDir, dir: true }
    )
    return { path: null, parent: null, entries }
  }
  const full = resolve(path)
  const root = parse(full).root
  const entries: RemoteDirListing['entries'] = []
  for (const name of readdirSync(full)) {
    if (name.startsWith('.') || name.startsWith('$')) continue
    const p = join(full, name)
    try {
      const dir = statSync(p).isDirectory()
      entries.push({ name, path: p, dir })
    } catch {
      /* unreadable */
    }
  }
  entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true }))
  return { path: full, parent: full === root ? null : dirname(full), entries: entries.slice(0, 2000) }
}

function savePath(name: string): string {
  const dir = join(getSettings().libraryDir, 'exports')
  mkdirSync(dir, { recursive: true })
  const clean = basename(name || 'export').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'export'
  const ext = extname(clean)
  const stem = clean.slice(0, clean.length - ext.length)
  let p = join(dir, clean)
  for (let i = 2; existsSync(p); i++) p = join(dir, `${stem} (${i})${ext}`)
  return p
}

export function registerRemote(): void {
  handle('remote:status', () => status())
  handle('remote:setEnabled', async (enabled, port) => {
    const cur = getSettings().remote
    updateSettings({ remote: { enabled, port: port && port > 1023 && port < 65536 ? port : cur.port } })
    await apply()
    return status()
  })
  handle('remote:pairStart', async () => {
    if (!getSettings().remote.enabled || !server.running) {
      updateSettings({ remote: { enabled: true } })
      await apply()
      if (!server.running) throw new Error(server.error ?? 'The phone remote could not start')
    }
    return server.startPairing(qrSvg)
  })
  handle('remote:pairCancel', () => server.cancelPairing())
  handle('remote:revoke', (id) => {
    server.revoke(id)
    emit('remote:changed', status())
  })
  handle('remote:setAnywhere', async (mode, customUrl) => {
    const cur = getSettings().remote
    updateSettings({ remote: { enabled: mode !== 'off' ? true : cur.enabled, anywhere: { mode, customUrl: customUrl ?? cur.anywhere?.customUrl } } })
    if (mode === 'tailscale') await anywhere.probeTailscale()
    await apply()
    return status()
  })
  handle('remote:listDir', (path) => listDir(path))
  handle('remote:savePath', (name) => savePath(name))

  cleanUploads()

  // Dev: open a pairing window at launch and log its link (e.g. `adb shell am start -d "<link>"`).
  if (!app.isPackaged && process.env.STITCH_REMOTE_DEV_PAIR === '1') {
    setTimeout(() => {
      if (!server.running) return
      void server.startPairing(qrSvg).then((p) => console.log(`[remote] dev pairing code ${p.code}
[remote] dev pairing link ${p.url}`))
    }, 3000)
  }

  // Dev: a fixed pre-paired token so the mobile web build can connect without pairing.
  if (!app.isPackaged && process.env.STITCH_REMOTE === '1') {
    const port = Number(process.env.STITCH_REMOTE_PORT) || getSettings().remote.port
    updateSettings({ remote: { enabled: true, port } })
    void import('./dev').then((m) => m.ensureDevDevice(process.env.STITCH_REMOTE_DEV_TOKEN))
  }
  void apply()
}

export async function shutdownRemote(): Promise<void> {
  anywhere.stopSync()
  await server.stop()
}
