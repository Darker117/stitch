// Scenario Composer: build a scenario together with the model — a chat on the
// left, the scenario forming live on the right (accept / regenerate / edit per
// section), scripts composed from plain-language mechanics, then “Create”.
import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { AnimatePresence, motion } from 'motion/react'
import { AlertTriangle, ArrowLeft, Check, CheckCheck, Code2, Ellipsis, Eye, Layers, MessagesSquare, RotateCcw, Sparkles } from 'lucide-react'
import { Page } from '@/components/shell/page'
import { LogoMark } from '@/components/shell/logo'
import { ModelPicker } from '@/components/model-picker'
import { Button, IconButton } from '@/components/ui/button'
import { Dialog, Menu, MenuItem } from '@/components/ui/overlay'
import { Segmented, SwitchRow } from '@/components/ui/controls'
import { errorText } from '@/lib/api'
import { useDefaultLlm } from '@/lib/llm'
import { cn, pluralize } from '@/lib/utils'
import { ease, spring } from '@/lib/motion'
import { useCompact } from '@/lib/platform'
import { toast } from '@/stores/toast'
import { StoryStyles } from '../components/StoryStyles'
import { FrostHeader } from '../components/frost'
import { CoverArt } from '../components/art'
import { useCanPaint } from '../components/cover'
import { generateCover } from '../engine/cover'
import { StateDot } from './bits'
import { ChatPanel } from './Chat'
import { Preview } from './Preview'
import { SECTIONS, saveDraft } from './draft'
import { attachDraftScripts } from './scripts'
import { useComposer } from './store'

function Stepper({ className }: { className?: string }): React.JSX.Element {
  const sections = useComposer((s) => s.draft.sections)
  const focus = useComposer((s) => s.focus)
  const setFocus = useComposer((s) => s.setFocus)
  const compact = useCompact()
  const box = useRef<HTMLDivElement>(null)
  // Phones: the stepper scrolls sideways — keep the focused step in view (chat or preview can move it).
  useEffect(() => {
    if (!compact) return
    const el = box.current?.querySelector<HTMLElement>(`[data-step="${focus}"]`)
    const sc = box.current?.parentElement
    if (!el || !sc) return
    const a = el.getBoundingClientRect()
    const b = sc.getBoundingClientRect()
    if (a.left < b.left + 8) sc.scrollBy({ left: a.left - b.left - 8, behavior: 'smooth' })
    else if (a.right > b.right - 8) sc.scrollBy({ left: a.right - b.right + 8, behavior: 'smooth' })
  }, [compact, focus])
  return (
    <div ref={box} className={cn('flex items-center gap-1 rounded-xl border border-line bg-white/[0.03] p-1', className)}>
      {SECTIONS.map((s, i) => {
        const active = focus === s.id
        return (
          <button
            key={s.id}
            data-step={s.id}
            onClick={() => setFocus(s.id)}
            className={cn('relative flex h-7.5 items-center gap-2 rounded-lg px-3 text-[12px] font-semibold transition-colors duration-200 max-md:h-8 max-md:shrink-0', active ? 'text-fg' : 'text-fg-3 hover:text-fg-2')}
          >
            {active && <motion.span layoutId="composer-step" className="absolute inset-0 rounded-lg border border-line-strong bg-white/[0.1] shadow-[inset_0_1px_0_rgb(255_255_255/0.08)]" transition={spring} />}
            <span className="relative flex items-center gap-2">
              <span className="text-[10.5px] text-fg-3 tabular-nums">{i + 1}</span>
              {s.label}
              <StateDot state={sections[s.id]} />
            </span>
          </button>
        )
      })}
    </div>
  )
}

