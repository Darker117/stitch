import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { AnimatePresence, motion } from 'motion/react'
import { ArrowLeft, Check, LayoutGrid, List, Pencil, Play, Settings, SlidersHorizontal } from 'lucide-react'
import type { Scenario } from '@shared/types'
import { Page } from '@/components/shell/page'
import { Button, IconButton } from '@/components/ui/button'
import { Segmented } from '@/components/ui/controls'
import { EmptyState, ProgressRing, Skeleton, Spinner } from '@/components/ui/misc'
import { errorText } from '@/lib/api'
import { ease, spring } from '@/lib/motion'
import { db, useCollectionLoaded, useDoc } from '@/stores/db'
import { toast } from '@/stores/toast'
import { StoryStyles } from './components/StoryStyles'
import { StoryCardsBoard } from './components/cards'
import { PlotComponentsEditor } from './components/plot'
import { OpeningEditor } from './components/opening'
import { StoryDetails } from './components/details'
import { CoverArt } from './components/art'
import { FrostHeader } from './components/frost'
import { useCoverProgress } from './engine/cover'
import { startAdventure } from './engine/adventure'
import type { StoryInfo } from './engine/ai'
import { exportScenarioBackup, saveFile } from './engine/io'
import { cardTypeLabel } from './engine/defaults'
import { useAutosave, type SaveState, type StoryChange } from './hooks'

type Tab = 'plot' | 'cards' | 'details'

export function SavedIndicator({ state }: { state: SaveState }): React.JSX.Element {
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.span key={state === 'saved' ? 's' : 'p'} initial={{ opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -3 }} transition={{ duration: 0.18, ease }} className="flex items-center gap-1.5 text-[12px] font-medium text-fg-3">
        {state === 'saved' ? <Check className="size-3.5" /> : <Spinner className="size-3" />}
        {state === 'saved' ? 'Saved' : 'Saving…'}
      </motion.span>
    </AnimatePresence>
  )
}

function descendants(id: string): Scenario[] {
  const s = db.get('scenarios', id)
  if (!s) return []
  return s.choices.flatMap((c) => {
    const k = db.get('scenarios', c)
    return k ? [k, ...descendants(k.id)] : []
  })
}

function rootOf(s: Scenario): Scenario {
  let cur = s
  for (let i = 0; i < 20 && cur.parentId; i++) {
    const p = db.get('scenarios', cur.parentId)
    if (!p) break
    cur = p
  }
  return cur
}

/** Small cover thumbnail in the header; shows cover-painting progress. */
function HeaderCover({ scenario, onClick }: { scenario: Scenario; onClick: () => void }): React.JSX.Element {
  const target = useMemo(() => ({ collection: 'scenarios' as const, id: scenario.id }), [scenario.id])
  const progress = useCoverProgress(target)
  const running = progress.phase !== 'idle'
  return (
    <motion.button whileHover={{ scale: 1.04 }} whileTap={{ scale: 0.96 }} transition={spring} onClick={onClick} title={running ? 'Painting the cover…' : 'Cover (Details)'} className="group relative shrink-0 max-[380px]:hidden">
      <CoverArt coverAssetId={scenario.coverAssetId} template={scenario.template} title={scenario.title} compact className="h-10 w-16 rounded-[10px] ring-1 ring-line-strong max-md:w-12">
        {running && (
          <div className="absolute inset-0 grid place-items-center bg-black/45">
            <ProgressRing value={progress.phase === 'painting' ? progress.value : undefined} size={18} />
          </div>
        )}
      </CoverArt>
    </motion.button>
  )
}

/** Keyed by id so moving between a scenario and its choices starts fresh. */
export function ScenarioEditor(): React.JSX.Element {
  const { id } = useParams()
  return <Editor key={id} id={id} />
}

