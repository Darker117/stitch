import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { AnimatePresence, motion } from 'motion/react'
import { BookOpenText, Check, CircleCheck, FolderOpen, ImagePlus, Lock, Mic2, Plus, ScanFace, ShieldCheck, SlidersHorizontal, Sparkles, UserRound, Users, Wand2, Zap } from 'lucide-react'
import type { Asset, Character, SheetSlot } from '@shared/types'
import { errorText, fileUrl } from '@/lib/api'
import { characterRefs, pickEditRecipe, SHEET_SLOTS } from '@/lib/characters'
import { useCompact } from '@/lib/platform'
import { cn, timeAgo } from '@/lib/utils'
import { ease, rise, spring, stagger } from '@/lib/motion'
import { Page } from '@/components/shell/page'
import { AssetLightbox, AssetThumb, DropZone, pickAndImport } from '@/components/media'
import { Button } from '@/components/ui/button'
import { Tabs } from '@/components/ui/controls'
import { Input } from '@/components/ui/input'
import { Badge, EmptyState } from '@/components/ui/misc'
import { Dialog } from '@/components/ui/overlay'
import { useCollection, useDoc } from '@/stores/db'
import { useGen } from '@/stores/gen'
import { toast } from '@/stores/toast'
import { createCharacter, generateSheet } from './sheet'
import { Silhouette } from './Silhouette'

const PREVIEW_SLOTS: SheetSlot[] = ['front', 'three-quarter-left', 'three-quarter-right', 'profile-left', 'profile-right', 'back', 'low-angle', 'high-angle', 'full-body']

/** The decorative "CHARACTER SHEET — LOCKED" board. */
export function SheetBoard({ images, className, animate = true }: { images?: Partial<Record<SheetSlot, string>>; className?: string; animate?: boolean }): React.JSX.Element {
  const [hi, setHi] = useState(4)
  return (
    <div className={cn('rounded-2xl border border-line bg-[color-mix(in_oklab,var(--panel-solid)_70%,transparent)] p-5 max-md:p-3.5', className)}>
      <div className="mb-4 flex items-center justify-between font-mono text-[9.5px] tracking-[0.22em] text-fg-3 max-md:mb-3">
        <span>CHARACTER SHEET</span>
        <span className="text-accent">LOCKED</span>
      </div>
      <motion.div variants={stagger(0.05, 0.1)} initial={animate ? 'initial' : false} animate="animate" className="grid grid-cols-3 gap-2.5 max-md:gap-2">
        {PREVIEW_SLOTS.map((slot, i) => {
          const def = SHEET_SLOTS.find((s) => s.slot === slot)!
          const img = images?.[slot]
          return (
            <motion.div
              key={slot}
              variants={rise}
              onHoverStart={() => setHi(i)}
              className={cn('relative aspect-[5/4] overflow-hidden rounded-xl border bg-white/[0.02] transition-colors duration-300', hi === i ? 'border-[color-mix(in_oklab,var(--accent)_55%,transparent)]' : 'border-line')}
            >
              {img ? (
                <img src={img} className="absolute inset-0 size-full object-cover" />
              ) : (
                <div className="absolute inset-x-0 top-2 bottom-5">
                  <Silhouette slot={slot} />
                </div>
              )}
              <div className="absolute inset-x-0 bottom-1.5 text-center font-mono text-[8.5px] tracking-[0.2em] text-fg-3 uppercase">{def.label}</div>
            </motion.div>
          )
        })}
      </motion.div>
      <div className="mt-4 font-mono text-[9px] tracking-[0.22em] text-fg-3 max-md:mt-3">ONE REFERENCE — EVERY POSE LOCKED</div>
    </div>
  )
}

