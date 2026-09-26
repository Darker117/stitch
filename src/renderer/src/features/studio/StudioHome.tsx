// Studio landing: every timeline as a poster card, plus “New timeline”.
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { AnimatePresence, motion } from 'motion/react'
import { AudioLines, Clapperboard, Copy, Film, MoreHorizontal, Pencil, Play, Plus, Trash2, Type } from 'lucide-react'
import type { Asset, ID, Timeline } from '@shared/types'
import { cn, timeAgo } from '@/lib/utils'
import { ease, rise, spring, stagger } from '@/lib/motion'
import { db, useCollection, useCollectionLoaded } from '@/stores/db'
import { Page, PageHeader } from '@/components/shell/page'
import { Button } from '@/components/ui/button'
import { SearchField } from '@/components/ui/input'
import { Menu, MenuItem, MenuSeparator } from '@/components/ui/overlay'
import { Badge, Skeleton } from '@/components/ui/misc'
import { AspectGlyph, ConfirmDialog, NewTimelineDialog, RenameDialog, TimelineThumb } from './common'
import { posterUrl, useAssetMap } from './helpers'
import { duplicateTimeline, presetFor, shortDuration, timelineDuration } from './model'

export function StudioHome(): React.JSX.Element {
  const timelines = useCollection('timelines')
  const loaded = useCollectionLoaded('timelines')
  const assets = useAssetMap()
  const navigate = useNavigate()
  const [creating, setCreating] = useState(false)
  const [query, setQuery] = useState('')
  const [renaming, setRenaming] = useState<Timeline | null>(null)
  const [deleting, setDeleting] = useState<Timeline | null>(null)

  const list = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? timelines.filter((t) => t.name.toLowerCase().includes(q)) : timelines
  }, [timelines, query])

  return (
    <Page>
      <PageHeader
        icon={<Clapperboard />}
        title="Studio"
        subtitle="Cut your generated shots, music and voice lines into finished videos."
        inline={timelines.length <= 3}
        actions={
          <>
            {timelines.length > 3 && <SearchField value={query} onChange={setQuery} placeholder="Search timelines" className="w-56 max-md:w-auto max-md:min-w-0 max-md:flex-1" />}
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)} className="max-md:h-10 max-md:rounded-xl max-md:px-4">
              <span className="max-md:hidden">New timeline</span>
              <span className="md:hidden">New</span>
            </Button>
          </>
        }
      />

      {!loaded ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4 px-8 pb-10 max-md:grid-cols-1 max-md:gap-3 max-md:px-4 max-md:pb-6">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="aspect-[16/12] rounded-2xl" />
          ))}
        </div>
      ) : timelines.length === 0 ? (
        <EmptyStudio onCreate={() => setCreating(true)} />
      ) : (
        <motion.div variants={stagger(0.045, 0.05)} initial="initial" animate="animate" className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4 px-8 pb-10 max-md:grid-cols-1 max-md:gap-3 max-md:px-4 max-md:pb-6">
          <motion.button
            variants={rise}
            whileHover={{ y: -2 }}
            whileTap={{ scale: 0.985 }}
            transition={spring}
            onClick={() => setCreating(true)}
            className="group relative flex min-h-[220px] flex-col items-center justify-center gap-3 overflow-hidden rounded-2xl border border-dashed max-md:hidden border-line-strong bg-white/[0.015] text-fg-3 transition-colors duration-300 hover:border-[color-mix(in_oklab,var(--accent)_45%,transparent)] hover:text-fg"
          >
            <div className="absolute inset-0 bg-grad-soft opacity-0 transition-opacity duration-500 group-hover:opacity-100" />
            <span className="relative grid size-12 place-items-center rounded-2xl bg-grad text-white shadow-[0_10px_30px_-10px_color-mix(in_oklab,var(--accent)_80%,transparent)] transition-transform duration-500 ease-[var(--ease-out)] group-hover:scale-110 group-hover:rotate-90">
              <Plus className="size-5" />
            </span>
            <span className="relative text-[13px] font-semibold">New timeline</span>
            <span className="relative -mt-2 text-[11.5px]">Landscape, vertical or square</span>
          </motion.button>
          <AnimatePresence mode="popLayout">
            {list.map((tl) => (
              <TimelineCard
                key={tl.id}
                tl={tl}
                assets={assets}
                onOpen={() => navigate(`/studio/${tl.id}`)}
                onRename={() => setRenaming(tl)}
                onDuplicate={() => void db.put('timelines', duplicateTimeline(tl))}
                onDelete={() => setDeleting(tl)}
              />
            ))}
          </AnimatePresence>
        </motion.div>
      )}

      <NewTimelineDialog open={creating} onClose={() => setCreating(false)} onCreated={(tl) => navigate(`/studio/${tl.id}`)} />
      <RenameDialog
        open={!!renaming}
        initial={renaming?.name ?? ''}
        onClose={() => setRenaming(null)}
        onSave={(name) => renaming && void db.update('timelines', renaming.id, (t) => ({ ...t, name, updatedAt: Date.now() }))}
      />
      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title={`Delete “${deleting?.name ?? ''}”?`}
        body="The timeline is removed. Media in your library and past exports stay where they are."
        onConfirm={() => deleting && void db.remove('timelines', deleting.id)}
      />
    </Page>
  )
}

