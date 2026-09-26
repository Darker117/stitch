// "Access from anywhere": give the phone remote a public HTTPS address.
//
//   cloudflare — a Cloudflare quick tunnel (no account). The address changes each time it starts, so
//                the PC also posts it, encrypted, to a private relay topic (ntfy.sh) that paired
//                phones read when they can't reach the PC — they follow it automatically.
//   tailscale  — Tailscale Funnel: a permanent https://<pc>.<tailnet>.ts.net address. The phone
//                doesn't need Tailscale. Uses a free funnel port and never touches other serve config.
//   custom     — an address the user runs themselves (own tunnel / reverse proxy).
import { app } from 'electron'
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createCipheriv, randomBytes } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import type { AnywhereMode, AnywhereStatus } from '@shared/ipc'
import { rendezvous } from './devices'

const run = promisify(execFile)

const CLOUDFLARED_URL = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe'
const RELAY = 'https://ntfy.sh'
const FUNNEL_PORTS = [443, 10000, 8443]

type Listener = () => void

export class Anywhere {
  status: AnywhereStatus = { mode: 'off', state: 'off' }
  private proc: ChildProcess | null = null
  private funnelPort: number | null = null
  private restartTimer: NodeJS.Timeout | null = null
  private relayTimer: NodeJS.Timeout | null = null
  private restarts = 0
  private generation = 0
  private localPort = 0

  constructor(private readonly onChange: Listener) {}

  get url(): string | undefined {
    return this.status.state === 'ready' ? this.status.url : undefined
  }

  private set(patch: Partial<AnywhereStatus>): void {
    this.status = { ...this.status, ...patch }
    this.onChange()
  }

  /** Switch mode (or restart the current one on a new local port). */
  async apply(mode: AnywhereMode, localPort: number, customUrl?: string): Promise<void> {
    const gen = ++this.generation
    await this.stop()
    if (gen !== this.generation) return
    this.localPort = localPort
    this.restarts = 0
    this.status = { mode, state: mode === 'off' ? 'off' : 'starting', tailscale: this.status.tailscale }
    this.onChange()
    try {
      if (mode === 'cloudflare') await this.startCloudflare(gen)
      else if (mode === 'tailscale') await this.startTailscale(gen)
      else if (mode === 'custom') await this.startCustom(gen, customUrl)
    } catch (err) {
      if (gen === this.generation) this.set({ state: 'error', error: err instanceof Error ? err.message : String(err) })
    }
  }

  async stop(): Promise<void> {
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    if (this.relayTimer) clearInterval(this.relayTimer)
    this.relayTimer = null
    const p = this.proc
    this.proc = null
    if (p && !p.killed) p.kill()
    if (this.funnelPort) {
      const port = this.funnelPort
      this.funnelPort = null
      const ts = tailscaleExe()
      if (ts) await run(ts, ['funnel', `--https=${port}`, 'off'], { windowsHide: true, timeout: 15_000 }).catch(() => {})
    }
  }

  /** On quit: close the tunnel and withdraw the Funnel before the process exits. */
  stopSync(): void {
    this.generation++
    if (this.relayTimer) clearInterval(this.relayTimer)
    if (this.restartTimer) clearTimeout(this.restartTimer)
    if (this.proc && !this.proc.killed) this.proc.kill()
    this.proc = null
    const ts = tailscaleExe()
    if (this.funnelPort && ts) {
      try {
        execFileSync(ts, ['funnel', `--https=${this.funnelPort}`, 'off'], { windowsHide: true, timeout: 5000 })
      } catch {
        /* best effort */
      }
    }
    this.funnelPort = null
  }

  // ─── Cloudflare quick tunnel ───────────────────────────────────────────────

