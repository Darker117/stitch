// Backgrounds (sunset, Wallpaper Engine, custom) and accent colours.
import { useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Film, ImageIcon, Paintbrush, Palette, Sparkles, Upload, Wand2 } from 'lucide-react'
import type { BackgroundSettings, ThemeSettings } from '@shared/types'
import { SUNSET, SUNSET_STOPS, tintFrom, tuneAccent } from '@shared/theme'
import { errorText, invoke } from '@/lib/api'
import { accentsForBackground, blurFor, glassFor } from '@/lib/theme'
import { isPhone } from '@/lib/platform'
import { rise, stagger } from '@/lib/motion'
import { Button } from '@/components/ui/button'
import { Segmented, SliderField, SwitchRow } from '@/components/ui/controls'
import { SectionTitle, Spinner } from '@/components/ui/misc'
import { useAppSettings, useSettings } from '@/stores/settings'
import { toast } from '@/stores/toast'
import { WallpaperPicker } from './wallpaper/WallpaperPicker'

type Source = 'sunset' | 'wallpaper' | 'custom' | 'plain'

/** Phone: segmented controls stretch to the full width with equal segments. */
const segFull = 'max-md:flex max-md:w-full max-md:[&>button]:h-9 max-md:[&>button]:min-w-0 max-md:[&>button]:flex-1 max-md:[&>button]:justify-center max-md:[&>button]:px-1.5'
/** Phone: the four background sources sit in a 2×2 grid (the highlight still glides between them). */
const segGrid = 'max-md:grid max-md:w-full max-md:grid-cols-2 max-md:[&>button]:h-9 max-md:[&>button]:justify-center max-md:[&>button]:px-2 max-md:[&>button]:whitespace-nowrap'

function sourceOf(bg: BackgroundSettings): Source {
  if (bg.type === 'gradient') return 'sunset'
  if (bg.type === 'none') return 'plain'
  return bg.wallpaperId ? 'wallpaper' : 'custom'
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }): React.JSX.Element {
  return (
    <label className="flex items-center gap-3 rounded-xl border border-line bg-white/[0.03] p-2.5 max-md:min-w-0">
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
  const [applying, setApplying] = useState<string>()

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

  /** Wallpaper Engine item → background. Scenes are read (and cached) first, which can take a moment. */
  const applyWallpaper = async (id: string): Promise<void> => {
    if (applying) return
    setApplying(id)
    try {
      const r = await invoke('wallpaper:apply', id)
      // Coming from the built-in gradient: start light so the wallpaper shines through.
      const fresh = !bg.wallpaperId
      if (fresh) await setTheme({ glass: -1, glassBlur: -1 }) // -1 = automatic
      await applyBackground({ ...r.background, dim: fresh ? r.background.dim : bg.dim, blur: bg.blur, audio: bg.audio }, r.background.preview, r.schemeColor)
    } catch (err) {
      toast.error('Could not apply wallpaper', errorText(err))
    } finally {
      setApplying(undefined)
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
            className={segGrid}
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
              <div className="flex h-24 overflow-hidden rounded-2xl ring-1 ring-line max-md:h-16">
                {SUNSET_STOPS.map((c) => (
                  <div key={c} className="flex-1" style={{ background: c }} />
                ))}
              </div>
            )}
            {source === 'wallpaper' && (
              <WallpaperPicker current={bg.wallpaperId} applying={applying} onApply={(id) => void applyWallpaper(id)} />
            )}
            {source === 'custom' && (
              <div className="flex items-center gap-3 max-md:flex-col max-md:items-stretch max-md:gap-2">
                <Button
                  className="max-md:w-full"
                  icon={<Upload className="size-3.5" />}
                  onClick={async () => {
                    const r = await invoke('wallpaper:pickCustom')
                    if (r) await applyBackground(r.background)
                  }}
                >
                  Choose image or video
                </Button>
                {bg.path && !bg.wallpaperId && <span className="truncate text-[12px] text-fg-3 max-md:text-center">{bg.path}</span>}
              </div>
            )}
          </motion.div>
        </AnimatePresence>
        {source === 'wallpaper' && !isPhone && (
          <div className="mt-4">
            <SwitchRow
              label="React to what's playing"
              help="Audio-reactive wallpapers follow this PC's sound. It's analysed on the spot, never recorded or sent anywhere."
              checked={bg.audio !== false}
              onChange={(v) => void setTheme({ background: { ...bg, audio: v } })}
            />
          </div>
        )}
        {bg.type !== 'none' && (
          <div className="mt-5 grid grid-cols-2 gap-x-6 gap-y-5 max-md:grid-cols-1 max-md:gap-y-6">
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
            className={segFull}
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
        <motion.div variants={stagger(0.04)} initial="initial" animate="animate" className="mt-4 grid grid-cols-3 gap-3 max-md:grid-cols-2 max-md:gap-2.5">
          <motion.div variants={rise}>
            <ColorField label="Primary" value={theme.accent} onChange={(v) => void setTheme({ accentMode: 'manual', accent: v })} />
          </motion.div>
          <motion.div variants={rise}>
            <ColorField label="Secondary" value={theme.accent2} onChange={(v) => void setTheme({ accentMode: 'manual', accent2: v })} />
          </motion.div>
          <motion.div variants={rise} className="flex items-center gap-3 rounded-xl border border-line p-2.5 max-md:col-span-2">
            <div className="h-9 flex-1 rounded-lg bg-grad" />
            <Button size="sm" variant="primary">
              Preview
            </Button>
          </motion.div>
        </motion.div>
        <div className="mt-4">
          <div className="label-caps mb-2">Sunset swatches</div>
          <div className="flex flex-wrap gap-2 max-md:gap-2.5">
            {SUNSET_STOPS.slice(0, 9).map((c) => (
              <button
                key={c}
                onClick={() => void setTheme({ accentMode: 'manual', accent: tuneAccent(c), tint: tintFrom(c) })}
                className="size-8 rounded-full ring-2 ring-transparent transition hover:scale-110 hover:ring-white/30 max-md:size-9"
                style={{ background: c }}
                title={c}
              />
            ))}
            <button onClick={() => void setTheme({ accentMode: 'manual', ...SUNSET })} className="h-8 rounded-full border border-line px-3 text-[11.5px] font-medium text-fg-2 hover:text-fg max-md:h-9">
              Reset to sunset
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