function TimelineCard({
  tl,
  assets,
  onOpen,
  onRename,
  onDuplicate,
  onDelete
}: {
  tl: Timeline
  assets: Map<ID, Asset>
  onOpen: () => void
  onRename: () => void
  onDuplicate: () => void
  onDelete: () => void
}): React.JSX.Element {
  const duration = timelineDuration(tl)
  const preset = presetFor(tl.width, tl.height)
  const counts = useMemo(() => {
    let video = 0
    let audio = 0
    let text = 0
    for (const c of tl.clips) {
      if (c.text) text++
      else if (assets.get(c.assetId)?.kind === 'audio') audio++
      else video++
    }
    return { video, audio, text }
  }, [tl.clips, assets])
  // Up to five shots for the hover strip
  const shots = useMemo(
    () =>
      tl.clips
        .filter((c) => {
          const a = assets.get(c.assetId)
          return a && (a.kind === 'image' || (a.kind === 'video' && a.thumbPath))
        })
        .sort((a, b) => a.start - b.start)
        .slice(0, 5)
        .map((c) => ({ id: c.id, url: posterUrl(assets.get(c.assetId)) })),
    [tl.clips, assets]
  )

  return (
    <motion.div
      layout
      variants={rise}
      exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.2, ease } }}
      whileHover="hover"
      className="group relative flex cursor-default flex-col overflow-hidden rounded-2xl border border-line bg-white/[0.03] hairline transition-[border-color,background] duration-300 hover:border-line-strong hover:bg-white/[0.05]"
      onClick={onOpen}
    >
      <div className="relative aspect-video overflow-hidden bg-black/40">
        <motion.div className="size-full" variants={{ hover: { scale: 1.045 } }} transition={{ duration: 0.8, ease }}>
          <TimelineThumb tl={tl} assets={assets} />
        </motion.div>
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/75 via-black/5 to-black/25" />

        {/* play affordance */}
        <motion.div
          className="pointer-events-none absolute inset-0 grid place-items-center"
          initial={{ opacity: 0 }}
          variants={{ hover: { opacity: 1 } }}
          transition={{ duration: 0.25, ease }}
        >
          <motion.span variants={{ hover: { scale: 1 } }} initial={{ scale: 0.8 }} transition={spring} className="grid size-11 place-items-center rounded-full bg-white/15 text-white ring-1 ring-white/25 backdrop-blur-md">
            <Play className="ml-0.5 size-4.5 fill-current" />
          </motion.span>
        </motion.div>

        {/* shot strip */}
        {shots.length > 1 && (
          <motion.div className="pointer-events-none absolute inset-x-2.5 bottom-2.5 flex gap-1" initial={{ opacity: 0, y: 8 }} variants={{ hover: { opacity: 1, y: 0 } }} transition={{ duration: 0.35, ease }}>
            {shots.map((s) => (
              <div key={s.id} className="aspect-video min-w-0 flex-1 overflow-hidden rounded-[5px] ring-1 ring-white/20">
                {s.url && <img src={s.url} alt="" className="size-full object-cover" draggable={false} />}
              </div>
            ))}
          </motion.div>
        )}

        <div className="absolute top-2.5 left-2.5 flex items-center gap-1.5">
          <span className="flex h-5.5 items-center gap-1.5 rounded-md bg-black/55 px-1.5 text-[10.5px] font-semibold text-white/90 backdrop-blur-md">
            <AspectGlyph w={tl.width} h={tl.height} size={11} />
            {preset?.label ?? `${tl.width}×${tl.height}`}
          </span>
        </div>
        <span className="absolute right-2.5 bottom-2.5 rounded-md bg-black/60 px-1.5 py-0.5 font-mono text-[10.5px] font-medium text-white/90 backdrop-blur-md transition-opacity duration-300 group-hover:opacity-0">
          {duration > 0 ? shortDuration(duration) : 'Empty'}
        </span>

        <div className="absolute top-2 right-2 opacity-0 transition-opacity duration-200 group-hover:opacity-100 has-[[data-state=open]]:opacity-100 max-md:opacity-100" onClick={(e) => e.stopPropagation()}>
          <Menu
            align="end"
            trigger={
              <button className="grid size-7 place-items-center rounded-lg bg-black/55 text-white/90 backdrop-blur-md transition hover:bg-black/75 max-md:size-9 max-md:rounded-xl" aria-label="Timeline menu">
                <MoreHorizontal className="size-4" />
              </button>
            }
          >
            <MenuItem icon={<Pencil />} onSelect={onRename}>
              Rename
            </MenuItem>
            <MenuItem icon={<Copy />} onSelect={onDuplicate}>
              Duplicate
            </MenuItem>
            <MenuSeparator />
            <MenuItem icon={<Trash2 />} danger onSelect={onDelete}>
              Delete
            </MenuItem>
          </Menu>
        </div>
      </div>

      <div className="flex flex-col gap-1.5 px-3.5 pt-3 pb-3.5">
        <div className="flex items-center justify-between gap-2">
          <div className="truncate text-[13.5px] font-semibold tracking-tight">{tl.name}</div>
          <span className="shrink-0 text-[11px] text-fg-3">{timeAgo(tl.updatedAt)}</span>
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-fg-3">
          <span className="tabular-nums">
            {tl.width}×{tl.height}
          </span>
          <span className="text-fg-3/50">·</span>
          <span>{tl.fps} fps</span>
          <div className="flex-1" />
          {counts.video > 0 && (
            <Badge className="gap-1">
              <Film className="size-2.5" />
              {counts.video}
            </Badge>
          )}
          {counts.audio > 0 && (
            <Badge className="gap-1">
              <AudioLines className="size-2.5" />
              {counts.audio}
            </Badge>
          )}
          {counts.text > 0 && (
            <Badge className="gap-1">
              <Type className="size-2.5" />
              {counts.text}
            </Badge>
          )}
        </div>
      </div>
    </motion.div>
  )
}

