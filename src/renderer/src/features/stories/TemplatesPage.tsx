// New story: three ways to begin — a template, a one-shot AI generation from a
// brief, or the Scenario Composer (build it together, scripts included).
import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { AnimatePresence, motion } from 'motion/react'
import { ArrowLeft, ArrowRight, ArrowUpRight, Code2, LayoutTemplate, MessagesSquare, WandSparkles } from 'lucide-react'
import { Page } from '@/components/shell/page'
import { Button, IconButton } from '@/components/ui/button'
import { Textarea } from '@/components/ui/input'
import { Spinner } from '@/components/ui/misc'
import { errorText } from '@/lib/api'
import { cn } from '@/lib/utils'
import { ease, rise, spring, stagger } from '@/lib/motion'
import { toast } from '@/stores/toast'
import { TemplateArt } from './components/art'
import { StoryStyles } from './components/StoryStyles'
import { QuickGenerate } from './composer/QuickGenerate'
import { SECTIONS } from './composer/draft'
import { useComposer } from './composer/store'
import { createFromTemplate, TEMPLATES, type TemplateId } from './templates'

type Mode = 'templates' | 'ai' | 'compose'

const MODES: { id: Mode; title: string; body: string; icon: React.ReactNode }[] = [
  { id: 'templates', title: 'Start from a template', body: 'Ready-made worlds you can play right away and tweak later.', icon: <LayoutTemplate /> },
  { id: 'ai', title: 'Generate with AI', body: 'Describe it in a sentence — get a complete scenario to review.', icon: <WandSparkles /> },
  { id: 'compose', title: 'Scenario Composer', body: 'Build it together with the AI, section by section — scripts included.', icon: <MessagesSquare /> }
]

function ModeCard({ m, active, onClick }: { m: (typeof MODES)[number]; active: boolean; onClick: () => void }): React.JSX.Element {
  return (
    <motion.button
      variants={rise}
      whileHover={{ y: -3 }}
      whileTap={{ scale: 0.985 }}
      transition={spring}
      onClick={onClick}
      className={cn('group relative flex items-start gap-3.5 overflow-hidden rounded-[18px] border p-4 text-left transition-colors duration-300', active ? 'border-transparent' : 'border-line bg-white/[0.03] hover:border-line-strong hover:bg-white/[0.05]')}
    >
      {active && (
        <motion.span
          layoutId="new-story-mode"
          transition={spring}
          className="absolute inset-0 rounded-[18px] border border-[color-mix(in_oklab,var(--accent)_45%,transparent)] bg-[linear-gradient(135deg,color-mix(in_oklab,var(--accent-2)_16%,transparent),color-mix(in_oklab,var(--accent)_10%,transparent))] shadow-[0_18px_40px_-24px_color-mix(in_oklab,var(--accent)_70%,transparent)]"
        />
      )}
      <span className={cn('relative grid size-10 shrink-0 place-items-center rounded-xl transition-colors duration-300 [&>svg]:size-[18px]', active ? 'bg-grad text-white' : 'bg-white/[0.06] text-fg-2 group-hover:text-fg')}>{m.icon}</span>
      <span className="relative min-w-0">
        <span className="block font-serif text-[16.5px] font-semibold tracking-tight">{m.title}</span>
        <span className="mt-0.5 block text-[12px] leading-snug text-fg-2">{m.body}</span>
      </span>
    </motion.button>
  )
}

function Templates(): React.JSX.Element {
  const navigate = useNavigate()
  const [busy, setBusy] = useState<TemplateId | null>(null)
  const pick = async (id: TemplateId): Promise<void> => {
    if (busy) return
    setBusy(id)
    try {
      const s = await createFromTemplate(id)
      navigate(`/stories/scenario/${s.id}`)
    } catch (err) {
      toast.error('Could not create the scenario', errorText(err))
      setBusy(null)
    }
  }
  return (
    <motion.div variants={stagger(0.05, 0.02)} initial="initial" animate="animate" className="grid grid-cols-3 gap-4">
      {TEMPLATES.map((t) => (
        <motion.button
          key={t.id}
          variants={rise}
          whileHover={{ y: -4 }}
          whileTap={{ scale: 0.985 }}
          transition={{ type: 'spring', stiffness: 380, damping: 28 }}
          onClick={() => void pick(t.id)}
          className="group relative aspect-[16/9] overflow-hidden rounded-[18px] text-left ring-1 ring-line transition-shadow duration-300 hover:shadow-[0_24px_60px_-20px_color-mix(in_oklab,var(--accent)_45%,transparent)] hover:ring-line-strong"
        >
          <TemplateArt template={t.id} className="absolute inset-0" />
          <div className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-3 p-4">
            <div>
              <div className="font-serif text-[19px] font-semibold text-white drop-shadow">{t.name}</div>
              <div className="mt-0.5 text-[12px] text-white/65 transition-colors group-hover:text-white/85">{t.blurb}</div>
            </div>
            <span className="grid size-8 translate-y-1 place-items-center rounded-full bg-white/10 text-white opacity-0 backdrop-blur transition-all duration-300 group-hover:translate-y-0 group-hover:opacity-100">
              <ArrowUpRight className="size-4" />
            </span>
          </div>
          {busy === t.id && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="absolute inset-0 grid place-items-center bg-black/50 backdrop-blur-sm">
              <Spinner className="size-6 text-white" />
            </motion.div>
          )}
        </motion.button>
      ))}
    </motion.div>
  )
}

