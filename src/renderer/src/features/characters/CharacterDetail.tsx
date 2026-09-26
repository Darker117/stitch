import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ComponentType } from 'react'
import { useNavigate, useParams } from 'react-router'
import { AnimatePresence, motion } from 'motion/react'
import { AlertTriangle, ArrowLeft, BookOpen, Clapperboard, ImagePlus, Lock, LockOpen, MoreHorizontal, RefreshCw, ScanEye, Sparkles, Trash2, Unlock } from 'lucide-react'
import type { Character, CharacterVoice, SheetSlot } from '@shared/types'
import { errorText, fileUrl, streamLlm } from '@/lib/api'
import { slotsFor, type SlotDef } from '@/lib/characters'
import { defaultLlm } from '@/lib/llm'
import { cn } from '@/lib/utils'
import { ease, rise, stagger } from '@/lib/motion'
import { Page } from '@/components/shell/page'
import { AssetLightbox, DropZone, pickAndImport } from '@/components/media'
import { Button, IconButton } from '@/components/ui/button'
import { Segmented } from '@/components/ui/controls'
import { Textarea } from '@/components/ui/input'
import { Badge, EmptyState, Field, ProgressRing, Spinner } from '@/components/ui/misc'
import { Menu, MenuItem, MenuSeparator, Tooltip } from '@/components/ui/overlay'
import { db, useCollection, useDoc } from '@/stores/db'
import { isActive, useGen } from '@/stores/gen'
import { toast } from '@/stores/toast'
import { Grid, isCharacterGeneration } from './Generations'
import { generateSheet, useSlotJobs } from './sheet'
import { Silhouette } from './Silhouette'

type VoicePickerProps = { value: CharacterVoice | undefined; onChange: (v: CharacterVoice) => void; characterName?: string }
const pickerModules = import.meta.glob<{ VoicePicker: ComponentType<VoicePickerProps> }>('../../components/voice-picker.tsx')
const pickerLoader = Object.values(pickerModules)[0]
const VoicePicker = pickerLoader ? lazy(() => pickerLoader().then((m) => ({ default: m.VoicePicker }))) : null

function SlotTile({ c, def, onOpen }: { c: Character; def: SlotDef; onOpen: (id: string) => void }): React.JSX.Element {
  const jobs = useSlotJobs(c.id)
  const job = jobs[def.slot]
  const assetId = c.sheet[def.slot]
  const asset = useDoc('assets', assetId)
  const busy = job && isActive(job)
  const pct = job?.progress?.max ? job.progress.value / job.progress.max : undefined
  const failed = job?.status === 'error' && !asset

  return (
    <motion.div variants={rise} className="group relative">
      <div
        onClick={() => asset && onOpen(asset.id)}
        className={cn(
          'relative overflow-hidden rounded-xl border bg-[color-mix(in_oklab,var(--panel-solid)_55%,black)] transition-[border-color,transform] duration-300',
          def.slot === 'full-body' ? 'aspect-[9/16]' : def.group === 'expressions' ? 'aspect-square' : 'aspect-[3/4]',
          busy ? 'border-[color-mix(in_oklab,var(--accent)_55%,transparent)]' : 'border-line',
          asset && 'cursor-pointer hover:border-line-strong'
        )}
      >
        <AnimatePresence mode="wait">
          {asset ? (
            <motion.img key={asset.id} src={fileUrl(asset.path)} initial={{ opacity: 0, scale: 1.05, filter: 'blur(8px)' }} animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }} transition={{ duration: 0.7, ease }} className="absolute inset-0 size-full object-cover" />
          ) : busy && job?.preview ? (
            <motion.img key="preview" src={job.preview} initial={{ opacity: 0 }} animate={{ opacity: 0.85 }} className="absolute inset-0 size-full object-cover" />
          ) : (
            <motion.div key="empty" className="absolute inset-x-4 top-4 bottom-7" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
              <Silhouette slot={def.slot} dim={!busy} />
            </motion.div>
          )}
        </AnimatePresence>
        {busy && (
          <div className="absolute inset-0 grid place-items-center bg-black/25">
            <ProgressRing value={pct} size={34} />
          </div>
        )}
        {failed && (
          <Tooltip content={job?.error}>
            <div className="absolute top-2 left-2 grid size-6 place-items-center rounded-md bg-danger/20 text-danger">
              <AlertTriangle className="size-3.5" />
            </div>
          </Tooltip>
        )}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent pt-6 pb-1.5 text-center font-mono text-[9px] tracking-[0.2em] text-white/75 uppercase">{def.label}</div>
      </div>
      {!busy && c.referenceAssetId && (
        <button
          onClick={() => void generateSheet(c, [def.slot]).catch((e) => toast.error('Could not regenerate', errorText(e)))}
          className="absolute top-2 right-2 grid size-7 place-items-center rounded-lg bg-black/55 text-white opacity-0 backdrop-blur transition group-hover:opacity-100 hover:bg-black/75 max-md:top-1.5 max-md:right-1.5 max-md:size-8 max-md:opacity-100"
          title="Regenerate this panel"
        >
          <RefreshCw className="size-3.5" />
        </button>
      )}
    </motion.div>
  )
}

