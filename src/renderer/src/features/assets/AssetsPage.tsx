import { useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { AnimatePresence, motion } from 'motion/react'
import { AudioLines, CheckSquare, Clapperboard, FolderOpen, ImageIcon, Layers, ListChecks, SlidersHorizontal, Sparkles, Trash2, Upload, X } from 'lucide-react'
import type { Asset, AssetKind } from '@shared/types'
import { invoke } from '@/lib/api'
import { useCompact } from '@/lib/platform'
import { cn } from '@/lib/utils'
import { ease, spring } from '@/lib/motion'
import { Page, PageHeader } from '@/components/shell/page'
import { AssetLightbox, AssetThumb, DropZone, importFiles, ACCEPT } from '@/components/media'
import { Button, Chip, IconButton } from '@/components/ui/button'
import { Segmented } from '@/components/ui/controls'
import { SearchField } from '@/components/ui/input'
import { EmptyState } from '@/components/ui/misc'
import { Dialog, Menu, MenuItem, MenuSeparator, Select } from '@/components/ui/overlay'
import { db, useCollection } from '@/stores/db'
import { toast } from '@/stores/toast'

type KindFilter = 'all' | AssetKind
type SourceFilter = 'all' | Asset['source']

const SOURCES: { value: SourceFilter; label: string }[] = [
  { value: 'all', label: 'Any source' },
  { value: 'generated', label: 'Generated' },
  { value: 'voice', label: 'Voice lines' },
  { value: 'edited', label: 'Studio exports' },
  { value: 'imported', label: 'Imported' }
]

/** Phone: source + character filters as a bottom sheet of chips. */
function FilterSheet({
  open,
  onClose,
  source,
  setSource,
  character,
  setCharacter,
  results
}: {
  open: boolean
  onClose: () => void
  source: SourceFilter
  setSource: (v: SourceFilter) => void
  character: string
  setCharacter: (v: string) => void
  results: number
}): React.JSX.Element {
  const characters = useCollection('characters')
  const chip = 'h-9 rounded-full px-3.5 text-[12.5px]'
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Filter assets"
      footer={
        <>
          <Button
            variant="ghost"
            disabled={source === 'all' && character === 'all'}
            onClick={() => {
              setSource('all')
              setCharacter('all')
            }}
          >
            Reset
          </Button>
          <div className="flex-1" />
          <Button variant="primary" className="h-10 px-5" onClick={onClose}>
            Show {results} {results === 1 ? 'item' : 'items'}
          </Button>
        </>
      }
    >
      <div className="space-y-5 px-5 py-4">
        <div>
          <div className="label-caps mb-2.5">Source</div>
          <div className="flex flex-wrap gap-2">
            {SOURCES.map((o) => (
              <Chip key={o.value} active={source === o.value} className={chip} onClick={() => setSource(o.value)}>
                {o.value === 'all' ? 'Any' : o.label}
              </Chip>
            ))}
          </div>
        </div>
        {characters.length > 0 && (
          <div>
            <div className="label-caps mb-2.5">Character</div>
            <div className="flex flex-wrap gap-2">
              <Chip active={character === 'all'} className={chip} onClick={() => setCharacter('all')}>
                Anyone
              </Chip>
              {characters.map((c) => (
                <Chip key={c.id} active={character === c.id} className={chip} onClick={() => setCharacter(c.id)}>
                  {c.name}
                </Chip>
              ))}
            </div>
          </div>
        )}
      </div>
    </Dialog>
  )
}

