// Discover: browse and search the Steam Workshop for Wallpaper Engine, and
// "download" by subscribing in the Steam client on the PC — the card flips to
// Apply as soon as Steam drops the files into the workshop folder.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { AlertTriangle, Check, Download, ExternalLink, Eye, Flame, Loader2, RotateCw, Sparkles, Star, Users, WifiOff } from 'lucide-react'
import type { WorkshopDownload, WorkshopEnvironment, WorkshopItem, WorkshopQuery, WorkshopRating, WorkshopSort, WorkshopType } from '@shared/wallpaper'
import { errorText, invoke, on } from '@/lib/api'
import { isPhone } from '@/lib/platform'
import { cn } from '@/lib/utils'
import { rise, spring, stagger } from '@/lib/motion'
import { Button } from '@/components/ui/button'
import { Segmented } from '@/components/ui/controls'
import { SearchField } from '@/components/ui/input'
import { Dialog, Select } from '@/components/ui/overlay'
import { Badge, EmptyState, Skeleton } from '@/components/ui/misc'
import { toast } from '@/stores/toast'
import { segFull, TYPE_ICON } from './Library'

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })
const STEAM_URL = 'https://store.steampowered.com/about/'
const WE_URL = 'https://store.steampowered.com/app/431960/Wallpaper_Engine/'
const pageUrl = (id: string): string => `https://steamcommunity.com/sharedfiles/filedetails/?id=${id}`

type DownloadState = WorkshopDownload['state']

/** Steam descriptions use BBCode; show them as plain text. */
function plain(text: string | undefined): string {
  return (text ?? '')
    .replace(/\[url=[^\]]*\]([\s\S]*?)\[\/url\]/gi, '$1')
    .replace(/\[\/?[a-z*0-9]+(?:=[^\]]*)?\]/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

interface Props {
  current?: string
  applying?: string
  onApply: (id: string) => void
}

