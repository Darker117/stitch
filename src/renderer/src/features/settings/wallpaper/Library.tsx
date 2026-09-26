// Installed Wallpaper Engine items (workshop subscriptions, presets, own projects).
import { useEffect, useMemo, useState } from 'react'
import { motion } from 'motion/react'
import { AppWindow, Check, Film, Globe, ImageIcon, Sparkles } from 'lucide-react'
import type { WallpaperItem } from '@shared/types'
import { fileUrl, invoke, on } from '@/lib/api'
import { cn } from '@/lib/utils'
import { spring } from '@/lib/motion'
import { Segmented } from '@/components/ui/controls'
import { SearchField } from '@/components/ui/input'
import { Badge, EmptyState, Skeleton, Spinner } from '@/components/ui/misc'

export const TYPE_ICON: Record<string, React.ReactNode> = {
  video: <Film className="size-3" />,
  web: <Globe className="size-3" />,
  scene: <Sparkles className="size-3" />,
  application: <AppWindow className="size-3" />
}

/** Phone: segmented controls stretch to the full width with equal segments. */
export const segFull = 'max-md:flex max-md:w-full max-md:[&>button]:h-9 max-md:[&>button]:min-w-0 max-md:[&>button]:flex-1 max-md:[&>button]:justify-center max-md:[&>button]:px-1.5'

export function WallpaperLibrary({ current, applying, onApply, onDiscover }: { current?: string; applying?: string; onApply: (id: string) => void; onDiscover: () => void }): React.JSX.Element {
  const [items, setItems] = useState<WallpaperItem[] | null>(null)
  const [q, setQ] = useState('')
  const [type, setType] = useState<'all' | 'video' | 'web' | 'scene'>('all')
  useEffect(() => {
    const load = (): void => void invoke('wallpaper:list').then(setItems)
    load()
    // New downloads from Discover show up here straight away.
    return on('wallpaper:download', (d) => d.state === 'ready' && load())
  }, [])
  const list = useMemo(() => (items ?? []).filter((w) => (type === 'all' || w.type === type) && (!q || w.title.toLowerCase().includes(q.toLowerCase()))), [items, q, type])

  if (items && !items.length) {
    return (
      <EmptyState
        icon={<ImageIcon />}
        title="No wallpapers yet"
        body="Find something you like in Discover — it downloads through Steam and shows up here."
        action={
          <button onClick={onDiscover} className="text-[12.5px] font-semibold text-accent hover:underline">
            Browse the workshop
          </button>
        }
      />
    )
  }
  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3 max-md:flex-col max-md:items-stretch max-md:gap-2">
        <SearchField value={q} onChange={setQ} placeholder={`Search ${items?.length ?? ''} wallpapers`} className="w-[260px] max-md:w-full" />
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
      </div>
      <div className="grid max-h-[460px] grid-cols-4 gap-2.5 overflow-y-auto pr-1 max-md:max-h-[52vh] max-md:grid-cols-2 max-md:gap-2 max-md:pr-0">
        {!items && Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="aspect-video" />)}
        {list.map((w) => {
          const active = current === w.id
          return (
            <motion.button
              key={w.dir + w.id}
              whileHover={{ y: -2 }}
              transition={spring}
              onClick={() => onApply(w.id)}
              className={cn('group relative aspect-video overflow-hidden rounded-xl bg-white/[0.04] text-left ring-1 transition', active ? 'ring-2 ring-accent' : 'ring-line hover:ring-line-strong')}
            >
              {w.preview && <img src={fileUrl(w.preview)} loading="lazy" decoding="async" alt="" className="absolute inset-0 size-full object-cover transition-transform duration-700 group-hover:scale-105" />}
              <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent p-2 pt-6">
                <div className="truncate text-[11px] font-medium text-white">{w.title}</div>
              </div>
              <div className="absolute top-1.5 left-1.5 flex gap-1">
                <Badge className="bg-black/50 text-white/85 backdrop-blur">
                  {TYPE_ICON[w.type]} {w.type}
                </Badge>
              </div>
              {w.schemeColor && <span className="absolute top-2 right-2 size-3 rounded-full ring-2 ring-black/40" style={{ background: w.schemeColor }} />}
              {applying === w.id ? (
                <span className="absolute right-2 bottom-2 grid size-5 place-items-center rounded-full bg-black/60 text-white backdrop-blur">
                  <Spinner className="size-3" />
                </span>
              ) : (
                active && (
                  <span className="absolute right-2 bottom-2 grid size-5 place-items-center rounded-full bg-accent text-accent-fg">
                    <Check className="size-3" strokeWidth={3} />
                  </span>
                )
              )}
            </motion.button>
          )
        })}
      </div>
      <p className="mt-2 text-[11.5px] text-fg-3">Scenes, videos and web wallpapers play live at your screen's full resolution. A few scene extras — text clocks, 3D models, puppet animation — show still.</p>
    </div>
  )
}