function UploadCard({ bare }: { bare?: boolean } = {}): React.JSX.Element {
  const navigate = useNavigate()
  const [ref, setRef] = useState<Asset | null>(null)
  const [name, setName] = useState('')
  const [detail, setDetail] = useState<Character['sheetDetail']>('studio')
  const [busy, setBusy] = useState(false)
  const recipes = useGen((s) => s.recipes)
  const edit = pickEditRecipe(recipes)

  const go = async (): Promise<void> => {
    if (!ref) return
    setBusy(true)
    try {
      const c = await createCharacter({ name: name || 'New character', referenceAssetId: ref.id, detail })
      const n = await generateSheet(c)
      toast.success(`Locking ${c.name}`, `${n} sheet panels queued`)
      navigate(`/characters/${c.id}`)
    } catch (err) {
      toast.error('Could not start the sheet', errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={bare ? 'p-4 pt-2' : 'glass hairline rounded-[22px] p-4'}>
      <DropZone kinds={['image']} onAssets={(a) => a[0] && setRef(a[0])} className="rounded-2xl">
        <button
          onClick={async () => {
            const [a] = await pickAndImport('image')
            if (a) setRef(a)
          }}
          className="group relative flex h-[210px] w-full flex-col max-md:h-[190px] items-center justify-center gap-3 overflow-hidden rounded-2xl border border-dashed border-line-strong bg-white/[0.02] transition hover:border-[color-mix(in_oklab,var(--accent)_50%,transparent)] hover:bg-white/[0.04]"
        >
          <AnimatePresence mode="wait">
            {ref ? (
              <motion.img key={ref.id} initial={{ opacity: 0, scale: 1.04 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.5, ease }} src={fileUrl(ref.path)} className="absolute inset-0 size-full object-contain p-2" />
            ) : (
              <motion.div key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex flex-col items-center gap-3">
                <span className="grid size-12 place-items-center rounded-full border border-line bg-white/[0.04] text-fg-2 transition group-hover:scale-105 group-hover:text-fg">
                  <ImagePlus className="size-5" />
                </span>
                <div className="text-center">
                  <div className="text-[14px] font-semibold">Upload reference image</div>
                  <div className="mt-0.5 text-[12px] text-fg-3">PNG or JPG, one clear face and outfit</div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </button>
      </DropZone>
      <div className="mt-3 grid grid-cols-[1fr_auto] gap-2">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Character name" />
      </div>
      <div className="label-caps mt-4 mb-2">Sheet detail</div>
      <div className="grid grid-cols-[1fr_1fr_1.1fr] gap-2 max-md:grid-cols-2">
        {(
          [
            { v: 'compact', title: 'Compact', sub: '9 angles', icon: <Zap className="size-3.5" /> },
            { v: 'studio', title: 'Studio', sub: 'Angles, expressions, light', icon: <CircleCheck className="size-3.5" /> }
          ] as const
        ).map((o) => (
          <button
            key={o.v}
            onClick={() => setDetail(o.v)}
            className={cn('relative flex items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-colors', detail === o.v ? 'border-white/60 text-fg' : 'border-line text-fg-3 hover:text-fg-2')}
          >
            {o.icon}
            <div>
              <div className="text-[12.5px] font-semibold">{o.title}</div>
              <div className="text-[11px] opacity-75 max-md:leading-snug">{o.sub}</div>
            </div>
          </button>
        ))}
        <Button variant="primary" size="lg" className="h-auto max-md:col-span-2 max-md:h-11" disabled={!ref || !edit} loading={busy} icon={<Sparkles className="size-4" />} onClick={() => void go()}>
          Generate sheet
        </Button>
      </div>
      {!edit && <div className="mt-3 text-[11.5px] text-warning">Needs Qwen Image 2.1 Edit or Flux 2 Klein — start ComfyUI to enable.</div>}
    </div>
  )
}

function HowItWorks(): React.JSX.Element {
  const steps = [
    { n: '1', title: 'Upload your reference', body: 'Any clear image of your character — face and outfit visible works best.', art: <ImagePlus className="size-6 text-fg-3" /> },
    { n: '2', title: 'Generate the sheet', body: 'Qwen Image 2.1 or Flux 2 Klein renders every angle, expression and lighting setup from that single image, on your GPU.', art: <span className="inline-flex items-center gap-2 rounded-xl bg-grad px-5 py-3 text-[14px] font-semibold text-white shadow-lg"><Sparkles className="size-4" /> Generate sheet</span> },
    { n: '3', title: 'Reuse everywhere', body: 'Stories, scenes and H3 videos automatically use the sheet as the character reference. No more drift.', art: <Users className="size-6 text-fg-3" /> }
  ]
  const features = [
    { icon: <ShieldCheck />, title: 'Identity lock', body: 'Face, hair, wardrobe and marks stay locked across every headshot, pose, expression and lighting panel.' },
    { icon: <SlidersHorizontal />, title: 'A full studio document', body: 'Nine angles, five expressions and five lighting references plus a cloned voice — one character, ready for production.' },
    { icon: <Lock />, title: 'Local by design', body: 'Everything renders on your own GPUs through ComfyUI. Nothing leaves your machine unless you choose a cloud voice.' }
  ]
  return (
    <div className="space-y-14 max-md:space-y-10">
      <div>
        <h2 className="display text-[30px] uppercase max-md:text-[23px]">Your character sheet in 3 steps</h2>
        <p className="mt-1.5 text-[13px] text-fg-3">From one reference image to a complete studio document.</p>
        <motion.div variants={stagger(0.08)} initial="initial" whileInView="animate" viewport={{ once: true }} className="mt-6 grid grid-cols-3 gap-4 max-md:mt-5 max-md:grid-cols-1 max-md:gap-6">
          {steps.map((s) => (
            <motion.div key={s.n} variants={rise}>
              <div className="glass hairline grid h-[180px] place-items-center rounded-2xl max-md:h-[128px]">{s.art}</div>
              <div className="mt-4 text-[15px] font-bold tracking-tight uppercase max-md:mt-3">
                {s.n}. {s.title}
              </div>
              <p className="mt-1.5 text-[12.5px] leading-relaxed text-fg-3">{s.body}</p>
            </motion.div>
          ))}
        </motion.div>
      </div>
      <div className="text-center">
        <h2 className="display text-[30px] uppercase max-md:text-[23px]">Built to kill character drift</h2>
        <p className="mt-1.5 text-[13px] text-fg-3">Everything here serves one goal: the same character in every shot.</p>
        <motion.div variants={stagger(0.08)} initial="initial" whileInView="animate" viewport={{ once: true }} className="mt-7 grid grid-cols-3 gap-4 text-left max-md:mt-5 max-md:grid-cols-1 max-md:gap-3">
          {features.map((f) => (
            <motion.div key={f.title} variants={rise} className="glass hairline rounded-2xl p-6 max-md:p-4.5">
              <div className="grid size-10 place-items-center rounded-xl border border-line bg-white/[0.05] text-fg-2 [&>svg]:size-4.5">{f.icon}</div>
              <div className="mt-6 text-[15px] font-semibold max-md:mt-4">{f.title}</div>
              <p className="mt-1.5 text-[12.5px] leading-relaxed text-fg-3">{f.body}</p>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </div>
  )
}

function CharacterCard({ c }: { c: Character }): React.JSX.Element {
  const navigate = useNavigate()
  const refId = characterRefs(c, 1)[0]
  const ref = useDoc('assets', refId)
  const filled = Object.keys(c.sheet).length
  return (
    <motion.button variants={rise} whileHover={{ y: -4 }} transition={spring} onClick={() => navigate(`/characters/${c.id}`)} className="group glass hairline overflow-hidden rounded-2xl text-left">
      <div className="relative aspect-[4/5] overflow-hidden bg-white/[0.03]">
        {ref ? <img src={fileUrl(ref.path)} className="size-full object-cover transition-transform duration-700 ease-out group-hover:scale-[1.04]" /> : <UserRound className="absolute inset-0 m-auto size-10 text-fg-3" />}
        <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/80 to-transparent" />
        <div className="absolute top-2.5 left-2.5 flex gap-1.5">
          {c.locked && (
            <Badge tone="accent" className="backdrop-blur">
              <Lock className="size-2.5" /> Locked
            </Badge>
          )}
          {c.voice?.sampleAssetId || c.voice?.voiceId ? (
            <Badge className="bg-black/40 backdrop-blur">
              <Mic2 className="size-2.5" /> Voice
            </Badge>
          ) : null}
        </div>
        <div className="absolute inset-x-3.5 bottom-3">
          <div className="text-[15px] font-semibold text-white">{c.name}</div>
          <div className="text-[11.5px] text-white/65">
            {filled ? (
              <>
                {filled}
                <span className="max-md:hidden"> sheet</span> panels
              </>
            ) : (
              'No sheet yet'
            )}{' '}
            · {timeAgo(c.updatedAt)}
          </div>
        </div>
      </div>
    </motion.button>
  )
}

export function CharactersPage(): React.JSX.Element {
  const characters = useCollection('characters')
  const assets = useCollection('assets')
  const navigate = useNavigate()
  const compact = useCompact()
  const [tab, setTab] = useState<'how' | 'mine' | 'gens'>(characters.length ? 'mine' : 'how')
  const [lightbox, setLightbox] = useState<string | null>(null)
  const [newOpen, setNewOpen] = useState(false)
  // Characters load after first paint: land on the list once they arrive, unless a tab was picked.
  const picked = useRef(false)
  useEffect(() => {
    if (characters.length && !picked.current) setTab('mine')
  }, [characters.length])
  // Phones: with characters to show, lead with them; the hero and sheet board are for first visits.
  const listFirst = compact && characters.length > 0
  const gens = useMemo(() => assets.filter((a) => a.characterIds?.length && a.source === 'generated'), [assets])

  // Show the most recent character's sheet in the hero board.
  const featured = characters.find((c) => Object.keys(c.sheet).length >= 3)
  const featuredImages = useMemo(() => {
    if (!featured) return undefined
    const out: Partial<Record<SheetSlot, string>> = {}
    for (const [slot, id] of Object.entries(featured.sheet)) {
      const a = assets.find((x) => x.id === id)
      if (a) out[slot as SheetSlot] = fileUrl(a.path)
    }
    return out
  }, [featured, assets])

  return (
    <Page>
      <div className="mx-auto max-w-[1180px] px-10 pt-10 pb-20 max-md:px-4 max-md:pt-6 max-md:pb-10">
        {listFirst ? (
          <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease }} className="-mt-1 flex items-center gap-2">
            <h1 className="display min-w-0 flex-1 truncate text-[23px]">Characters</h1>
            <Button variant="primary" className="h-10 rounded-xl px-4" icon={<Plus className="size-4" />} onClick={() => setNewOpen(true)}>
              New
            </Button>
          </motion.div>
        ) : (
        <>
        <div className="grid grid-cols-[1fr_1.15fr] items-center gap-10 max-md:grid-cols-1 max-md:gap-6">
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.7, ease }} className="max-md:px-1">
            <div className="label-caps flex items-center gap-2 text-fg-2">
              <ScanFace className="size-4" /> Character lock
            </div>
            <h1 className="display mt-4 text-[46px] max-md:mt-3 max-md:text-[36px]">
              Lock your character.
              <br />
              <span className="text-grad">Forever.</span>
            </h1>
            <p className="mt-4 max-w-md text-[14px] leading-relaxed text-fg-2 max-md:mt-3 max-md:text-[13px]">One reference image → a full studio character sheet. Headshots, poses, expressions, lighting and a voice — locked to your character and reused in every story, scene and video.</p>
          </motion.div>
          <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.8, ease, delay: 0.1 }}>
            <UploadCard />
          </motion.div>
        </div>

        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.8, ease, delay: 0.2 }} className="mx-auto mt-10 max-w-[620px] max-md:mt-6">
          <SheetBoard images={featuredImages} />
        </motion.div>
        </>
        )}

        <div className={listFirst ? 'mt-4' : 'mt-14 max-md:mt-9'}>
          {/* Phones: shorter labels, no icons; the strip scrolls sideways if it still doesn't fit. */}
          <div className="max-md:-mx-4 max-md:overflow-x-auto max-md:px-4 max-md:[scrollbar-width:none]!">
            <Tabs
              value={tab}
              onChange={(t) => {
                picked.current = true
                setTab(t)
              }}
              className="max-md:w-max max-md:min-w-full max-md:gap-0.5 max-md:[&>button]:h-10 max-md:[&>button]:px-2"
              items={
                listFirst
                  ? [
                      { value: 'mine', label: 'Characters', count: characters.length },
                      { value: 'gens', label: 'Generations', count: gens.length },
                      { value: 'how', label: 'How it works' }
                    ]
                  : [
                      { value: 'how', label: 'How it works', icon: compact ? undefined : <BookOpenText /> },
                      { value: 'mine', label: compact ? 'Characters' : 'My characters', icon: compact ? undefined : <Users />, count: characters.length },
                      { value: 'gens', label: compact ? 'Generations' : 'My generations', icon: compact ? undefined : <FolderOpen />, count: gens.length }
                    ]
              }
            />
          </div>
          <div className="pt-8 max-md:pt-5">
            <AnimatePresence mode="wait">
              <motion.div key={tab} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.3, ease }}>
                {tab === 'how' && <HowItWorks />}
                {tab === 'mine' &&
                  (characters.length ? (
                    <motion.div variants={stagger(0.04)} initial="initial" animate="animate" className="grid grid-cols-4 gap-4 max-md:grid-cols-2 max-md:gap-3 min-[440px]:max-md:grid-cols-3">
                      {characters.map((c) => (
                        <CharacterCard key={c.id} c={c} />
                      ))}
                      <motion.button
                        variants={rise}
                        whileHover={{ y: -4 }}
                        onClick={async () => {
                          const c = await createCharacter({ name: 'New character', detail: 'studio' })
                          navigate(`/characters/${c.id}`)
                        }}
                        className="flex aspect-[4/5] flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-line-strong text-fg-3 transition hover:border-[color-mix(in_oklab,var(--accent)_50%,transparent)] hover:text-fg-2"
                      >
                        <Wand2 className="size-5" />
                        <span className="text-[12.5px] font-medium">Blank character</span>
                      </motion.button>
                    </motion.div>
                  ) : (
                    <EmptyState icon={<Users />} title="No characters yet" body="Upload a reference above to lock your first character." />
                  ))}
                {tab === 'gens' &&
                  (gens.length ? (
                    <div className="grid grid-cols-5 gap-3 max-md:grid-cols-3 max-md:gap-2">
                      {gens.map((a) => (
                        <AssetThumb key={a.id} asset={a} className="aspect-square" onClick={() => setLightbox(a.id)} />
                      ))}
                    </div>
                  ) : (
                    <EmptyState icon={<Check />} title="Nothing yet" body="Everything you generate with a locked character shows up here." />
                  ))}
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
      </div>
      <AssetLightbox assetId={lightbox} onClose={() => setLightbox(null)} />
      <Dialog open={newOpen} onOpenChange={setNewOpen} title="New character" description="One reference image → a full character sheet.">
        <UploadCard bare />
      </Dialog>
    </Page>
  )
}