function ComposeLaunch({ onOpen }: { onOpen: (brief: string) => void }): React.JSX.Element {
  const draft = useComposer((s) => s.draft)
  const [brief, setBrief] = useState('')
  const inProgress = SECTIONS.some((s) => draft.sections[s.id] !== 'empty')
  const steps = [
    { n: '1', title: 'Pitch it', body: 'Chat about the story you want. The composer asks the right questions.' },
    { n: '2', title: 'Watch it form', body: 'Premise, world, cast, opening and rules appear live — accept, regenerate or edit each.' },
    { n: '3', title: 'Add mechanics', body: 'Describe HP, inventory or inner thoughts; it writes and validates an AI Dungeon-style script.' },
    { n: '4', title: 'Create', body: 'One click saves the scenario, attaches the scripts and paints a cover.' }
  ]
  return (
    <motion.div variants={stagger(0.05, 0.02)} initial="initial" animate="animate" className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] gap-5">
      <motion.div variants={rise} className="flex flex-col gap-4 rounded-[20px] border border-line bg-white/[0.03] p-5 hairline">
        {inProgress && (
          <button onClick={() => onOpen('')} className="group flex items-center gap-3 rounded-2xl border border-[color-mix(in_oklab,var(--accent)_35%,transparent)] bg-[color-mix(in_oklab,var(--accent)_8%,transparent)] px-4 py-3 text-left transition-colors hover:bg-[color-mix(in_oklab,var(--accent)_12%,transparent)]">
            <span className="size-2 animate-pulse rounded-full bg-accent" />
            <span className="min-w-0 flex-1">
              <span className="block text-[12.5px] font-semibold">Continue your draft{draft.title ? ` — “${draft.title}”` : ''}</span>
              <span className="block text-[11.5px] text-fg-3">{SECTIONS.filter((s) => draft.sections[s.id] !== 'empty').length} of {SECTIONS.length} sections started</span>
            </span>
            <ArrowRight className="size-4 text-fg-2 transition-transform group-hover:translate-x-0.5" />
          </button>
        )}
        <div className="label-caps">{inProgress ? 'Or start fresh with a pitch' : 'Start with a pitch (optional)'}</div>
        <Textarea value={brief} onChange={(e) => setBrief(e.target.value)} minRows={4} maxRows={10} placeholder="What should the story be about? You can also just open the Composer and chat." className="text-[13.5px]" />
        <div className="flex items-center justify-end gap-2">
          <Button
            variant="primary"
            size="lg"
            icon={<MessagesSquare className="size-4" />}
            onClick={() => {
              if (brief.trim() && inProgress) useComposer.getState().reset()
              onOpen(brief)
            }}
          >
            Open the Composer
          </Button>
        </div>
      </motion.div>
      <motion.div variants={rise} className="relative flex flex-col gap-3.5 overflow-hidden rounded-[20px] border border-line bg-white/[0.02] p-5 hairline">
        <div className="pointer-events-none absolute -right-20 -bottom-24 size-72 rounded-full opacity-40 blur-[80px]" style={{ background: 'radial-gradient(circle, var(--accent), transparent 70%)' }} />
        {steps.map((s) => (
          <div key={s.n} className="relative flex gap-3">
            <span className="grid size-7 shrink-0 place-items-center rounded-full bg-white/[0.07] text-[11.5px] font-semibold text-fg-2 tabular-nums">{s.n}</span>
            <div>
              <div className="text-[12.5px] font-semibold">{s.title}</div>
              <div className="text-[11.5px] leading-snug text-fg-3">{s.body}</div>
            </div>
          </div>
        ))}
        <div className="relative mt-1 flex items-center gap-2 text-[11.5px] text-fg-3">
          <Code2 className="size-3.5" /> Scripts use the AI Dungeon format — Library, Input, Context, Output.
        </div>
      </motion.div>
    </motion.div>
  )
}

export function TemplatesPage(): React.JSX.Element {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const raw = params.get('mode')
  const mode: Mode = raw === 'ai' || raw === 'compose' ? raw : 'templates'
  const setMode = (m: Mode): void => void setParams(m === 'templates' ? {} : { mode: m }, { replace: true })
  const compose = (brief: string): void => void navigate('/stories/compose', { state: brief.trim() ? { brief: brief.trim() } : null })

  return (
    <Page>
      <StoryStyles />
      <div className="mx-auto max-w-[1180px] px-8 pt-7 pb-14">
        <div className="flex items-start gap-3">
          <IconButton label="Back to stories" variant="secondary" onClick={() => navigate('/stories')} className="mt-1">
            <ArrowLeft className="size-4" />
          </IconButton>
          <div>
            <motion.h1 initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease }} className="font-serif text-[30px] font-semibold tracking-tight">
              New story
            </motion.h1>
            <motion.p initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease, delay: 0.06 }} className="mt-1 text-[13px] text-fg-2">
              Three ways to begin. Whatever you pick, everything stays editable.
            </motion.p>
          </div>
        </div>

        <motion.div variants={stagger(0.06, 0.05)} initial="initial" animate="animate" className="mt-7 grid grid-cols-3 gap-3">
          {MODES.map((m) => (
            <ModeCard key={m.id} m={m} active={mode === m.id} onClick={() => setMode(m.id)} />
          ))}
        </motion.div>

        <div className="mt-6">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={mode} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.28, ease }}>
              {mode === 'templates' && <Templates />}
              {mode === 'ai' && (
                <motion.div variants={stagger(0.06, 0.02)} initial="initial" animate="animate">
                  <QuickGenerate onCompose={compose} />
                </motion.div>
              )}
              {mode === 'compose' && <ComposeLaunch onOpen={compose} />}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </Page>
  )
}
