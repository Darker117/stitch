// Web search for text models (Skills → Web search) with the phone's own SearXNG: the app carries SearXNG on
// Chaquopy's CPython (native `StitchDevice.web*`), so models can search even when the PC is out of reach.
// Where calls go is a phone-local preference, `WebRoute` (@capacitor/preferences):
//   auto (default) — the PC while the link is up (and this phone if that call can't reach the PC), else this phone
//   phone — always this phone;  pc — always the PC
// `web:setRoute` is answered here and never reaches the PC. Phone answers carry `where: 'phone'`, and every
// `web:status` answered here carries `route`. Nothing loads on the phone until the first start/search.
import { Preferences } from '@capacitor/preferences'
import type { WebPage, WebRoute, WebSearchRequest, WebSearchResult, WebStatus } from '@shared/ipc'
import { errorText } from '@/lib/api'
import { useSettings } from '@/stores/settings'
import { link, useLink } from '@mobile/bridge/connection'
import { emitLocal, override } from '@mobile/bridge/router'
import { StitchDevice, type PhoneWebStatus } from './plugin'
import { useDevice } from './store'

const ROUTE_KEY = 'stitch.web.route'
const ROUTES: readonly WebRoute[] = ['auto', 'phone', 'pc']

let route: WebRoute = 'auto'
let phone: PhoneWebStatus = { where: 'phone', state: 'stopped', version: '' }
let loaded: Promise<void> = Promise.resolve()

const native = (): boolean => useDevice.getState().native

/** Which SearXNG answers right now. */
export function webTarget(): 'phone' | 'pc' {
  if (!native()) return 'pc'
  if (route !== 'auto') return route
  return link.ready ? 'pc' : 'phone'
}

export function webRoute(): WebRoute {
  return route
}

function safeLevel(v: unknown): 0 | 1 | 2 {
  const s = v ?? useSettings.getState().settings?.web?.safeSearch
  return s === 0 || s === 1 || s === 2 ? s : 1
}

/** Why the PC can't take a web call — it isn't reachable, or its Stitch predates web search — as opposed to
 * the PC's SearXNG answering with an error (null). */
function pcUnavailable(err: unknown): 'unreachable' | 'unsupported' | null {
  const msg = errorText(err)
  if (/lost connection to your pc|can't reach your pc|didn't answer|not paired/i.test(msg)) return 'unreachable'
  if (/unknown channel: web:|web:\w+ is only available on the pc/i.test(msg)) return 'unsupported'
  return null
}

/** Call the PC; in `auto`, fall back to this phone when the PC can't take it. */
async function onPc<T>(channel: string, args: unknown[], fallback: () => Promise<T>): Promise<T> {
  try {
    return (await link.call(channel, args)) as T
  } catch (err) {
    if (route === 'auto' && native() && pcUnavailable(err)) return fallback()
    throw err
  }
}

// ─── This phone ──────────────────────────────────────────────────────────────

function phoneStatus(): WebStatus {
  const { state, version, error } = phone
  return { where: 'phone', state, route, ...(version ? { version } : {}), ...(error ? { error } : {}) }
}

async function phoneRefresh(): Promise<WebStatus> {
  try {
    phone = await StitchDevice.webStatus()
  } catch {
    /* keep the last known state */
  }
  return phoneStatus()
}

async function phoneStart(): Promise<WebStatus> {
  phone = await StitchDevice.webStart({ safeSearch: safeLevel(undefined) })
  return phoneStatus()
}

async function phoneStop(): Promise<WebStatus> {
  phone = await StitchDevice.webStop()
  return phoneStatus()
}

async function phoneSearch(req: WebSearchRequest): Promise<WebSearchResult> {
  const limit = req.limit ?? useSettings.getState().settings?.web?.maxResults
  const r = await StitchDevice.webSearch({ req: { ...req, safeSearch: safeLevel(req.safeSearch), ...(limit ? { limit } : {}) } })
  return { ...r, where: 'phone' }
}

async function phonePage(url: string, maxChars?: number): Promise<WebPage> {
  const r = await StitchDevice.webPage({ url, ...(maxChars ? { maxChars } : {}) })
  return { ...r, where: 'phone' }
}

// ─── Routing ─────────────────────────────────────────────────────────────────

async function pcStatus(channel: 'web:status' | 'web:start' | 'web:stop', fallback: () => Promise<WebStatus>): Promise<WebStatus> {
  try {
    return { ...(await onPc<WebStatus>(channel, [], fallback)), route }
  } catch (err) {
    // The status of a PC that can't do web search (route `pc`) is an answer, not a failure.
    const why = channel === 'web:status' ? pcUnavailable(err) : null
    if (why === 'unreachable') return { where: 'pc', state: 'error', error: errorText(err), route }
    if (why === 'unsupported') return { where: 'pc', state: 'missing', error: 'Web search needs a newer Stitch on your PC.', route }
    throw err
  }
}

async function currentStatus(): Promise<WebStatus> {
  return webTarget() === 'phone' ? phoneRefresh() : pcStatus('web:status', phoneRefresh)
}

/** Tell the app which engine it's looking at now (route changed, PC came or went). */
async function announce(): Promise<void> {
  try {
    emitLocal('web:status', await currentStatus())
  } catch {
    /* a PC without web search: nothing to announce */
  }
}

export function installWeb(): void {
  loaded = Preferences.get({ key: ROUTE_KEY })
    .then(({ value }) => {
      if (ROUTES.includes(value as WebRoute)) route = value as WebRoute
    })
    .catch(() => undefined)

  override('web:setRoute', async ([r]) => {
    if (!ROUTES.includes(r as WebRoute)) throw new Error(`Unknown web search route "${String(r)}"`)
    await loaded
    route = r as WebRoute
    await Preferences.set({ key: ROUTE_KEY, value: route }).catch(() => undefined)
    const s = await currentStatus()
    emitLocal('web:status', s)
    return s
  })
  override('web:status', async () => {
    await loaded
    return currentStatus()
  })
  override('web:start', async () => {
    await loaded
    return webTarget() === 'phone' ? phoneStart() : pcStatus('web:start', phoneStart)
  })
  override('web:stop', async () => {
    await loaded
    return webTarget() === 'phone' ? phoneStop() : pcStatus('web:stop', phoneStop)
  })
  override('web:search', async ([r]) => {
    await loaded
    const req = r as WebSearchRequest
    return webTarget() === 'phone' ? phoneSearch(req) : onPc('web:search', [req], () => phoneSearch(req))
  })
  override('web:page', async ([u, m]) => {
    await loaded
    const url = String(u)
    const max = typeof m === 'number' ? m : undefined
    return webTarget() === 'phone' ? phonePage(url, max) : onPc('web:page', max === undefined ? [url] : [url, max], () => phonePage(url, max))
  })

  if (!native()) return
  void StitchDevice.addListener('webStatus', (s) => {
    phone = s
    if (webTarget() === 'phone') emitLocal('web:status', phoneStatus())
  })
  // The PC's own status events pass through untouched (where: 'pc'); while searches go to this phone, follow each
  // one with the phone's status so the app ends up showing the engine that answers.
  link.on('web:status', (s) => {
    if ((s as WebStatus | undefined)?.where === 'pc' && webTarget() === 'phone') queueMicrotask(() => emitLocal('web:status', phoneStatus()))
  })
  useLink.subscribe((s, prev) => {
    if (route === 'auto' && (s.state === 'ready') !== (prev.state === 'ready')) void announce()
  })
}
