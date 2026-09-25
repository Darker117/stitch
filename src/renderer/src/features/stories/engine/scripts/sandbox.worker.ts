// Story script sandbox. Every hook run gets a brand-new worker (a fresh
// realm), so nothing leaks between scripts, turns or adventures — the same
// isolation AI Dungeon gives each hook.
//
// Before any user code runs, the worker captures what it needs and then
// strips network and escape hatches from its global: fetch/XHR/sockets,
// importScripts, storage, timers, nested workers and its own postMessage.
// `import()` is syntax and cannot be deleted, so every piece of code that
// gets evaluated (the script itself, and anything it passes to eval or the
// Function constructors) has dynamic imports rewritten to a throwing stub.
//
// This file must not import runtime code: type imports only.
import type { AidCard, AidEnv, SandboxLog, SandboxRequest, SandboxResponse } from './types'

type Scope = Record<string, unknown> & {
  postMessage: (msg: unknown) => void
  addEventListener: (type: 'message', fn: (e: MessageEvent) => void) => void
}
const scope = globalThis as unknown as Scope

// ─── Captured natives (scripts may tamper with the originals) ────────────────

const send = scope.postMessage.bind(scope)
const listen = scope.addEventListener.bind(scope)
const nativeEval = scope.eval as (src: string) => unknown
const NativeFunction = Function
const apply = Reflect.apply
const construct = Reflect.construct
const defineProperty = Object.defineProperty
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor
const getPrototypeOf = Object.getPrototypeOf
const isArray = Array.isArray
const indexOf = String.prototype.indexOf
const slice = String.prototype.slice
const stringify = JSON.stringify
const parse = JSON.parse
const clock = performance.now.bind(performance)

const MAX_LOGS = 300
const MAX_LOG_CHARS = 20_000

// ─── Dynamic import guard ────────────────────────────────────────────────────

const STUB = '__stitchNoImport'

function isIdentChar(c: string | undefined): boolean {
  if (c === undefined) return false
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '_' || c === '$' || c > '\u007f'
}

function isSpace(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\v' || c === '\f' || c === ' ' || c === '﻿' || c === ' ' || c === ' ' || (c >= ' ' && c <= ' ') || c === ' ' || c === ' ' || c === ' ' || c === '　'
}

/** Index of the first non-space, non-comment character at or after `i`. */
function skipTrivia(src: string, i: number): number {
  const n = src.length
  while (i < n) {
    const c = src[i]
    if (isSpace(c)) i++
    else if (c === '/' && src[i + 1] === '*') {
      const end = apply(indexOf, src, ['*/', i + 2]) as number
      i = end < 0 ? n : end + 2
    } else if ((c === '/' && src[i + 1] === '/') || (c === '<' && src[i + 1] === '!' && src[i + 2] === '-' && src[i + 3] === '-') || (c === '-' && src[i + 1] === '-' && src[i + 2] === '>')) {
      while (i < n && src[i] !== '\n' && src[i] !== '\r' && src[i] !== ' ' && src[i] !== ' ') i++
    } else break
  }
  return i
}

/**
 * Rewrite every `import (` call to a stub that throws. Deliberately blunt: it
 * also rewrites the words inside strings and comments, which is harmless, and
 * never misses a real dynamic import. Uses only captured natives.
 */
function guard(src: string): string {
  let out = ''
  let from = 0
  let at = apply(indexOf, src, ['import', 0]) as number
  while (at >= 0) {
    const before = src[at - 1]
    // `a.import(` / `a?.import(` are property calls; `...import(` is a spread and must be caught.
    const member = before === '.' && src[at - 2] !== '.'
    if (!isIdentChar(before) && !member && !isIdentChar(src[at + 6]) && src[skipTrivia(src, at + 6)] === '(') {
      out += (apply(slice, src, [from, at]) as string) + STUB
      from = at + 6
    }
    at = apply(indexOf, src, ['import', at + 6]) as number
  }
  return from === 0 ? src : out + (apply(slice, src, [from]) as string)
}

// ─── Harden the global ───────────────────────────────────────────────────────

const BLOCKED = [
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'WebSocketStream',
  'WebTransport',
  'EventSource',
  'importScripts',
  'indexedDB',
  'IDBFactory',
  'caches',
  'CacheStorage',
  'cookieStore',
  'BroadcastChannel',
  'Worker',
  'SharedWorker',
  'ServiceWorker',
  'FontFace',
  'fonts',
  'navigator',
  'Notification',
  'setTimeout',
  'setInterval',
  'clearTimeout',
  'clearInterval',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'postMessage',
  'close',
  'onmessage',
  'webkitRequestFileSystem',
  'webkitRequestFileSystemSync',
  'webkitResolveLocalFileSystemURL',
  'webkitResolveLocalFileSystemSyncURL'
]