  private async startCloudflare(gen: number): Promise<void> {
    const exe = await this.ensureCloudflared(gen)
    if (gen !== this.generation) return
    this.set({ state: 'starting', progress: undefined })
    killStray()
    const proc = spawn(exe, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${this.localPort}`], { windowsHide: true })
    this.proc = proc
    if (proc.pid) writeFileSync(pidFile(), String(proc.pid))
    let found = false
    const onData = (buf: Buffer): void => {
      const text = buf.toString()
      const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(text)
      if (m && !found) {
        found = true
        void this.becomeReady(gen, m[0])
      }
    }
    proc.stdout?.on('data', onData)
    proc.stderr?.on('data', onData)
    proc.on('exit', (code) => {
      if (this.proc !== proc || gen !== this.generation) return
      this.proc = null
      // Keep the tunnel up: restart with backoff (a new address is published to the relay).
      const delay = Math.min(60_000, 3000 * 2 ** this.restarts++)
      this.set({ state: 'starting', error: `Tunnel stopped (${code ?? 'signal'}) — reconnecting…` })
      this.restartTimer = setTimeout(() => void this.startCloudflare(gen).catch((err) => this.set({ state: 'error', error: String(err?.message ?? err) })), delay)
    })
  }

  private async ensureCloudflared(gen: number): Promise<string> {
    const dir = join(app.getPath('userData'), 'bin')
    const exe = join(dir, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared')
    if (existsSync(exe) && statSync(exe).size > 1_000_000) return exe
    if (process.platform !== 'win32') throw new Error('Install cloudflared and put it on PATH')
    mkdirSync(dir, { recursive: true })
    this.set({ state: 'downloading', progress: 0 })
    const res = await fetch(CLOUDFLARED_URL, { redirect: 'follow' })
    if (!res.ok || !res.body) throw new Error(`Couldn't download cloudflared (${res.status})`)
    const total = Number(res.headers.get('content-length') ?? 0)
    let got = 0
    let last = 0
    const part = `${exe}.part`
    const body = Readable.fromWeb(res.body as never)
    body.on('data', (c: Buffer) => {
      got += c.length
      if (total && Date.now() - last > 250 && gen === this.generation) {
        last = Date.now()
        this.set({ progress: got / total })
      }
    })
    try {
      await pipeline(body, createWriteStream(part))
      renameSync(part, exe)
    } catch (err) {
      try {
        unlinkSync(part)
      } catch {
        /* ignore */
      }
      throw err
    }
    return exe
  }

  // ─── Tailscale Funnel ──────────────────────────────────────────────────────

  async probeTailscale(): Promise<AnywhereStatus['tailscale']> {
    const ts = tailscaleExe()
    if (!ts) return { installed: false, running: false, funnel: false }
    try {
      const { stdout } = await run(ts, ['status', '--json'], { windowsHide: true, timeout: 8000 })
      const j = JSON.parse(stdout) as { BackendState?: string; Self?: { DNSName?: string; Capabilities?: string[]; CapMap?: Record<string, unknown> } }
      const caps = [...(j.Self?.Capabilities ?? []), ...Object.keys(j.Self?.CapMap ?? {})]
      const info = {
        installed: true,
        running: j.BackendState === 'Running',
        dnsName: j.Self?.DNSName?.replace(/\.$/, ''),
        funnel: caps.some((c) => c === 'funnel' || c.endsWith('/cap/funnel'))
      }
      this.status = { ...this.status, tailscale: info }
      return info
    } catch {
      return { installed: true, running: false, funnel: false }
    }
  }

  private async startTailscale(gen: number): Promise<void> {
    const ts = tailscaleExe()
    if (!ts) throw new Error('Tailscale isn’t installed on this PC')
    const info = await this.probeTailscale()
    if (gen !== this.generation) return
    if (!info?.running || !info.dnsName) {
      this.set({ state: 'needs-action', error: 'Sign in to Tailscale on this PC first.', actionUrl: 'https://login.tailscale.com/start', actionLabel: 'Open Tailscale' })
      return
    }
    // Pick a funnel port that's free (or already ours) so other serve config is left alone.
    let used: Record<string, string> = {}
    try {
      const { stdout } = await run(ts, ['serve', 'status', '--json'], { windowsHide: true, timeout: 8000 })
      const j = JSON.parse(stdout || '{}') as { Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }> }
      for (const [host, cfg] of Object.entries(j.Web ?? {})) used[host.split(':').pop() ?? ''] = cfg.Handlers?.['/']?.Proxy ?? 'other'
    } catch {
      used = {}
    }
    const ours = `http://127.0.0.1:${this.localPort}`
    const port = FUNNEL_PORTS.find((p) => used[String(p)] === ours) ?? FUNNEL_PORTS.find((p) => !used[String(p)])
    if (!port) throw new Error('All Tailscale Funnel ports (443, 8443, 10000) are in use by other apps')

    const out = await new Promise<string>((resolve) => {
      const p = spawn(ts, ['funnel', '--bg', `--https=${port}`, ours], { windowsHide: true })
      let text = ''
      const t = setTimeout(() => {
        p.kill()
        resolve(text)
      }, 25_000)
      p.stdout.on('data', (b: Buffer) => (text += b.toString()))
      p.stderr.on('data', (b: Buffer) => (text += b.toString()))
      p.on('exit', () => {
        clearTimeout(t)
        resolve(text)
      })
    })
    if (gen !== this.generation) return
    const enable = /https:\/\/login\.tailscale\.com\/\S+/.exec(out)
    if (enable && !/Available on the internet/i.test(out)) {
      this.set({ state: 'needs-action', error: 'Funnel needs to be allowed for this PC in your tailnet.', actionUrl: enable[0], actionLabel: 'Allow Funnel' })
      return
    }
    this.funnelPort = port
    await this.becomeReady(gen, `https://${info.dnsName}${port === 443 ? '' : `:${port}`}`)
  }

