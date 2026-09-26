// Steam Workshop for Wallpaper Engine (appid 431960), without a Web API key
// or any Steam login:
//   • browse/search — the public workshop browse page, which embeds its
//     results (items + author names) as JSON; older markup falls back to
//     scraping item ids and asking GetPublishedFileDetails.
//   • details — ISteamRemoteStorage/GetPublishedFileDetails (keyless POST),
//     author names from the public profile XML.
//   • "download" — Steam is the only legitimate way to get workshop content:
//     open the item in the Steam client so the user can subscribe, then watch
//     the workshop folder until it lands.
import { app, shell } from 'electron'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import type { WorkshopDownload, WorkshopEnvironment, WorkshopItem, WorkshopPage, WorkshopQuery } from '@shared/wallpaper'
import { emit } from '../../ipc'

export const APP_ID = 431960
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36'

// ─── Steam / Wallpaper Engine on this PC ─────────────────────────────────────

interface SteamInfo {
  steamDir?: string
  libraries: string[]
  /** steamapps/common/wallpaper_engine */
  weDir?: string
  /** steamapps/workshop/content/431960 (may not exist until the first subscription) */
  workshopDir?: string
  /** steamapps/workshop/downloads/431960 (in-progress downloads) */
  downloadsDir?: string
  at: number
}

let steamCache: SteamInfo | null = null

function registrySteamPath(): string | undefined {
  if (process.platform !== 'win32') return undefined
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], { encoding: 'utf8', timeout: 3000, windowsHide: true })
    const m = /SteamPath\s+REG_SZ\s+(.+)/.exec(out)
    return m ? m[1].trim().replace(/\//g, '\\') : undefined
  } catch {
    return undefined
  }
}

export function steamInfo(): SteamInfo {
  if (steamCache && Date.now() - steamCache.at < 30_000) return steamCache
  // Dev test runs can point at a stand-in Steam folder (never touches the real one).
  const override = !app.isPackaged ? process.env.STITCH_STEAM_DIR : undefined
  const candidates = (override ? [override] : [registrySteamPath(), 'C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam']).filter((p): p is string => !!p)
  const steamDir = candidates.find((d) => existsSync(join(d, 'steam.exe')) || existsSync(join(d, 'steamapps')))
  const libraries = new Set<string>()
  if (steamDir) {
    libraries.add(steamDir)
    const vdf = join(steamDir, 'steamapps', 'libraryfolders.vdf')
    if (existsSync(vdf)) {
      try {
        for (const m of readFileSync(vdf, 'utf8').matchAll(/"path"\s+"([^"]+)"/g)) libraries.add(m[1].replace(/\\\\/g, '\\'))
      } catch {
        /* unreadable */
      }
    }
  }
  const info: SteamInfo = { steamDir, libraries: [...libraries], at: Date.now() }
  for (const lib of info.libraries) {
    const we = join(lib, 'steamapps', 'common', 'wallpaper_engine')
    const manifest = join(lib, 'steamapps', `appmanifest_${APP_ID}.acf`)
    const content = join(lib, 'steamapps', 'workshop', 'content', String(APP_ID))
    if (existsSync(we) || existsSync(manifest) || existsSync(content)) {
      info.weDir = existsSync(we) ? we : undefined
      info.workshopDir = content
      info.downloadsDir = join(lib, 'steamapps', 'workshop', 'downloads', String(APP_ID))
      break
    }
  }
  steamCache = info
  return info
}

/** Wallpaper Engine's shared asset folder (materials, effects, shaders). */
export function weAssetsDir(): string | undefined {
  const we = steamInfo().weDir
  const assets = we ? join(we, 'assets') : undefined
  return assets && existsSync(assets) ? assets : undefined
}

export function environment(): WorkshopEnvironment {
  const s = steamInfo()
  return {
    steam: !!s.steamDir,
    wallpaperEngine: !!s.weDir && (existsSync(join(s.weDir, 'wallpaper64.exe')) || existsSync(join(s.weDir, 'wallpaper32.exe')) || existsSync(join(s.weDir, 'assets'))),
    workshopDir: s.workshopDir
  }
}

