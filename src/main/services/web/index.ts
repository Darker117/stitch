// Web search for text models: the SearXNG bundled with the app (resources/searxng, built by
// `npm run searxng`). Its portable Python runs `stitch_searx.py serve` on a free loopback port,
// started on the first search and stopped after a quiet spell. See searxng/stitch_searx.py.
import { app } from 'electron'
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, type WriteStream } from 'node:fs'
import { dirname, join } from 'node:path'
import type { WebPage, WebSearchRequest, WebSearchResult, WebStatus } from '@shared/ipc'
import { emit, handle } from '../../ipc'
import { getSettings } from '../../settings'

const READY_TIMEOUT = 45_000 // the first start compiles bytecode for the whole bundle
const SEARCH_TIMEOUT = 15_000
const PAGE_TIMEOUT = 25_000
const IDLE_STOP = 15 * 60_000
const MAX_QUERY = 400
const RESTART_DELAYS = [1_000, 3_000, 10_000, 30_000, 60_000]
const LOG_MAX = 2 * 1024 * 1024

const CATEGORIES = new Set(['general', 'news', 'science', 'it', 'images', 'videos'])
const TIME_RANGES = new Set(['day', 'week', 'month', 'year'])

// ─── Paths ───────────────────────────────────────────────────────────────────

const PY_EXE = process.platform === 'win32' ? join('python', 'python.exe') : join('python', 'bin', 'python3')

function bundleDir(): string | undefined {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'searxng')]
    : [join(app.getAppPath(), 'resources', 'searxng'), join(__dirname, '../../resources/searxng')]
  return candidates.find((d) => existsSync(join(d, PY_EXE)) && existsSync(join(d, 'stitch_searx.py')))
}

const dataDir = (): string => join(app.getPath('userData'), 'searxng')
const logFile = (): string => join(app.getPath('userData'), 'logs', 'searxng.log')

function bundleVersion(dir: string | undefined): { raw: string; date?: string; commit?: string } | undefined {
  if (!dir) return undefined
  try {
    const raw = readFileSync(join(dir, 'VERSION.json'), 'utf8')
    const v = JSON.parse(raw) as { date?: string; commit?: string }
    return { raw, date: v.date, commit: v.commit }
  } catch {
    return undefined
  }
}

// ─── State ───────────────────────────────────────────────────────────────────

const st: WebStatus = { where: 'pc', state: 'stopped' }
let child: ChildProcess | null = null
let port = 0
let token = ''
let stopping = false
let startPromise: Promise<number> | null = null
let restartTimer: NodeJS.Timeout | null = null
let restartAttempt = 0
let stableTimer: NodeJS.Timeout | null = null
let idleTimer: NodeJS.Timeout | null = null
let lastUsed = 0
let inflight = 0
let shuttingDown = false
/** Recent output of the current SearXNG process (for error messages). */
const tail: string[] = []

function snapshot(): WebStatus {
  const dir = bundleDir()
  const out: WebStatus = { ...st }
  const v = bundleVersion(dir)
  if (v?.date) out.version = v.date
  if (!dir && st.state !== 'running') {
    out.state = 'missing'
    out.error = missingMessage()
  } else if (dir && st.state === 'missing') {
    // Built since (npm run searxng): the next search starts it.
    st.state = out.state = 'stopped'
    st.error = out.error = undefined
  }
  if (!out.error) delete out.error
  return out
}

function missingMessage(): string {
  return app.isPackaged
    ? 'Web search is missing from this installation — reinstall Stitch to restore it.'
    : 'The SearXNG bundle is missing — run `npm run searxng`.'
}

function setState(state: WebStatus['state'], error?: string): void {
  if (st.state === state && st.error === error) return
  st.state = state
  st.error = error
  emit('web:status', snapshot())
}

// ─── Log ─────────────────────────────────────────────────────────────────────

let log: WriteStream | null = null

function logLine(line: string, fromProcess = false): void {
  const clean = line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trimEnd()
  if (!clean.trim()) return
  if (fromProcess) {
    tail.push(clean)
    if (tail.length > 60) tail.splice(0, tail.length - 60)
  }
  try {
    if (!log) {
      const file = logFile()
      mkdirSync(dirname(file), { recursive: true })
      if (existsSync(file) && statSync(file).size > LOG_MAX) renameSync(file, file.replace(/\.log$/, '.old.log'))
      log = createWriteStream(file, { flags: 'a' })
      log.on('error', () => {
        log = null
      })
    }
    log.write(`${new Date().toISOString()} ${clean}\n`)
  } catch {
    /* logging must never break search */
  }
}