export function WallpaperDiscover({ current, applying, onApply }: Props): React.JSX.Element {
  const [env, setEnv] = useState<WorkshopEnvironment | null>(null)
  const [text, setText] = useState('')
  const [sort, setSort] = useState<WorkshopSort>('trend')
  const [type, setType] = useState<WorkshopType>('all')
  const [rating, setRating] = useState<WorkshopRating>('everyone')
  const [items, setItems] = useState<WorkshopItem[]>([])
  const [page, setPage] = useState(0)
  const [totalPages, setTotalPages] = useState(1)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [downloads, setDownloads] = useState<Record<string, DownloadState>>({})
  const [detail, setDetail] = useState<WorkshopItem | null>(null)
  const query = useDebounced(text.trim(), 400)
  const request = useRef(0)
  const scroller = useRef<HTMLDivElement>(null)
  const sentinel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void invoke('wallpaper:environment').then((e) => {
      setEnv(e)
      setDownloads(Object.fromEntries(e.downloads.map((d) => [d.id, d.state])))
    })
    return on('wallpaper:download', (d) => {
      setDownloads((m) => ({ ...m, [d.id]: d.state }))
      if (d.state === 'ready') {
        setItems((list) => list.map((i) => (i.id === d.id ? { ...i, installed: true } : i)))
        toast.success('Downloaded', d.title ? `${d.title} is ready to apply.` : 'Ready to apply.')
      }
    })
  }, [])

  // Searching switches to relevance; clearing the search goes back to trending.
  useEffect(() => {
    if (query && sort === 'trend') setSort('relevance')
    if (!query && sort === 'relevance') setSort('trend')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])

  const load = useCallback(
    async (nextPage: number) => {
      const id = ++request.current
      setLoading(true)
      setError(null)
      try {
        const q: WorkshopQuery = { text: query || undefined, sort: query ? sort : sort === 'relevance' ? 'trend' : sort, type, rating, page: nextPage }
        const res = await invoke('wallpaper:search', q)
        if (id !== request.current) return
        setItems((list) => {
          if (nextPage === 1) return res.items
          const seen = new Set(list.map((i) => i.id))
          return [...list, ...res.items.filter((i) => !seen.has(i.id))]
        })
        setPage(res.page)
        setTotalPages(res.totalPages)
      } catch (err) {
        if (id === request.current) setError(errorText(err))
      } finally {
        if (id === request.current) setLoading(false)
      }
    },
    [query, sort, type, rating]
  )

  useEffect(() => {
    setItems([])
    setPage(0)
    scroller.current?.scrollTo({ top: 0 })
    void load(1)
  }, [load])

  // Infinite scroll.
  useEffect(() => {
    const el = sentinel.current
    if (!el) return
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && !loading && !error && page > 0 && page < totalPages) void load(page + 1)
    }, { root: scroller.current, rootMargin: '400px' })
    io.observe(el)
    return () => io.disconnect()
  }, [load, loading, error, page, totalPages])

  const get = useCallback(
    async (item: WorkshopItem) => {
      if (env && !env.steam) {
        toast.error("Steam isn't installed", 'Workshop wallpapers download through Steam. Install Steam and Wallpaper Engine first.')
        return
      }
      try {
        setDownloads((m) => ({ ...m, [item.id]: 'waiting' }))
        const r = await invoke('wallpaper:subscribe', item.id)
        setDownloads((m) => ({ ...m, [item.id]: r.state }))
        if (r.state === 'ready') setItems((list) => list.map((i) => (i.id === item.id ? { ...i, installed: true } : i)))
        else toast.info(isPhone ? 'Opened in Steam on your PC' : 'Opened in Steam', 'Press Subscribe on the item page — it appears here as soon as Steam downloads it.')
      } catch (err) {
        setDownloads((m) => {
          const next = { ...m }
          delete next[item.id]
          return next
        })
        toast.error('Could not open Steam', errorText(err))
      }
    },
    [env]
  )

  const sorts = useMemo(
    () => [
      ...(query ? [{ value: 'relevance' as const, label: 'Relevant', icon: <Sparkles /> }] : []),
      { value: 'trend' as const, label: 'Trending', icon: <Flame /> },
      { value: 'popular' as const, label: 'Popular', icon: <Star /> },
      { value: 'recent' as const, label: 'Newest' }
    ],
    [query]
  )

  if (env && !env.steam) {
    return (
      <EmptyState
        icon={<Download />}
        title="Steam isn't installed"
        body="Workshop wallpapers are downloaded by Steam for Wallpaper Engine owners. Install Steam and Wallpaper Engine on this PC to get them."
        action={
          <Button size="sm" icon={<ExternalLink className="size-3.5" />} onClick={() => void invoke('sys:openExternal', STEAM_URL)}>
            Get Steam
          </Button>
        }
      />
    )
  }

  return (
    <div>
      {env && !env.wallpaperEngine && (
        <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} className="mb-3 flex items-center gap-3 rounded-xl border border-warning/25 bg-warning/[0.07] px-3 py-2.5 text-[12px] max-md:flex-col max-md:items-start">
          <AlertTriangle className="size-4 shrink-0 text-warning" />
          <span className="flex-1 text-fg-2">Wallpaper Engine isn't installed. You can browse, but downloads need it (it's a paid app on Steam).</span>
          <Button size="xs" variant="ghost" iconRight={<ExternalLink className="size-3" />} onClick={() => void invoke('sys:openExternal', WE_URL)}>
            Get it on Steam
          </Button>
        </motion.div>
      )}
      <div className="mb-3 flex flex-wrap items-center gap-2.5 max-md:flex-col max-md:items-stretch max-md:gap-2">
        <SearchField value={text} onChange={setText} placeholder="Search the workshop" className="w-[240px] max-md:w-full" />
        <Segmented size="sm" className={segFull} value={sort} onChange={setSort} items={sorts} />
      </div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2.5 max-md:flex-col max-md:items-stretch max-md:gap-2">
        <Segmented
          size="sm"
          className={segFull}
          value={type}
          onChange={setType}
          items={[
            { value: 'all', label: 'All' },
            { value: 'scene', label: 'Scene' },
            { value: 'video', label: 'Video' },
            { value: 'web', label: 'Web' }
          ]}
        />
        <Select
          size="sm"
          className="w-[210px] max-md:w-full"
          value={rating}
          onChange={(v) => setRating(v as WorkshopRating)}
          triggerIcon={<Eye />}
          align="end"
          options={[
            { value: 'everyone', label: 'Everyone', hint: 'Hides Questionable and Mature' },
            { value: 'questionable', label: 'Include Questionable', hint: 'Still hides Mature' },
            { value: 'all', label: 'All ratings', hint: 'Mature previews stay blurred' }
          ]}
        />
      </div>

      <div ref={scroller} className="max-h-[520px] overflow-y-auto pr-1 max-md:max-h-[58vh] max-md:pr-0">
        {error && !items.length ? (
          <EmptyState
            icon={<WifiOff />}
            title="Couldn't reach the workshop"
            body={error}
            action={
              <Button size="sm" icon={<RotateCw className="size-3.5" />} onClick={() => void load(1)}>
                Try again
              </Button>
            }
          />
        ) : !loading && page > 0 && !items.length ? (
          <EmptyState icon={<Sparkles />} title="Nothing found" body="Try another search, type or rating." />
        ) : (
          <motion.div key={`${query}|${sort}|${type}|${rating}`} variants={stagger(0.025)} initial="initial" animate="animate" className="grid grid-cols-3 gap-3 max-md:grid-cols-2 max-md:gap-2">
            {items.map((item) => (
              <WorkshopCard key={item.id} item={item} state={item.installed ? 'ready' : downloads[item.id]} active={current === item.id} applying={applying === item.id} onOpen={() => setDetail(item)} onGet={() => void get(item)} onApply={() => onApply(item.id)} />
            ))}
            {loading && Array.from({ length: items.length ? 3 : 9 }).map((_, i) => <Skeleton key={`s${i}`} className="aspect-[4/3] rounded-xl" />)}
          </motion.div>
        )}
        <div ref={sentinel} className="h-px" />
        {error && items.length > 0 && (
          <div className="py-3 text-center">
            <Button size="sm" variant="ghost" icon={<RotateCw className="size-3.5" />} onClick={() => void load(page + 1)}>
              Load more
            </Button>
          </div>
        )}
      </div>
      <p className="mt-2 text-[11.5px] text-fg-3">From the Steam Workshop for Wallpaper Engine. Downloads go through your Steam account on this PC — Stitch never signs in to Steam.</p>

      <WorkshopDetail item={detail} state={detail ? (detail.installed || items.find((i) => i.id === detail.id)?.installed ? 'ready' : downloads[detail.id]) : undefined} active={current === detail?.id} onClose={() => setDetail(null)} onGet={() => detail && void get(detail)} onApply={() => detail && onApply(detail.id)} />
    </div>
  )
}