export function AssetsPage(): React.JSX.Element {
  const assets = useCollection('assets')
  const projects = useCollection('projects')
  const characters = useCollection('characters')
  const navigate = useNavigate()
  const compact = useCompact()
  const [kind, setKind] = useState<KindFilter>('all')
  const [source, setSource] = useState<SourceFilter>('all')
  const [character, setCharacter] = useState<string>('all')
  const [q, setQ] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  // Phone: explicit selection mode (entered from the toolbar or by long-pressing a tile).
  const [selectMode, setSelectMode] = useState(false)
  const [filters, setFilters] = useState(false)
  const [lightbox, setLightbox] = useState<string | null>(null)
  const press = useRef<{ timer?: ReturnType<typeof setTimeout>; fired: boolean }>({ fired: false })

  const list = useMemo(() => {
    const t = q.trim().toLowerCase()
    return assets.filter(
      (a) =>
        (kind === 'all' || a.kind === kind) &&
        (source === 'all' || a.source === source) &&
        (character === 'all' || a.characterIds?.includes(character)) &&
        (!t || a.name.toLowerCase().includes(t) || a.prompt?.toLowerCase().includes(t))
    )
  }, [assets, kind, source, character, q])

  const selecting = selected.length > 0 || selectMode
  const toggle = (id: string): void => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))
  const clearSelection = (): void => {
    setSelected([])
    setSelectMode(false)
  }
  const filtered = source !== 'all' || character !== 'all'

  const toTimeline = async (): Promise<void> => {
    const chosen = selected.map((id) => db.get('assets', id)).filter((a): a is Asset => !!a)
    const now = Date.now()
    const v = { id: `trk-${now}-v`, kind: 'video' as const, name: 'V1', muted: false, locked: false, hidden: false }
    const au = { id: `trk-${now}-a`, kind: 'audio' as const, name: 'A1', muted: false, locked: false, hidden: false }
    let t = 0
    let ta = 0
    const clips = chosen.map((a, i) => {
      const dur = a.kind === 'image' ? 4 : a.duration ?? 4
      const onAudio = a.kind === 'audio'
      const start = onAudio ? ta : t
      if (onAudio) ta += dur
      else t += dur
      return { id: `clip-${now}-${i}`, assetId: a.id, trackId: onAudio ? au.id : v.id, start, in: 0, out: dur, volume: 1 }
    })
    const tl = { id: `tl-${now}`, name: 'New cut', width: 1920, height: 1080, fps: 24, tracks: [v, au], clips, createdAt: now, updatedAt: now }
    await db.put('timelines', tl)
    navigate(`/studio/${tl.id}`)
  }
  const addToProject = async (p: { id: string; name: string }): Promise<void> => {
    for (const id of selected) await db.patch('assets', id, { projectId: p.id })
    toast.success(`Added to ${p.name}`)
    clearSelection()
  }
  const showSelected = (): void => {
    if (selected[0]) void invoke('sys:showInFolder', db.get('assets', selected[0])!.path)
  }
  const deleteSelected = async (fromDisk: boolean): Promise<void> => {
    for (const id of selected) await invoke('assets:delete', id, fromDisk)
    if (fromDisk) toast.info(`Deleted ${selected.length} item${selected.length === 1 ? '' : 's'}`)
    clearSelection()
  }

  const importAssets = async (): Promise<void> => {
    const paths = await invoke('sys:pickFiles', { multi: true, filters: [{ name: 'Media', extensions: [...ACCEPT.image, ...ACCEPT.video, ...ACCEPT.audio] }] })
    if (paths.length) {
      const done = await importFiles(paths)
      if (done.length) toast.success(`Imported ${done.length} file${done.length === 1 ? '' : 's'}`)
    }
  }

  // Touch long-press on a tile starts selecting with that tile.
  const pressStart = (e: React.PointerEvent, id: string): void => {
    if (!compact || e.pointerType !== 'touch') return
    press.current.fired = false
    clearTimeout(press.current.timer)
    press.current.timer = setTimeout(() => {
      press.current.fired = true
      setSelectMode(true)
      setSelected((s) => (s.includes(id) ? s : [...s, id]))
      navigator.vibrate?.(8)
    }, 450)
  }
  const pressEnd = (): void => clearTimeout(press.current.timer)

  const kindItems = [
    { value: 'all' as const, label: 'All', count: assets.length },
    { value: 'image' as const, label: 'Images', icon: compact ? undefined : <ImageIcon /> },
    { value: 'video' as const, label: 'Videos', icon: compact ? undefined : <Clapperboard /> },
    { value: 'audio' as const, label: 'Audio', icon: compact ? undefined : <AudioLines /> }
  ]

  return (
    <Page>
      <PageHeader
        title="Assets"
        subtitle="Everything you've generated, recorded or imported — images, H3 videos, music and voice lines."
        actions={
          compact ? (
            <>
              <SearchField value={q} onChange={setQ} placeholder="Search assets" className="min-w-0 flex-1 [&_input]:h-10" />
              <IconButton label={selectMode ? 'Done selecting' : 'Select'} variant="secondary" active={selectMode} className="size-10 rounded-[10px]" onClick={() => (selecting ? clearSelection() : setSelectMode(true))}>
                <ListChecks className="size-4" />
              </IconButton>
              <Button className="h-10" icon={<Upload className="size-3.5" />} onClick={() => void importAssets()}>
                Import
              </Button>
            </>
          ) : (
            <Button icon={<Upload className="size-3.5" />} onClick={() => void importAssets()}>
              Import
            </Button>
          )
        }
      />
      <div className="sticky top-0 z-10 flex items-center gap-2 border-y border-line bg-[color-mix(in_oklab,var(--panel-solid)_80%,transparent)] px-8 py-3 backdrop-blur-xl max-md:px-4 max-md:py-2.5">
        <Segmented size="sm" value={kind} onChange={setKind} items={kindItems} className="max-md:flex max-md:min-w-0 max-md:flex-1 max-md:[&>button]:h-8 max-md:[&>button]:flex-1 max-md:[&>button]:justify-center" />
        {compact ? (
          <IconButton label="Filter" variant="secondary" active={filtered} className="relative size-10 rounded-[10px]" onClick={() => setFilters(true)}>
            <SlidersHorizontal className="size-4" />
            <AnimatePresence>
              {filtered && <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }} transition={spring} className="absolute top-1.5 right-1.5 size-2 rounded-full bg-grad ring-2 ring-[var(--panel-solid)]" />}
            </AnimatePresence>
          </IconButton>
        ) : (
          <>
            <Select size="sm" className="w-[150px]" value={source} onChange={(v) => setSource(v as SourceFilter)} options={SOURCES} />
            {characters.length > 0 && (
              <Select size="sm" className="w-[170px]" value={character} onChange={setCharacter} options={[{ value: 'all', label: 'Any character' }, ...characters.map((c) => ({ value: c.id, label: c.name }))]} />
            )}
            <div className="flex-1" />
            <SearchField value={q} onChange={setQ} placeholder="Search names and prompts" className="w-[260px]" />
          </>
        )}
      </div>

      <DropZone kinds={['image', 'video', 'audio']} onAssets={(a) => a.length && toast.success(`Imported ${a.length}`)} className={cn('min-h-[60vh] px-8 py-6 max-md:px-4 max-md:py-4', selecting && 'max-md:pb-36')}>
        {list.length ? (
          <motion.div layout className="columns-5 gap-3 [&>*]:mb-3 max-md:columns-2 max-md:gap-2.5 max-md:[&>*]:mb-2.5 min-[440px]:max-md:columns-3">
            <AnimatePresence initial={false}>
              {list.map((a, i) => (
                <motion.div
                  key={a.id}
                  layout
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0, transition: { duration: 0.45, ease, delay: Math.min(i, 15) * 0.02 } }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  className="break-inside-avoid"
                >
                  <div
                    draggable={!compact}
                    onDragStart={(e) => e.dataTransfer.setData('application/x-stitch-asset', a.id)}
                    onPointerDown={(e) => pressStart(e, a.id)}
                    onPointerUp={pressEnd}
                    onPointerLeave={pressEnd}
                    onPointerCancel={pressEnd}
                    onContextMenu={compact ? (e) => e.preventDefault() : undefined}
                    onClickCapture={(e) => {
                      // The tap that ends a long-press must not also toggle / open the tile.
                      if (press.current.fired) {
                        press.current.fired = false
                        e.stopPropagation()
                      }
                    }}
                    style={{ aspectRatio: a.kind === 'audio' ? '16 / 8' : a.width && a.height ? `${a.width} / ${a.height}` : '1 / 1' }}
                  >
                    <AssetThumb asset={a} className="size-full" selected={selected.includes(a.id)} onClick={() => (selecting ? toggle(a.id) : setLightbox(a.id))}>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          toggle(a.id)
                        }}
                        className={cn(
                          'absolute top-2 left-2 grid size-5 place-items-center rounded-md border border-white/40 bg-black/40 text-white backdrop-blur transition',
                          selected.includes(a.id) ? 'opacity-0' : 'opacity-0 group-hover:opacity-100',
                          selecting && !selected.includes(a.id) && 'max-md:opacity-100'
                        )}
                        title="Select"
                      />
                    </AssetThumb>
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>
          </motion.div>
        ) : (
          <EmptyState
            icon={<Sparkles />}
            title={assets.length ? 'Nothing matches' : 'Your library is empty'}
            body={assets.length ? 'Try another filter.' : compact ? 'Generate something, or tap Import to add files.' : 'Generate something, or drop files here to import them.'}
          />
        )}
      </DropZone>

      <AnimatePresence>
        {selecting &&
          (compact ? (
            <motion.div
              initial={{ y: 40, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 40, opacity: 0 }}
              transition={spring}
              className="glass-strong fixed inset-x-2.5 bottom-2.5 z-40 rounded-[20px] p-2 shadow-[var(--shadow-pop)]"
            >
              <div className="flex items-center gap-2 pb-2 pl-2.5">
                <CheckSquare className="size-4 text-accent" />
                <span className="text-[13px] font-medium">{selected.length ? `${selected.length} selected` : 'Tap items to select'}</span>
                <div className="flex-1" />
                {list.length > 0 && (
                  <button
                    onClick={() => setSelected(selected.length === list.length ? [] : list.map((a) => a.id))}
                    className="h-9 rounded-lg px-2.5 text-[12px] font-semibold text-accent transition active:bg-white/10"
                  >
                    {selected.length === list.length ? 'Select none' : 'Select all'}
                  </button>
                )}
                <IconButton label="Done selecting" className="size-9" onClick={clearSelection}>
                  <X className="size-4" />
                </IconButton>
              </div>
              <div className="flex gap-1.5 [&>*]:h-auto [&>*]:min-w-0 [&>*]:flex-1 [&>*]:flex-col [&>*]:gap-1 [&>*]:py-2.5 [&>*]:text-[11px]">
                <Button size="sm" disabled={!selected.length} icon={<Clapperboard className="size-4" />} onClick={() => void toTimeline()}>
                  Studio cut
                </Button>
                {projects.length > 0 && (
                  <Menu
                    side="top"
                    trigger={
                      <Button size="sm" disabled={!selected.length} icon={<Layers className="size-4" />}>
                        Project
                      </Button>
                    }
                  >
                    {projects.map((p) => (
                      <MenuItem key={p.id} onSelect={() => void addToProject(p)}>
                        {p.name}
                      </MenuItem>
                    ))}
                  </Menu>
                )}
                <Button size="sm" disabled={!selected.length} icon={<FolderOpen className="size-4" />} onClick={showSelected}>
                  Open
                </Button>
                <Menu
                  side="top"
                  align="end"
                  trigger={
                    <Button size="sm" variant="danger" disabled={!selected.length} icon={<Trash2 className="size-4" />}>
                      Delete
                    </Button>
                  }
                >
                  <MenuItem danger icon={<Trash2 />} onSelect={() => void deleteSelected(true)}>
                    Delete files from disk
                  </MenuItem>
                  <MenuSeparator />
                  <MenuItem onSelect={() => void deleteSelected(false)}>Remove from library only</MenuItem>
                </Menu>
              </div>
            </motion.div>
          ) : (
            <motion.div initial={{ y: 40, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 40, opacity: 0 }} transition={spring} className="glass-strong fixed bottom-5 left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-2xl p-2 pl-4 shadow-[var(--shadow-pop)]">
              <CheckSquare className="size-4 text-accent" />
              <span className="mr-2 text-[12.5px] font-medium">{selected.length} selected</span>
              <Button size="sm" icon={<Clapperboard className="size-3.5" />} onClick={() => void toTimeline()}>
                New Studio cut
              </Button>
              {projects.length > 0 && (
                <Menu
                  side="top"
                  trigger={
                    <Button size="sm" icon={<Layers className="size-3.5" />}>
                      Add to project
                    </Button>
                  }
                >
                  {projects.map((p) => (
                    <MenuItem key={p.id} onSelect={() => void addToProject(p)}>
                      {p.name}
                    </MenuItem>
                  ))}
                </Menu>
              )}
              <Button size="sm" icon={<FolderOpen className="size-3.5" />} onClick={showSelected}>
                Show
              </Button>
              <Menu
                side="top"
                trigger={
                  <Button size="sm" variant="danger" icon={<Trash2 className="size-3.5" />}>
                    Delete
                  </Button>
                }
              >
                <MenuItem danger icon={<Trash2 />} onSelect={() => void deleteSelected(true)}>
                  Delete files from disk
                </MenuItem>
                <MenuSeparator />
                <MenuItem onSelect={() => void deleteSelected(false)}>Remove from library only</MenuItem>
              </Menu>
              <button onClick={clearSelection} className="grid size-8 place-items-center rounded-lg text-fg-3 hover:bg-white/10 hover:text-fg">
                <X className="size-4" />
              </button>
            </motion.div>
          ))}
      </AnimatePresence>
      <FilterSheet open={filters} onClose={() => setFilters(false)} source={source} setSource={setSource} character={character} setCharacter={setCharacter} results={list.length} />
      <AssetLightbox assetId={lightbox} onClose={() => setLightbox(null)} />
    </Page>
  )
}