function lineReader(onLine: (line: string) => void): (chunk: Buffer) => void {
  let rest = ''
  return (chunk) => {
    const parts = (rest + chunk.toString('utf8')).split(/\r?\n/)
    rest = parts.pop() ?? ''
    for (const p of parts) onLine(p)
  }
}

/** The most useful recent stderr line (a Python exception, usually). */
function lastError(): string {
  const errs = tail.filter((l) => /error|exception|traceback|failed|cannot|can't/i.test(l) && !/^\s/.test(l))
  return (errs[errs.length - 1] ?? tail[tail.length - 1] ?? '').slice(0, 300)
}

// ─── Process ─────────────────────────────────────────────────────────────────

function killTree(proc: ChildProcess, sync = false): void {
  if (proc.exitCode !== null || proc.signalCode !== null || !proc.pid) return
  try {
    proc.stdin?.end() // --watch-stdin: it exits on its own too
  } catch {
    /* already closed */
  }
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

function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, STITCH_SEARX_TOKEN: token, NO_COLOR: '1' }
  // -I already makes Python ignore PYTHON* variables; drop them anyway, with other Python setups.
  for (const k of Object.keys(env)) {
    if (/^(PYTHON|SEARXNG_)/i.test(k) || ['VIRTUAL_ENV', 'CONDA_PREFIX', 'CONDA_DEFAULT_ENV', 'PIP_TARGET', 'PIP_PREFIX'].includes(k.toUpperCase())) delete env[k]
  }
  return env
}

/** Bytecode lives under the profile; start fresh whenever a different bundle is installed. */
function pycacheDir(version: string | undefined): string {
  const dir = join(dataDir(), 'pycache')
  const marker = join(dir, 'bundle.json')
  try {
    const have = existsSync(marker) ? readFileSync(marker, 'utf8') : ''
    if (have !== (version ?? '')) {
      rmSync(dir, { recursive: true, force: true })
      mkdirSync(dir, { recursive: true })
      writeFileSync(marker, version ?? '')
    }
  } catch {
    /* a stale cache only costs speed */
  }
  return dir
}

function ensureRunning(): Promise<number> {
  if (child && port && st.state === 'running') return Promise.resolve(port)
  if (startPromise) return startPromise
  if (restartTimer) {
    clearTimeout(restartTimer)
    restartTimer = null
  }
  startPromise = doStart().finally(() => {
    startPromise = null
  })
  return startPromise
}

