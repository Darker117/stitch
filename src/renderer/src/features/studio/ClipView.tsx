// A clip on the timeline: filmstrip for video, repeated still for images,
// waveform for audio (and under video with sound), a label for titles.
import { memo, useMemo } from 'react'
import { AudioLines, Film, ImageIcon, Type, VolumeX } from 'lucide-react'
import type { Asset, TimelineClip } from '@shared/types'
import { fileUrl } from '@/lib/api'
import { cn } from '@/lib/utils'
import { frameAt, useFrames, usePeaks, type Peaks } from './media-cache'
import { clipDur, type ClipKind } from './model'

export interface ClipViewProps {
  clip: TimelineClip
  asset: Asset | undefined
  kind: ClipKind
  zoom: number
  height: number
  selected: boolean
  dragging: boolean
  locked: boolean
  dimmed: boolean
}

const TONE: Record<ClipKind, string> = {
  video: 'var(--accent-2)',
  image: 'color-mix(in oklab, var(--accent-2) 55%, var(--accent))',
  audio: 'var(--accent)',
  text: 'color-mix(in oklab, var(--accent) 45%, #ffffff)'
}

function Waveform({ peaks, clip, className, color }: { peaks: Peaks; clip: TimelineClip; className?: string; color: string }): React.JSX.Element {
  const x = clip.in * peaks.rate
  const w = Math.max(0.001, clipDur(clip) * peaks.rate)
  return (
    <svg className={cn('pointer-events-none block', className)} viewBox={`${x} 0 ${w} 1`} preserveAspectRatio="none">
      <path d={peaks.path} fill={color} />
    </svg>
  )
}

function Filmstrip({ clip, asset, zoom, height }: { clip: TimelineClip; asset: Asset; zoom: number; height: number }): React.JSX.Element {
  const frames = useFrames(asset)
  const width = clipDur(clip) * zoom
  const aspect = frames?.aspect ?? (asset.width && asset.height ? asset.width / asset.height : 16 / 9)
  const tileW = Math.max(24, height * aspect)
  const count = Math.min(300, Math.max(1, Math.ceil(width / tileW)))
  const poster = asset.thumbPath ? fileUrl(asset.thumbPath) : ''
  const tiles = useMemo(() => {
    const out: string[] = []
    for (let i = 0; i < count; i++) {
      const t = clip.in + ((i + 0.5) * tileW) / zoom
      out.push((frames && frameAt(frames, t)) || poster)
    }
    return out
  }, [count, clip.in, tileW, zoom, frames, poster])
  return (
    <div className="absolute inset-0 flex overflow-hidden">
      {tiles.map((url, i) => (
        <div
          key={i}
          className="h-full shrink-0 border-r border-black/40 bg-cover bg-center"
          style={{ width: tileW, backgroundImage: url ? `url("${url}")` : undefined, backgroundColor: 'rgb(0 0 0 / 0.35)' }}
        />
      ))}
    </div>
  )
}

function StillStrip({ asset, width, height }: { asset: Asset; width: number; height: number }): React.JSX.Element {
  const aspect = asset.width && asset.height ? asset.width / asset.height : 16 / 9
  const tileW = Math.max(24, height * aspect)
  return (
    <div
      className="absolute inset-0 bg-repeat-x"
      style={{ backgroundImage: `url("${fileUrl(asset.path)}")`, backgroundSize: `${tileW}px 100%`, width, backgroundColor: 'rgb(0 0 0 / 0.35)' }}
    />
  )
}