function strip(name: string): void {
  let o: object | null = scope
  while (o) {
    const d = getOwnPropertyDescriptor(o, name)
    if (d) {
      if (d.configurable) delete (o as Record<string, unknown>)[name]
      else {
        try {
          defineProperty(o, name, { value: undefined, writable: false })
        } catch {
          /* non-configurable and non-writable: nothing more we can do */
        }
      }
    }
    o = getPrototypeOf(o) as object | null
  }
}

/** Wrap a function constructor so the code it compiles goes through `guard`. */
function guardConstructor(Native: typeof Function): typeof Function {
  const Guarded = function (...args: unknown[]): unknown {
    const src: string[] = []
    for (let i = 0; i < args.length; i++) src[i] = guard(String(args[i]))
    return construct(Native, src)
  } as unknown as typeof Function
  defineProperty(Guarded, 'prototype', { value: Native.prototype })
  defineProperty(Guarded, 'name', { value: Native.name })
  defineProperty(Native.prototype, 'constructor', { value: Guarded, writable: true, configurable: true })
  return Guarded
}

function harden(): void {
  for (const name of BLOCKED) strip(name)
  scope.Function = guardConstructor(NativeFunction)
  guardConstructor(getPrototypeOf(async function () {}).constructor as typeof Function)
  guardConstructor(getPrototypeOf(function* () {}).constructor as typeof Function)
  guardConstructor(getPrototypeOf(async function* () {}).constructor as typeof Function)
  // Indirect semantics: code passed to eval runs in the global scope.
  scope.eval = function evaluate(src: unknown): unknown {
    return typeof src === 'string' ? nativeEval(guard(src)) : src
  }
  defineProperty(scope, STUB, {
    value: () => {
      throw new Error('import() is not available to story scripts')
    }
  })
}

// ─── AID globals ─────────────────────────────────────────────────────────────

function show(v: unknown): string {
  if (typeof v === 'string') return v
  if (v instanceof Error) return v.stack || `${v.name}: ${v.message}`
  if (v === undefined) return 'undefined'
  if (typeof v === 'function') return `[Function ${(v as { name?: string }).name || 'anonymous'}]`
  try {
    return stringify(v) ?? String(v)
  } catch {
    return String(v)
  }
}

function install(env: AidEnv, logs: SandboxLog[]): void {
  const log =
    (level: SandboxLog['level']) =>
    (...args: unknown[]): void => {
      if (logs.length >= MAX_LOGS) return
      let msg = ''
      for (let i = 0; i < args.length; i++) msg += (i ? ' ' : '') + show(args[i])
      logs.push({ level, message: msg.length > MAX_LOG_CHARS ? `${apply(slice, msg, [0, MAX_LOG_CHARS]) as string}…` : msg })
    }
  const plain = log('log')
  const cards = (): AidCard[] => scope.storyCards as AidCard[]
  const stamp = (): string => new Date().toISOString()
  let seq = 0
  const newId = (): string => `${Date.now()}${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}${seq++}`
  const at = (index: unknown): number => {
    const i = Number(index)
    const list = cards()
    if (!isArray(list) || !Number.isInteger(i) || i < 0 || i >= list.length || !list[i]) throw new Error(`Story card ${String(index)} does not exist`)
    return i
  }

  const given = (v: unknown): boolean => v !== undefined && v !== null

  /** addStoryCard(keys, entry, type = 'Custom', title = keys, notes = '', { returnCard }) */
  function addStoryCard(keys?: unknown, entry?: unknown, type?: unknown, title?: unknown, description?: unknown, options?: unknown): AidCard | number | false {
    const list = cards()
    const k = given(keys) ? String(keys) : ''
    for (const c of list) if (c && c.keys === k) return false
    const now = stamp()
    const card: AidCard = {
      id: newId(),
      title: given(title) ? String(title) : k,
      keys: k,
      entry: given(entry) ? String(entry) : '',
      type: given(type) ? String(type) : 'Custom',
      description: given(description) ? String(description) : '',
      createdAt: now,
      updatedAt: now,
      useForCharacterCreation: false
    }
    list.push(card)
    return options && typeof options === 'object' && (options as { returnCard?: unknown }).returnCard === true ? card : list.length
  }
  function removeStoryCard(index: unknown): void {
    cards().splice(at(index), 1)
  }
  /** updateStoryCard(index, keys, entry, type, title, notes): omitted values are kept. */
  function updateStoryCard(index: unknown, keys?: unknown, entry?: unknown, type?: unknown, title?: unknown, description?: unknown): void {
    const card = cards()[at(index)]
    if (given(keys)) card.keys = String(keys)
    if (given(entry)) card.entry = String(entry)
    if (given(type)) card.type = String(type)
    if (given(title)) card.title = String(title)
    if (given(description)) card.description = String(description)
    card.updatedAt = stamp()
  }

  const g = scope
  g.text = env.text
  g.stop = false
  g.state = env.state
  g.info = env.info
  g.history = env.history
  g.storyCards = env.storyCards
  g.memory = env.memory
  defineProperty(g, 'worldInfo', { get: () => g.storyCards, set: (v) => (g.storyCards = v), configurable: true })
  g.addStoryCard = addStoryCard
  g.removeStoryCard = removeStoryCard
  g.updateStoryCard = updateStoryCard
  g.addWorldEntry = addStoryCard
  g.removeWorldEntry = removeStoryCard
  g.updateWorldEntry = updateStoryCard
  g.log = plain
  g.console = { log: plain, info: log('info'), debug: plain, warn: log('warn'), error: log('error'), trace: plain, dir: plain, table: plain }
  g.sandboxConsole = { log: plain }
}

