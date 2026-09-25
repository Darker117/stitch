// “Generate with AI”: a brief in, a complete scenario out (premise, world,
// rules, story cards, opening) — then straight into the editor for review.
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { create } from 'zustand'
import { AnimatePresence, motion } from 'motion/react'
import { BookOpen, Layers, ListChecks, MessagesSquare, NotebookPen, Scroll, Square, Tags, Users, WandSparkles } from 'lucide-react'
import { ModelPicker } from '@/components/model-picker'
import { LogoMark } from '@/components/shell/logo'
import { Button, Chip } from '@/components/ui/button'
import { Textarea } from '@/components/ui/input'
import { Segmented, SwitchRow } from '@/components/ui/controls'
import { Field } from '@/components/ui/misc'
import { errorText } from '@/lib/api'
import { useDefaultLlm, type LlmChoice } from '@/lib/llm'
import { ease, rise, stagger } from '@/lib/motion'
import { toast, useToasts } from '@/stores/toast'
import { ThinkingBlock } from '@/features/create/Messages'
import { useCanPaint } from '../components/cover'
import { generateCover } from '../engine/cover'
import { generateDraft, isAborted, type GenStage, type OpeningPref } from './ai'
import { StageList } from './bits'
import { saveDraft, type ScenarioDraft } from './draft'

const EXAMPLES = [
  'A noir detective story in a city where it never stops raining',
  'Survive a zombie outbreak on a cruise ship',
  'A cozy fantasy bakery in a town of retired adventurers',
  'Space pirates, a stolen AI and a bounty on your head'
]

const STAGES = [
  { id: 'core', label: 'Premise, world & rules', hint: 'Title, pitch, tags, plot essentials, narrator rules' },
  { id: 'cards', label: 'Story cards', hint: 'Characters, places, factions and lore' },
  { id: 'opening', label: 'Opening', hint: 'The first scene of the adventure' },
  { id: 'save', label: 'Saving & opening the editor' }
]

const YOU_GET = [
  { icon: <Tags />, title: 'Title, pitch & tags', body: 'Shown on your story card' },
  { icon: <NotebookPen />, title: 'Plot essentials & backstory', body: 'What the narrator always remembers' },
  { icon: <ListChecks />, title: "AI instructions & author's note", body: 'Tone, pacing and style' },
  { icon: <Layers />, title: 'Story cards', body: 'Characters, places, factions, lore' },
  { icon: <BookOpen />, title: 'An opening', body: 'Story or character creator' }
]

// The run lives outside the component: leaving the page doesn't lose it — the
// scenario is still created (and offered in a toast) when it finishes.
interface Run {
  brief: string
  stage: GenStage | 'save' | null
  partial: ScenarioDraft | null
  reasoning: string
  error: string | null
  /** Set when the scenario was saved; the page opens it if it's still showing. */
  createdId: string | null
}
const useRun = create<Run>(() => ({ brief: '', stage: null, partial: null, reasoning: '', error: null, createdId: null }))
let runCtrl: AbortController | null = null
let pageMounted = false

async function startRun(brief: string, opts: { llm?: LlmChoice; pref: OpeningPref; cardCount: number; paint: boolean }): Promise<void> {
  if (useRun.getState().stage) return
  runCtrl = new AbortController()
  useRun.setState({ brief, stage: 'core', partial: null, reasoning: '', error: null, createdId: null })
  try {
    const { draft } = await generateDraft(brief, {
      llm: opts.llm,
      signal: runCtrl.signal,
      pref: opts.pref,
      cardCount: opts.cardCount,
      onReasoning: (reasoning) => useRun.setState({ reasoning }),
      onStage: (stage, partial) => useRun.setState({ stage, partial })
    })
    useRun.setState({ partial: draft, stage: 'save' })
    const s = await saveDraft(draft)
    if (opts.paint) void generateCover({ collection: 'scenarios', id: s.id }, { llm: opts.llm })
    const body = opts.paint ? 'Painting the cover in the background…' : 'Review it, then press Play.'
    if (pageMounted) toast.success(`Created “${s.title}”`, body)
    else useToasts.getState().push({ title: `Created “${s.title}”`, body, tone: 'success', ms: 10000, action: { label: 'Open', run: () => void (window.location.hash = `#/stories/scenario/${s.id}`) } })
    useRun.setState({ stage: null, createdId: pageMounted ? s.id : null, brief: '' })
  } catch (err) {
    useRun.setState({ stage: null, error: isAborted(err) ? null : errorText(err) })
    if (!pageMounted && !isAborted(err)) toast.error('Could not generate the scenario', errorText(err))
  }
}

