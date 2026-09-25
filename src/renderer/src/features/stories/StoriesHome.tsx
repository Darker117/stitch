import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { AnimatePresence, motion } from 'motion/react'
import { BookOpen, Copy, Ellipsis, FileJson, ImagePlus, Images, Layers, LayoutTemplate, List, MessagesSquare, Pencil, Play, Plus, Sparkles, Trash2, Upload, Users, WandSparkles } from 'lucide-react'
import type { Adventure, Scenario } from '@shared/types'
import { Page } from '@/components/shell/page'
import { Button, IconButton } from '@/components/ui/button'
import { Menu, MenuItem, MenuSeparator } from '@/components/ui/overlay'
import { Badge, SectionTitle, Skeleton } from '@/components/ui/misc'
import { errorText } from '@/lib/api'
import { cn, pluralize, timeAgo } from '@/lib/utils'
import { ease, rise, spring, stagger } from '@/lib/motion'
import { db, useCollectionLoaded } from '@/stores/db'
import { toast, useToasts } from '@/stores/toast'
import { LogoMark } from '@/components/shell/logo'
import { AssetPicker } from '@/components/media'
import { CoverArt, TemplateArt } from './components/art'
import { CoverProgressLayer, useCanPaint, useCoverActions } from './components/cover'
import { setCover, useCoverProgress } from './engine/cover'
import { StoryStyles } from './components/StoryStyles'
import { deleteScenarioTree, duplicateScenarioTree, scenarioTree, startAdventure } from './engine/adventure'
import { importScenarioBackup, saveFile } from './engine/io'
import { isAiAction } from './engine/text'
import { createFromTemplate, TEMPLATES, type TemplateId } from './templates'
import { useAdventures, useScenarios } from './hooks'

const OPENING_BADGE: Record<Scenario['openingType'], { label: string; icon: React.ReactNode }> = {
  story: { label: 'Story', icon: <BookOpen /> },
  multipleChoice: { label: 'Choices', icon: <List /> },
  characterCreator: { label: 'Character creator', icon: <Users /> }
}

function lastPassage(a: Adventure): string {
  for (let i = a.actions.length - 1; i >= 0; i--) if (isAiAction(a.actions[i])) return a.actions[i].text
  return a.description
}

function HeroStack({ scenarios }: { scenarios: Scenario[] }): React.JSX.Element {
  const picks = scenarios.slice(0, 3)
  const fallback: TemplateId[] = ['fantasy', 'cyberpunk', 'mystery']
  const cards = [0, 1, 2].map((i) => picks[i] ?? null)
  const pose = [
    { rotate: -9, x: -150, y: 26, z: 1 },
    { rotate: 7, x: 150, y: 30, z: 2 },
    { rotate: 0, x: 0, y: 0, z: 3 }
  ]
  return (
    <div className="relative h-full w-full">
      <div className="absolute top-1/2 left-1/2 size-[420px] -translate-x-1/2 -translate-y-1/2 rounded-full opacity-50 blur-[90px]" style={{ background: 'radial-gradient(circle, var(--accent), var(--accent-2) 45%, transparent 70%)' }} />
      {cards.map((s, i) => (
        <motion.div
          key={s?.id ?? fallback[i]}
          initial={{ opacity: 0, y: 40, rotate: 0, scale: 0.9 }}
          animate={{ opacity: 1, y: pose[i].y, x: pose[i].x, rotate: pose[i].rotate, scale: 1 }}
          transition={{ type: 'spring', stiffness: 140, damping: 18, delay: 0.15 + i * 0.09 }}
          whileHover={{ y: pose[i].y - 10, rotate: pose[i].rotate * 0.6 }}
          className="group absolute top-1/2 left-1/2 -mt-[105px] -ml-[150px] h-[210px] w-[300px] overflow-hidden rounded-[20px] shadow-[0_30px_70px_-20px_rgb(0_0_0/0.85)] ring-1 ring-white/10"
          style={{ zIndex: pose[i].z }}
        >
          {s ? <CoverArt coverAssetId={s.coverAssetId} template={s.template} title={s.title} className="absolute inset-0" compact /> : <TemplateArt template={fallback[i]} className="absolute inset-0" compact />}
          <div className="absolute inset-x-0 bottom-0 bg-[linear-gradient(to_top,rgb(0_0_0/0.75),transparent)] p-3.5 pt-10">
            <div className="truncate font-serif text-[15px] font-semibold text-white">{s?.title || TEMPLATES.find((t) => t.id === fallback[i])?.name}</div>
          </div>
        </motion.div>
      ))}
    </div>
  )
}

