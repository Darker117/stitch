import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { AnimatePresence, motion } from 'motion/react'
import { AudioLines, CheckSquare, Clapperboard, FolderOpen, ImageIcon, Layers, Sparkles, Trash2, Upload, X } from 'lucide-react'
import type { Asset, AssetKind } from '@shared/types'
import { invoke } from '@/lib/api'
import { cn } from '@/lib/utils'
import { ease, spring } from '@/lib/motion'
import { Page, PageHeader } from '@/components/shell/page'
import { AssetLightbox, AssetThumb, DropZone, importFiles, ACCEPT } from '@/components/media'
import { Button } from '@/components/ui/button'
import { Segmented } from '@/components/ui/controls'
import { SearchField } from '@/components/ui/input'
import { EmptyState } from '@/components/ui/misc'
import { Menu, MenuItem, MenuSeparator, Select } from '@/components/ui/overlay'
import { db, useCollection } from '@/stores/db'
import { toast } from '@/stores/toast'

type KindFilter = 'all' | AssetKind
type SourceFilter = 'all' | Asset['source']

export function AssetsPage(): React.JSX.Element {
  const assets = useCollection('assets')
  const projects = useCollection('projects')
  const characters = useCollection('characters')
  const navigate = useNavigate()
  const [kind, setKind] = useState<KindFilter>('all')
  const [source, setSource] = useState<SourceFilter>('all')
  const [character, setCharacter] = useState<string>('all')
  const [q, setQ] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [lightbox, setLightbox] = useState<string | null>(null)

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

  const selecting = selected.length > 0
  const toggle = (id: string): void => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))

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

  return (
    <Page>
      <PageHeader
        title="Assets"
        subtitle="Everything you've generated, recorded or imported — images, H3 videos, music and voice lines."
        actions={
          <Button
            icon={<Upload className="size-3.5" />}
            onClick={async () => {
              const paths = await invoke('sys:pickFiles', { multi: true, filters: [{ name: 'Media', extensions: [...ACCEPT.image, ...ACCEPT.video, ...ACCEPT.audio] }] })
              if (paths.length) {
                const done = await importFiles(paths)
                if (done.length) toast.success(`Imported ${done.length} file${done.length === 1 ? '' : 's'}`)
              }
            }}
          >
            Import
          </Button>
        }
      />
      <div className="sticky top-0 z-10 flex items-center gap-2 border-y border-line bg-[color-mix(in_oklab,var(--panel-solid)_80%,transparent)] px-8 py-3 backdrop-blur-xl">
        <Segmented
          size="sm"
          value={kind}
          onChange={setKind}
          items={[
            { value: 'all', label: 'All', count: assets.length },
            { value: 'image', label: 'Images', icon: <ImageIcon /> },
            { value: 'video', label: 'Videos', icon: <Clapperboard /> },
            { value: 'audio', label: 'Audio', icon: <AudioLines /> }
          ]}
        />
        <Select
          size="sm"
          className="w-[150px]"
          value={source}
          onChange={(v) => setSource(v as SourceFilter)}
          options={[
            { value: 'all', label: 'Any source' },
            { value: 'generated', label: 'Generated' },
            { value: 'voice', label: 'Voice lines' },
            { value: 'edited', label: 'Studio exports' },
            { value: 'imported', label: 'Imported' }
          ]}
        />
        {characters.length > 0 && (
          <Select size="sm" className="w-[170px]" value={character} onChange={setCharacter} options={[{ value: 'all', label: 'Any character' }, ...characters.map((c) => ({ value: c.id, label: c.name }))]} />
        )}
        <div className="flex-1" />
        <SearchField value={q} onChange={setQ} placeholder="Search names and prompts" className="w-[260px]" />
      </div>

      <DropZone kinds={['image', 'video', 'audio']} onAssets={(a) => a.length && toast.success(`Imported ${a.length}`)} className="min-h-[60vh] px-8 py-6">
        {list.length ? (
          <motion.div layout className="columns-5 gap-3 [&>*]:mb-3">
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
                  <div draggable onDragStart={(e) => e.dataTransfer.setData('application/x-stitch-asset', a.id)} style={{ aspectRatio: a.kind === 'audio' ? '16 / 8' : a.width && a.height ? `${a.width} / ${a.height}` : '1 / 1' }}>
                    <AssetThumb asset={a} className="size-full" selected={selected.includes(a.id)} onClick={() => (selecting ? toggle(a.id) : setLightbox(a.id))}>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          toggle(a.id)
                        }}
                        className={cn('absolute top-2 left-2 grid size-5 place-items-center rounded-md border border-white/40 bg-black/40 text-white backdrop-blur transition', selected.includes(a.id) ? 'opacity-0' : 'opacity-0 group-hover:opacity-100')}
                        title="Select"
                      />
                    </AssetThumb>
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>
          </motion.div>
        ) : (
          <EmptyState icon={<Sparkles />} title={assets.length ? 'Nothing matches' : 'Your library is empty'} body={assets.length ? 'Try another filter.' : 'Generate something, or drop files here to import them.'} />
        )}
      </DropZone>

      <AnimatePresence>
        {selecting && (
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
                  <MenuItem
                    key={p.id}
                    onSelect={async () => {
                      for (const id of selected) await db.patch('assets', id, { projectId: p.id })
                      toast.success(`Added to ${p.name}`)
                      setSelected([])
                    }}
                  >
                    {p.name}
                  </MenuItem>
                ))}
              </Menu>
            )}
            <Button size="sm" icon={<FolderOpen className="size-3.5" />} onClick={() => selected[0] && invoke('sys:showInFolder', db.get('assets', selected[0])!.path)}>
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
              <MenuItem
                danger
                icon={<Trash2 />}
                onSelect={async () => {
                  for (const id of selected) await invoke('assets:delete', id, true)
                  toast.info(`Deleted ${selected.length} item${selected.length === 1 ? '' : 's'}`)
                  setSelected([])
                }}
              >
                Delete files from disk
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                onSelect={async () => {
                  for (const id of selected) await invoke('assets:delete', id, false)
                  setSelected([])
                }}
              >
                Remove from library only
              </MenuItem>
            </Menu>
            <button onClick={() => setSelected([])} className="grid size-8 place-items-center rounded-lg text-fg-3 hover:bg-white/10 hover:text-fg">
              <X className="size-4" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
      <AssetLightbox assetId={lightbox} onClose={() => setLightbox(null)} />
    </Page>
  )
}
