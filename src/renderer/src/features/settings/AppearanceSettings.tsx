// Backgrounds (sunset, Wallpaper Engine, custom) and accent colours.
import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Check, Film, Globe, ImageIcon, Paintbrush, Palette, Sparkles, Upload, Wand2 } from 'lucide-react'
import type { BackgroundSettings, ThemeSettings, WallpaperItem } from '@shared/types'
import { SUNSET, SUNSET_STOPS, tintFrom, tuneAccent } from '@shared/theme'
import { errorText, fileUrl, invoke } from '@/lib/api'
import { accentsForBackground, blurFor, glassFor } from '@/lib/theme'
import { cn } from '@/lib/utils'
import { rise, spring, stagger } from '@/lib/motion'
import { Button } from '@/components/ui/button'
import { Segmented, SliderField } from '@/components/ui/controls'
import { SearchField } from '@/components/ui/input'
import { Badge, EmptyState, SectionTitle, Skeleton, Spinner } from '@/components/ui/misc'
import { useAppSettings, useSettings } from '@/stores/settings'
import { toast } from '@/stores/toast'

type Source = 'sunset' | 'wallpaper' | 'custom' | 'plain'

function sourceOf(bg: BackgroundSettings): Source {
  if (bg.type === 'gradient') return 'sunset'
  if (bg.type === 'none') return 'plain'
  return bg.wallpaperId ? 'wallpaper' : 'custom'
}

const TYPE_ICON: Record<string, React.ReactNode> = { video: <Film className="size-3" />, web: <Globe className="size-3" />, scene: <Sparkles className="size-3" /> }

function WallpaperGallery({ current, onApply }: { current?: string; onApply: (w: WallpaperItem) => void }): React.JSX.Element {
  const [items, setItems] = useState<WallpaperItem[] | null>(null)
  const [q, setQ] = useState('')
  const [type, setType] = useState<'all' | 'video' | 'web' | 'scene'>('all')
  useEffect(() => {
    void invoke('wallpaper:list').then(setItems)
  }, [])
  const list = useMemo(() => (items ?? []).filter((w) => (type === 'all' || w.type === type) && (!q || w.title.toLowerCase().includes(q.toLowerCase()))), [items, q, type])

  if (items && !items.length) return <EmptyState icon={<ImageIcon />} title="Wallpaper Engine not found" body="Install Wallpaper Engine from Steam and subscribe to a few wallpapers — they'll appear here." />
  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3">
        <SearchField value={q} onChange={setQ} placeholder={`Search ${items?.length ?? ''} wallpapers`} className="w-[260px]" />
        <Segmented
          size="sm"
          value={type}
          onChange={setType}
          items={[
            { value: 'all', label: 'All' },
            { value: 'video', label: 'Video' },
            { value: 'web', label: 'Web' },
            { value: 'scene', label: 'Scene' }
          ]}
        />
      </div>
      <div className="grid max-h-[460px] grid-cols-4 gap-2.5 overflow-y-auto pr-1">
        {!items && Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="aspect-video" />)}
        {list.map((w) => {
          const active = current === w.id
          return (
            <motion.button
              key={`${w.dir}`}
              whileHover={{ y: -2 }}
              transition={spring}
              onClick={() => onApply(w)}
              className={cn('group relative aspect-video overflow-hidden rounded-xl bg-white/[0.04] text-left ring-1 transition', active ? 'ring-2 ring-accent' : 'ring-line hover:ring-line-strong')}
            >
              {w.preview && <img src={fileUrl(w.preview)} loading="lazy" className="absolute inset-0 size-full object-cover transition-transform duration-700 group-hover:scale-105" />}
              <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent p-2 pt-6">
                <div className="truncate text-[11px] font-medium text-white">{w.title}</div>
              </div>
              <div className="absolute top-1.5 left-1.5 flex gap-1">
                <Badge className="bg-black/50 text-white/85 backdrop-blur">
                  {TYPE_ICON[w.type]} {w.type}
                </Badge>
              </div>
              {w.schemeColor && <span className="absolute top-2 right-2 size-3 rounded-full ring-2 ring-black/40" style={{ background: w.schemeColor }} />}
              {active && (
                <span className="absolute right-2 bottom-2 grid size-5 place-items-center rounded-full bg-accent text-accent-fg">
                  <Check className="size-3" strokeWidth={3} />
                </span>
              )}
            </motion.button>
          )
        })}
      </div>
      <p className="mt-2 text-[11.5px] text-fg-3">Video and web wallpapers play live. Scene wallpapers use their animated preview (the scene format is proprietary).</p>
    </div>
  )
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }): React.JSX.Element {
  return (
    <label className="flex items-center gap-3 rounded-xl border border-line bg-white/[0.03] p-2.5">
      <span className="relative size-9 overflow-hidden rounded-lg ring-1 ring-white/15" style={{ background: value }}>
        <input type="color" value={value} onChange={(e) => onChange(e.target.value)} className="absolute inset-0 size-full cursor-pointer opacity-0" />
      </span>
      <div>
        <div className="label-caps">{label}</div>
        <div className="font-mono text-[12px] text-fg-2 uppercase">{value}</div>
      </div>
    </label>
  )
}