function Editor({ id }: { id: string | undefined }): React.JSX.Element {
  const navigate = useNavigate()
  const loaded = useCollectionLoaded('scenarios')
  const { value: s, change, state, flush } = useAutosave('scenarios', id)
  const parent = useDoc('scenarios', s?.parentId)
  const [tab, setTab] = useState<Tab>('plot')
  const [starting, setStarting] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void flush()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [flush])

  const info: StoryInfo = useMemo(
    () => ({ title: s?.title ?? '', description: s?.description ?? '', opening: s?.opening ?? '', plot: s?.plot ?? { plotEssentials: '', storySummary: '', aiInstructions: '' }, cards: s?.cards ?? [] }),
    [s?.title, s?.description, s?.opening, s?.plot, s?.cards]
  )

  if (!loaded) {
    return (
      <Page>
        <div className="mx-auto flex max-w-[760px] flex-col gap-4 px-6 pt-8">
          <Skeleton className="h-[110px] rounded-2xl" />
          <Skeleton className="h-[260px] rounded-2xl" />
        </div>
      </Page>
    )
  }
  if (!s) {
    return (
      <Page>
        <EmptyState title="Scenario not found" body="It may have been deleted." action={<Button onClick={() => navigate('/stories')}>Back to stories</Button>} className="h-full" />
      </Page>
    )
  }

  const scenario = s
  const isChild = !!scenario.parentId
  const setup = scenario.openingType !== 'story'

  const finish = async (): Promise<void> => {
    await flush()
    if (isChild && scenario.parentId) navigate(`/stories/scenario/${scenario.parentId}`)
    else navigate('/stories')
  }

  const play = async (): Promise<void> => {
    setStarting(true)
    try {
      await flush()
      const root = rootOf(db.get('scenarios', scenario.id) ?? scenario)
      const adv = await startAdventure(root)
      navigate(`/play/${adv.id}`)
    } catch (err) {
      toast.error('Could not start the adventure', errorText(err))
      setStarting(false)
    }
  }

  const exportBackup = (): void => {
    void exportScenarioBackup(scenario, descendants(scenario.id))
  }
  const exportText = (): void => {
    const parts = [
      scenario.title && `# ${scenario.title}`,
      scenario.description,
      scenario.opening && `## Opening\n${scenario.opening}`,
      scenario.plot.plotEssentials && `## Plot Essentials\n${scenario.plot.plotEssentials}`,
      scenario.plot.authorsNote && `## Author's Note\n${scenario.plot.authorsNote}`,
      scenario.cards.length && `## Story Cards\n${scenario.cards.map((c) => `### ${c.name} (${cardTypeLabel(c)})\n${c.entry}\nTriggers: ${c.triggers}`).join('\n\n')}`
    ]
    void saveFile(scenario.title || 'scenario', parts.filter(Boolean).join('\n\n'), 'txt')
  }

  const storyChange = change as unknown as StoryChange

  return (
    <Page>
      <StoryStyles />
      {/* Frosted sticky header — the page diffuses underneath as it scrolls. */}
      <FrostHeader width={780}>
        {/* Phones: one compact row — the save state moves under the title, Play becomes an icon. */}
        <div className="flex items-center gap-3 max-md:gap-2.5">
          {isChild && (
            <IconButton label={`Back to ${parent?.title || 'parent'}`} variant="secondary" onClick={() => void finish()} className="max-md:size-10">
              <ArrowLeft className="size-4" />
            </IconButton>
          )}
          <HeaderCover scenario={scenario} onClick={() => setTab('details')} />
          <div className="min-w-0 max-md:flex-1">
            <h1 className="flex items-center gap-2 font-serif text-[21px] leading-tight font-semibold tracking-tight max-md:text-[17px]">
              <span className="max-md:truncate">{isChild ? 'Edit Choice' : 'Edit Scenario'}</span>
              <Pencil className="size-3.5 text-fg-3 max-md:hidden" />
            </h1>
            <div className="flex min-w-0 items-center gap-2">
              <div className="min-w-0 truncate text-[11.5px] text-fg-3">{isChild ? `Part of “${parent?.title || 'Untitled'}”` : scenario.title || 'Untitled scenario'}</div>
              <span className="shrink-0 md:hidden [&>span]:text-[11px]">
                <SavedIndicator state={state} />
              </span>
            </div>
          </div>
          <span className="contents max-md:hidden">
            <SavedIndicator state={state} />
          </span>
          <div className="flex-1 max-md:hidden" />
          <Button variant="secondary" icon={<Play className="size-3.5 fill-current" />} loading={starting} onClick={() => void play()} aria-label="Play" className="max-md:size-10 max-md:rounded-xl max-md:px-0">
            <span className="max-md:hidden">Play</span>
          </Button>
          <Button variant="primary" className="min-w-[92px] tracking-wide uppercase max-md:h-10 max-md:min-w-0 max-md:rounded-xl max-md:px-3.5" onClick={() => void finish()}>
            Finish
          </Button>
        </div>
        <div className="mt-3.5 max-md:mt-3">
          <Segmented
            caps
            value={tab}
            onChange={setTab}
            className="max-md:flex max-md:w-full max-md:[&_svg]:hidden max-md:[&>button]:h-9 max-md:[&>button]:flex-1 max-md:[&>button]:justify-center max-md:[&>button]:px-2"
            items={[
              { value: 'plot', label: setup ? 'Setup' : 'Plot', icon: setup ? <Settings /> : <SlidersHorizontal /> },
              {
                value: 'cards',
                label: (
                  <>
                    <span className="max-md:hidden">Story cards</span>
                    <span className="md:hidden">Cards</span>
                  </>
                ),
                icon: <LayoutGrid />,
                count: scenario.cards.length
              },
              { value: 'details', label: 'Details', icon: <List /> }
            ]}
          />
        </div>
      </FrostHeader>
      <div className="mx-auto max-w-[780px] px-6 pb-24 max-md:px-3 max-md:pb-16">

        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={`${id}-${tab}`} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.28, ease }} className="pt-2">
            {tab === 'plot' && (
              <div className="flex flex-col gap-3">
                <OpeningEditor scenario={scenario} change={change} info={info} onConfigure={(cid) => void flush().then(() => navigate(`/stories/scenario/${cid}`))} />
                <PlotComponentsEditor plot={scenario.plot} onChange={(plot) => change({ plot })} />
              </div>
            )}
            {tab === 'cards' && <StoryCardsBoard cards={scenario.cards} onChange={(next) => change((cur) => ({ cards: typeof next === 'function' ? next(cur.cards) : next }))} info={info} />}
            {tab === 'details' && (
              <StoryDetails doc={scenario} change={storyChange} collection="scenarios" template={scenario.template} info={info} onExportBackup={exportBackup} onExportText={exportText} />
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </Page>
  )
}
