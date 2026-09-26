// Story covers in the editor and on story cards: upload, library, or paint one
// from the story. Rendering progress comes from the job queue, so it shows
// wherever the story appears — and the cover lands even if you navigate away.
import { useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Images, Palette, Trash2, Upload, WandSparkles, X } from 'lucide-react'
import type { ID } from '@shared/types'
import { Button, IconButton } from '@/components/ui/button'
import { Textarea } from '@/components/ui/input'
import { Popover, PopoverClose } from '@/components/ui/overlay'
import { ProgressBar } from '@/components/ui/misc'
import { AssetPicker, DropZone, pickAndImport } from '@/components/media'
import { pickTextImageRecipe } from '@/lib/characters'
import { cn } from '@/lib/utils'
import { ease } from '@/lib/motion'
import { useGen } from '@/stores/gen'
import { useSettings } from '@/stores/settings'
import type { StoryInfo } from '../engine/ai'
import { cancelCover, COVER_PHASE_LABEL, generateCover, setCover, useCoverProgress, type CoverProgress, type CoverTarget } from '../engine/cover'
import type { StoryDoc } from '../hooks'
import { CoverArt } from './art'

/** Can covers be painted right now? (an image recipe with its models, and ComfyUI running or set to auto-launch) */
export function useCanPaint(): boolean {
  const recipe = useGen((s) => !!pickTextImageRecipe(s.recipes))
  const online = useGen((s) => s.comfy.some((c) => c.online))
  const autoLaunch = useSettings((s) => !!s.settings?.comfyAutoLaunch)
  return recipe && (online || autoLaunch)
}