export const ClipView = memo(function ClipView({ clip, asset, kind, zoom, height, selected, dragging, locked, dimmed }: ClipViewProps): React.JSX.Element {
  const width = Math.max(2, clipDur(clip) * zoom)
  const peaks = usePeaks(asset, kind === 'audio' || kind === 'video')
  const tone = TONE[kind]
  const name = clip.text ? clip.text.content.split('\n')[0] || 'Title' : (asset?.name ?? 'Missing media')
  const showWaveUnder = kind === 'video' && !!peaks && height >= 48
  const fi = Math.min(clip.fadeIn ?? 0, clipDur(clip) / 2) * zoom
  const fo = Math.min(clip.fadeOut ?? 0, clipDur(clip) / 2) * zoom
  const muted = clip.muted || clip.volume <= 0

  return (
    <div
      className={cn(
        'absolute inset-0 overflow-hidden rounded-[7px] transition-[box-shadow,filter,opacity] duration-150',
        dragging && 'shadow-[0_14px_30px_-10px_rgb(0_0_0/0.9)]',
        dimmed && 'opacity-45',
        locked && 'saturate-[0.35]'
      )}
      style={{
        background: `color-mix(in oklab, ${tone} ${kind === 'audio' ? 16 : 22}%, #0b0a10)`,
        boxShadow: selected
          ? `inset 0 0 0 1.5px ${tone}, 0 0 0 1px color-mix(in oklab, ${tone} 40%, transparent), 0 6px 22px -8px color-mix(in oklab, ${tone} 75%, transparent)`
          : `inset 0 0 0 1px color-mix(in oklab, ${tone} 42%, transparent)`
      }}
    >
      {asset && kind === 'video' && <Filmstrip clip={clip} asset={asset} zoom={zoom} height={showWaveUnder ? height - 14 : height} />}
      {asset && kind === 'image' && <StillStrip asset={asset} width={width} height={height} />}
      {(kind === 'video' || kind === 'image') && <div className="pointer-events-none absolute inset-x-0 top-0 h-5 bg-gradient-to-b from-black/70 to-transparent" />}

      {kind === 'audio' && (
        <>
          <div className="absolute inset-0" style={{ background: `linear-gradient(180deg, color-mix(in oklab, ${tone} 16%, transparent), transparent 70%)` }} />
          {peaks ? (
            <Waveform peaks={peaks} clip={clip} className="absolute inset-x-0 top-[16px] bottom-[3px] h-[calc(100%-19px)] w-full" color={`color-mix(in oklab, ${tone} 88%, #fff)`} />
          ) : (
            <div className="absolute inset-x-2 top-1/2 h-px bg-[color-mix(in_oklab,var(--accent)_45%,transparent)]" />
          )}
        </>
      )}

      {showWaveUnder && (
        <div className="absolute inset-x-0 bottom-0 h-[14px] border-t border-black/40 bg-black/55">
          <Waveform peaks={peaks!} clip={clip} className="h-full w-full" color={`color-mix(in oklab, ${TONE.audio} 72%, transparent)`} />
        </div>
      )}

      {kind === 'text' && (
        <div className="absolute inset-0" style={{ background: `repeating-linear-gradient(135deg, transparent 0 7px, color-mix(in oklab, ${tone} 7%, transparent) 7px 8px)` }} />
      )}

      {/* fades */}
      {fi > 1 && (
        <svg className="pointer-events-none absolute top-0 left-0 h-full" style={{ width: fi }} viewBox="0 0 10 10" preserveAspectRatio="none">
          <path d="M0,10 L10,0 L0,0 Z" fill="rgb(0 0 0 / 0.45)" />
          <path d="M0,10 L10,0" stroke="rgb(255 255 255 / 0.55)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        </svg>
      )}
      {fo > 1 && (
        <svg className="pointer-events-none absolute top-0 right-0 h-full" style={{ width: fo }} viewBox="0 0 10 10" preserveAspectRatio="none">
          <path d="M0,0 L10,10 L10,0 Z" fill="rgb(0 0 0 / 0.45)" />
          <path d="M0,0 L10,10" stroke="rgb(255 255 255 / 0.55)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        </svg>
      )}

      {/* label */}
      {width > 26 && (
        <div className={cn('pointer-events-none absolute top-0 left-0 flex max-w-full items-center gap-1 px-1.5 pt-[3px] text-[10.5px] leading-none font-medium', kind === 'text' || kind === 'audio' ? 'text-fg' : 'text-white')}>
          <span className="shrink-0 opacity-80 [&>svg]:size-2.5">
            {kind === 'video' ? <Film /> : kind === 'image' ? <ImageIcon /> : kind === 'audio' ? <AudioLines /> : <Type />}
          </span>
          {width > 60 && <span className="truncate drop-shadow-[0_1px_1px_rgb(0_0_0/0.8)]">{name}</span>}
          {muted && kind !== 'image' && kind !== 'text' && <VolumeX className="size-2.5 shrink-0 text-danger" />}
        </div>
      )}
    </div>
  )
})
