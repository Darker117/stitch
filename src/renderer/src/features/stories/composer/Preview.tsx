// Live preview of the scenario as it forms: one card per section with
// accept / regenerate (optionally steered) / edit.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { BookOpen, Check, Pencil, Plus, RefreshCw, Trash2, Users, WandSparkles, X } from 'lucide-react'
import type { StoryCardType } from '@shared/types'
import { Button, IconButton } from '@/components/ui/button'
import { Input, Textarea } from '@/components/ui/input'
import { Popover, PopoverClose, Select } from '@/components/ui/overlay'
import { Segmented } from '@/components/ui/controls'
import { cn } from '@/lib/utils'
import { ease, rise, springSoft, stagger } from '@/lib/motion'
import { ThinkingBlock } from '@/features/create/Messages'
import { CARD_ICON } from '../components/cards'
import { CARD_TYPES, cardTypeLabel, LIMITS } from '../engine/defaults'
import { Label, PlaceholderText, Shimmer, StatusBadge } from './bits'
import { SECTIONS, type CardDraft, type ScenarioDraft, type SectionId } from './draft'
import { useComposer } from './store'
import { ScriptsSection } from './ScriptsSection'
import { nanoid } from 'nanoid'

type Editable = Exclude<SectionId, 'scripts'>

/** Set when focus changes by clicking a section (no need to scroll to it). */
let skipScroll = false

const FILL_SECTIONS: Record<string, SectionId[]> = { core: ['premise', 'world', 'rules'], cards: ['cards'], opening: ['opening'] }

function useSectionBusy(id: SectionId): boolean {
  return useComposer((s) => (s.busy?.kind === 'section' && s.busy.section === id) || (s.busy?.kind === 'fill' && (FILL_SECTIONS[s.busy.stage] ?? []).includes(id)))
}

function Steer({ onGo, disabled }: { onGo: (steer: string) => void; disabled?: boolean }): React.JSX.Element {
  const [v, setV] = useState('')
  return (
    <Popover
      align="end"
      className="w-[300px] p-3"
      trigger={
        <IconButton label="Regenerate with a direction" size="sm" disabled={disabled}>
          <WandSparkles className="size-3.5" />
        </IconButton>
      }
    >
      <Label>Regenerate with a direction</Label>
      <Textarea value={v} onChange={(e) => setV(e.target.value)} minRows={2} maxRows={5} placeholder="e.g. darker, funnier, more political, set it in winter…" autoFocus />
      <div className="mt-2.5 flex justify-end">
        <PopoverClose asChild>
          <Button size="sm" variant="primary" icon={<RefreshCw className="size-3.5" />} disabled={!v.trim()} onClick={() => onGo(v)}>
            Regenerate
          </Button>
        </PopoverClose>
      </div>
    </Popover>
  )
}