function AdventureCard({ a, onPlay }: { a: Adventure; onPlay: () => void }): React.JSX.Element {
  const scenario = a.scenarioId ? db.get('scenarios', a.scenarioId) : undefined
  const turns = a.actions.filter((x) => x.type !== 'start').length
  const media = a.actions.reduce((n, x) => n + (x.media?.length ?? 0), 0)
  const snippet = lastPassage(a)
  return (
    <motion.div variants={rise} layout className="group relative w-[300px] shrink-0">
      <motion.button whileHover={{ y: -4 }} whileTap={{ scale: 0.985 }} transition={spring} onClick={onPlay} className="block w-full text-left">
        <CoverArt coverAssetId={a.coverAssetId ?? scenario?.coverAssetId} template={scenario?.template} title={a.title} compact className="aspect-[16/10] w-full rounded-[18px] ring-1 ring-line transition-shadow duration-300 group-hover:shadow-[0_24px_50px_-20px_color-mix(in_oklab,var(--accent)_50%,transparent)]">
          <div className="absolute inset-0 bg-[linear-gradient(to_top,rgb(0_0_0/0.85)_8%,rgb(0_0_0/0.25)_55%,transparent)]" />
          <div className="absolute inset-x-0 bottom-0 flex flex-col gap-1.5 p-4">
            <div className="truncate font-serif text-[17px] font-semibold text-white">{a.title || 'Untitled adventure'}</div>
            {snippet && <p className="line-clamp-2 text-[11.5px] leading-snug text-white/65">{snippet}</p>}
            <div className="mt-1 flex items-center gap-2 text-[11px] text-white/60">
              <span>{timeAgo(a.lastPlayedAt || a.updatedAt)}</span>
              <span className="size-0.5 rounded-full bg-white/40" />
              <span>{a.actions.length ? pluralize(turns, 'turn') : 'Not started'}</span>
              {media > 0 && (
                <>
                  <span className="size-0.5 rounded-full bg-white/40" />
                  <span>{pluralize(media, 'scene')}</span>
                </>
              )}
            </div>
            <div className="mt-1 h-[3px] overflow-hidden rounded-full bg-white/15">
              <motion.div initial={{ width: 0 }} animate={{ width: `${Math.min(100, 8 + turns * 3)}%` }} transition={{ duration: 0.9, ease, delay: 0.2 }} className="h-full rounded-full bg-grad" />
            </div>
          </div>
          <span className="absolute top-1/2 left-1/2 grid size-14 -translate-x-1/2 -translate-y-1/2 scale-75 place-items-center rounded-full bg-white/15 text-white opacity-0 backdrop-blur-md transition-all duration-300 group-hover:scale-100 group-hover:opacity-100">
            <Play className="size-5 translate-x-[1px] fill-current" />
          </span>
        </CoverArt>
      </motion.button>
      <div className="absolute top-2.5 right-2.5 opacity-0 transition-opacity group-hover:opacity-100">
        <Menu
          align="end"
          trigger={
            <IconButton label="Adventure options" variant="glass" size="sm" className="bg-black/40 text-white">
              <Ellipsis className="size-4" />
            </IconButton>
          }
        >
          <MenuItem icon={<Play />} onSelect={onPlay}>
            Continue
          </MenuItem>
          <MenuItem icon={<FileJson />} onSelect={() => void saveFile(a.title || 'adventure', JSON.stringify({ kind: 'stitch-adventure', version: 1, adventure: a }, null, 2), 'json')}>
            Export backup
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon={<Trash2 />} danger onSelect={() => void db.remove('adventures', a.id)}>
            Delete adventure
          </MenuItem>
        </Menu>
      </div>
    </motion.div>
  )
}