/** Latent preview, scrim, phase label and progress while a cover renders. */
export function CoverProgressLayer({ progress, compact }: { progress: CoverProgress; compact?: boolean }): React.JSX.Element {
  const running = progress.phase !== 'idle'
  return (
    <>
      <AnimatePresence>
        {running && progress.preview && (
          <motion.img key="pv" src={progress.preview} initial={{ opacity: 0 }} animate={{ opacity: 0.92 }} exit={{ opacity: 0 }} transition={{ duration: 0.4, ease }} className="absolute inset-0 size-full object-cover blur-[2px]" />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {running && (
          <motion.div
            key="run"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.35, ease }}
            className={cn('absolute inset-0 flex flex-col items-center justify-center bg-black/45 backdrop-blur-[2px]', compact ? 'gap-2' : 'gap-3')}
          >
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={progress.phase}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.2, ease }}
                className={cn('flex items-center gap-1.5 font-medium text-white/90', compact ? 'text-[11px]' : 'text-[12.5px]')}
              >
                <WandSparkles className={cn('text-white/80', compact ? 'size-3' : 'size-3.5')} />
                {COVER_PHASE_LABEL[progress.phase as Exclude<CoverProgress['phase'], 'idle'>]}
              </motion.div>
            </AnimatePresence>
            <ProgressBar value={progress.phase === 'painting' ? progress.value : undefined} className={compact ? 'w-24' : 'w-44'} />
            {!compact && progress.job && (
              <button onClick={() => cancelCover(progress)} className="mt-0.5 flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] text-white/55 transition hover:bg-white/10 hover:text-white">
                <X className="size-3" /> Cancel
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}

/** Optional art direction for a painted cover. */
function ArtDirection({ onPaint, disabled, className }: { onPaint: (steer: string) => void; disabled?: boolean; className?: string }): React.JSX.Element {
  const [steer, setSteer] = useState('')
  return (
    <Popover
      align="center"
      side="bottom"
      className="w-[320px] p-3"
      trigger={
        <IconButton label="Paint with art direction" variant="glass" size="sm" disabled={disabled} className={cn('rounded-full bg-black/35 text-white/85 hover:text-white', className)}>
          <Palette className="size-3.5" />
        </IconButton>
      }
    >
      <div className="label-caps px-0.5 pb-2">Art direction</div>
      <Textarea value={steer} onChange={(e) => setSteer(e.target.value)} minRows={3} maxRows={6} placeholder="e.g. watercolour, the lighthouse at dusk, lonely and warm" autoFocus />
      <div className="mt-2.5 flex justify-end">
        <PopoverClose asChild>
          <Button size="sm" variant="primary" icon={<WandSparkles className="size-3.5" />} onClick={() => onPaint(steer)}>
            Paint cover
          </Button>
        </PopoverClose>
      </div>
    </Popover>
  )
}

/** The Details-tab cover: big art with upload / library / paint actions. */
export function CoverEditor({ doc, collection, template, info }: { doc: StoryDoc; collection: 'scenarios' | 'adventures'; template?: string; info: StoryInfo }): React.JSX.Element {
  const target: CoverTarget = useMemo(() => ({ collection, id: doc.id }), [collection, doc.id])
  const progress = useCoverProgress(target)
  const canPaint = useCanPaint()
  const [picker, setPicker] = useState(false)
  const running = progress.phase !== 'idle'
  const has = !!doc.coverAssetId
  const hasStory = !!(info.title.trim() || info.description.trim() || info.opening.trim())

  const upload = async (): Promise<void> => {
    const [a] = await pickAndImport('image', false, { projectId: doc.projectId })
    if (a) await setCover(target, a.id)
  }
  const paint = (steer?: string): void => void generateCover(target, { info, steer })
  const paintHint = !canPaint ? 'Start ComfyUI (Connectors) to paint covers' : !hasStory ? 'Write a title or description first' : undefined

  return (
    <div className="flex flex-col gap-2">
      <DropZone kinds={['image', 'video']} meta={{ projectId: doc.projectId }} onAssets={(a) => a[0] && void setCover(target, a[0].id)} className="rounded-2xl">
        <div className="group relative">
          {/* Phones: the empty state needs more height for its copy and buttons. */}
          <CoverArt coverAssetId={doc.coverAssetId} template={template} title={doc.title} className={cn('aspect-[16/8] w-full rounded-2xl ring-1 ring-line', !has && !running && 'max-md:aspect-[6/5]')}>
            <CoverProgressLayer progress={progress} />
            <AnimatePresence>
              {!has && !running && (
                <motion.div
                  key="empty"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.35, ease }}
                  className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-[linear-gradient(to_top,rgb(0_0_0/0.78),rgb(0_0_0/0.42)_60%,rgb(0_0_0/0.3))] p-6 text-center backdrop-blur-[3px] max-md:p-4"
                >
                  <div className="label-caps text-white/55">No cover yet</div>
                  <div className="font-serif text-[20px] leading-tight font-semibold text-white">Give your story a face</div>
                  <p className="max-w-[400px] text-[12px] leading-relaxed text-white/65">Paint one from your title, description and opening — or upload an image, pick one from your library, or drop it right here.</p>
                  <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
                    <Button size="sm" variant="primary" icon={<WandSparkles className="size-3.5" />} disabled={!!paintHint} onClick={() => paint()} title={paintHint} className="max-md:h-9">
                      Paint from story
                    </Button>
                    <ArtDirection onPaint={paint} disabled={!!paintHint} className="max-md:size-9" />
                    <Button size="sm" variant="glass" icon={<Upload className="size-3.5" />} onClick={() => void upload()} className="bg-black/35 text-white max-md:h-9">
                      Upload
                    </Button>
                    <Button size="sm" variant="glass" icon={<Images className="size-3.5" />} onClick={() => setPicker(true)} className="bg-black/35 text-white max-md:h-9">
                      Library
                    </Button>
                  </div>
                  {paintHint && <div className="mt-0.5 text-[11px] text-white/45">{paintHint}</div>}
                </motion.div>
              )}
            </AnimatePresence>
          </CoverArt>
          <AnimatePresence>
            {has && !running && (
              <motion.div
                key="tools"
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.2, ease }}
                className="absolute top-3 right-3 flex items-center gap-0.5 rounded-full border border-white/10 bg-black/40 p-1 opacity-0 backdrop-blur-md transition-opacity duration-300 group-focus-within:opacity-100 group-hover:opacity-100 max-md:top-2 max-md:right-2 max-md:opacity-100 max-md:[&>button]:size-8"
              >
                <IconButton label={paintHint ?? 'Paint a new cover from the story'} size="sm" disabled={!!paintHint} onClick={() => paint()} className="rounded-full text-white/85 hover:bg-white/15 hover:text-white">
                  <WandSparkles className="size-3.5" />
                </IconButton>
                <ArtDirection onPaint={paint} disabled={!!paintHint} className="border-0 bg-transparent" />
                <IconButton label="Upload an image" size="sm" onClick={() => void upload()} className="rounded-full text-white/85 hover:bg-white/15 hover:text-white">
                  <Upload className="size-3.5" />
                </IconButton>
                <IconButton label="Choose from library" size="sm" onClick={() => setPicker(true)} className="rounded-full text-white/85 hover:bg-white/15 hover:text-white">
                  <Images className="size-3.5" />
                </IconButton>
                <span className="mx-0.5 h-4 w-px bg-white/15" />
                <IconButton label="Remove cover" size="sm" onClick={() => void setCover(target, undefined)} className="rounded-full text-white/85 hover:bg-white/15 hover:text-white">
                  <Trash2 className="size-3.5" />
                </IconButton>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </DropZone>
      <AssetPicker open={picker} onClose={() => setPicker(false)} kinds={['image', 'video']} onPick={(a) => a[0] && void setCover(target, a[0].id)} title="Choose a cover" />
    </div>
  )
}

/** Small cover actions for a story card with no cover yet (and for its menu). */
export function useCoverActions(target: CoverTarget, projectId?: ID): { upload: () => Promise<void>; paint: () => void } {
  return {
    upload: async () => {
      const [a] = await pickAndImport('image', false, { projectId })
      if (a) await setCover(target, a.id)
    },
    paint: () => void generateCover(target)
  }
}
