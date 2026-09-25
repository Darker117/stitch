// Shared visuals for models: coloured kind tags, base-model tags, NSFW-aware
// thumbnails (local sidecar previews and Civitai CDN media), keyword chips.
import { useState, type CSSProperties, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Aperture, Box, Check, Copy, Cpu, Eye, EyeOff, File, Hash, Layers, Maximize2, Play, Type, Waypoints } from 'lucide-react'
import type { CivitaiImage, LocalModel, ModelKind, ModelMeta } from '@shared/types'
import { baseFamily, civitaiImageVariant } from '@shared/civitai'
import { fileUrl } from '@/lib/api'
import { blurhashUrl } from '@/lib/blurhash'
import { cn } from '@/lib/utils'
import { ease } from '@/lib/motion'
import { useSettings } from '@/stores/settings'
import { toast } from '@/stores/toast'

// ─── Kinds ───────────────────────────────────────────────────────────────────

/** Categorical hues (oklch) — one tonal family so the tags read as a set. */
export const KIND_META: Record<ModelKind, { label: string; hue: number; chroma?: number; icon: ReactNode }> = {
  checkpoint: { label: 'Checkpoint', hue: 60, icon: <Box /> },
  unet: { label: 'UNet', hue: 295, icon: <Cpu /> },
  lora: { label: 'LoRA', hue: 350, icon: <Layers /> },
  controlnet: { label: 'ControlNet', hue: 215, icon: <Waypoints /> },
  vae: { label: 'VAE', hue: 150, icon: <Aperture /> },
  textencoder: { label: 'Text encoder', hue: 255, icon: <Type /> },
  embedding: { label: 'Embedding', hue: 100, icon: <Hash /> },
  upscaler: { label: 'Upscaler', hue: 185, icon: <Maximize2 /> },
  clipvision: { label: 'CLIP vision', hue: 22, icon: <Eye /> },
  other: { label: 'Other', hue: 280, chroma: 0.01, icon: <File /> }
}

export function kindColor(kind: ModelKind, l = 0.82, alpha = 1): string {
  const k = KIND_META[kind]
  return `oklch(${l} ${k.chroma ?? 0.13} ${k.hue}${alpha < 1 ? ` / ${alpha}` : ''})`
}

export function kindTone(kind: ModelKind, active = true): CSSProperties {
  return active
    ? { color: kindColor(kind, 0.86), background: kindColor(kind, 0.7, 0.16), borderColor: kindColor(kind, 0.75, 0.34) }
    : { color: 'var(--fg-3)', background: 'transparent', borderColor: 'var(--line)' }
}

export function KindTag({ kind, className, icon }: { kind: ModelKind; className?: string; icon?: boolean }): React.JSX.Element {
  return (
    <span className={cn('inline-flex h-5 shrink-0 items-center gap-1 rounded-md border px-1.5 text-[10.5px] font-semibold tracking-wide whitespace-nowrap [&>svg]:size-2.5', className)} style={kindTone(kind)}>
      {icon ? KIND_META[kind].icon : <span className="size-1.5 rounded-full" style={{ background: kindColor(kind, 0.8) }} />}
      {KIND_META[kind].label}
    </span>
  )
}

function familyHue(base: string): number {
  const fam = baseFamily(base)
  let h = 0
  for (const c of fam) h = (h * 31 + c.charCodeAt(0)) % 360
  return h
}

export function BaseTag({ base, className }: { base?: string; className?: string }): React.JSX.Element {
  if (!base)
    return (
      <span className={cn('inline-flex h-5 shrink-0 items-center rounded-md border border-dashed border-line-strong px-1.5 text-[10.5px] font-medium whitespace-nowrap text-fg-3', className)}>
        Unknown base
      </span>
    )
  return (
    <span className={cn('inline-flex h-5 max-w-full shrink-0 items-center gap-1 rounded-md border border-line bg-white/[0.06] px-1.5 text-[10.5px] font-medium whitespace-nowrap text-fg-2', className)} title={base}>
      <span className="size-1.5 shrink-0 rounded-full" style={{ background: `oklch(0.8 0.12 ${familyHue(base)})` }} />
      <span className="truncate">{base}</span>
    </span>
  )
}

// ─── NSFW ────────────────────────────────────────────────────────────────────

export function useHideNsfw(): boolean {
  return useSettings((s) => s.settings?.civitai?.hideNsfw ?? true)
}

const MATURE =
  /\b(nsfw|nude|nudity|naked|porn\w*|hentai|sex|sexy|explicit|uncensored|erotic\w*|lewd|ecchi|nipples?|pussy|vagina\w*|penis|anal|anus|oral|cum\w*|creampie|missionary|doggy\w*|cowgirl|blowjob|futa\w*|xxx|r-?18|genitals?|topless|lingerie|bdsm|fetish|after sex)\b/i

/**
 * Is a local preview NSFW? `previewNsfwLevel` is the preview image's Civitai
 * rating — written by Stitch into its own sidecars, or looked up in the
 * background for Stability Matrix previews (whose model flag is unreliable).
 * Until that lookup lands the preview stays hidden; if it was inconclusive
 * (0), fall back to the model's flag, tags and name.
 */