/** Empty state with a little animated timeline. */
function EmptyStudio({ onCreate }: { onCreate: () => void }): React.JSX.Element {
  const rows = [
    { y: 0, clips: [[0, 34], [36, 28], [66, 30]], tone: 'accent-2' },
    { y: 1, clips: [[10, 44], [58, 22]], tone: 'accent-2' },
    { y: 2, clips: [[0, 60], [62, 34]], tone: 'accent' },
    { y: 3, clips: [[18, 50]], tone: 'accent' }
  ]
  return (
    <div className="flex flex-col items-center px-8 pt-10 pb-16 max-md:px-4 max-md:pt-4 max-md:pb-10">
      <motion.div
        initial={{ opacity: 0, y: 14, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.6, ease }}
        className="glass hairline relative w-full max-w-[560px] overflow-hidden rounded-3xl p-5"
      >
        <div className="absolute inset-0 bg-grad-soft opacity-40" />
        <div className="relative mb-3 flex items-center gap-2">
          {[0, 1, 2].map((i) => (
            <span key={i} className="size-2 rounded-full bg-white/15" />
          ))}
          <div className="ml-2 h-2 w-24 rounded-full bg-white/10" />
        </div>
        <div className="relative flex flex-col gap-2">
          {rows.map((r, ri) => (
            <div key={ri} className="relative h-7 rounded-lg bg-white/[0.03]">
              {r.clips.map(([x, w], ci) => (
                <motion.div
                  key={ci}
                  initial={{ opacity: 0, x: -24, scaleX: 0.6 }}
                  animate={{ opacity: 1, x: 0, scaleX: 1 }}
                  transition={{ ...spring, delay: 0.25 + ri * 0.08 + ci * 0.06 }}
                  className={cn(
                    'absolute inset-y-1 origin-left rounded-md border',
                    r.tone === 'accent'
                      ? 'border-[color-mix(in_oklab,var(--accent)_45%,transparent)] bg-[color-mix(in_oklab,var(--accent)_22%,transparent)]'
                      : 'border-[color-mix(in_oklab,var(--accent-2)_50%,transparent)] bg-[color-mix(in_oklab,var(--accent-2)_24%,transparent)]'
                  )}
                  style={{ left: `${x}%`, width: `${w}%` }}
                />
              ))}
            </div>
          ))}
          <motion.div
            className="absolute -inset-y-1 left-0 w-px bg-accent shadow-[0_0_12px_var(--accent)]"
            initial={{ x: 40 }}
            animate={{ x: [40, 420, 40] }}
            transition={{ duration: 9, repeat: Infinity, ease: 'easeInOut' }}
          />
        </div>
      </motion.div>
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease, delay: 0.15 }} className="mt-8 flex flex-col items-center gap-3 text-center max-md:mt-6">
        <div className="display text-[22px] max-md:text-[20px]">Your first cut starts here</div>
        <p className="max-w-md text-[13px] text-fg-3">Drop FastH3 shots, stills, music and voice lines on a multi-track timeline, add titles, and export an MP4 — all on your machine.</p>
        <Button variant="primary" size="lg" className="mt-2" icon={<Plus className="size-4" />} onClick={onCreate}>
          New timeline
        </Button>
      </motion.div>
    </div>
  )
}