async function doStart(): Promise<number> {
  const dir = bundleDir()
  if (!dir) {
    setState('missing', missingMessage())
    throw new Error(missingMessage())
  }
  const version = bundleVersion(dir)
  const data = dataDir()
  mkdirSync(data, { recursive: true })
  token = randomBytes(24).toString('hex')
  stopping = false
  setState('starting')
  logLine(`▸ Starting SearXNG ${version?.date ?? ''} (${version?.commit?.slice(0, 9) ?? 'unknown'}) from ${dir}`)

  const safe = getSettings().web?.safeSearch ?? 1
  const args = ['-I', '-u', '-X', 'utf8', '-X', `pycache_prefix=${pycacheDir(version?.raw)}`, join(dir, 'stitch_searx.py'), 'serve', '--data', data, '--port', '0', '--safe', String(safe), '--watch-stdin']

  const t0 = Date.now()
  let proc: ChildProcess
  try {
    proc = spawn(join(dir, PY_EXE), args, { cwd: data, env: cleanEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  } catch (err) {
    const msg = `Could not launch SearXNG's Python (${err instanceof Error ? err.message : String(err)})`
    logLine(`✗ ${msg}`)
    setState('error', msg)
    throw new Error(msg)
  }
  child = proc
  tail.length = 0

  return await new Promise<number>((resolve, reject) => {
    let settled = false
    const finish = (err: Error | null, p = 0): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err) reject(err)
      else resolve(p)
    }
    const timer = setTimeout(() => {
      logLine(`✗ SearXNG did not start within ${READY_TIMEOUT / 1000} s`)
      killTree(proc)
      if (child === proc) child = null
      setState('error', `SearXNG did not start within ${READY_TIMEOUT / 1000} seconds`)
      finish(new Error(`SearXNG did not start within ${READY_TIMEOUT / 1000} seconds`))
    }, READY_TIMEOUT)

    proc.stdout?.on(
      'data',
      lineReader((line) => {
        const m = /^STITCH_SEARX_READY (\d+)\s*$/.exec(line)
        if (m && child === proc) {
          port = Number(m[1])
          logLine(`✓ SearXNG ready on 127.0.0.1:${port} in ${((Date.now() - t0) / 1000).toFixed(1)} s (pid ${proc.pid})`)
          setState('running')
          markUsed()
          if (stableTimer) clearTimeout(stableTimer)
          stableTimer = setTimeout(() => (restartAttempt = 0), 120_000)
          finish(null, port)
        } else logLine(line, true)
      })
    )
    proc.stderr?.on(
      'data',
      lineReader((line) => logLine(line, true))
    )
    proc.stdin?.on('error', () => {}) // EPIPE when it exits first

    proc.on('error', (err) => {
      logLine(`✗ ${err.message}`)
      if (child !== proc) return
      child = null
      port = 0
      setState('error', `Could not launch SearXNG's Python (${err.message})`)
      finish(new Error(`Could not launch SearXNG's Python (${err.message})`))
    })

    proc.on('exit', (code, signal) => {
      if (child !== proc) return
      child = null
      port = 0
      if (stableTimer) clearTimeout(stableTimer)
      stableTimer = null
      if (stopping || shuttingDown) {
        logLine('SearXNG stopped')
        setState('stopped')
        finish(new Error('SearXNG was stopped'))
        return
      }
      const why = lastError()
      const msg = settled
        ? `SearXNG stopped unexpectedly (exit code ${code ?? signal})${why ? ` — ${why}` : ''}`
        : `SearXNG failed to start (exit code ${code ?? signal})${why ? ` — ${why}` : ''}`
      logLine(`✗ ${msg}`)
      setState('error', msg)
      finish(new Error(msg))
      scheduleRestart()
    })
  })
}

/** After a crash, come back on our own (with backoff) while web search is in use. */
function scheduleRestart(): void {
  if (shuttingDown || restartTimer || Date.now() - lastUsed > IDLE_STOP) return
  if (restartAttempt >= RESTART_DELAYS.length) {
    logLine('✗ SearXNG keeps failing — giving up until the next search')
    restartAttempt = 0
    return
  }
  const delay = RESTART_DELAYS[restartAttempt++]
  logLine(`Restarting SearXNG in ${delay / 1000} s`)
  restartTimer = setTimeout(() => {
    restartTimer = null
    ensureRunning().catch(() => {
      /* exit handler schedules the next attempt */
    })
  }, delay)
}

/** Stop SearXNG; resolves once the process has exited (or after a few seconds). */
function stopSearx(): Promise<void> {
  if (restartTimer) clearTimeout(restartTimer)
  restartTimer = null
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
  restartAttempt = 0
  const proc = child
  if (!proc) {
    if (st.state !== 'missing') setState('stopped')
    return Promise.resolve()
  }
  stopping = true
  const exited = new Promise<void>((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve()
    const t = setTimeout(resolve, 5000)
    proc.once('exit', () => {
      clearTimeout(t)
      resolve()
    })
  })
  killTree(proc)
  return exited
}

function markUsed(): void {
  lastUsed = Date.now()
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(checkIdle, IDLE_STOP + 1000)
}

function checkIdle(): void {
  idleTimer = null
  if (!child) return
  if (inflight > 0 || Date.now() - lastUsed < IDLE_STOP) {
    idleTimer = setTimeout(checkIdle, Math.max(5_000, IDLE_STOP - (Date.now() - lastUsed)))
    return
  }
  logLine('Stopping SearXNG after 15 idle minutes')
  void stopSearx()
}

// ─── Requests ────────────────────────────────────────────────────────────────

