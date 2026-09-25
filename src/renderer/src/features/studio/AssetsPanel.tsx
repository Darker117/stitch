// Left column: the asset browser (filters, search, import, drag to timeline,
// live generation tiles) and the list of timelines.
import { memo, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { AnimatePresence, motion } from 'motion/react'
import { AudioLines, ChevronDown, Film, ImageIcon, LayoutGrid, Plus, Upload, X } from 'lucide-react'
import type { Asset, GenJob } from '@shared/types'
import { fileUrl, invoke } from '@/lib/api'
import { cn } from '@/lib/utils'
import { ease, spring } from '@/lib/motion'
import { useCollection } from '@/stores/db'
import { isActive, useGen } from '@/stores/gen'
import { ACCEPT, DropZone, importFiles } from '@/components/media'
import { IconButton } from '@/components/ui/button'
import { SearchField } from '@/components/ui/input'
import { Segmented } from '@/components/ui/controls'
import { ProgressRing } from '@/components/ui/misc'
import { Tooltip } from '@/components/ui/overlay'
import { NewTimelineDialog, TimelineThumb } from './common'
import { endAssetDrag, startAssetDrag, useAssetMap } from './helpers'
import { frameAt, getFrames, useFrames } from './media-cache'
import { appendAsset } from './actions'
import { editor, useEditor } from './store'
import { shortDuration, timelineDuration } from './model'

type Filter = 'all' | 'video' | 'image' | 'audio'

export function AssetsPanel(): React.JSX.Element {
  const assets = useCollection('assets')
  const tlId = useEditor((s) => s.tl?.id)
  const clips = useEditor((s) => s.tl?.clips)
  const used = useMemo(() => new Set((clips ?? []).map((c) => c.assetId)), [clips])
  const sourceId = useEditor((s) => s.sourceId)
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const jobs = useGen((s) => s.jobs)

  const list = useMemo(() => {
    const q = query.trim().toLowerCase()
    return assets.filter((a) => (filter === 'all' || a.kind === filter) && (!q || a.name.toLowerCase().includes(q) || a.prompt?.toLowerCase().includes(q)))
  }, [assets, filter, query])

  const live = useMemo(
    () =>
      Object.values(jobs)
        .filter((j) => isActive(j) && (filter === 'all' || j.kind === filter || (filter === 'audio' && j.kind === 'voice')))
        .sort((a, b) => b.createdAt - a.createdAt),
    [jobs, filter]
  )

  const counts = useMemo(() => {
    const c = { all: assets.length, video: 0, image: 0, audio: 0 }
    for (const a of assets) c[a.kind]++
    return c
  }, [assets])

  const importAny = async (): Promise<void> => {
    const paths = await invoke('sys:pickFiles', { multi: true, title: 'Import media', filters: [{ name: 'Media', extensions: Object.values(ACCEPT).flat() }] })
    if (paths.length) await importFiles(paths)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 px-3">
        <span className="text-[13px] font-semibold tracking-tight">Assets</span>
        <span className="rounded-md bg-white/[0.06] px-1.5 text-[10.5px] font-semibold text-fg-3 tabular-nums">{counts.all}</span>
        <div className="flex-1" />
        <Tooltip content="Import media">
          <IconButton label="Import media" size="sm" onClick={() => void importAny()}>
            <Upload className="size-3.5" />
          </IconButton>
        </Tooltip>
      </div>
      <div className="flex shrink-0 flex-col gap-2 px-3 pb-2.5">
        <Segmented
          size="sm"
          className="w-full [&>button]:flex-1 [&>button]:justify-center"
          value={filter}
          onChange={setFilter}
          items={[
            { value: 'all', label: 'All', icon: <LayoutGrid /> },
            { value: 'video', label: '', icon: <Film /> },
            { value: 'image', label: '', icon: <ImageIcon /> },
            { value: 'audio', label: '', icon: <AudioLines /> }
          ]}
        />
        <SearchField value={query} onChange={setQuery} placeholder="Search assets" className="[&_input]:h-8 [&_input]:text-[12px]" />
      </div>
      <DropZone kinds={['video', 'image', 'audio']} onAssets={() => {}} className="min-h-0 flex-1">
        <div className="scroll-fade h-full overflow-y-auto px-3 pt-1 pb-4">
          {list.length === 0 && live.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-3 py-10 text-center">
              <div className="glass hairline grid size-10 place-items-center rounded-xl text-fg-2">
                <Upload className="size-4" />
              </div>
              <div className="text-[12.5px] font-medium text-fg-2">{query ? 'Nothing matches' : 'No media yet'}</div>
              <div className="text-[11.5px] text-fg-3">Drop files here, import, or generate in Gen Space.</div>
            </div>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(88px,1fr))] gap-2">
              <AnimatePresence initial={false}>
                {live.map((j) => (
                  <JobTile key={j.id} job={j} highlight={j.origin?.type === 'timeline' && j.origin.id === tlId} />
                ))}
              </AnimatePresence>
              {list.map((a, i) => (
                <AssetTile key={a.id} asset={a} index={i} active={a.id === sourceId} used={used.has(a.id)} />
              ))}
            </div>
          )}
        </div>
      </DropZone>
    </div>
  )
}