  // ─── Custom address ────────────────────────────────────────────────────────

  private async startCustom(gen: number, customUrl?: string): Promise<void> {
    const url = (customUrl ?? '').trim().replace(/\/+$/, '')
    if (!/^https?:\/\/[^/\s]+$/i.test(url)) throw new Error('Enter the public address, like https://stitch.example.com')
    await this.becomeReady(gen, url)
  }

  // ─── Ready: verify from outside, publish to the relay ──────────────────────

  private async becomeReady(gen: number, url: string): Promise<void> {
    this.set({ state: 'starting', url, error: undefined, actionUrl: undefined, actionLabel: undefined })
    // New tunnel hostnames take a few seconds to resolve worldwide.
    let ok = false
    for (let i = 0; i < 25 && gen === this.generation; i++) {
      try {
        const r = await fetch(`${url}/api/hello`, { signal: AbortSignal.timeout(4000) })
        if (r.ok && ((await r.json()) as { app?: string }).app === 'stitch') {
          ok = true
          break
        }
      } catch {
        /* not yet */
      }
      await new Promise((r) => setTimeout(r, 1500))
    }
    if (gen !== this.generation) return
    this.restarts = 0
    this.set({ state: 'ready', url, error: ok ? undefined : 'Couldn’t confirm the address from outside yet — it may take a minute.' })
    void publishRelay(url)
    if (this.relayTimer) clearInterval(this.relayTimer)
    // The relay keeps messages ~12 h; refresh well before that.
    this.relayTimer = setInterval(() => void publishRelay(url), 4 * 3600_000)
  }
}

const pidFile = (): string => join(app.getPath('userData'), 'bin', 'cloudflared.pid')

/** A tunnel left behind by a crash would keep an old address alive — end it (only ours, by PID). */
function killStray(): void {
  try {
    const pid = Number(readFileSync(pidFile(), 'utf8'))
    // PIDs get reused after a reboot: only end it if it's still cloudflared.
    const name = process.platform === 'win32' ? execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], { windowsHide: true }).toString() : 'cloudflared'
    if (pid > 0 && /cloudflared/i.test(name)) process.kill(pid)
  } catch {
    /* none running */
  }
  try {
    unlinkSync(pidFile())
  } catch {
    /* ignore */
  }
}

export function tailscaleExe(): string | null {
  const candidates = [join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Tailscale', 'tailscale.exe'), join(process.env['ProgramFiles(x86)'] ?? '', 'Tailscale', 'tailscale.exe')]
  return candidates.find((p) => existsSync(p)) ?? null
}

/** Post the current public address to the relay topic, AES-256-GCM encrypted with the pairing key. */
async function publishRelay(url: string): Promise<void> {
  const r = rendezvous()
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', Buffer.from(r.key, 'base64'), iv)
  const body = Buffer.concat([iv, c.update(JSON.stringify({ u: url, t: Date.now() }), 'utf8'), c.final(), c.getAuthTag()]).toString('base64')
  try {
    await fetch(`${RELAY}/${r.topic}`, { method: 'POST', body, headers: { Title: 'stitch', Tags: 'stitch' }, signal: AbortSignal.timeout(10_000) })
  } catch (err) {
    console.warn('[remote] relay publish failed:', err instanceof Error ? err.message : err)
  }
}