function StateButton({ state, active, applying, onGet, onApply, size = 'xs' }: { state?: DownloadState; active: boolean; applying: boolean; onGet: () => void; onApply: () => void; size?: 'xs' | 'sm' | 'md' }): React.JSX.Element {
  const content =
    state === 'ready' ? (
      active ? (
        <Button key="applied" size={size} variant="accent" icon={<Check className="size-3" strokeWidth={3} />} onClick={onApply}>
          Applied
        </Button>
      ) : (
        <Button key="apply" size={size} variant="primary" loading={applying} icon={<Sparkles className="size-3" />} onClick={onApply}>
          {size === 'xs' ? 'Apply' : 'Downloaded — Apply'}
        </Button>
      )
    ) : state === 'waiting' || state === 'downloading' ? (
      <span key="wait" className={cn('inline-flex items-center gap-1.5 rounded-md bg-black/65 font-medium text-white backdrop-blur', size === 'xs' ? 'h-6 px-2 text-[11px]' : 'h-7.5 px-2.5 text-[12px]')}>
        <Loader2 className="size-3 animate-spin" />
        {state === 'downloading' ? 'Downloading…' : 'Waiting for Steam'}
      </span>
    ) : (
      <Button key="get" size={size} variant="glass" icon={<Download className="size-3" />} onClick={onGet}>
        {size === 'xs' ? 'Get' : 'Get in Steam'}
      </Button>
    )
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.span key={`${state}|${active}`} initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }} transition={spring} className="inline-flex">
        {content}
      </motion.span>
    </AnimatePresence>
  )
}