function SectionCard({
  id,
  index,
  children,
  editor,
  empty,
  registerRef
}: {
  id: SectionId
  index: number
  children: ReactNode
  editor?: (done: () => void) => ReactNode
  empty: boolean
  registerRef: (id: SectionId, el: HTMLElement | null) => void
}): React.JSX.Element {
  const meta = SECTIONS.find((s) => s.id === id)!
  const state = useComposer((s) => s.draft.sections[id])
  const focus = useComposer((s) => s.focus === id)
  const flash = useComposer((s) => s.flash[id])
  const anyBusy = useComposer((s) => !!s.busy)
  const busy = useSectionBusy(id)
  const live = useComposer((s) => (s.busy?.kind === 'section' && s.busy.section === id) || (busy && s.busy?.kind === 'fill') ? s.liveReasoning : '')
  const { accept, regenerate } = useComposer.getState()
  const setFocus = (s: SectionId): void => {
    skipScroll = true
    useComposer.getState().setFocus(s)
  }
  const [editing, setEditing] = useState(false)
  const editable = id !== 'scripts'

  return (
    <motion.section
      ref={(el) => registerRef(id, el)}
      variants={rise}
      layout="position"
      transition={springSoft}
      onMouseDown={() => !focus && setFocus(id)}
      className={cn(
        'relative scroll-mt-4 rounded-[20px] border bg-white/[0.03] p-5 transition-[border-color,background-color] duration-300 hairline',
        focus ? 'border-[color-mix(in_oklab,var(--accent)_40%,transparent)] bg-white/[0.045]' : 'border-line'
      )}
    >
      {/* Change pulse */}
      <AnimatePresence>
        {flash && (
          <motion.span
            key={flash}
            aria-hidden
            initial={{ opacity: 0.9 }}
            animate={{ opacity: 0 }}
            transition={{ duration: 1.6, ease }}
            className="pointer-events-none absolute inset-0 rounded-[20px] shadow-[0_0_0_1px_var(--accent),0_0_40px_-6px_var(--accent)]"
          />
        )}
      </AnimatePresence>
      <div className="flex items-center gap-3">
        <span className={cn('grid size-7 shrink-0 place-items-center rounded-full text-[11.5px] font-semibold tabular-nums transition-colors', focus ? 'bg-grad text-white' : 'bg-white/[0.07] text-fg-2')}>{index + 1}</span>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-[14px] font-semibold tracking-tight">{meta.label}</h2>
            <StatusBadge state={state} />
          </div>
          <div className="text-[11.5px] text-fg-3">{meta.hint}</div>
        </div>
        <div className="flex-1" />
        {editable && (
          <div className="flex items-center gap-0.5">
            {state === 'proposed' && !busy && (
              <Button size="sm" variant="secondary" icon={<Check className="size-3.5" />} onClick={() => accept(id)} className="mr-1">
                Accept
              </Button>
            )}
            {!empty && (
              <>
                <IconButton label="Regenerate" size="sm" disabled={anyBusy} onClick={() => void regenerate(id as Editable)}>
                  <RefreshCw className={cn('size-3.5', busy && 'animate-spin')} />
                </IconButton>
                <Steer disabled={anyBusy} onGo={(steer) => void regenerate(id as Editable, steer)} />
              </>
            )}
            {editor && (
              <IconButton label={editing ? 'Done editing' : 'Edit'} size="sm" active={editing} disabled={busy} onClick={() => setEditing((e) => !e)}>
                {editing ? <Check className="size-3.5" /> : <Pencil className="size-3.5" />}
              </IconButton>
            )}
          </div>
        )}
      </div>

      <div className="mt-4">
        <AnimatePresence mode="wait" initial={false}>
          {busy ? (
            <motion.div key="busy" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} className="flex flex-col gap-3">
              <Shimmer lines={id === 'cards' ? 5 : 3} />
              {live && <ThinkingBlock reasoning={live} live />}
            </motion.div>
          ) : editing && editor ? (
            <motion.div key="edit" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.22, ease }}>
              {editor(() => setEditing(false))}
            </motion.div>
          ) : empty && editable ? (
            <motion.div key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} className="flex items-center gap-3 rounded-2xl border border-dashed border-line-strong px-4 py-3.5">
              <p className="flex-1 text-[12px] leading-relaxed text-fg-3">Nothing here yet — talk it through in the chat, write it yourself, or let the AI draft it from what exists.</p>
              {editor && (
                <Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" />} onClick={() => setEditing(true)}>
                  Write
                </Button>
              )}
              <Button size="sm" variant="secondary" icon={<WandSparkles className="size-3.5" />} disabled={anyBusy} onClick={() => void regenerate(id as Editable)}>
                Draft it
              </Button>
            </motion.div>
          ) : (
            <motion.div key="view" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.25, ease }}>
              {children}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.section>
  )
}

// ─── Section bodies ─────────────────────────────────────────────────────────