export function AppearanceSettings(): React.JSX.Element {
  const settings = useAppSettings()
  const update = useSettings((s) => s.update)
  const theme = settings.theme
  const bg = theme.background
  const [source, setSource] = useState<Source>(sourceOf(bg))
  const [busy, setBusy] = useState(false)

  const setTheme = (patch: Partial<ThemeSettings>): Promise<unknown> => update({ theme: patch })

  /** Apply a background and (in auto mode) recolour from it. */
  const applyBackground = async (next: BackgroundSettings, preview?: string, scheme?: string): Promise<void> => {
    setBusy(true)
    try {
      const patch: Partial<ThemeSettings> = { background: next }
      if (theme.accentMode === 'auto') {
        if (next.type === 'gradient' || next.type === 'none') Object.assign(patch, SUNSET)
        else {
          const picked = await accentsForBackground(next, preview, scheme)
          if (picked) Object.assign(patch, picked)
        }
      }
      await setTheme(patch)
    } catch (err) {
      toast.error('Could not apply background', errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-8">
      <div>
        <SectionTitle icon={<ImageIcon />} action={busy && <Spinner className="size-4 text-fg-3" />}>
          Background
        </SectionTitle>
        <div className="mt-4">
          <Segmented
            value={source}
            onChange={(s) => {
              setSource(s)
              if (s === 'sunset') void applyBackground({ type: 'gradient', dim: 0.35, blur: 0 })
              if (s === 'plain') void applyBackground({ type: 'none', dim: 0, blur: 0 })
            }}
            items={[
              { value: 'sunset', label: 'Sunset', icon: <Sparkles /> },
              { value: 'wallpaper', label: 'Wallpaper Engine', icon: <Film /> },
              { value: 'custom', label: 'Custom', icon: <Upload /> },
              { value: 'plain', label: 'Plain', icon: <Paintbrush /> }
            ]}
          />
        </div>
        <AnimatePresence mode="wait">
          <motion.div key={source} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.25 }} className="mt-4">
            {source === 'sunset' && (
              <div className="flex h-24 overflow-hidden rounded-2xl ring-1 ring-line">
                {SUNSET_STOPS.map((c) => (
                  <div key={c} className="flex-1" style={{ background: c }} />
                ))}
              </div>
            )}
            {source === 'wallpaper' && (
              <WallpaperGallery
                current={bg.wallpaperId}
                onApply={async (w) => {
                  const r = await invoke('wallpaper:apply', w.id)
                  // Coming from the built-in gradient: start light so the wallpaper shines through.
                  const fresh = !bg.wallpaperId
                  if (fresh) await setTheme({ glass: -1, glassBlur: -1 }) // -1 = automatic
                  await applyBackground({ ...r.background, dim: fresh ? r.background.dim : bg.dim, blur: bg.blur }, w.preview, r.schemeColor)
                }}
              />
            )}
            {source === 'custom' && (
              <div className="flex items-center gap-3">
                <Button
                  icon={<Upload className="size-3.5" />}
                  onClick={async () => {
                    const r = await invoke('wallpaper:pickCustom')
                    if (r) await applyBackground(r.background)
                  }}
                >
                  Choose image or video
                </Button>
                {bg.path && !bg.wallpaperId && <span className="truncate text-[12px] text-fg-3">{bg.path}</span>}
              </div>
            )}
          </motion.div>
        </AnimatePresence>
        {bg.type !== 'none' && (
          <div className="mt-5 grid grid-cols-2 gap-x-6 gap-y-5">
            <SliderField label="Dim" help="Darkens the background itself." value={Math.round(bg.dim * 100)} min={0} max={90} format={(v) => `${v}%`} defaultValue={bg.type === 'gradient' ? 35 : 18} onChange={(v) => void setTheme({ background: { ...bg, dim: v / 100 } })} />
            <SliderField label="Background blur" help="Softens the whole background." value={bg.blur} min={0} max={40} format={(v) => `${v}px`} defaultValue={0} onChange={(v) => void setTheme({ background: { ...bg, blur: v } })} />
            <SliderField
              label="Glass opacity"
              help="Lower lets the background show through Stitch's panels."
              value={Math.round(glassFor(theme) * 100)}
              min={20}
              max={95}
              format={(v) => `${v}%`}
              defaultValue={Math.round(glassFor({ ...theme, glass: -1 }) * 100)}
              onChange={(v) => void setTheme({ glass: v / 100 })}
            />
            <SliderField
              label="Frost"
              help="How much the glass diffuses what's behind it."
              value={blurFor(theme)}
              min={0}
              max={40}
              format={(v) => `${v}px`}
              defaultValue={blurFor({ ...theme, glassBlur: -1 })}
              onChange={(v) => void setTheme({ glassBlur: v })}
            />
          </div>
        )}
      </div>

      <div>
        <SectionTitle icon={<Palette />}>Accent colour</SectionTitle>
        <div className="mt-4 flex items-center gap-3">
          <Segmented
            value={theme.accentMode}
            onChange={async (m) => {
              await setTheme({ accentMode: m })
              if (m === 'auto') await applyBackground(bg, undefined, undefined)
            }}
            items={[
              { value: 'auto', label: 'From background', icon: <Wand2 /> },
              { value: 'manual', label: 'Choose my own', icon: <Paintbrush /> }
            ]}
          />
        </div>
        <motion.div variants={stagger(0.04)} initial="initial" animate="animate" className="mt-4 grid grid-cols-3 gap-3">
          <motion.div variants={rise}>
            <ColorField label="Primary" value={theme.accent} onChange={(v) => void setTheme({ accentMode: 'manual', accent: v })} />
          </motion.div>
          <motion.div variants={rise}>
            <ColorField label="Secondary" value={theme.accent2} onChange={(v) => void setTheme({ accentMode: 'manual', accent2: v })} />
          </motion.div>
          <motion.div variants={rise} className="flex items-center gap-3 rounded-xl border border-line p-2.5">
            <div className="h-9 flex-1 rounded-lg bg-grad" />
            <Button size="sm" variant="primary">
              Preview
            </Button>
          </motion.div>
        </motion.div>
        <div className="mt-4">
          <div className="label-caps mb-2">Sunset swatches</div>
          <div className="flex flex-wrap gap-2">
            {SUNSET_STOPS.slice(0, 9).map((c) => (
              <button
                key={c}
                onClick={() => void setTheme({ accentMode: 'manual', accent: tuneAccent(c), tint: tintFrom(c) })}
                className="size-8 rounded-full ring-2 ring-transparent transition hover:scale-110 hover:ring-white/30"
                style={{ background: c }}
                title={c}
              />
            ))}
            <button onClick={() => void setTheme({ accentMode: 'manual', ...SUNSET })} className="h-8 rounded-full border border-line px-3 text-[11.5px] font-medium text-fg-2 hover:text-fg">
              Reset to sunset
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