function installed(id: string): boolean {
  const dir = steamInfo().workshopDir
  return !!dir && existsSync(join(dir, id, 'project.json'))
}

// ─── Browse / search ─────────────────────────────────────────────────────────

interface RawItem {
  publishedfileid: string
  title?: string
  preview_url?: string
  creator?: string
  subscriptions?: number
  favorited?: number
  tags?: { tag: string }[]
  file_size?: string | number
  time_updated?: number
  description?: string
  short_description?: string
}

const RATINGS = ['Everyone', 'Questionable', 'Mature']

function thumbOf(preview: string): string | undefined {
  // Steam's image CDN resizes stills (animated GIFs come back as they are).
  if (!/^https:\/\/images\.steamusercontent\.com\//.test(preview)) return undefined
  return `${preview}${preview.includes('?') ? '&' : '?'}imw=640&imh=640&ima=fit&impolicy=Letterbox&imcolor=%23000000&letterbox=false`
}

function toItem(r: RawItem, authors: Map<string, string>): WorkshopItem {
  const tags = (r.tags ?? []).map((t) => t.tag).filter(Boolean)
  const lower = tags.map((t) => t.toLowerCase())
  const type = lower.includes('scene') ? 'scene' : lower.includes('video') ? 'video' : lower.includes('web') ? 'web' : lower.includes('application') ? 'application' : undefined
  const preview = r.preview_url ?? ''
  return {
    id: String(r.publishedfileid),
    title: (r.title ?? '').trim() || `Wallpaper ${r.publishedfileid}`,
    preview,
    thumb: thumbOf(preview),
    author: r.creator ? authors.get(r.creator) : undefined,
    authorId: r.creator,
    subscriptions: Number(r.subscriptions) || 0,
    favorited: Number(r.favorited) || undefined,
    type,
    rating: tags.find((t) => RATINGS.includes(t)) ?? 'Everyone',
    tags: tags.filter((t) => !RATINGS.includes(t) && !/^\d+ x \d+$/.test(t) && t !== 'Wallpaper'),
    fileSize: Number(r.file_size) || undefined,
    updated: Number(r.time_updated) || undefined,
    description: r.description,
    installed: installed(String(r.publishedfileid))
  }
}

async function fetchText(url: string, init?: RequestInit): Promise<string> {
  const res = await fetch(url, {
    ...init,
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(20_000)
  })
  if (!res.ok) throw new Error(`Steam answered ${res.status}`)
  return await res.text()
}

/** The JSON the browse page renders from (`window.SSR.renderContext`). */
function ssrQueries(html: string): { queryKey: unknown[]; state: { data: unknown } }[] | null {
  const marker = 'window.SSR.renderContext=JSON.parse('
  const at = html.indexOf(marker)
  if (at < 0) return null
  const start = at + marker.length
  if (html[start] !== '"') return null
  let i = start + 1
  while (i < html.length && html[i] !== '"') i += html[i] === '\\' ? 2 : 1
  try {
    const ctx = JSON.parse(JSON.parse(html.slice(start, i + 1)) as string) as { queryData?: string }
    const qd = JSON.parse(ctx.queryData ?? '{}') as { queries?: { queryKey: unknown[]; state: { data: unknown } }[] }
    return qd.queries ?? null
  } catch {
    return null
  }
}

const SORT: Record<WorkshopQuery['sort'], string> = { relevance: 'textsearch', trend: 'trend', popular: 'totaluniquesubscribers', recent: 'mostrecent' }
const TYPE_TAG: Record<string, string> = { scene: 'Scene', video: 'Video', web: 'Web' }
const PER_PAGE = 30

const searchCache = new Map<string, { at: number; page: WorkshopPage }>()
const SEARCH_TTL = 10 * 60_000

export async function search(q: WorkshopQuery): Promise<WorkshopPage> {
  const text = (q.text ?? '').trim().slice(0, 200)
  const sort = q.sort === 'relevance' && !text ? 'trend' : q.sort
  const page = Math.max(1, Math.min(1000, Math.floor(q.page) || 1))
  const params = new URLSearchParams({ appid: String(APP_ID), section: 'readytouseitems', browsesort: SORT[sort], actualsort: SORT[sort], p: String(page), numperpage: String(PER_PAGE) })
  if (sort === 'trend') params.set('days', '7')
  if (text) params.set('searchtext', text)
  if (TYPE_TAG[q.type]) params.append('requiredtags[]', TYPE_TAG[q.type])
  if (q.rating !== 'all') params.append('excludedtags[]', 'Mature')
  if (q.rating === 'everyone') params.append('excludedtags[]', 'Questionable')
  const url = `https://steamcommunity.com/workshop/browse/?${params}`

  const hit = searchCache.get(url)
  if (hit && Date.now() - hit.at < SEARCH_TTL) return refreshInstalled(hit.page)

  const html = await fetchText(url)
  let result: WorkshopPage | null = null
  const queries = ssrQueries(html)
  if (queries) {
    const browse = queries.find((x) => Array.isArray(x.queryKey) && x.queryKey[0] === 'workshop_browse')?.state.data as
      | { results?: RawItem[]; current_page?: number; total_pages?: number; total_count?: number }
      | undefined
    if (browse?.results) {
      const authors = new Map<string, string>()
      for (const x of queries) {
        if (x.queryKey[0] !== 'PlayerLinkDetails') continue
        const d = x.state.data as { public_data?: { persona_name?: string } } | null
        if (d?.public_data?.persona_name) authors.set(String(x.queryKey[1]), d.public_data.persona_name)
      }
      for (const [id, name] of authors) authorCache.set(id, name)
      result = {
        items: browse.results.map((r) => toItem(r, authors)),
        page: browse.current_page ?? page,
        totalPages: browse.total_pages ?? page,
        total: browse.total_count ?? browse.results.length
      }
    }
  }
  if (!result) {
    // Older markup: scrape item ids in page order, then look them up.
    const ids = [...new Set([...html.matchAll(/sharedfiles\/filedetails\/\?id=(\d+)/g)].map((m) => m[1]))].slice(0, PER_PAGE)
    const items = ids.length ? await details(ids) : []
    const total = Number(/of\s+([\d,]+)\s+entries/i.exec(html)?.[1]?.replace(/,/g, '')) || items.length
    result = { items, page, totalPages: Math.max(page, Math.ceil(total / PER_PAGE)), total }
  }
  searchCache.set(url, { at: Date.now(), page: result })
  if (searchCache.size > 60) searchCache.delete(searchCache.keys().next().value!)
  return result
}

function refreshInstalled(p: WorkshopPage): WorkshopPage {
  return { ...p, items: p.items.map((i) => ({ ...i, installed: installed(i.id) })) }
}

// ─── Details ─────────────────────────────────────────────────────────────────

const authorCache = new Map<string, string>()

async function authorName(steamId: string): Promise<string | undefined> {
  if (authorCache.has(steamId)) return authorCache.get(steamId)
  try {
    const xml = await fetchText(`https://steamcommunity.com/profiles/${encodeURIComponent(steamId)}/?xml=1`)
    const name = /<steamID><!\[CDATA\[([\s\S]*?)\]\]><\/steamID>/.exec(xml)?.[1]?.trim()
    if (name) authorCache.set(steamId, name)
    return name
  } catch {
    return undefined
  }
}

export async function details(ids: string[]): Promise<WorkshopItem[]> {
  const clean = ids.filter((id) => /^\d{1,20}$/.test(id)).slice(0, 100)
  if (!clean.length) return []
  const body = new URLSearchParams({ itemcount: String(clean.length) })
  clean.forEach((id, i) => body.set(`publishedfileids[${i}]`, id))
  const text = await fetchText('https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  })
  const json = JSON.parse(text) as { response?: { publishedfiledetails?: (RawItem & { result?: number })[] } }
  const raw = (json.response?.publishedfiledetails ?? []).filter((r) => r.result === 1)
  const creators = [...new Set(raw.map((r) => r.creator).filter((c): c is string => !!c))]
  await Promise.all(creators.slice(0, 30).map((c) => authorName(c)))
  const authors = new Map(creators.map((c) => [c, authorCache.get(c) ?? ''] as const).filter(([, n]) => n))
  const byId = new Map(raw.map((r) => [String(r.publishedfileid), toItem(r, authors)]))
  return clean.map((id) => byId.get(id)).filter((x): x is WorkshopItem => !!x)
}

// ─── Subscribe through Steam, then watch for the download ────────────────────

const pending = new Map<string, WorkshopDownload & { since: number }>()
let watchers: FSWatcher[] = []
let poller: ReturnType<typeof setInterval> | null = null

export function itemPageUrl(id: string): string {
  return `https://steamcommunity.com/sharedfiles/filedetails/?id=${id}`
}

/** Open the item in the Steam client (where the user subscribes) and wait for it to land. */
export async function subscribe(id: string): Promise<WorkshopDownload> {
  if (!/^\d{1,20}$/.test(id)) throw new Error('Not a workshop item')
  if (installed(id)) return { id, state: 'ready', title: titleOf(id) }
  const env = environment()
  if (!env.steam) throw new Error("Steam isn't installed on this PC. Install Steam and Wallpaper Engine to download workshop wallpapers.")
  const url = `steam://openurl/${itemPageUrl(id)}`
  // Dev test runs can exercise everything except actually opening Steam.
  const dryRun = !app.isPackaged && process.env.STITCH_WORKSHOP_DRYRUN === '1'
  if (dryRun) console.log('[workshop] dry run, would open', url)
  else await shell.openExternal(url)
  const state: WorkshopDownload & { since: number } = { id, state: 'waiting', since: Date.now() }
  pending.set(id, state)
  emit('wallpaper:download', { id, state: 'waiting' })
  ensureWatching()
  return { id, state: 'waiting' }
}

export function downloads(): WorkshopDownload[] {
  return [...pending.values()].map(({ id, state, title }) => ({ id, state, title }))
}

function titleOf(id: string): string | undefined {
  const dir = steamInfo().workshopDir
  if (!dir) return undefined
  try {
    const j = JSON.parse(readFileSync(join(dir, id, 'project.json'), 'utf8').replace(/^\uFEFF/, '')) as { title?: string }
    return j.title?.trim() || undefined
  } catch {
    return undefined
  }
}

function check(): void {
  const s = steamInfo()
  for (const p of [...pending.values()]) {
    if (installed(p.id)) {
      // Steam moves the folder in once it's complete; give it a beat to finish writing.
      pending.delete(p.id)
      emit('wallpaper:download', { id: p.id, state: 'ready', title: titleOf(p.id) })
      continue
    }
    const downloading = !!s.downloadsDir && existsSync(join(s.downloadsDir, p.id))
    if (downloading && p.state !== 'downloading') {
      p.state = 'downloading'
      emit('wallpaper:download', { id: p.id, state: 'downloading' })
    }
    // Give up quietly after two hours.
    if (Date.now() - p.since > 2 * 3600_000) pending.delete(p.id)
  }
  if (!pending.size) stopWatching()
}

function ensureWatching(): void {
  if (poller) return
  const s = steamInfo()
  for (const dir of [s.workshopDir, s.downloadsDir]) {
    if (!dir || !existsSync(dir)) continue
    try {
      const w = watch(dir, { persistent: false }, () => setTimeout(check, 400))
      w.on('error', () => {})
      watchers.push(w)
    } catch {
      /* polling covers it */
    }
  }
  // Folders that don't exist yet (first ever subscription) and missed events: poll too.
  poller = setInterval(check, 2500)
}

function stopWatching(): void {
  for (const w of watchers) w.close()
  watchers = []
  if (poller) clearInterval(poller)
  poller = null
}