function CreateDialog({ open, onClose }: { open: boolean; onClose: () => void }): React.JSX.Element {
  const navigate = useNavigate()
  const d = useComposer((s) => s.draft)
  const llm = useComposer((s) => s.llm)
  const canPaint = useCanPaint()
  const [paint, setPaint] = useState(true)
  const [busy, setBusy] = useState(false)
  const attach = d.scripts.filter((s) => s.attach && s.status !== 'writing')
  const missing = SECTIONS.filter((s) => s.id !== 'scripts' && d.sections[s.id] === 'empty')
  const proposed = SECTIONS.filter((s) => d.sections[s.id] === 'proposed')

  const create = async (): Promise<void> => {
    setBusy(true)
    try {
      const s = await saveDraft(d)
      const n = await attachDraftScripts(s.id, d.scripts)
      if (paint && canPaint) void generateCover({ collection: 'scenarios', id: s.id }, { llm })
      toast.success(`Created “${s.title}”`, [n ? pluralize(n, 'script') + ' attached' : '', paint && canPaint ? 'painting the cover…' : ''].filter(Boolean).join(' · ') || undefined)
      useComposer.getState().reset()
      onClose()
      navigate(`/stories/scenario/${s.id}`)
    } catch (err) {
      toast.error('Could not create the scenario', errorText(err))
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && !busy && onClose()}
      title="Create scenario"
      width={500}
      footer={
        <>
          <div className="flex-1" />
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Keep composing
          </Button>
          <Button variant="primary" icon={<Check className="size-4" />} loading={busy} onClick={() => void create()}>
            Create & open
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 p-5 pt-1">
        <div className="overflow-hidden rounded-2xl border border-line">
          <CoverArt title={d.title || 'Untitled'} compact className="aspect-[16/6] w-full">
            <div className="absolute inset-0 bg-[linear-gradient(to_top,rgb(0_0_0/0.8),transparent_70%)]" />
            <div className="absolute inset-x-0 bottom-0 p-4">
              <div className="truncate font-serif text-[19px] font-semibold text-white">{d.title || 'Untitled scenario'}</div>
              <div className="mt-1 flex items-center gap-3 text-[11.5px] text-white/65">
                <span className="flex items-center gap-1">
                  <Layers className="size-3" /> {pluralize(d.cards.length, 'story card')}
                </span>
                <span>{d.openingType === 'characterCreator' ? 'Character creator' : 'Story opening'}</span>
                {attach.length > 0 && (
                  <span className="flex items-center gap-1">
                    <Code2 className="size-3" /> {pluralize(attach.length, 'script')}
                  </span>
                )}
              </div>
            </div>
          </CoverArt>
        </div>
        {(missing.length > 0 || proposed.length > 0) && (
          <div className="flex flex-col gap-1.5 rounded-xl border border-line bg-white/[0.03] p-3 text-[12px] text-fg-2">
            {missing.length > 0 && (
              <div className="flex gap-2">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
                <span>
                  Still empty: <b className="font-semibold text-fg">{missing.map((m) => m.label).join(', ')}</b>. You can fill {missing.length > 1 ? 'them' : 'it'} in later in the editor.
                </span>
              </div>
            )}
            {proposed.length > 0 && (
              <div className="flex gap-2">
                <Sparkles className="mt-0.5 size-3.5 shrink-0 text-accent" />
                <span>Proposed sections are included as they are — everything stays editable.</span>
              </div>
            )}
          </div>
        )}
        <SwitchRow
          label="Paint a cover from the story"
          help={canPaint ? 'Writes an image prompt from the title, description and opening, then renders it. It lands on the scenario even if you move on.' : 'Start ComfyUI (Connectors) to paint covers — you can add one later in Details.'}
          checked={paint && canPaint}
          disabled={!canPaint}
          onChange={setPaint}
        />
      </div>
    </Dialog>
  )
}

export function ComposerPage(): React.JSX.Element {
  const navigate = useNavigate()
  const location = useLocation()
  const brief = (location.state as { brief?: string } | null)?.brief
  const [headerH, setHeaderH] = useState(150)
  const [stuck, setStuck] = useState(false)
  const [creating, setCreating] = useState(false)
  const defLlm = useDefaultLlm()
  const llm = useComposer((s) => s.llm)
  const setLlm = useComposer((s) => s.setLlm)
  const d = useComposer((s) => s.draft)
  const busy = useComposer((s) => !!s.busy)
  const { acceptAll, reset } = useComposer.getState()
  const ready = SECTIONS.filter((s) => d.sections[s.id] === 'accepted').length
  const anyProposed = SECTIONS.some((s) => d.sections[s.id] === 'proposed')
  const canCreate = !!(d.title.trim() || d.description.trim() || d.opening.trim())
  // Phones: chat and preview share the screen through a Chat / Preview switch.
  const compact = useCompact()
  const [view, setView] = useState<'chat' | 'preview'>('chat')
  const [reveal, setReveal] = useState(0)

  useEffect(() => {
    if (!llm && defLlm) setLlm(defLlm)
  }, [llm, defLlm, setLlm])

  // A pitch handed over from “New story” starts the conversation (once).
  const sent = useRef(false)
  useEffect(() => {
    if (!brief || sent.current) return
    sent.current = true
    navigate('/stories/compose', { replace: true, state: null })
    void useComposer.getState().send(brief)
  }, [brief, navigate])

  return (
    <Page scroll={false}>
      <StoryStyles />
      <div className="relative h-full">
        <FrostHeader overlay stuck={compact ? stuck && view === 'preview' : stuck} onHeight={setHeaderH} width={1280}>
          {compact ? (
            <>
              <div className="flex items-center gap-2.5">
                <IconButton label="Back to new story" variant="secondary" onClick={() => navigate('/stories/new')} className="size-10 rounded-xl">
                  <ArrowLeft className="size-4" />
                </IconButton>
                <div className="min-w-0 flex-1">
                  <h1 className="truncate font-serif text-[17px] leading-tight font-semibold tracking-tight">Composer</h1>
                  <AnimatePresence mode="wait" initial={false}>
                    <motion.div key={d.title || '-'} initial={{ opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -3 }} transition={{ duration: 0.2, ease }} className="truncate text-[11.5px] text-fg-3">
                      {d.title || 'Build it with your model'}
                    </motion.div>
                  </AnimatePresence>
                </div>
                <Menu
                  align="end"
                  trigger={
                    <IconButton label="Composer options" variant="secondary" disabled={busy} className="size-10 rounded-xl">
                      <Ellipsis className="size-4" />
                    </IconButton>
                  }
                >
                  <MenuItem icon={<RotateCcw />} danger onSelect={reset}>
                    Start over — discard this draft
                  </MenuItem>
                </Menu>
                <Button variant="primary" icon={<Check className="size-4" />} disabled={!canCreate || busy} onClick={() => setCreating(true)} className="h-10 rounded-xl px-3.5 tracking-wide">
                  Create
                </Button>
              </div>
              <Segmented
                value={view}
                onChange={setView}
                className="mt-2.5 flex w-full [&>button]:h-9 [&>button]:flex-1 [&>button]:justify-center"
                items={[
                  { value: 'chat', label: 'Chat', icon: <MessagesSquare /> },
                  { value: 'preview', label: 'Preview', icon: <Eye />, count: ready }
                ]}
              />
              <AnimatePresence initial={false}>
                {view === 'preview' && (
                  <motion.div key="steps" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.28, ease }} className="overflow-hidden">
                    <div className="flex items-center gap-2 pt-2">
                      <div className="min-w-0 flex-1 overflow-x-auto rounded-xl [scrollbar-width:none]">
                        <Stepper className="w-max" />
                      </div>
                      <AnimatePresence>
                        {anyProposed && (
                          <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }} transition={spring}>
                            <Button size="sm" variant="secondary" icon={<CheckCheck className="size-3.5" />} onClick={acceptAll} disabled={busy} className="h-10 rounded-xl">
                              All
                            </Button>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </>
          ) : (
          <>
          <div className="flex items-center gap-3">
            <IconButton label="Back to new story" variant="secondary" onClick={() => navigate('/stories/new')}>
              <ArrowLeft className="size-4" />
            </IconButton>
            <LogoMark size={28} />
            <div className="min-w-0">
              <h1 className="font-serif text-[21px] leading-tight font-semibold tracking-tight">Scenario Composer</h1>
              <AnimatePresence mode="wait" initial={false}>
                <motion.div key={d.title || '-'} initial={{ opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -3 }} transition={{ duration: 0.2, ease }} className="truncate text-[11.5px] text-fg-3">
                  {d.title || 'Build a scenario together with your model'}
                </motion.div>
              </AnimatePresence>
            </div>
            <div className="flex-1" />
            <ModelPicker value={llm ?? defLlm} onChange={setLlm} align="end" />
            <Menu
              align="end"
              trigger={
                <Button variant="ghost" icon={<RotateCcw className="size-3.5" />} disabled={busy}>
                  Start over
                </Button>
              }
            >
              <MenuItem icon={<RotateCcw />} danger onSelect={reset}>
                Discard this draft
              </MenuItem>
            </Menu>
            <Button variant="primary" icon={<Check className="size-4" />} disabled={!canCreate || busy} onClick={() => setCreating(true)} className="tracking-wide">
              Create scenario
            </Button>
          </div>
          <div className="mt-3.5 flex items-center gap-3">
            <Stepper />
            <div className="flex-1" />
            <span className="text-[11.5px] text-fg-3 tabular-nums">
              <b className="font-semibold text-fg-2">{ready}</b> / {SECTIONS.length} accepted
            </span>
            <AnimatePresence>
              {anyProposed && (
                <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }} transition={spring}>
                  <Button size="sm" variant="secondary" icon={<CheckCheck className="size-3.5" />} onClick={acceptAll} disabled={busy}>
                    Accept all
                  </Button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
          </>
          )}
        </FrostHeader>

        {compact ? (
          // Phones: both panes stay mounted (chat scroll, preview edits) and cross-fade.
          <div className="relative h-full">
            <motion.div
              initial={false}
              animate={view === 'chat' ? { opacity: 1, scale: 1, visibility: 'visible' } : { opacity: 0, scale: 0.985, transitionEnd: { visibility: 'hidden' } }}
              transition={{ duration: 0.3, ease }}
              className="pointer-events-none absolute inset-0 z-30 flex flex-col px-3 pb-3"
              style={{ paddingTop: headerH }}
            >
              <div className={cn('flex min-h-0 flex-1 flex-col', view === 'chat' && 'pointer-events-auto')}>
                <ChatPanel
                  onOpenSection={() => {
                    setView('preview')
                    setReveal((n) => n + 1)
                  }}
                />
              </div>
            </motion.div>
            <motion.div
              initial={false}
              animate={view === 'preview' ? { opacity: 1, scale: 1, visibility: 'visible' } : { opacity: 0, scale: 0.985, transitionEnd: { visibility: 'hidden' } }}
              transition={{ duration: 0.3, ease }}
              className="absolute inset-0 px-3"
            >
              <Preview topPad={headerH} onScrolled={setStuck} revealKey={reveal} />
            </motion.div>
          </div>
        ) : (
        <div className="mx-auto flex h-full max-w-[1280px] gap-4 px-6">
          {/* Above the header's diffusion band, so the chat never blurs. Its top padding sits under the
              header, so it lets clicks through to the header (back button, stepper); the panel takes them. */}
          <div className="pointer-events-none relative z-30 flex w-[400px] shrink-0 flex-col pb-4" style={{ paddingTop: headerH }}>
            <ChatPanel />
          </div>
          <div className="min-w-0 flex-1">
            <Preview topPad={headerH} onScrolled={setStuck} />
          </div>
        </div>
        )}
      </div>
      <CreateDialog open={creating} onClose={() => setCreating(false)} />
    </Page>
  )
}