export function CharacterDetail(): React.JSX.Element {
  const { id } = useParams()
  const navigate = useNavigate()
  const c = useDoc('characters', id)
  const ref = useDoc('assets', c?.referenceAssetId)
  const jobs = useSlotJobs(c?.id)
  const assets = useCollection('assets')
  const gens = useMemo(() => (c ? assets.filter((a) => isCharacterGeneration(a, c.id)).sort((a, b) => b.createdAt - a.createdAt) : []), [assets, c?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const [lightbox, setLightbox] = useState<string | null>(null)
  const [describing, setDescribing] = useState(false)
  const [name, setName] = useState(c?.name ?? '')
  const [appearance, setAppearance] = useState(c?.appearance ?? '')
  const [description, setDescription] = useState(c?.description ?? '')
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  useEffect(() => {
    setName(c?.name ?? '')
    setAppearance(c?.appearance ?? '')
    setDescription(c?.description ?? '')
  }, [c?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!c) {
    return (
      <Page>
        <EmptyState className="h-full" title="Character not found" action={<Button onClick={() => navigate('/characters')}>Back to characters</Button>} />
      </Page>
    )
  }

  const patch = (p: Partial<Character>): void => {
    void db.patch('characters', c.id, { ...p, updatedAt: Date.now() })
  }
  const patchDebounced = (p: Partial<Character>): void => {
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => patch(p), 350)
  }

  const slots = slotsFor(c.sheetDetail)
  const filled = slots.filter((s) => c.sheet[s.slot]).length
  const running = Object.values(jobs).filter((j) => j && isActive(j)).length
  const groups: { key: SlotDef['group']; title: string }[] = [
    { key: 'angles', title: 'Angles' },
    { key: 'expressions', title: 'Expressions' },
    { key: 'lighting', title: 'Lighting' }
  ]

  const describe = async (): Promise<void> => {
    const llm = defaultLlm()
    if (!llm || !ref) return
    setDescribing(true)
    try {
      const h = streamLlm(
        {
          connectorId: llm.connectorId,
          model: llm.model,
          system: 'You write compact visual descriptions of characters for image prompts. One paragraph, 40–70 words: apparent age, build, face, eyes, hair, skin, outfit, accessories, distinctive marks. No names, no preamble.',
          messages: [{ role: 'user', content: 'Describe this character.', images: [ref.path] }],
          maxTokens: 200,
          temperature: 0.4
        },
        (full) => setAppearance(full)
      )
      const r = await h.done
      setAppearance(r.text.trim())
      patch({ appearance: r.text.trim() })
    } catch (err) {
      toast.error('Could not describe the image', `${errorText(err)} — the selected model may not accept images.`)
    } finally {
      setDescribing(false)
    }
  }

  return (
    <Page>
      <div className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-line bg-[color-mix(in_oklab,var(--panel-solid)_75%,transparent)] px-4 backdrop-blur-xl max-md:gap-1.5 max-md:px-2">
        <IconButton label="Back" className="max-md:size-10" onClick={() => navigate('/characters')}>
          <ArrowLeft className="size-4" />
        </IconButton>
        <input
          value={name}
          onChange={(e) => {
            setName(e.target.value)
            patchDebounced({ name: e.target.value })
          }}
          className="min-w-0 flex-1 bg-transparent text-[17px] font-semibold tracking-tight outline-none"
        />
        {running > 0 && (
          <Badge tone="accent">
            <Spinner className="size-3" /> <span className="contents max-md:hidden">Rendering </span>{running}
          </Badge>
        )}
        <Button
          size="sm"
          className="max-md:h-9 max-md:px-3"
          variant={c.locked ? 'primary' : 'secondary'}
          icon={c.locked ? <Lock className="size-3.5" /> : <LockOpen className="size-3.5" />}
          onClick={() => {
            if (!c.locked && filled < 3) toast.info('Generate the sheet first', 'Lock once the panels look right.')
            patch({ locked: !c.locked })
          }}
        >
          {c.locked ? (
            'Locked'
          ) : (
            <>
              Lock<span className="contents max-md:hidden"> character</span>
            </>
          )}
        </Button>
        <Menu
          align="end"
          trigger={
            <IconButton label="More" className="max-md:size-10">
              <MoreHorizontal className="size-4" />
            </IconButton>
          }
        >
          <MenuItem icon={<Sparkles />} onSelect={() => navigate('/generate/image', { state: { cast: [c.id] } })}>
            Generate a scene
          </MenuItem>
          <MenuItem icon={<Clapperboard />} onSelect={() => navigate('/generate/video', { state: { cast: [c.id] } })}>
            Make a video
          </MenuItem>
          <MenuItem icon={<BookOpen />} onSelect={() => navigate('/stories/new')}>
            Start a story
          </MenuItem>
          <MenuSeparator />
          {c.locked && (
            <MenuItem icon={<Unlock />} onSelect={() => patch({ locked: false })}>
              Unlock
            </MenuItem>
          )}
          <MenuItem
            icon={<Trash2 />}
            danger
            onSelect={async () => {
              await db.remove('characters', c.id)
              navigate('/characters')
            }}
          >
            Delete character
          </MenuItem>
        </Menu>
      </div>

      <div className="grid grid-cols-[320px_1fr] gap-8 px-8 py-7 max-md:grid-cols-1 max-md:gap-5 max-md:px-4 max-md:pt-4 max-md:pb-8">
        {/* Identity column — on phones its children join the grid so the sheet can sit right under the reference. */}
        <div className="space-y-5 max-md:contents max-md:space-y-0">
          <DropZone kinds={['image']} onAssets={(a) => a[0] && patch({ referenceAssetId: a[0].id })} className="rounded-2xl">
            <button
              onClick={async () => {
                const [a] = await pickAndImport('image')
                if (a) patch({ referenceAssetId: a.id })
              }}
              className="group relative block aspect-[4/5] w-full overflow-hidden rounded-2xl border border-line bg-white/[0.02] max-md:aspect-square"
            >
              {ref ? (
                <img src={fileUrl(ref.path)} className="size-full object-cover transition-transform duration-700 group-hover:scale-[1.03]" />
              ) : (
                <div className="flex size-full flex-col items-center justify-center gap-2 text-fg-3">
                  <ImagePlus className="size-6" />
                  <span className="text-[12.5px] font-medium">Upload reference</span>
                </div>
              )}
              <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 to-transparent p-3 pt-10 text-left opacity-0 transition-opacity group-hover:opacity-100 max-md:opacity-100">
                <span className="text-[12px] font-medium text-white">Replace reference</span>
              </div>
              <span className="absolute top-2.5 left-2.5 rounded-md bg-black/55 px-1.5 py-0.5 font-mono text-[9px] tracking-[0.18em] text-white/80 backdrop-blur">REFERENCE</span>
            </button>
          </DropZone>

          <Field
            className="max-md:order-2"
            label="Appearance"
            help="Used in every prompt with this character."
            action={
              ref && (
                <button onClick={() => void describe()} disabled={describing} className="flex items-center gap-1 text-[11.5px] font-semibold text-accent hover:brightness-125 disabled:opacity-50 max-md:-my-2 max-md:py-2">
                  {describing ? <Spinner className="size-3" /> : <ScanEye className="size-3" />} Describe from image
                </button>
              )
            }
          >
            <Textarea value={appearance} onChange={(e) => {
                setAppearance(e.target.value)
                patchDebounced({ appearance: e.target.value })
              }} minRows={4} placeholder="e.g. mid-20s woman, sharp green eyes, copper braid, scar across left brow, worn leather ranger coat…" />
          </Field>
          <Field className="max-md:order-2" label="Personality & backstory">
            <Textarea value={description} onChange={(e) => {
                setDescription(e.target.value)
                patchDebounced({ description: e.target.value })
              }} minRows={3} placeholder="Who are they? What do they want?" />
          </Field>
          <Field className="max-md:order-2" label="Voice" help="Used for narration, dialogue and as the H3 video voice reference.">
            {VoicePicker ? (
              <Suspense fallback={<Spinner />}>
                <VoicePicker value={c.voice} onChange={(voice) => patch({ voice })} characterName={c.name} />
              </Suspense>
            ) : (
              <div className="rounded-xl border border-dashed border-line px-3 py-3 text-[12px] text-fg-3">Voice tools are being set up.</div>
            )}
          </Field>
        </div>

        {/* Sheet */}
        <div className="min-w-0 max-md:order-1">
          <div className="flex items-center justify-between gap-4 max-md:flex-wrap max-md:gap-x-3 max-md:gap-y-3">
            <div>
              <div className="font-mono text-[10px] tracking-[0.22em] text-fg-3">
                CHARACTER SHEET · <span className={c.locked ? 'text-accent' : ''}>{c.locked ? 'LOCKED' : 'DRAFT'}</span>
              </div>
              <div className="mt-1 text-[13px] text-fg-2">
                {filled}/{slots.length} panels
              </div>
            </div>
            <div className="flex items-center gap-2 max-md:contents">
              <Segmented
                size="sm"
                className="max-md:[&>button]:h-8"
                value={c.sheetDetail}
                onChange={(v) => patch({ sheetDetail: v })}
                items={[
                  { value: 'compact', label: 'Compact' },
                  { value: 'studio', label: 'Studio' }
                ]}
              />
              <Button
                size="sm"
                variant="primary"
                className="max-md:h-10 max-md:w-full max-md:text-[13px]"
                disabled={!c.referenceAssetId || running > 0}
                icon={<Sparkles className="size-3.5" />}
                onClick={async () => {
                  try {
                    const missing = slots.filter((s) => !c.sheet[s.slot]).map((s) => s.slot)
                    const n = await generateSheet(c, missing.length ? missing : undefined)
                    toast.success(`${n} panels queued`)
                  } catch (err) {
                    toast.error('Could not generate', errorText(err))
                  }
                }}
              >
                {filled === 0 ? 'Generate sheet' : filled < slots.length ? 'Fill missing' : 'Regenerate all'}
              </Button>
            </div>
          </div>
          {!c.referenceAssetId && <div className="mt-4 rounded-xl border border-line bg-white/[0.03] p-3 text-[12.5px] text-fg-2">Upload a reference image <span className="max-md:hidden">on the left</span><span className="md:hidden">above</span> to generate this character's sheet.</div>}
          <div className="mt-5 space-y-7 rounded-2xl border border-line bg-[color-mix(in_oklab,var(--panel-solid)_45%,transparent)] p-5 max-md:mt-4 max-md:space-y-6 max-md:p-3.5">
            {groups.map((g) => {
              const list = slots.filter((s) => s.group === g.key)
              if (!list.length) return null
              return (
                <div key={g.key}>
                  <div className="label-caps mb-3">{g.title}</div>
                  <motion.div variants={stagger(0.03)} initial="initial" animate="animate" className={cn('grid gap-3 max-md:gap-2.5', g.key === 'angles' ? 'grid-cols-5' : 'grid-cols-5', 'max-md:grid-cols-3')}>
                    {list.map((def) => (
                      <SlotTile key={def.slot} c={c} def={def} onOpen={setLightbox} />
                    ))}
                  </motion.div>
                </div>
              )
            })}
            <div className="font-mono text-[9px] tracking-[0.22em] text-fg-3">ONE REFERENCE — EVERY POSE LOCKED</div>
          </div>
          {gens.length > 0 && (
            <div className="mt-8 max-md:mt-6">
              <div className="mb-3 flex items-baseline gap-2">
                <div className="label-caps">Generations</div>
                <span className="text-[11.5px] text-fg-3 tabular-nums">{gens.length}</span>
              </div>
              <Grid items={gens} onOpen={setLightbox} />
            </div>
          )}
        </div>
      </div>
      <AssetLightbox
        assetId={lightbox}
        onClose={() => setLightbox(null)}
        actions={(a) => (
          <Button size="sm" onClick={() => patch({ referenceAssetId: a.id })}>
            Use as reference
          </Button>
        )}
      />
    </Page>
  )
}