function ScenarioCard({ s, onPlay, playing }: { s: Scenario; onPlay: () => void; playing: boolean }): React.JSX.Element {
  const navigate = useNavigate()
  const badge = OPENING_BADGE[s.openingType]
  const target = useMemo(() => ({ collection: 'scenarios' as const, id: s.id }), [s.id])
  const progress = useCoverProgress(target)
  const cover = useCoverActions(target, s.projectId)
  const canPaint = useCanPaint()
  const [picker, setPicker] = useState(false)
  const running = progress.phase !== 'idle'
  return (
    <motion.div variants={rise} layout className="group relative flex flex-col overflow-hidden rounded-[18px] border border-line bg-white/[0.03] transition-[border-color,box-shadow,transform] duration-300 hover:-translate-y-1 hover:border-line-strong hover:shadow-[0_24px_50px_-24px_rgb(0_0_0/0.9)]">
      <div className="relative">
        <button onClick={() => navigate(`/stories/scenario/${s.id}`)} className="block w-full text-left">
          <CoverArt coverAssetId={s.coverAssetId} template={s.template} title={s.title} compact className="aspect-[16/9] w-full">
            <div className="absolute inset-0 bg-[linear-gradient(to_top,rgb(0_0_0/0.45),transparent_50%)]" />
            <div className="absolute top-2.5 left-2.5 flex gap-1.5">
              <Badge className="gap-1 bg-black/45 text-white/90 backdrop-blur-md [&>svg]:size-3">
                {badge.icon}
                {badge.label}
              </Badge>
            </div>
            <CoverProgressLayer progress={progress} compact />
          </CoverArt>
        </button>
        {!s.coverAssetId && !running && (
          <div className="absolute right-2.5 bottom-2.5 translate-y-1 opacity-0 transition-all duration-300 group-hover:translate-y-0 group-hover:opacity-100 has-[[data-state=open]]:translate-y-0 has-[[data-state=open]]:opacity-100">
            <Menu
              align="end"
              trigger={
                <button className="flex h-7 items-center gap-1.5 rounded-full border border-white/10 bg-black/45 px-2.5 text-[11px] font-medium text-white/85 backdrop-blur-md transition hover:bg-black/60 hover:text-white">
                  <ImagePlus className="size-3.5" /> Add cover
                </button>
              }
            >
              <MenuItem icon={<WandSparkles />} onSelect={cover.paint} disabled={!canPaint} hint={canPaint ? undefined : 'ComfyUI offline'}>
                Paint from story
              </MenuItem>
              <MenuItem icon={<Upload />} onSelect={() => void cover.upload()}>
                Upload image
              </MenuItem>
              <MenuItem icon={<Images />} onSelect={() => setPicker(true)}>
                Choose from library
              </MenuItem>
            </Menu>
          </div>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-1.5 p-4">
        <div className="truncate font-serif text-[16.5px] font-semibold">{s.title || 'Untitled scenario'}</div>
        <p className="line-clamp-2 min-h-[2.6em] text-[12px] leading-snug text-fg-2">{s.description || 'No description yet.'}</p>
        <div className="mt-1 flex items-center gap-2 overflow-hidden text-[11px] whitespace-nowrap text-fg-3">
          <span className="flex shrink-0 items-center gap-1">
            <Layers className="size-3" /> {pluralize(s.cards.length, 'card')}
          </span>
          {s.tags.slice(0, 2).map((t) => (
            <span key={t} className="min-w-0 truncate">
              #{t}
            </span>
          ))}
          <span className="ml-auto shrink-0 pl-1">{timeAgo(s.updatedAt)}</span>
        </div>
        <div className="mt-3 flex items-center gap-2">
          <Button size="sm" variant="primary" icon={<Play className="size-3 fill-current" />} loading={playing} onClick={onPlay} className="flex-1">
            Play
          </Button>
          <Button size="sm" variant="secondary" icon={<Pencil className="size-3" />} onClick={() => navigate(`/stories/scenario/${s.id}`)}>
            Edit
          </Button>
          <Menu
            align="end"
            trigger={
              <IconButton label="Scenario options" size="sm" variant="secondary">
                <Ellipsis className="size-4" />
              </IconButton>
            }
          >
            <MenuItem icon={<Copy />} onSelect={() => void duplicateScenarioTree(s.id)}>
              Duplicate
            </MenuItem>
            <MenuSeparator />
            <MenuItem icon={<WandSparkles />} onSelect={cover.paint} disabled={!canPaint || running} hint={canPaint ? undefined : 'ComfyUI offline'}>
              {s.coverAssetId ? 'Paint a new cover' : 'Paint a cover'}
            </MenuItem>
            <MenuItem icon={<Upload />} onSelect={() => void cover.upload()}>
              Upload cover
            </MenuItem>
            <MenuItem icon={<Images />} onSelect={() => setPicker(true)}>
              Cover from library
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              icon={<Trash2 />}
              danger
              onSelect={() => {
                const snapshot = scenarioTree(s.id)
                void deleteScenarioTree(s.id).then(() =>
                  useToasts.getState().push({
                    title: `Deleted “${s.title || 'Untitled scenario'}”`,
                    ms: 6000,
                    action: {
                      label: 'Undo',
                      run: () => {
                        for (const d of [...snapshot].reverse()) void db.put('scenarios', d)
                      }
                    }
                  })
                )
              }}
            >
              Delete
            </MenuItem>
          </Menu>
        </div>
      </div>
      <AssetPicker open={picker} onClose={() => setPicker(false)} kinds={['image', 'video']} onPick={(a) => a[0] && void setCover(target, a[0].id)} title="Choose a cover" />
    </motion.div>
  )
}

export function StoriesHome(): React.JSX.Element {
  const navigate = useNavigate()
  const scenarios = useScenarios()
  const adventures = useAdventures()
  const scenariosLoaded = useCollectionLoaded('scenarios')
  const adventuresLoaded = useCollectionLoaded('adventures')
  const loaded = scenariosLoaded && adventuresLoaded
  const [starting, setStarting] = useState<string | null>(null)

  const play = async (s: Scenario): Promise<void> => {
    setStarting(s.id)
    try {
      const adv = await startAdventure(s)
      navigate(`/play/${adv.id}`)
    } catch (err) {
      toast.error('Could not start the adventure', errorText(err))
      setStarting(null)
    }
  }

  const quick = async (id: TemplateId): Promise<void> => {
    try {
      const s = await createFromTemplate(id)
      navigate(`/stories/scenario/${s.id}`)
    } catch (err) {
      toast.error('Could not create the scenario', errorText(err))
    }
  }

  return (
    <Page>
      <StoryStyles />
      {/* Hero */}
      <div className="relative overflow-hidden border-b border-line">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(80%_120%_at_85%_20%,color-mix(in_oklab,var(--accent-2)_16%,transparent),transparent_60%),radial-gradient(60%_100%_at_70%_110%,color-mix(in_oklab,var(--accent)_16%,transparent),transparent_65%)]" />
        <div className="relative z-10 grid min-h-[330px] grid-cols-[1.05fr_1fr] items-center gap-6 px-10 py-10">
          <motion.div variants={stagger(0.06, 0.05)} initial="initial" animate="animate" className="flex flex-col gap-4">
            <motion.div variants={rise} className="label-caps flex items-center gap-2 text-fg-2">
              <LogoMark size={16} /> Stories
            </motion.div>
            <motion.h1 variants={rise} className="max-w-[520px] font-serif text-[40px] leading-[1.08] font-semibold tracking-tight">
              Play a story. <span className="text-grad">See it, hear it,</span> keep it.
            </motion.h1>
            <motion.p variants={rise} className="max-w-[460px] text-[13.5px] leading-relaxed text-fg-2">
              An AI Dungeon-style engine on your own models — with scenes, clips and narration that keep your characters on-model.
            </motion.p>
            <motion.div variants={rise} className="mt-2 flex gap-2">
              <Button variant="primary" size="lg" icon={<Plus className="size-4" />} onClick={() => navigate('/stories/new')}>
                New story
              </Button>
              <Button variant="glass" size="lg" icon={<MessagesSquare className="size-4" />} onClick={() => navigate('/stories/compose')}>
                Compose
              </Button>
              <Button
                variant="glass"
                size="lg"
                icon={<Upload className="size-4" />}
                onClick={async () => {
                  const s = await importScenarioBackup()
                  if (s) navigate(`/stories/scenario/${s.id}`)
                }}
              >
                Import
              </Button>
            </motion.div>
          </motion.div>
          <div className="relative h-[290px]">
            <HeroStack scenarios={scenarios} />
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-10 px-10 pt-8 pb-16">
        {/* Continue playing */}
        <AnimatePresence initial={false}>
          {adventures.length > 0 && (
            <motion.section initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.4, ease }}>
              <SectionTitle icon={<Play className="fill-current" />}>Continue playing</SectionTitle>
              <motion.div variants={stagger(0.05, 0.1)} initial="initial" animate="animate" className="-mx-2 mt-4 flex gap-4 overflow-x-auto px-2 pt-1 pb-3">
                {adventures.slice(0, 12).map((a) => (
                  <AdventureCard key={a.id} a={a} onPlay={() => navigate(`/play/${a.id}`)} />
                ))}
              </motion.div>
            </motion.section>
          )}
        </AnimatePresence>

        {/* My scenarios */}
        <section>
          <SectionTitle
            icon={<BookOpen />}
            action={
              scenarios.length > 0 && (
                <Menu
                  align="end"
                  trigger={
                    <Button size="sm" variant="secondary" icon={<Plus className="size-3.5" />}>
                      New
                    </Button>
                  }
                >
                  <MenuItem icon={<LayoutTemplate />} onSelect={() => navigate('/stories/new')}>
                    From a template
                  </MenuItem>
                  <MenuItem icon={<WandSparkles />} onSelect={() => navigate('/stories/new?mode=ai')}>
                    Generate with AI
                  </MenuItem>
                  <MenuItem icon={<MessagesSquare />} onSelect={() => navigate('/stories/compose')}>
                    Scenario Composer
                  </MenuItem>
                </Menu>
              )
            }
          >
            My scenarios
          </SectionTitle>
          {!loaded ? (
            <div className="mt-4 grid grid-cols-4 gap-4">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-[290px] rounded-[18px]" />
              ))}
            </div>
          ) : scenarios.length ? (
            <motion.div variants={stagger(0.04, 0.12)} initial="initial" animate="animate" className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-4">
              {scenarios.map((s) => (
                <ScenarioCard key={s.id} s={s} onPlay={() => void play(s)} playing={starting === s.id} />
              ))}
            </motion.div>
          ) : (
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease }} className="mt-4 rounded-[20px] border border-dashed border-line-strong p-8">
              <div className="flex items-center gap-3">
                <span className="grid size-10 place-items-center rounded-xl bg-grad-soft text-accent">
                  <Sparkles className="size-4.5" />
                </span>
                <div>
                  <div className="font-serif text-[18px] font-semibold">Start your first story</div>
                  <div className="text-[12.5px] text-fg-2">Describe it, build it with the AI, or pick a world — everything stays editable.</div>
                </div>
              </div>
              <motion.div variants={stagger(0.05, 0.05)} initial="initial" animate="animate" className="mt-6 grid grid-cols-2 gap-3">
                {[
                  { icon: <WandSparkles />, title: 'Generate with AI', body: 'A sentence in, a complete scenario out.', to: '/stories/new?mode=ai' },
                  { icon: <MessagesSquare />, title: 'Scenario Composer', body: 'Build it together — cast, opening, rules and scripts.', to: '/stories/compose' }
                ].map((a) => (
                  <motion.button
                    key={a.title}
                    variants={rise}
                    whileHover={{ y: -3 }}
                    onClick={() => navigate(a.to)}
                    className="group flex items-center gap-3.5 rounded-2xl border border-line bg-white/[0.03] p-4 text-left transition-colors hover:border-line-strong hover:bg-white/[0.06]"
                  >
                    <span className="grid size-10 place-items-center rounded-xl bg-grad text-white [&>svg]:size-[18px]">{a.icon}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-serif text-[15.5px] font-semibold">{a.title}</span>
                      <span className="block text-[12px] text-fg-2">{a.body}</span>
                    </span>
                  </motion.button>
                ))}
              </motion.div>
              <motion.div variants={stagger(0.05, 0.1)} initial="initial" animate="animate" className="mt-3 grid grid-cols-5 gap-3">
                {TEMPLATES.filter((t) => t.id !== 'random').slice(0, 5).map((t) => (
                  <motion.button key={t.id} variants={rise} whileHover={{ y: -3 }} onClick={() => void quick(t.id)} className={cn('group relative aspect-[4/3] overflow-hidden rounded-2xl text-left ring-1 ring-line')}>
                    <TemplateArt template={t.id} compact className="absolute inset-0" />
                    <div className="absolute bottom-2.5 left-3 font-serif text-[14px] font-semibold text-white">{t.name}</div>
                  </motion.button>
                ))}
              </motion.div>
            </motion.div>
          )}
        </section>
      </div>
    </Page>
  )
}