export function localPreviewIsNsfw(meta: ModelMeta | undefined): boolean {
  if (!meta?.previewPath) return false
  if (meta.previewNsfwLevel && meta.previewNsfwLevel > 0) return meta.previewNsfwLevel >= 4
  if (meta.source !== 'civitai') return false
  if (meta.previewNsfwLevel === undefined) return true
  return meta.nsfw || MATURE.test(`${meta.name} ${meta.tags.join(' ')}`)
}

/** Civitai levels: 1 PG, 2 PG-13, 4 R, 8 X, 16 XXX. Unrated images follow the model. */
export function civitaiImageIsNsfw(img: CivitaiImage, modelNsfw: boolean): boolean {
  return img.nsfwLevel > 0 ? img.nsfwLevel >= 4 : modelNsfw
}

function Veil({ onReveal, compact }: { onReveal?: () => void; compact?: boolean }): React.JSX.Element {
  if (compact)
    return (
      <div className="absolute inset-0 grid place-items-center bg-black/25" title="Hidden: NSFW">
        <span className="grid size-5 place-items-center rounded-full bg-black/45 text-white/85 backdrop-blur-md">
          <EyeOff className="size-2.5" />
        </span>
      </div>
    )
  return (
    <div className="absolute inset-0 grid place-items-center bg-black/25">
      <div className="flex flex-col items-center gap-1.5">
        <span className="inline-flex h-5.5 items-center gap-1 rounded-md border border-white/15 bg-black/45 px-1.5 text-[10px] font-semibold tracking-wider text-white/90 backdrop-blur-md">
          <EyeOff className="size-3" /> NSFW
        </span>
        {onReveal && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              onReveal()
            }}
            className="rounded-md px-1.5 py-0.5 text-[10.5px] font-medium text-white/70 transition hover:bg-white/10 hover:text-white"
          >
            Show
          </button>
        )}
      </div>
    </div>
  )
}

// ─── Thumbnails ──────────────────────────────────────────────────────────────

export function KindPlaceholder({ kind, className, compact }: { kind: ModelKind; className?: string; compact?: boolean }): React.JSX.Element {
  const { hue, chroma = 0.13 } = KIND_META[kind]
  return (
    <div
      className={cn('grid size-full place-items-center', className)}
      style={{ background: `radial-gradient(130% 95% at 28% 12%, oklch(0.34 ${chroma * 0.55} ${hue} / 0.95), oklch(0.18 ${chroma * 0.25} ${hue} / 0.96) 72%)` }}
    >
      <span
        className={cn('grid place-items-center rounded-2xl', compact ? '[&>svg]:size-3.5' : 'size-14 border border-white/[0.07] bg-white/[0.04] [&>svg]:size-6')}
        style={{ color: kindColor(kind, 0.82, 0.8) }}
      >
        {KIND_META[kind].icon}
      </span>
    </div>
  )
}

const isVideo = (p?: string): boolean => !!p && /\.(mp4|webm)$/i.test(p)

