// Host side of the script sandbox: a couple of pre-warmed single-use workers,
// a hard timeout per run (terminate + replace), structured-clone messaging.
import type { AidEnv, SandboxRequest, SandboxResponse } from './types'

/** Per script, per hook. AI Dungeon allows about two seconds; we stay a little under. */
export const HOOK_TIMEOUT_MS = 1500
const SPARES = 2
const SPAWN_TIMEOUT_MS = 10_000
const IDLE_MS = 3 * 60_000

let spares: Promise<Worker>[] = []
let idleTimer: ReturnType<typeof setTimeout> | undefined

function spawn(): Promise<Worker> {
  return new Promise<Worker>((resolve, reject) => {
    let w: Worker
    try {
      w = new Worker(new URL('./sandbox.worker.ts', import.meta.url), { type: 'module', name: 'stitch-story-script' })
    } catch (err) {
      reject(err)
      return
    }
    const timer = setTimeout(() => {
      w.terminate()
      reject(new Error('The script sandbox did not start'))
    }, SPAWN_TIMEOUT_MS)
    w.onmessage = (e: MessageEvent) => {
      if ((e.data as { type?: string })?.type !== 'ready') return
      clearTimeout(timer)
      w.onmessage = null
      w.onerror = null
      resolve(w)
    }
    w.onerror = (e: ErrorEvent) => {
      e.preventDefault()
      clearTimeout(timer)
      w.terminate()
      reject(new Error(e.message || 'The script sandbox failed to start'))
    }
  })
}

function refill(): void {
  while (spares.length < SPARES) {
    const p = spawn()
    p.catch(() => {
      spares = spares.filter((x) => x !== p)
    })
    spares.push(p)
  }
  clearTimeout(idleTimer)
  idleTimer = setTimeout(releaseSandbox, IDLE_MS)
}

/** Start workers ahead of time so the first hook doesn't pay for startup. */
export function prewarmSandbox(): void {
  refill()
}

/** Drop idle workers (they are recreated on demand). */
export function releaseSandbox(): void {
  const old = spares
  spares = []
  for (const p of old) void p.then((w) => w.terminate()).catch(() => {})
}

async function take(): Promise<Worker> {
  const next = spares.shift()
  refill()
  if (next) {
    try {
      return await next
    } catch {
      /* fall through to a fresh spawn */
    }
  }
  return spawn()
}

function failure(env: AidEnv, error: string, errorKind: SandboxResponse['errorKind'], ms: number): SandboxResponse {
  return { ok: false, text: env.text, stop: false, returned: false, state: env.state, storyCards: env.storyCards, logs: [], error, errorKind, ms }
}

/** Evaluate `code` once in a fresh sandbox with the AID globals from `env`. Never throws. */
export async function runSandboxed(code: string, env: AidEnv, opts: { timeoutMs?: number; compileOnly?: boolean } = {}): Promise<SandboxResponse> {
  const timeoutMs = opts.timeoutMs ?? HOOK_TIMEOUT_MS
  let w: Worker
  try {
    w = await take()
  } catch (err) {
    return failure(env, err instanceof Error ? err.message : String(err), 'crash', 0)
  }
  return new Promise<SandboxResponse>((resolve) => {
    const t0 = performance.now()
    const finish = (res: SandboxResponse): void => {
      clearTimeout(timer)
      w.onmessage = null
      w.onerror = null
      w.terminate()
      resolve(res)
    }
    const timer = setTimeout(() => finish(failure(env, `Timed out after ${timeoutMs} ms (infinite loop?)`, 'timeout', timeoutMs)), timeoutMs)
    w.onmessage = (e: MessageEvent) => finish(e.data as SandboxResponse)
    w.onerror = (e: ErrorEvent) => {
      e.preventDefault()
      finish(failure(env, e.message || 'The script crashed the sandbox', 'crash', performance.now() - t0))
    }
    w.onmessageerror = () => finish(failure(env, 'The script produced data that cannot be passed back', 'crash', performance.now() - t0))
    const req: SandboxRequest = { type: 'run', code, env, compileOnly: opts.compileOnly }
    try {
      w.postMessage(req)
    } catch (err) {
      finish(failure(env, `Could not pass data to the script: ${err instanceof Error ? err.message : String(err)}`, 'crash', 0))
    }
  })
}