function WorkshopCard({ item, state, active, applying, onOpen, onGet, onApply }: { item: WorkshopItem; state?: DownloadState; active: boolean; applying: boolean; onOpen: () => void; onGet: () => void; onApply: () => void }): React.JSX.Element {
  const mature = item.rating === 'Mature'
  return (
    <motion.div variants={rise} whileHover={{ y: -2 }} transition={spring} className={cn('group relative overflow-hidden rounded-xl bg-white/[0.04] ring-1 transition-shadow', active ? 'ring-2 ring-accent' : 'ring-line hover:ring-line-strong')}>
      <button onClick={onOpen} className="block w-full text-left">
        <div className="relative aspect-[4/3] overflow-hidden bg-black/40">
          <img src={item.thumb ?? item.preview} loading="lazy" decoding="async" alt="" className={cn('absolute inset-0 size-full object-cover transition-transform duration-700 group-hover:scale-105', mature && 'scale-110 blur-xl')} />
          <div className="absolute top-1.5 left-1.5 flex gap-1">
            {item.type && (
              <Badge className="bg-black/50 text-white/85 backdrop-blur">
                {TYPE_ICON[item.type]} {item.type}
              </Badge>
            )}
            {item.rating !== 'Everyone' && <Badge className={cn('backdrop-blur', mature ? 'bg-danger/70 text-white' : 'bg-warning/70 text-black')}>{item.rating}</Badge>}
          </div>
        </div>
        <div className="px-2.5 pt-2 pb-2.5">
          <div className="truncate text-[12px] font-semibold text-fg">{item.title}</div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-fg-3">
            <span className="min-w-0 truncate">{item.author ?? 'Workshop'}</span>
            <span className="ml-auto flex shrink-0 items-center gap-1 tabular-nums">
              <Users className="size-3" />
              {compact.format(item.subscriptions)}
            </span>
          </div>
        </div>
      </button>
      <div className={cn('absolute top-1.5 right-1.5 transition-opacity duration-200', state ? 'opacity-100' : 'opacity-100 md:opacity-0 md:group-hover:opacity-100')}>
        <StateButton state={state} active={active} applying={applying} onGet={onGet} onApply={onApply} />
      </div>
    </motion.div>
  )
}

function WorkshopDetail({ item, state, active, onClose, onGet, onApply }: { item: WorkshopItem | null; state?: DownloadState; active: boolean; onClose: () => void; onGet: () => void; onApply: () => void }): React.JSX.Element {
  const [full, setFull] = useState<WorkshopItem | null>(null)
  useEffect(() => {
    setFull(null)
    if (!item) return
    let alive = true
    void invoke('wallpaper:details', item.id)
      .then((d) => alive && setFull(d))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [item])
  const shown = full ?? item
  const description = plain(full?.description)
  return (
    <Dialog open={!!item} onOpenChange={(o) => !o && onClose()} title={shown?.title} description={shown ? `${shown.author ?? 'Workshop'} · ${compact.format(shown.subscriptions)} subscribers` : undefined} width={620}>
      {shown && (
        <div className="space-y-3">
          <div className="relative overflow-hidden rounded-xl bg-black/40 ring-1 ring-line">
            <img src={shown.preview} alt="" className="mx-auto max-h-[340px] w-full object-contain" />
          </div>
          <div className="flex flex-wrap gap-1.5">
            {shown.type && (
              <Badge>
                {TYPE_ICON[shown.type]} {shown.type}
              </Badge>
            )}
            <Badge tone={shown.rating === 'Everyone' ? 'default' : 'warning'}>{shown.rating}</Badge>
            {shown.tags.slice(0, 8).map((t) => (
              <Badge key={t} tone="outline">
                {t}
              </Badge>
            ))}
            {shown.fileSize ? <Badge tone="outline">{(shown.fileSize / 1048576).toFixed(shown.fileSize > 1048576 * 100 ? 0 : 1)} MB</Badge> : null}
          </div>
          {description && <p className="max-h-[140px] overflow-y-auto text-[12.5px] leading-relaxed whitespace-pre-line text-fg-2">{description}</p>}
          <div className="flex items-center justify-between gap-2 pt-1 max-md:flex-col-reverse max-md:items-stretch">
            <Button size="sm" variant="ghost" icon={<ExternalLink className="size-3.5" />} onClick={() => void invoke('sys:openExternal', pageUrl(shown.id))}>
              View on Steam
            </Button>
            <StateButton state={state} active={active} applying={false} onGet={onGet} onApply={onApply} size="sm" />
          </div>
        </div>
      )}
    </Dialog>
  )
}