export function QuickGenerate({ onCompose }: { onCompose: (brief: string) => void }): React.JSX.Element {
  const navigate = useNavigate()
  const defLlm = useDefaultLlm()
  const canPaint = useCanPaint()
  const run = useRun()
  const [brief, setBrief] = useState(() => useRun.getState().brief)
  const [pref, setPref] = useState<OpeningPref>('auto')
  const [count, setCount] = useState<'5' | '8' | '12'>('8')
  const [paint, setPaint] = useState(true)
  const [llm, setLlm] = useState<LlmChoice | undefined>()
  const { stage, partial, reasoning, error } = run
  const running = stage !== null

  useEffect(() => {
    pageMounted = true
    return () => {
      pageMounted = false
    }
  }, [])
  // Finished while this page was showing → open it in the editor.
  useEffect(() => {
    if (!run.createdId) return
    const id = run.createdId
    useRun.setState({ createdId: null })
    navigate(`/stories/scenario/${id}`)
  }, [run.createdId, navigate])

  const go = (): void => {
    if (!brief.trim() || running) return
    void startRun(brief, { llm: llm ?? defLlm, pref, cardCount: Number(count), paint: paint && canPaint })
  }

  return (
    <div className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] gap-5">
      <motion.div variants={rise} className="flex flex-col gap-4 rounded-[20px] border border-line bg-white/[0.03] p-5 hairline">
        <Field label="Describe your story">
          <Textarea
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) go()
            }}
            minRows={5}
            maxRows={14}
            disabled={running}
            placeholder="A premise, a vibe, a character, a twist — a sentence is enough. e.g. You're a disgraced knight hired to escort a cursed princess who keeps trying to escape."
            className="text-[13.5px]"
            autoFocus
          />
        </Field>
        <div className="flex flex-wrap gap-1.5">
          {EXAMPLES.map((e) => (
            <Chip key={e} disabled={running} onClick={() => setBrief(e)} className="h-7 text-[11.5px]">
              {e}
            </Chip>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Opening">
            <Segmented
              size="sm"
              value={pref}
              onChange={setPref}
              items={[
                { value: 'auto', label: 'Auto', icon: <WandSparkles /> },
                { value: 'story', label: 'Story', icon: <BookOpen /> },
                { value: 'characterCreator', label: 'Creator', icon: <Users /> }
              ]}
            />
          </Field>
          <Field label="Story cards">
            <Segmented
              size="sm"
              value={count}
              onChange={setCount}
              items={[
                { value: '5', label: 'A few' },
                { value: '8', label: 'Some' },
                { value: '12', label: 'Lots' }
              ]}
            />
          </Field>
        </div>
        <SwitchRow
          label="Paint a cover too"
          help={canPaint ? 'Turns the finished story into an image prompt and renders a cover — it attaches itself while you review.' : 'Start ComfyUI (Connectors) to paint covers. You can add one later in Details.'}
          checked={paint && canPaint}
          disabled={!canPaint}
          onChange={setPaint}
        />
        <div className="mt-1 flex items-center gap-2 border-t border-line pt-4">
          <ModelPicker value={llm ?? defLlm} onChange={setLlm} />
          <div className="flex-1" />
          <Button variant="ghost" icon={<MessagesSquare className="size-3.5" />} disabled={running} onClick={() => onCompose(brief)}>
            Compose instead
          </Button>
          {running ? (
            <Button variant="secondary" icon={<Square className="size-3 fill-current" />} onClick={() => runCtrl?.abort()}>
              Stop
            </Button>
          ) : (
            <Button variant="primary" size="lg" icon={<WandSparkles className="size-4" />} disabled={!brief.trim()} onClick={go}>
              Generate scenario
            </Button>
          )}
        </div>
      </motion.div>

      <motion.div variants={rise} className="relative overflow-hidden rounded-[20px] border border-line bg-white/[0.02] p-5 hairline">
        <div className="pointer-events-none absolute -top-24 -right-24 size-72 rounded-full opacity-40 blur-[80px]" style={{ background: 'radial-gradient(circle, var(--accent-2), transparent 70%)' }} />
        <AnimatePresence mode="wait" initial={false}>
          {running ? (
            <motion.div key="run" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.3, ease }} className="relative flex flex-col gap-5">
              <div className="label-caps">Writing your scenario</div>
              <StageList stages={STAGES} current={stage ?? undefined} />
              {reasoning && <ThinkingBlock reasoning={reasoning} live={stage !== 'save'} />}
              <AnimatePresence>
                {partial && (partial.title || partial.description) && (
                  <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease }} className="flex flex-col gap-2 rounded-2xl border border-line bg-white/[0.03] p-4">
                    <div className="font-serif text-[18px] leading-tight font-semibold">{partial.title}</div>
                    <p className="line-clamp-3 text-[12px] leading-relaxed text-fg-2">{partial.description}</p>
                    {partial.cards.length > 0 && (
                      <motion.div variants={stagger(0.03, 0)} initial="initial" animate="animate" className="flex flex-wrap gap-1.5 pt-1">
                        {partial.cards.map((c) => (
                          <motion.span key={c.id} variants={rise} className="rounded-full border border-line bg-white/[0.04] px-2 py-0.5 text-[11px] text-fg-2">
                            {c.name}
                          </motion.span>
                        ))}
                      </motion.div>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          ) : (
            <motion.div key="idle" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.3, ease }} className="relative flex h-full flex-col gap-4">
              <div className="flex items-center gap-3">
                <LogoMark size={30} />
                <div>
                  <div className="font-serif text-[17px] font-semibold">A complete scenario, in one go</div>
                  <div className="text-[12px] text-fg-3">Opens in the editor so you can review everything.</div>
                </div>
              </div>
              {error && <div className="rounded-xl border border-danger/25 bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</div>}
              <motion.ul variants={stagger(0.05, 0.1)} initial="initial" animate="animate" className="flex flex-col gap-2.5">
                {YOU_GET.map((y) => (
                  <motion.li key={y.title} variants={rise} className="flex items-center gap-3">
                    <span className="grid size-8 shrink-0 place-items-center rounded-xl border border-line bg-white/[0.04] text-fg-2 [&>svg]:size-4">{y.icon}</span>
                    <div>
                      <div className="text-[12.5px] font-medium">{y.title}</div>
                      <div className="text-[11.5px] text-fg-3">{y.body}</div>
                    </div>
                  </motion.li>
                ))}
              </motion.ul>
              <div className="mt-auto flex items-center gap-2 rounded-xl border border-line bg-white/[0.03] px-3 py-2 text-[11.5px] text-fg-3">
                <Scroll className="size-3.5 shrink-0" />
                Want mechanics like HP or inventory? The Composer can write scripts for them.
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  )
}