// ─── Run ─────────────────────────────────────────────────────────────────────

function cleanCards(v: unknown): AidCard[] {
  if (!isArray(v)) return []
  const out: AidCard[] = []
  const str = (x: unknown): string => (x === undefined || x === null ? '' : typeof x === 'string' ? x : String(x))
  for (const c of v as Record<string, unknown>[]) {
    if (!c || typeof c !== 'object') continue
    out.push({
      id: str(c.id),
      title: str(c.title),
      keys: str(c.keys),
      entry: str(c.entry),
      type: str(c.type),
      description: str(c.description),
      createdAt: str(c.createdAt),
      updatedAt: str(c.updatedAt),
      useForCharacterCreation: c.useForCharacterCreation === true
    })
  }
  return out
}

/** Line of the failure inside the evaluated script, from a V8 stack. */
function errorLine(err: unknown): number | undefined {
  const stack = err instanceof Error ? String(err.stack ?? '') : ''
  const m = /stitch-script\.js:(\d+):\d+/.exec(stack)
  return m ? Number(m[1]) : undefined
}

function run(req: SandboxRequest): SandboxResponse {
  const logs: SandboxLog[] = []
  const t0 = clock()
  const base = { stop: false, returned: false, state: req.env.state, storyCards: req.env.storyCards, logs }
  const code = `${guard(req.code)}\n//# sourceURL=stitch-script.js`
  if (req.compileOnly) {
    try {
      construct(NativeFunction, [code])
      return { ...base, ok: true, text: req.env.text, ms: clock() - t0 }
    } catch (err) {
      return { ...base, ok: false, text: req.env.text, error: show(err instanceof Error ? err.message : err), errorKind: 'syntax', ms: clock() - t0 }
    }
  }
  install(req.env, logs)
  let value: unknown
  try {
    value = nativeEval(code)
  } catch (err) {
    const syntax = err instanceof SyntaxError
    return {
      ...base,
      ok: false,
      text: req.env.text,
      error: err instanceof Error ? `${err.name}: ${err.message}` : `Uncaught ${show(err)}`,
      line: syntax ? undefined : errorLine(err),
      errorKind: syntax ? 'syntax' : 'runtime',
      ms: clock() - t0
    }
  }
  const g = scope
  let text: unknown = g.text
  let stop = g.stop === true
  let returned = false
  if (value && typeof value === 'object' && 'text' in value) {
    const r = value as { text: unknown; stop?: unknown }
    text = r.text
    stop = r.stop === true
    returned = true
  }
  let state: Record<string, unknown>
  try {
    const s = g.state
    state = s && typeof s === 'object' && !isArray(s) ? (parse(stringify(s)) as Record<string, unknown>) : {}
  } catch (err) {
    return { ...base, ok: false, text: req.env.text, error: `state could not be saved: ${show(err instanceof Error ? err.message : err)}`, errorKind: 'state', ms: clock() - t0 }
  }
  return {
    ok: true,
    text: text === null || text === undefined ? null : typeof text === 'string' ? text : String(text),
    stop,
    returned,
    state,
    storyCards: cleanCards(g.storyCards),
    logs,
    ms: clock() - t0
  }
}

let used = false
listen('message', (e: MessageEvent) => {
  const req = e.data as SandboxRequest
  if (used || !req || req.type !== 'run') return
  used = true
  let res: SandboxResponse
  try {
    res = run(req)
  } catch (err) {
    res = { ok: false, text: req.env?.text ?? '', stop: false, returned: false, state: req.env?.state ?? {}, storyCards: [], logs: [], error: show(err), errorKind: 'crash', ms: 0 }
  }
  send(res)
})

harden()
send({ type: 'ready' })