/** Local model preview (cached thumbnail), blurred with a badge when hidden. */
export function ModelThumb({
  model,
  className,
  full,
  allowReveal,
  compact
}: {
  model: LocalModel
  className?: string
  /** Use the full-size preview instead of the cached thumbnail. */
  full?: boolean
  allowReveal?: boolean
  compact?: boolean
}): React.JSX.Element {
  const hide = useHideNsfw()
  const [revealed, setRevealed] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const meta = model.meta
  const src = full ? (meta?.previewPath ?? meta?.thumbPath) : (meta?.thumbPath ?? meta?.previewPath)
  const hidden = hide && !revealed && localPreviewIsNsfw(meta)
  if (!src) return <div className={cn('relative overflow-hidden', className)}><KindPlaceholder kind={model.kind} compact={compact} /></div>
  return (
    <div className={cn('relative overflow-hidden bg-white/[0.04]', className)}>
      {isVideo(src) ? (
        <video src={fileUrl(src)} muted loop autoPlay={!hidden} playsInline className={cn('size-full object-cover transition-[filter,transform] duration-500', hidden && 'scale-125 blur-2xl saturate-150')} />
      ) : (
        <img
          src={fileUrl(src)}
          alt=""
          draggable={false}
          loading="lazy"
          decoding="async"
          onLoad={() => setLoaded(true)}
          className={cn('size-full object-cover transition-[opacity,filter,transform] duration-500', loaded ? 'opacity-100' : 'opacity-0', hidden && 'scale-125 blur-2xl saturate-150')}
        />
      )}
      {!loaded && !isVideo(src) && <div className="shimmer absolute inset-0" />}
      <AnimatePresence>
        {hidden && (
          <motion.div key="veil" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.3, ease }} className="absolute inset-0">
            <Veil compact={compact} onReveal={allowReveal ? () => setRevealed(true) : undefined} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

/**
 * Civitai image or video. Hidden NSFW media is never loaded — its blurhash is
 * painted instead. `play` autoplays videos (detail views); grids get a still.
 */
export function CivitaiMedia({
  image,
  modelNsfw,
  width = 450,
  className,
  play,
  allowReveal,
  fit = 'cover',
  compact,
  kind = 'other'
}: {
  image: CivitaiImage | undefined
  kind?: ModelKind
  modelNsfw: boolean
  width?: number
  className?: string
  play?: boolean
  allowReveal?: boolean
  fit?: 'cover' | 'contain'
  compact?: boolean
}): React.JSX.Element {
  const hide = useHideNsfw()
  const [revealed, setRevealed] = useState(false)
  const [loaded, setLoaded] = useState(false)
  if (!image) return <div className={cn('relative overflow-hidden', className)}><KindPlaceholder kind={kind} compact={compact} /></div>
  const hidden = hide && !revealed && civitaiImageIsNsfw(image, modelNsfw)
  const blur = blurhashUrl(image.hash)
  const video = image.type === 'video'
  const obj = fit === 'cover' ? 'object-cover' : 'object-contain'
  return (
    <div className={cn('relative overflow-hidden bg-white/[0.04]', className)}>
      {blur && <img src={blur} alt="" draggable={false} className={cn('absolute inset-0 size-full object-cover transition-opacity duration-500', hidden ? 'scale-110 opacity-100 blur-md' : loaded ? 'opacity-0' : 'opacity-100')} />}
      {!blur && !loaded && !hidden && <div className="shimmer absolute inset-0" />}
      {hidden && !blur && <div className="absolute inset-0 bg-gradient-to-br from-white/[0.08] to-white/[0.02]" />}
      {!hidden &&
        (video && play ? (
          <video
            src={civitaiImageVariant(image.url, { width })}
            poster={civitaiImageVariant(image.url, { width, poster: true })}
            muted
            loop
            autoPlay
            playsInline
            onLoadedData={() => setLoaded(true)}
            className={cn('relative size-full transition-opacity duration-500', obj, loaded ? 'opacity-100' : 'opacity-0')}
          />
        ) : (
          <img
            src={civitaiImageVariant(image.url, { width, poster: video, optimized: true })}
            alt=""
            draggable={false}
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            onLoad={() => setLoaded(true)}
            className={cn('relative size-full transition-opacity duration-500', obj, loaded ? 'opacity-100' : 'opacity-0')}
          />
        ))}
      {video && !hidden && !play && (
        <span className="absolute top-2 right-2 grid size-5 place-items-center rounded-full bg-black/45 text-white/90 backdrop-blur">
          <Play className="size-2.5 fill-current" />
        </span>
      )}
      <AnimatePresence>
        {hidden && (
          <motion.div key="veil" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.3, ease }} className="absolute inset-0">
            <Veil compact={compact} onReveal={allowReveal ? () => setRevealed(true) : undefined} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ─── Keywords ────────────────────────────────────────────────────────────────

export async function copyText(text: string, label = 'Copied'): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(label, text.length > 80 ? `${text.slice(0, 80)}…` : text)
  } catch {
    toast.error("Couldn't copy to the clipboard")
  }
}

/** Activation keyword chip: copies by default, or runs `onClick` (e.g. insert into a prompt). */
export function WordChip({ word, onClick, className, title }: { word: string; onClick?: (w: string) => void; className?: string; title?: string }): React.JSX.Element {
  const [done, setDone] = useState(false)
  return (
    <motion.button
      whileTap={{ scale: 0.95 }}
      onClick={(e) => {
        e.stopPropagation()
        if (onClick) onClick(word)
        else void navigator.clipboard.writeText(word).catch(() => {})
        setDone(true)
        setTimeout(() => setDone(false), 1100)
      }}
      title={title ?? (onClick ? `Insert “${word}”` : `Copy “${word}”`)}
      className={cn(
        'group/chip inline-flex h-6 max-w-[220px] items-center gap-1 rounded-md border border-[color-mix(in_oklab,var(--accent)_28%,transparent)] bg-[color-mix(in_oklab,var(--accent)_9%,transparent)] px-1.5 font-mono text-[10.5px] text-fg transition-colors hover:border-[color-mix(in_oklab,var(--accent)_50%,transparent)] hover:bg-[color-mix(in_oklab,var(--accent)_16%,transparent)]',
        className
      )}
    >
      <span className="truncate">{word}</span>
      <span className="grid size-3 shrink-0 place-items-center text-fg-3 group-hover/chip:text-accent">
        {done ? <Check className="size-2.5 text-success" /> : onClick ? <span className="text-[10px] leading-none">+</span> : <Copy className="size-2.5" />}
      </span>
    </motion.button>
  )
}

export function formatCount(n: number | undefined): string {
  if (!n) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`
  return String(n)
}

/** Display name for a local model file. */
export function modelTitle(m: LocalModel): string {
  return m.meta?.name ?? m.name.split('/').pop()!.replace(/\.(safetensors|gguf|ckpt|pt|pth|bin|sft)$/i, '')
}
