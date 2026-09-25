// Media building blocks: thumbnails, lightbox, asset picker, drop zones, slots.
import { useCallback, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { AudioLines, Check, Film, FolderOpen, ImageIcon, ImagePlus, Music, Play, Plus, Trash2, Upload, X } from 'lucide-react'
import type { Asset, AssetKind, ID } from '@shared/types'
import { errorText, fileUrl, invoke } from '@/lib/api'
import { cn, formatDuration } from '@/lib/utils'
import { ease, spring } from '@/lib/motion'
import { db, useCollection, useDoc } from '@/stores/db'
import { toast } from '@/stores/toast'
import { Button, IconButton } from './ui/button'
import { Dialog } from './ui/overlay'
import { Segmented } from './ui/controls'
import { EmptyState } from './ui/misc'

export const ACCEPT: Record<AssetKind, string[]> = {
  image: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'],
  video: ['mp4', 'webm', 'mov', 'mkv', 'm4v'],
  audio: ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'opus']
}

export async function importFiles(paths: string[], meta?: Partial<Asset>): Promise<Asset[]> {
  try {
    const assets = await invoke('assets:import', paths, meta)
    return assets
  } catch (err) {
    toast.error('Import failed', errorText(err))
    return []
  }
}

export async function pickAndImport(kind: AssetKind, multi = false, meta?: Partial<Asset>): Promise<Asset[]> {
  const paths = await invoke('sys:pickFiles', { multi, filters: [{ name: kind, extensions: ACCEPT[kind] }] })
  if (!paths.length) return []
  return importFiles(paths, meta)
}

export function kindIcon(kind: AssetKind, className = 'size-3.5'): React.JSX.Element {
  if (kind === 'video') return <Film className={className} />
  if (kind === 'audio') return <AudioLines className={className} />
  return <ImageIcon className={className} />
}

