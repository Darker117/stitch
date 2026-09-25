import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { AnimatePresence, motion } from 'motion/react'
import { ArrowLeft, Check, LayoutGrid, List, Pencil, Play, Settings, SlidersHorizontal } from 'lucide-react'
import type { Scenario } from '@shared/types'
import { Page } from '@/components/shell/page'
import { Button, IconButton } from '@/components/ui/button'
import { Segmented } from '@/components/ui/controls'
import { EmptyState, Skeleton, Spinner } from '@/components/ui/misc'
import { errorText } from '@/lib/api'
import { ease } from '@/lib/motion'
import { db, useCollectionLoaded, useDoc } from '@/stores/db'
import { toast } from '@/stores/toast'
import { StoryStyles } from './components/StoryStyles'
import { StoryCardsBoard } from './components/cards'
import { PlotComponentsEditor } from './components/plot'
import { OpeningEditor } from './components/opening'
import { StoryDetails } from './components/details'
import { startAdventure } from './engine/adventure'
import type { StoryInfo } from './engine/ai'
import { saveFile } from './engine/io'
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
    void saveFile(scenario.title || 'scenario', JSON.stringify({ kind: 'stitch-scenario', version: 1, scenario, children: descendants(scenario.id) }, null, 2), 'json')
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
      <div className="mx-auto max-w-[780px] px-6 pb-24">
        {/* Header card */}
        <div className="sticky top-0 z-20 -mx-2 px-2 pt-5 pb-3">
          <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.45, ease }} className="glass-strong rounded-[20px] p-4 shadow-[0_24px_50px_-28px_rgb(0_0_0/0.9)]">
            <div className="flex items-center gap-3">
              {isChild && (
                <IconButton label={`Back to ${parent?.title || 'parent'}`} variant="secondary" onClick={() => void finish()}>
                  <ArrowLeft className="size-4" />
                </IconButton>
              )}
              <Pencil className="size-4.5 text-fg-2" />
              <div className="min-w-0">
                <h1 className="font-serif text-[21px] leading-tight font-semibold tracking-tight">{isChild ? 'Edit Choice' : 'Edit Scenario'}</h1>
                {isChild && <div className="truncate text-[11.5px] text-fg-3">Part of “{parent?.title || 'Untitled'}”</div>}
              </div>
              <SavedIndicator state={state} />
              <div className="flex-1" />
              <Button variant="secondary" icon={<Play className="size-3.5 fill-current" />} loading={starting} onClick={() => void play()}>
                Play
              </Button>
              <Button variant="primary" className="min-w-[92px] tracking-wide uppercase" onClick={() => void finish()}>
                Finish
              </Button>
            </div>
            <div className="mt-3.5">
              <Segmented
                caps
                value={tab}
                onChange={setTab}
                items={[
                  { value: 'plot', label: setup ? 'Setup' : 'Plot', icon: setup ? <Settings /> : <SlidersHorizontal /> },
                  { value: 'cards', label: 'Story cards', icon: <LayoutGrid />, count: scenario.cards.length },
                  { value: 'details', label: 'Details', icon: <List /> }
                ]}
              />
            </div>
          </motion.div>
        </div>

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