const AssetTile = memo(function AssetTile({ asset, index, active, used }: { asset: Asset; index: number; active: boolean; used: boolean }): React.JSX.Element {
  const [hover, setHover] = useState(false)
  const [scrub, setScrub] = useState<number | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const frames = useFrames(asset, hover)
  const poster = asset.kind === 'image' ? fileUrl(asset.path) : asset.thumbPath ? fileUrl(asset.thumbPath) : ''
  const hoverUrl = frames && scrub !== null && asset.duration ? frameAt(frames, scrub * asset.duration) : undefined
  return (
    <motion.div
      layout="position"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease, delay: Math.min(index, 16) * 0.018 }}
    >
    <div
      ref={ref}
      draggable
      onDragStart={(e) => startAssetDrag(e, asset)}
      onDragEnd={endAssetDrag}
      onClick={() => editor.setSource(asset.id)}
      onDoubleClick={() => appendAsset(asset)}
      onMouseEnter={() => {
        setHover(true)
        if (asset.kind === 'video') void getFrames(asset, true)
      }}
      onMouseLeave={() => {
        setHover(false)
        setScrub(null)
      }}
      onMouseMove={(e) => {
        if (asset.kind !== 'video') return
        const r = ref.current!.getBoundingClientRect()
        setScrub(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)))
      }}
      className={cn(
        'group relative aspect-video cursor-grab overflow-hidden rounded-[10px] bg-white/[0.04] ring-1 transition-[box-shadow] duration-200 active:cursor-grabbing',
        active ? 'ring-2 ring-accent shadow-[0_0_20px_-6px_var(--accent)]' : 'ring-line hover:ring-line-strong'
      )}
      title={asset.prompt ?? asset.name}
    >
      {asset.kind === 'audio' ? (
        <AudioTileArt asset={asset} />
      ) : poster || hoverUrl ? (
        <img src={hoverUrl ?? poster} alt="" draggable={false} loading="lazy" className="pointer-events-none size-full object-cover" />
      ) : (
        <div className="grid size-full place-items-center text-fg-3">
          <Film className="size-4" />
        </div>
      )}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-black/70 to-transparent" />
      <div className="pointer-events-none absolute right-1 bottom-1 left-1.5 flex items-center gap-1 text-[10px] font-medium text-white/90">
        <span className="[&>svg]:size-2.5">{asset.kind === 'video' ? <Film /> : asset.kind === 'audio' ? <AudioLines /> : <ImageIcon />}</span>
        <span className="min-w-0 flex-1 truncate">{asset.name}</span>
        {asset.duration ? <span className="rounded bg-black/50 px-1 font-mono text-[9.5px]">{shortDuration(asset.duration)}</span> : null}
      </div>
      {used && <span className="pointer-events-none absolute top-1.5 left-1.5 size-1.5 rounded-full bg-accent shadow-[0_0_0_2px_rgb(0_0_0/0.45),0_0_8px_var(--accent)]" title="In this timeline" />}
      {scrub !== null && asset.kind === 'video' && (
        <div className="pointer-events-none absolute inset-y-0 w-px bg-white/80" style={{ left: `${scrub * 100}%` }} />
      )}
      <button
        onClick={(e) => {
          e.stopPropagation()
          appendAsset(asset)
        }}
        className="absolute top-1 right-1 grid size-5.5 place-items-center rounded-md bg-black/55 text-white opacity-0 backdrop-blur transition hover:bg-black/80 group-hover:opacity-100"
        title="Append to timeline"
      >
        <Plus className="size-3" />
      </button>
    </div>
    </motion.div>
  )
})