/** Thumbnail for any asset. Videos preview on hover. */
export function AssetThumb({
  asset,
  className,
  onClick,
  selected,
  children,
  fit = 'cover',
  hoverPlay = true,
  rounded = 'rounded-xl'
}: {
  asset: Asset
  className?: string
  onClick?: () => void
  selected?: boolean
  children?: ReactNode
  fit?: 'cover' | 'contain'
  hoverPlay?: boolean
  rounded?: string
}): React.JSX.Element {
  const video = useRef<HTMLVideoElement>(null)
  const [hover, setHover] = useState(false)
  return (
    <motion.div
      layout="position"
      onClick={onClick}
      onHoverStart={() => {
        setHover(true)
        if (hoverPlay) void video.current?.play().catch(() => {})
      }}
      onHoverEnd={() => {
        setHover(false)
        if (video.current) {
          video.current.pause()
          video.current.currentTime = 0
        }
      }}
      className={cn('group relative overflow-hidden bg-white/[0.03] ring-1 ring-line', rounded, selected && 'ring-2 ring-accent', onClick && 'cursor-pointer', className)}
    >
      {asset.kind === 'image' && (
        <img src={fileUrl(asset.path)} alt={asset.name} loading="lazy" draggable={false} className={cn('size-full transition-transform duration-700 ease-out group-hover:scale-[1.03]', fit === 'cover' ? 'object-cover' : 'object-contain')} />
      )}
      {asset.kind === 'video' && (
        <>
          <video
            ref={video}
            src={fileUrl(asset.path)}
            poster={asset.thumbPath ? fileUrl(asset.thumbPath) : undefined}
            muted
            loop
            playsInline
            preload="metadata"
            className={cn('size-full', fit === 'cover' ? 'object-cover' : 'object-contain')}
          />
          <div className={cn('pointer-events-none absolute bottom-2 left-2 flex items-center gap-1 rounded-md bg-black/55 px-1.5 py-0.5 text-[10.5px] font-medium text-white/90 backdrop-blur transition-opacity', hover && 'opacity-0')}>
            <Play className="size-2.5 fill-current" /> {formatDuration(asset.duration)}
          </div>
        </>
      )}
      {asset.kind === 'audio' && (
        <div className="flex size-full flex-col items-center justify-center gap-2 bg-grad-soft p-3">
          <AudioWaveGlyph />
          <div className="line-clamp-2 text-center text-[11px] font-medium text-fg-2">{asset.name}</div>
          {asset.duration && <div className="text-[10.5px] text-fg-3">{formatDuration(asset.duration)}</div>}
        </div>
      )}
      {selected && (
        <motion.div initial={{ scale: 0.5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={spring} className="absolute top-2 right-2 grid size-5 place-items-center rounded-full bg-accent text-accent-fg">
          <Check className="size-3" strokeWidth={3} />
        </motion.div>
      )}
      {children}
    </motion.div>
  )
}

function AudioWaveGlyph(): React.JSX.Element {
  const bars = useMemo(() => Array.from({ length: 18 }, (_, i) => 0.25 + Math.abs(Math.sin(i * 1.7)) * 0.75), [])
  return (
    <div className="flex h-8 items-center gap-[3px]">
      {bars.map((h, i) => (
        <span key={i} className="w-[3px] rounded-full bg-grad" style={{ height: `${h * 100}%` }} />
      ))}
    </div>
  )
}

/** Full-screen viewer with metadata and actions. */
export function AssetLightbox({ assetId, onClose, actions }: { assetId: ID | null; onClose: () => void; actions?: (a: Asset) => ReactNode }): React.JSX.Element {
  const asset = useDoc('assets', assetId)
  return (
    <AnimatePresence>
      {assetId && asset && (
        <motion.div
          className="fixed inset-0 z-50 flex bg-black/80 backdrop-blur-md"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.25, ease }}
          onClick={onClose}
        >
          <div className="flex min-w-0 flex-1 items-center justify-center p-10 pt-14" onClick={(e) => e.stopPropagation()}>
            <motion.div initial={{ scale: 0.96, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={spring} className="max-h-full max-w-full">
              {asset.kind === 'image' && <img src={fileUrl(asset.path)} className="max-h-[calc(100vh-120px)] max-w-full rounded-xl object-contain shadow-2xl" />}
              {asset.kind === 'video' && <video src={fileUrl(asset.path)} controls autoPlay loop className="max-h-[calc(100vh-120px)] max-w-full rounded-xl shadow-2xl" />}
              {asset.kind === 'audio' && (
                <div className="glass-strong flex w-[520px] flex-col items-center gap-5 rounded-2xl p-8">
                  <AudioWaveGlyph />
                  <div className="font-medium">{asset.name}</div>
                  <audio src={fileUrl(asset.path)} controls autoPlay className="w-full" />
                </div>
              )}
            </motion.div>
          </div>
          <motion.aside
            initial={{ x: 40, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            transition={{ ...spring, delay: 0.05 }}
            className="glass-strong flex w-[320px] shrink-0 flex-col gap-4 overflow-y-auto border-y-0 border-r-0 p-5 pt-14"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="font-semibold">{asset.name}</div>
                <div className="mt-0.5 text-[11.5px] text-fg-3">
                  {asset.width && asset.height ? `${asset.width}×${asset.height} · ` : ''}
                  {asset.duration ? `${formatDuration(asset.duration)} · ` : ''}
                  {new Date(asset.createdAt).toLocaleString()}
                </div>
              </div>
              <IconButton label="Close" onClick={onClose}>
                <X className="size-4" />
              </IconButton>
            </div>
            {asset.prompt && (
              <div>
                <div className="label-caps mb-1.5">Prompt</div>
                <p className="selectable rounded-xl border border-line bg-white/[0.03] p-3 text-[12.5px] leading-relaxed text-fg-2">{asset.prompt}</p>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" icon={<FolderOpen className="size-3.5" />} onClick={() => invoke('sys:showInFolder', asset.path)}>
                Show in folder
              </Button>
              <Button
                size="sm"
                variant="danger"
                icon={<Trash2 className="size-3.5" />}
                onClick={async () => {
                  onClose()
                  await invoke('assets:delete', asset.id, true)
                }}
              >
                Delete
              </Button>
              {actions?.(asset)}
            </div>
          </motion.aside>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/** Drop files anywhere inside; imports them and hands back assets. */
export function DropZone({
  kinds,
  onAssets,
  children,
  className,
  meta
}: {
  kinds: AssetKind[]
  onAssets: (assets: Asset[]) => void
  children: ReactNode
  className?: string
  meta?: Partial<Asset>
}): React.JSX.Element {
  const [over, setOver] = useState(false)
  const depth = useRef(0)
  const accepted = useMemo(() => new Set(kinds.flatMap((k) => ACCEPT[k])), [kinds])
  const onDrop = useCallback(
    async (e: DragEvent) => {
      e.preventDefault()
      depth.current = 0
      setOver(false)
      const paths = [...e.dataTransfer.files]
        .filter((f) => accepted.has(f.name.split('.').pop()?.toLowerCase() ?? ''))
        .map((f) => window.stitch.pathForFile(f))
        .filter(Boolean)
      const assetId = e.dataTransfer.getData('application/x-stitch-asset')
      if (assetId) {
        const a = db.get('assets', assetId)
        if (a && kinds.includes(a.kind)) onAssets([a])
        return
      }
      if (paths.length) onAssets(await importFiles(paths, meta))
    },
    [accepted, kinds, meta, onAssets]
  )
  return (
    <div
      className={cn('relative', className)}
      onDragEnter={(e) => {
        e.preventDefault()
        depth.current++
        setOver(true)
      }}
      onDragLeave={() => {
        depth.current--
        if (depth.current <= 0) setOver(false)
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    >
      {children}
      <AnimatePresence>
        {over && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="pointer-events-none absolute inset-0 z-20 grid place-items-center rounded-[inherit] border-2 border-dashed border-[color-mix(in_oklab,var(--accent)_60%,transparent)] bg-[color-mix(in_oklab,var(--accent)_10%,transparent)] backdrop-blur-sm"
          >
            <div className="flex items-center gap-2 text-[13px] font-medium">
              <Upload className="size-4" /> Drop to add
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

/** Pick assets from the library or import from disk. */
export function AssetPicker({
  open,
  onClose,
  kinds,
  multiple,
  onPick,
  title
}: {
  open: boolean
  onClose: () => void
  kinds: AssetKind[]
  multiple?: boolean
  onPick: (assets: Asset[]) => void
  title?: string
}): React.JSX.Element {
  const assets = useCollection('assets')
  const [kind, setKind] = useState<AssetKind>(kinds[0])
  const [sel, setSel] = useState<ID[]>([])
  const list = assets.filter((a) => a.kind === kind)
  const done = (picked: Asset[]): void => {
    onPick(picked)
    setSel([])
    onClose()
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={title ?? (multiple ? 'Choose media' : `Choose ${kinds[0] === 'audio' ? 'audio' : kinds[0]}`)}
      width={880}
      headerAction={
        kinds.length > 1 ? (
          <Segmented size="sm" value={kind} onChange={setKind} items={kinds.map((k) => ({ value: k, label: k[0].toUpperCase() + k.slice(1), icon: kindIcon(k) }))} />
        ) : undefined
      }
      footer={
        <>
          <Button
            variant="ghost"
            icon={<Upload className="size-3.5" />}
            onClick={async () => {
              const imported = await pickAndImport(kind, multiple)
              if (imported.length) done(imported)
            }}
          >
            Import from disk
          </Button>
          <div className="flex-1" />
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {multiple && (
            <Button variant="primary" disabled={!sel.length} onClick={() => done(sel.map((id) => db.get('assets', id)!).filter(Boolean))}>
              Add {sel.length || ''}
            </Button>
          )}
        </>
      }
    >
      <DropZone kinds={kinds} onAssets={done} className="min-h-[360px] p-4">
        {list.length ? (
          <div className="grid grid-cols-5 gap-2.5">
            {list.map((a) => (
              <AssetThumb
                key={a.id}
                asset={a}
                className="aspect-square"
                selected={sel.includes(a.id)}
                onClick={() => (multiple ? setSel((s) => (s.includes(a.id) ? s.filter((x) => x !== a.id) : [...s, a.id])) : done([a]))}
              />
            ))}
          </div>
        ) : (
          <EmptyState icon={kind === 'audio' ? <Music /> : <ImagePlus />} title={`No ${kind}s yet`} body="Import from disk or drop files here." />
        )}
      </DropZone>
    </Dialog>
  )
}

/** Compact slot for a single media input (e.g. first frame). */
export function MediaSlot({
  value,
  onChange,
  kind,
  label,
  className,
  aspect = 'aspect-video'
}: {
  value: ID | undefined
  onChange: (id: ID | undefined) => void
  kind: AssetKind
  label: string
  className?: string
  aspect?: string
}): React.JSX.Element {
  const asset = useDoc('assets', value)
  const [picker, setPicker] = useState(false)
  return (
    <>
      <DropZone kinds={[kind]} onAssets={(a) => a[0] && onChange(a[0].id)} className={className}>
        {asset ? (
          <AssetThumb asset={asset} className={cn('w-full', kind !== 'audio' ? aspect : 'h-20')} onClick={() => setPicker(true)}>
            <button
              onClick={(e) => {
                e.stopPropagation()
                onChange(undefined)
              }}
              className="absolute top-1.5 right-1.5 grid size-6 place-items-center rounded-md bg-black/55 text-white opacity-0 backdrop-blur transition group-hover:opacity-100 hover:bg-black/75"
            >
              <X className="size-3.5" />
            </button>
          </AssetThumb>
        ) : (
          <button
            onClick={() => setPicker(true)}
            className={cn(
              'flex w-full flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-line-strong bg-white/[0.02] text-fg-3 transition hover:border-[color-mix(in_oklab,var(--accent)_50%,transparent)] hover:bg-white/[0.04] hover:text-fg-2',
              kind !== 'audio' ? aspect : 'h-20'
            )}
          >
            {kind === 'audio' ? <Music className="size-4.5" /> : <ImagePlus className="size-4.5" />}
            <span className="text-[11.5px] font-medium">{label}</span>
          </button>
        )}
      </DropZone>
      <AssetPicker open={picker} onClose={() => setPicker(false)} kinds={[kind]} onPick={(a) => a[0] && onChange(a[0].id)} />
    </>
  )
}

/** Row of media inputs (reference images / voice clips). */
export function MediaList({
  value,
  onChange,
  kind,
  max = 9,
  label = 'Add'
}: {
  value: ID[]
  onChange: (ids: ID[]) => void
  kind: AssetKind
  max?: number
  label?: string
}): React.JSX.Element {
  const assets = useCollection('assets')
  const [picker, setPicker] = useState(false)
  const items = value.map((id) => assets.find((a) => a.id === id)).filter(Boolean) as Asset[]
  return (
    <DropZone kinds={[kind]} onAssets={(a) => onChange([...value, ...a.map((x) => x.id)].slice(0, max))}>
      <div className={cn('grid gap-2', kind === 'audio' ? 'grid-cols-2' : 'grid-cols-4')}>
        <AnimatePresence initial={false}>
          {items.map((a, i) => (
            <motion.div key={a.id} layout initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }} transition={spring}>
              <AssetThumb asset={a} className={kind === 'audio' ? 'h-16' : 'aspect-square'} hoverPlay={false}>
                <span className="absolute top-1 left-1 rounded bg-black/60 px-1 font-mono text-[9.5px] text-white/90">{i + 1}</span>
                <button
                  onClick={() => onChange(value.filter((x) => x !== a.id))}
                  className="absolute top-1 right-1 grid size-5 place-items-center rounded bg-black/60 text-white opacity-0 transition group-hover:opacity-100"
                >
                  <X className="size-3" />
                </button>
              </AssetThumb>
            </motion.div>
          ))}
        </AnimatePresence>
        {items.length < max && (
          <button
            onClick={() => setPicker(true)}
            className={cn(
              'flex flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-line-strong text-fg-3 transition hover:border-[color-mix(in_oklab,var(--accent)_50%,transparent)] hover:text-fg-2',
              kind === 'audio' ? 'h-16' : 'aspect-square'
            )}
          >
            <Plus className="size-4" />
            <span className="text-[10.5px] font-medium">{label}</span>
          </button>
        )}
      </div>
      <AssetPicker open={picker} onClose={() => setPicker(false)} kinds={[kind]} multiple onPick={(a) => onChange([...value, ...a.map((x) => x.id)].slice(0, max))} />
    </DropZone>
  )
}