async function callSearx<T>(method: 'GET' | 'POST', path: string, body: unknown, timeoutMs: number): Promise<T> {
  inflight++
  markUsed()
  try {
    for (let attempt = 0; ; attempt++) {
      const p = await ensureRunning()
      let res: Response
      try {
        res = await fetch(`http://127.0.0.1:${p}${path}`, {
          method,
          headers: { 'X-Stitch-Token': token, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(timeoutMs)
        })
      } catch (err) {
        const name = err instanceof Error ? err.name : ''
        if (name === 'TimeoutError' || name === 'AbortError') throw new Error(`Web search timed out after ${timeoutMs / 1000} s`)
        // The process went away between requests: start it again once.
        if (attempt === 0 && !child) continue
        throw new Error(`Couldn't reach SearXNG (${err instanceof Error ? err.message : String(err)})`)
      }
      const text = await res.text()
      let json: unknown
      try {
        json = JSON.parse(text)
      } catch {
        throw new Error(`SearXNG answered HTTP ${res.status}`)
      }
      if (!res.ok) throw new Error(String((json as { error?: string })?.error ?? `SearXNG answered HTTP ${res.status}`))
      return json as T
    }
  } finally {
    inflight--
    markUsed()
  }
}

function sanitizeRequest(req: WebSearchRequest): WebSearchRequest {
  if (!req || typeof req !== 'object') throw new Error('Search request missing')
  const query = String(req.query ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_QUERY)
  if (!query) throw new Error('Empty search query')
  const web = getSettings().web
  const out: WebSearchRequest = { query }
  if (req.category) {
    if (!CATEGORIES.has(req.category)) throw new Error(`Unknown search category: ${req.category}`)
    out.category = req.category
  }
  if (req.timeRange) {
    if (!TIME_RANGES.has(req.timeRange)) throw new Error(`Unknown time range: ${req.timeRange}`)
    out.timeRange = req.timeRange
  }
  if (req.language && typeof req.language === 'string') out.language = req.language.trim().slice(0, 20)
  if (req.page) out.page = Math.max(1, Math.min(10, Math.floor(Number(req.page)) || 1))
  const limit = Math.floor(Number(req.limit ?? web?.maxResults ?? 6)) || 6
  out.limit = Math.max(1, Math.min(50, limit))
  const safe = req.safeSearch ?? web?.safeSearch ?? 1
  out.safeSearch = safe === 0 || safe === 2 ? safe : 1
  return out
}

function checkUrl(url: string): string {
  let u: URL
  try {
    u = new URL(String(url ?? '').trim())
  } catch {
    throw new Error('Not a valid URL')
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only http(s) pages can be opened')
  if (u.username || u.password) throw new Error('URLs with credentials are not allowed')
  return u.toString()
}

async function statusWithHealth(): Promise<WebStatus> {
  if (child && port && st.state === 'running') {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/stitch/health`, { headers: { 'X-Stitch-Token': token }, signal: AbortSignal.timeout(3000) })
      if (res.ok) return snapshot()
    } catch {
      /* hung — restart below */
    }
    logLine('SearXNG is not answering — restarting it')
    await stopSearx()
  }
  try {
    await ensureRunning()
  } catch {
    /* the status carries the error */
  }
  return snapshot()
}

// ─── Registration ────────────────────────────────────────────────────────────

export function registerWeb(): void {
  if (!bundleDir()) st.state = 'missing'
  handle('web:status', () => snapshot())
  handle('web:start', () => statusWithHealth())
  handle('web:stop', async () => {
    await stopSearx()
    return snapshot()
  })
  handle('web:search', async (req) => {
    const body = sanitizeRequest(req)
    const res = await callSearx<Omit<WebSearchResult, 'where'>>('POST', '/stitch/search', body, SEARCH_TIMEOUT)
    return { ...res, where: 'pc' as const }
  })
  handle('web:page', async (url, maxChars) => {
    const target = checkUrl(url)
    const max = Math.max(200, Math.min(200_000, Math.floor(Number(maxChars ?? 12_000)) || 12_000))
    const res = await callSearx<Omit<WebPage, 'where'>>('GET', `/stitch/page?url=${encodeURIComponent(target)}&max=${max}`, undefined, PAGE_TIMEOUT)
    return { ...res, where: 'pc' as const }
  })
  // Answered on the phone; the PC has only one route.
  handle('web:setRoute', () => snapshot())
}

/** Kill SearXNG synchronously on app quit. */
export function shutdownWeb(): void {
  shuttingDown = true
  if (restartTimer) clearTimeout(restartTimer)
  if (idleTimer) clearTimeout(idleTimer)
  if (stableTimer) clearTimeout(stableTimer)
  restartTimer = idleTimer = stableTimer = null
  if (child) {
    stopping = true
    killTree(child, true)
    child = null
  }
  try {
    log?.end()
  } catch {
    /* ignore */
  }
  log = null
}