function AudioTileArt({ asset }: { asset: Asset }): React.JSX.Element {
  const bars = useMemo(() => {
    let h = 0
    for (const ch of asset.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0
    return Array.from({ length: 22 }, (_, i) => 0.2 + Math.abs(Math.sin(i * 0.9 + (h % 97))) * 0.8)
  }, [asset.id])
  return (
    <div className="relative flex size-full items-center justify-center gap-[2px] bg-[color-mix(in_oklab,var(--accent)_10%,#0c0a12)] px-2 pb-3">
      <div className="absolute inset-0 bg-grad-soft opacity-60" />
      {bars.map((b, i) => (
        <span key={i} className="relative w-[3px] rounded-full bg-grad" style={{ height: `${b * 55}%` }} />
      ))}
    </div>
  )
}

function JobTile({ job, highlight }: { job: GenJob; highlight: boolean }): React.JSX.Element {
  const cancel = useGen((s) => s.cancel)
  const p = job.progress ? job.progress.value / Math.max(1, job.progress.max) : undefined
  return (
    <motion.div
      layout
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.9 }}
      transition={spring}
      className={cn('group relative aspect-video overflow-hidden rounded-[10px] bg-black/40 ring-1', highlight ? 'ring-[color-mix(in_oklab,var(--accent)_50%,transparent)]' : 'ring-line')}
      title={String(job.params.prompt ?? job.label ?? '')}
    >
      {job.preview ? <img src={job.preview} alt="" className="size-full object-cover opacity-80 blur-[1px]" /> : <div className="shimmer size-full" />}
      <div className="absolute inset-0 grid place-items-center">
        <div className="flex flex-col items-center gap-1">
          <ProgressRing value={job.status === 'queued' ? undefined : p} size={24} />
          <span className="text-[9.5px] font-semibold tracking-wide text-white/85 uppercase">{job.status === 'queued' ? 'Queued' : p !== undefined ? `${Math.round(p * 100)}%` : 'Working'}</span>
        </div>
      </div>
      <button
        onClick={() => void cancel(job.id)}
        className="absolute top-1 right-1 grid size-5 place-items-center rounded-md bg-black/55 text-white opacity-0 transition group-hover:opacity-100"
        title="Cancel"
      >
        <X className="size-3" />
      </button>
    </motion.div>
  )
}

// ─── Timelines list ──────────────────────────────────────────────────────────

export function TimelinesList(): React.JSX.Element {
  const timelines = useCollection('timelines')
  const current = useEditor((s) => s.tl)
  const assets = useAssetMap()
  const navigate = useNavigate()
  const [open, setOpen] = useState(true)
  const [creating, setCreating] = useState(false)
  // show the live working copy for the open timeline
  const rows = useMemo(() => timelines.map((t) => (current && t.id === current.id ? current : t)), [timelines, current])
  return (
    <div className="flex shrink-0 flex-col border-t border-line">
      <div className="flex h-9 items-center gap-1 px-3">
        <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-1.5 text-[12px] font-semibold text-fg-2 transition hover:text-fg">
          <ChevronDown className={cn('size-3.5 transition-transform duration-300', !open && '-rotate-90')} />
          Timelines
          <span className="text-[10.5px] font-medium text-fg-3 tabular-nums">{timelines.length}</span>
        </button>
        <div className="flex-1" />
        <Tooltip content="New timeline">
          <IconButton label="New timeline" size="xs" onClick={() => setCreating(true)}>
            <Plus className="size-3.5" />
          </IconButton>
        </Tooltip>
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.3, ease }} className="overflow-hidden">
            <div className="flex max-h-[168px] flex-col gap-0.5 overflow-y-auto px-2 pb-2">
              {rows.map((t) => {
                const active = t.id === current?.id
                return (
                  <button
                    key={t.id}
                    onClick={() => !active && navigate(`/studio/${t.id}`)}
                    className={cn('relative flex h-10 shrink-0 items-center gap-2.5 rounded-lg px-1.5 text-left transition-colors', active ? 'text-fg' : 'text-fg-2 hover:bg-white/[0.04] hover:text-fg')}
                  >
                    {active && <motion.span layoutId="tl-active" className="absolute inset-0 rounded-lg border border-line-strong bg-white/[0.07]" transition={spring} />}
                    <span className="relative h-7 w-11 shrink-0 overflow-hidden rounded-md ring-1 ring-line">
                      <TimelineThumb tl={t} assets={assets} small />
                    </span>
                    <span className="relative min-w-0 flex-1">
                      <span className="block truncate text-[12px] font-medium">{t.name}</span>
                      <span className="block text-[10.5px] text-fg-3 tabular-nums">
                        {shortDuration(timelineDuration(t))} · {t.width}×{t.height}
                      </span>
                    </span>
                    {active && <span className="relative mr-1 size-1.5 rounded-full bg-accent shadow-[0_0_8px_var(--accent)]" />}
                  </button>
                )
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <NewTimelineDialog open={creating} onClose={() => setCreating(false)} onCreated={(tl) => navigate(`/studio/${tl.id}`)} projectId={current?.projectId} />
    </div>
  )
}