function PremiseView({ d }: { d: ScenarioDraft }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2.5">
      <div className="font-serif text-[24px] leading-tight font-semibold tracking-tight">{d.title || <span className="text-fg-3">Untitled</span>}</div>
      {d.description && <p className="text-[13px] leading-relaxed text-fg-2">{d.description}</p>}
      {d.tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {d.tags.map((t) => (
            <span key={t} className="rounded-full border border-line bg-white/[0.04] px-2.5 py-0.5 text-[11.5px] text-fg-2">
              #{t}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function PremiseEditor({ d, done }: { d: ScenarioDraft; done: () => void }): React.JSX.Element {
  const [title, setTitle] = useState(d.title)
  const [description, setDescription] = useState(d.description)
  const [tags, setTags] = useState(d.tags.join(', '))
  return (
    <div className="flex flex-col gap-3">
      <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" className="h-10 font-serif text-[15px]" maxLength={LIMITS.title} />
      <Textarea value={description} onChange={(e) => setDescription(e.target.value)} minRows={3} maxRows={10} placeholder="The pitch shown on the story card" />
      <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="Tags, comma separated" />
      <SaveRow
        onSave={() => {
          useComposer.getState().edit({ title: title.trim(), description: description.trim(), tags: tags.split(',').map((t) => t.trim().replace(/^#/, '').toLowerCase()).filter(Boolean).slice(0, LIMITS.tags) }, 'premise')
          done()
        }}
        onCancel={done}
      />
    </div>
  )
}

function WorldView({ d }: { d: ScenarioDraft }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      {d.plotEssentials && (
        <div>
          <Label>Plot essentials</Label>
          <p className="text-[13px] leading-relaxed whitespace-pre-wrap text-fg">{d.plotEssentials}</p>
        </div>
      )}
      {d.storySummary && (
        <div>
          <Label>Backstory summary</Label>
          <p className="text-[12.5px] leading-relaxed whitespace-pre-wrap text-fg-2">{d.storySummary}</p>
        </div>
      )}
    </div>
  )
}

function WorldEditor({ d, done }: { d: ScenarioDraft; done: () => void }): React.JSX.Element {
  const [pe, setPe] = useState(d.plotEssentials)
  const [ss, setSs] = useState(d.storySummary)
  return (
    <div className="flex flex-col gap-3">
      <Label className="mb-0">Plot essentials</Label>
      <Textarea value={pe} onChange={(e) => setPe(e.target.value)} minRows={4} maxRows={14} placeholder="What the narrator must always remember" />
      <Label className="mb-0">Backstory summary</Label>
      <Textarea value={ss} onChange={(e) => setSs(e.target.value)} minRows={2} maxRows={8} placeholder="What happened before the adventure begins" />
      <SaveRow
        onSave={() => {
          useComposer.getState().edit({ plotEssentials: pe.trim(), storySummary: ss.trim() }, 'world')
          done()
        }}
        onCancel={done}
      />
    </div>
  )
}

function CardTile({ c, onRemove }: { c: CardDraft; onRemove?: () => void }): React.JSX.Element {
  return (
    <motion.div variants={rise} layout className="group relative flex flex-col gap-1.5 rounded-2xl border border-line bg-white/[0.03] p-3.5">
      <div className="flex items-center gap-2">
        <span className="grid size-6 place-items-center rounded-lg bg-white/[0.06] text-fg-2 [&>svg]:size-3.5">{CARD_ICON[c.type]}</span>
        <div className="min-w-0 flex-1 truncate font-serif text-[14.5px] font-semibold">{c.name}</div>
        <span className="text-[10.5px] font-semibold tracking-wide text-fg-3 uppercase">{cardTypeLabel(c)}</span>
        {onRemove && (
          <button onClick={onRemove} className="grid size-5 place-items-center rounded-md text-fg-3 opacity-0 transition group-hover:opacity-100 hover:bg-white/10 hover:text-fg" title="Remove card">
            <X className="size-3" />
          </button>
        )}
      </div>
      <p className="line-clamp-3 text-[12px] leading-snug text-fg-2">{c.entry}</p>
      {c.notes && <p className="line-clamp-1 text-[11px] text-fg-3 italic">“{c.notes}”</p>}
      <div className="truncate font-mono text-[10.5px] text-fg-3">{c.triggers}</div>
    </motion.div>
  )
}

function removeCard(id: string): void {
  useComposer.setState((s) => {
    const cards = s.draft.cards.filter((x) => x.id !== id)
    return { draft: { ...s.draft, cards, sections: { ...s.draft.sections, cards: cards.length ? s.draft.sections.cards : 'empty' } } }
  })
}

function CardsView({ d }: { d: ScenarioDraft }): React.JSX.Element {
  return (
    <motion.div variants={stagger(0.03, 0)} initial="initial" animate="animate" className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-2.5">
      <AnimatePresence initial={false}>
        {d.cards.map((c) => (
          <CardTile key={c.id} c={c} onRemove={() => removeCard(c.id)} />
        ))}
      </AnimatePresence>
    </motion.div>
  )
}

const TYPE_OPTIONS = CARD_TYPES.map((t) => ({ value: t.value, label: t.label }))

function CardsEditor({ d, done }: { d: ScenarioDraft; done: () => void }): React.JSX.Element {
  const [cards, setCards] = useState<CardDraft[]>(d.cards)
  const set = (id: string, p: Partial<CardDraft>): void => setCards((cs) => cs.map((c) => (c.id === id ? { ...c, ...p } : c)))
  return (
    <div className="flex flex-col gap-3">
      <AnimatePresence initial={false}>
        {cards.map((c) => (
          <motion.div key={c.id} layout initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.25, ease }} className="overflow-hidden">
            <div className="flex flex-col gap-2 rounded-2xl border border-line bg-white/[0.03] p-3">
              <div className="flex gap-2">
                <Input value={c.name} onChange={(e) => set(c.id, { name: e.target.value })} placeholder="Name" className="font-serif" />
                <Select size="sm" value={c.type} onChange={(v) => set(c.id, { type: v as StoryCardType })} options={TYPE_OPTIONS} className="w-[150px]" />
                <IconButton label="Remove card" size="md" onClick={() => setCards((cs) => cs.filter((x) => x.id !== c.id))}>
                  <Trash2 className="size-3.5" />
                </IconButton>
              </div>
              <Textarea value={c.entry} onChange={(e) => set(c.id, { entry: e.target.value })} minRows={2} maxRows={8} placeholder="Entry" />
              <Input value={c.triggers} onChange={(e) => set(c.id, { triggers: e.target.value })} placeholder="Triggers, comma separated" className="font-mono text-[11.5px]" />
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
      <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} className="self-start" onClick={() => setCards((cs) => [...cs, { id: nanoid(8), type: 'character', name: '', entry: '', triggers: '' }])}>
        Add card
      </Button>
      <SaveRow
        onSave={() => {
          const clean = cards.filter((c) => c.name.trim() && c.entry.trim()).map((c) => ({ ...c, triggers: c.triggers.trim() || c.name.trim() }))
          useComposer.setState((s) => ({ draft: { ...s.draft, cards: clean, sections: { ...s.draft.sections, cards: clean.length ? 'accepted' : 'empty' } } }))
          done()
        }}
        onCancel={done}
      />
    </div>
  )
}

function OpeningView({ d }: { d: ScenarioDraft }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      <span className="inline-flex w-fit items-center gap-1.5 rounded-full border border-line bg-white/[0.04] px-2.5 py-0.5 text-[11.5px] text-fg-2 [&>svg]:size-3">
        {d.openingType === 'characterCreator' ? <Users /> : <BookOpen />}
        {d.openingType === 'characterCreator' ? 'Character creator' : 'Story'}
      </span>
      <PlaceholderText text={d.opening} className="font-serif text-[14.5px] leading-[1.8] text-fg" />
    </div>
  )
}

function OpeningEditor({ d, done }: { d: ScenarioDraft; done: () => void }): React.JSX.Element {
  const [type, setType] = useState(d.openingType)
  const [text, setText] = useState(d.opening)
  return (
    <div className="flex flex-col gap-3">
      <Segmented
        size="sm"
        className="self-start"
        value={type}
        onChange={setType}
        items={[
          { value: 'story', label: 'Story', icon: <BookOpen /> },
          { value: 'characterCreator', label: 'Character creator', icon: <Users /> }
        ]}
      />
      <Textarea value={text} onChange={(e) => setText(e.target.value)} minRows={6} maxRows={20} className="font-serif text-[14px] leading-[1.75]" placeholder="How does the adventure begin?" />
      {type === 'characterCreator' && <p className="text-[11.5px] text-fg-3">Use placeholders like {'${character.name}'}, {'${character.class}'} or {'${character.race}'} where the player’s choices go.</p>}
      <SaveRow
        onSave={() => {
          useComposer.getState().edit({ openingType: type, opening: text.trim() }, 'opening')
          done()
        }}
        onCancel={done}
      />
    </div>
  )
}

function RulesView({ d }: { d: ScenarioDraft }): React.JSX.Element {
  const rules = d.aiInstructions
    .split('\n')
    .map((l) => l.trim().replace(/^[-*•]\s*/, ''))
    .filter(Boolean)
  return (
    <div className="flex flex-col gap-4">
      {rules.length > 0 && (
        <div>
          <Label>Narrator rules · added to the Stitch defaults</Label>
          <ul className="flex flex-col gap-1.5">
            {rules.map((r, i) => (
              <li key={i} className="flex gap-2 text-[12.5px] leading-relaxed text-fg">
                <span className="mt-[7px] size-1 shrink-0 rounded-full bg-accent" />
                {r}
              </li>
            ))}
          </ul>
        </div>
      )}
      {d.authorsNote && (
        <div>
          <Label>Author’s note</Label>
          <p className="rounded-xl border border-line bg-white/[0.03] px-3 py-2 text-[12.5px] text-fg-2 italic">{d.authorsNote}</p>
        </div>
      )}
    </div>
  )
}

function RulesEditor({ d, done }: { d: ScenarioDraft; done: () => void }): React.JSX.Element {
  const [rules, setRules] = useState(d.aiInstructions)
  const [note, setNote] = useState(d.authorsNote)
  return (
    <div className="flex flex-col gap-3">
      <Label className="mb-0">Narrator rules (one per line)</Label>
      <Textarea value={rules} onChange={(e) => setRules(e.target.value)} minRows={4} maxRows={12} placeholder="- Keep magic rare and costly" />
      <Label className="mb-0">Author’s note</Label>
      <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={LIMITS.authorsNote} placeholder="Tone: … Style: …" />
      <SaveRow
        onSave={() => {
          useComposer.getState().edit({ aiInstructions: rules.trim(), authorsNote: note.trim() }, 'rules')
          done()
        }}
        onCancel={done}
      />
    </div>
  )
}

function SaveRow({ onSave, onCancel }: { onSave: () => void; onCancel: () => void }): React.JSX.Element {
  return (
    <div className="flex justify-end gap-2 pt-1">
      <Button size="sm" variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
      <Button size="sm" variant="primary" icon={<Check className="size-3.5" />} onClick={onSave}>
        Save
      </Button>
    </div>
  )
}

// ─── Preview column ─────────────────────────────────────────────────────────

export function Preview({ topPad, onScrolled }: { topPad: number; onScrolled: (scrolled: boolean) => void }): React.JSX.Element {
  const d = useComposer((s) => s.draft)
  const focus = useComposer((s) => s.focus)
  const refs = useRef<Partial<Record<SectionId, HTMLElement | null>>>({})
  const scroller = useRef<HTMLDivElement>(null)
  const lastFocus = useRef(focus)

  // Bring the focused section into view when focus changes (stepper, chat).
  useEffect(() => {
    if (lastFocus.current === focus) return
    lastFocus.current = focus
    if (skipScroll) {
      skipScroll = false
      return
    }
    const el = refs.current[focus]
    const sc = scroller.current
    if (el && sc) sc.scrollTo({ top: Math.max(0, el.offsetTop - topPad - 12), behavior: 'smooth' })
  }, [focus, topPad])

  const register = (id: SectionId, el: HTMLElement | null): void => {
    refs.current[id] = el
  }
  const filled: Record<SectionId, boolean> = {
    premise: !!(d.title || d.description),
    world: !!(d.plotEssentials || d.storySummary),
    cards: d.cards.length > 0,
    opening: !!d.opening,
    rules: !!(d.aiInstructions || d.authorsNote),
    scripts: d.scripts.length > 0
  }

  return (
    <div ref={scroller} onScroll={(e) => onScrolled(e.currentTarget.scrollTop > 6)} className="h-full overflow-y-auto" style={{ paddingTop: topPad }}>
      <motion.div variants={stagger(0.05, 0.1)} initial="initial" animate="animate" className="flex flex-col gap-4 pt-2 pb-24">
        <SectionCard id="premise" index={0} empty={!filled.premise} registerRef={register} editor={(done) => <PremiseEditor d={d} done={done} />}>
          <PremiseView d={d} />
        </SectionCard>
        <SectionCard id="world" index={1} empty={!filled.world} registerRef={register} editor={(done) => <WorldEditor d={d} done={done} />}>
          <WorldView d={d} />
        </SectionCard>
        <SectionCard id="cards" index={2} empty={!filled.cards} registerRef={register} editor={(done) => <CardsEditor d={d} done={done} />}>
          <CardsView d={d} />
        </SectionCard>
        <SectionCard id="opening" index={3} empty={!filled.opening} registerRef={register} editor={(done) => <OpeningEditor d={d} done={done} />}>
          <OpeningView d={d} />
        </SectionCard>
        <SectionCard id="rules" index={4} empty={!filled.rules} registerRef={register} editor={(done) => <RulesEditor d={d} done={done} />}>
          <RulesView d={d} />
        </SectionCard>
        <SectionCard id="scripts" index={5} empty={false} registerRef={register}>
          <ScriptsSection />
        </SectionCard>
      </motion.div>
    </div>
  )
}
