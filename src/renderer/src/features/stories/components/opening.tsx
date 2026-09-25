// Opening editor: Story, Multiple Choice (nested child scenarios) and
// Character Creator (fields backed by story cards).
import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { BookOpen, Braces, List, ListTree, Plus, Settings, Trash2, Users, WandSparkles, Wrench, X } from 'lucide-react'
import type { CreatorField, Scenario, StoryCard, StoryCardType } from '@shared/types'
import { IconButton } from '@/components/ui/button'
import { Input, Textarea } from '@/components/ui/input'
import { Menu, MenuItem, MenuSeparator } from '@/components/ui/overlay'
import { RadioCards } from '@/components/ui/controls'
import { Spinner } from '@/components/ui/misc'
import { errorText } from '@/lib/api'
import { cn } from '@/lib/utils'
import { ease, spring, springSoft } from '@/lib/motion'
import { db, useDoc } from '@/stores/db'
import { toast } from '@/stores/toast'
import { nanoid } from 'nanoid'
import { CARD_TYPES, DEFAULT_GENERATOR, LIMITS, defaultCreatorFields, emptyPlot, newCard, newScenario } from '../engine/defaults'
import { deleteScenarioTree } from '../engine/adventure'
import { generateCard, type StoryInfo } from '../engine/ai'
import { characterKey } from '../engine/placeholders'
import { CARD_ICON, StoryCardModal } from './cards'
import { Counter } from './plot'

export const OPENING_TYPES = [
  { value: 'story' as const, title: 'Story', description: 'Scenario opens with a brief story.', icon: <BookOpen />, group: 'Simple' },
  { value: 'multipleChoice' as const, title: 'Multiple Choice', description: 'Scenario opens with a menu of scenarios to choose from.', icon: <List />, group: 'Advanced' },
  { value: 'characterCreator' as const, title: 'Character Creator', description: 'Scenario opens with the choice to create a character.', icon: <Users />, group: 'Advanced' }
]

const PLACEHOLDER: Record<Scenario['openingType'], string> = {
  story: 'How does your story begin? Example: You are ${character.name}, a knight from the kingdom of ${enter a country...}',
  multipleChoice: 'Enter a description for the choices the player will see. Example: "Choose your scenario:"',
  characterCreator: 'What is the world like when the adventure begins? Example: Noiral is a world where ${enter a theme...} shapes all life.'
}

type Change = (patch: Partial<Scenario> | ((cur: Scenario) => Partial<Scenario>)) => void

export function OpeningEditor({ scenario, change, info, onConfigure }: { scenario: Scenario; change: Change; info: StoryInfo; onConfigure: (childId: string) => void }): React.JSX.Element {
  const [choosing, setChoosing] = useState(false)
  const area = useRef<HTMLTextAreaElement>(null)
  const type = scenario.openingType

  const setType = async (t: Scenario['openingType']): Promise<void> => {
    const patch: Partial<Scenario> = { openingType: t }
    if (t === 'characterCreator' && !scenario.creatorFields.length) patch.creatorFields = defaultCreatorFields()
    if (t === 'multipleChoice' && !scenario.choices.length) {
      const kids = [1, 2].map((n) => newScenario({ parentId: scenario.id, title: `Choice ${n}`, template: scenario.template, plot: emptyPlot() }))
      for (const k of kids) await db.put('scenarios', k)
      patch.choices = kids.map((k) => k.id)
    }
    change(patch)
    setTimeout(() => setChoosing(false), 260)
  }

  const insert = (token: string): void => {
    const el = area.current
    const text = scenario.opening
    const at = el ? el.selectionStart : text.length
    const next = text.slice(0, at) + token + text.slice(el ? el.selectionEnd : at)
    change({ opening: next })
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(at + token.length, at + token.length)
    })
  }

  const tokens =
    type === 'characterCreator'
      ? ['${character.name}', ...scenario.creatorFields.map((f) => `\${${characterKey(f.label)}}`), '${enter a ...}']
      : type === 'story'
        ? ['${enter your name...}', '${enter a ...}']
        : []

  return (
    <motion.div layout transition={springSoft} className="overflow-hidden rounded-2xl border border-line bg-white/[0.03] hairline">
      <div className="flex items-center gap-2 px-4 pt-3.5">
        <span className="text-[12px] font-bold tracking-[0.06em] uppercase">Opening:</span>
        <AnimatePresence mode="wait" initial={false}>
          <motion.span key={type} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.2, ease }} className="text-[12.5px] font-medium text-fg-2">
            {OPENING_TYPES.find((o) => o.value === type)?.title}
          </motion.span>
        </AnimatePresence>
        <IconButton label="Opening type" variant="secondary" className={cn('ml-auto rounded-full', choosing && 'bg-white/[0.12] text-fg')} onClick={() => setChoosing((c) => !c)}>
          <motion.span animate={{ rotate: choosing ? 90 : 0 }} transition={spring}>
            <Settings className="size-4" />
          </motion.span>
        </IconButton>
      </div>

      <AnimatePresence mode="wait" initial={false}>
        {choosing ? (
          <motion.div key="choose" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.32, ease }} className="px-4 pt-3 pb-4">
            <RadioCards value={type} onChange={(t) => void setType(t)} items={OPENING_TYPES} />
          </motion.div>
        ) : (
          <motion.div key="body" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.32, ease }}>
            <div className="px-4 pt-3 pb-3">
              <Textarea
                ref={area}
                bare
                value={scenario.opening}
                onChange={(e) => change({ opening: e.target.value })}
                minRows={type === 'multipleChoice' ? 3 : 6}
                maxRows={22}
                placeholder={PLACEHOLDER[type]}
                className="font-serif text-[14.5px] leading-[1.75]"
              />
              <div className="flex items-end gap-2">
                <div className="flex flex-wrap gap-1.5">
                  {tokens.map((t) => (
                    <button key={t} onClick={() => insert(t)} className="flex h-6 items-center gap-1 rounded-md border border-line bg-white/[0.04] px-1.5 font-mono text-[10.5px] text-fg-2 transition hover:border-line-strong hover:text-fg" title="Insert placeholder">
                      <Braces className="size-3 text-fg-3" />
                      {t.replace(/^\$\{|\}$/g, '')}
                    </button>
                  ))}
                </div>
                <div className="ml-auto">
                  <Counter value={scenario.opening} max={LIMITS.opening} />
                </div>
              </div>
            </div>
            {type === 'multipleChoice' && <ChoicesEditor scenario={scenario} change={change} onConfigure={onConfigure} />}
            {type === 'characterCreator' && <CreatorEditor scenario={scenario} change={change} info={info} />}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

// ─── Multiple choice ─────────────────────────────────────────────────────────

function ChoiceRow({ id, index, onConfigure, onNest, onDelete }: { id: string; index: number; onConfigure: () => void; onNest: () => void; onDelete: () => void }): React.JSX.Element {
  const child = useDoc('scenarios', id)
  const [name, setName] = useState(child?.title ?? '')
  const [focus, setFocus] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => {
    if (!focus && child) setName(child.title)
  }, [child?.title, focus, child])
  const save = (v: string): void => {
    setName(v)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => void db.patch('scenarios', id, { title: v, updatedAt: Date.now() }), 400)
  }
  const label = name || `Choice ${index + 1}`
  const nested = child?.openingType === 'multipleChoice' && child.choices.length > 0
  return (
    <motion.div layout initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 8 }} transition={springSoft} className="group flex h-13 items-center gap-2 border-b border-line px-4 last:border-b-0">
      <input
        value={name}
        onChange={(e) => save(e.target.value)}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        placeholder={`Choice ${index + 1}`}
        className="min-w-0 flex-1 bg-transparent text-[13.5px] font-medium text-fg outline-none placeholder:text-fg-3"
        style={{ maxWidth: `${Math.max(8, label.length + 2)}ch` }}
      />
      {index === 0 && !focus && <span className="text-[12px] font-medium text-fg-3">(Tap name to edit)</span>}
      {nested && (
        <span className="flex items-center gap-1 rounded-md bg-white/[0.06] px-1.5 py-0.5 text-[10.5px] font-semibold text-fg-2">
          <ListTree className="size-3" /> {child!.choices.length} choices
        </span>
      )}
      <div className="flex-1" />
      <Menu
        align="end"
        trigger={
          <IconButton label={`Configure ${label}`} variant="secondary" className="rounded-full">
            <Wrench className="size-3.5" />
          </IconButton>
        }
      >
        <MenuItem right={<Wrench className="size-3.5 text-fg-3" />} onSelect={onConfigure}>
          Configure “{label}”
        </MenuItem>
        <MenuItem right={<List className="size-3.5 text-fg-3" />} onSelect={onNest}>
          Add Choices to “{label}”
        </MenuItem>
        <MenuSeparator />
        <MenuItem danger right={<Trash2 className="size-3.5" />} onSelect={onDelete}>
          Delete choice
        </MenuItem>
      </Menu>
    </motion.div>
  )
}

function ChoicesEditor({ scenario, change, onConfigure }: { scenario: Scenario; change: Change; onConfigure: (id: string) => void }): React.JSX.Element {
  const add = async (): Promise<void> => {
    const k = newScenario({ parentId: scenario.id, title: `Choice ${scenario.choices.length + 1}`, template: scenario.template, plot: emptyPlot() })
    await db.put('scenarios', k)
    change((cur) => ({ choices: [...cur.choices, k.id] }))
  }
  const nest = async (id: string): Promise<void> => {
    const child = db.get('scenarios', id)
    if (!child) return
    if (child.openingType !== 'multipleChoice' || !child.choices.length) {
      const kids = [1, 2].map((n) => newScenario({ parentId: id, title: `Choice ${n}`, template: scenario.template, plot: emptyPlot() }))
      for (const k of kids) await db.put('scenarios', k)
      await db.patch('scenarios', id, { openingType: 'multipleChoice', choices: kids.map((k) => k.id), updatedAt: Date.now() })
    }
    onConfigure(id)
  }
  return (
    <div className="px-4 pb-4">
      <div className="overflow-hidden rounded-xl border border-line bg-white/[0.035]">
        <AnimatePresence initial={false}>
          {scenario.choices.map((id, i) => (
            <ChoiceRow
              key={id}
              id={id}
              index={i}
              onConfigure={() => onConfigure(id)}
              onNest={() => void nest(id)}
              onDelete={() => {
                change((cur) => ({ choices: cur.choices.filter((x) => x !== id) }))
                void deleteScenarioTree(id)
              }}
            />
          ))}
        </AnimatePresence>
        {!scenario.choices.length && <div className="px-4 py-5 text-center text-[12px] text-fg-3">No choices yet.</div>}
      </div>
      <div className="mt-3 flex justify-center">
        <button onClick={() => void add()} className="flex items-center gap-1.5 text-[12.5px] font-semibold tracking-wide text-accent uppercase transition hover:brightness-125">
          <Plus className="size-4" /> Add choice
        </button>
      </div>
    </div>
  )
}

// ─── Character creator ───────────────────────────────────────────────────────

function fieldCards(cards: StoryCard[], f: CreatorField): StoryCard[] {
  return cards.filter((c) => c.type === f.cardType && (f.cardType !== 'custom' || (c.customType ?? '').toLowerCase() === (f.customType ?? f.label).toLowerCase()))
}

function plural(f: CreatorField): string {
  if (f.cardType === 'custom') return f.label
  return CARD_TYPES.find((t) => t.value === f.cardType)?.plural ?? f.label
}

function CreatorEditor({ scenario, change, info }: { scenario: Scenario; change: Change; info: StoryInfo }): React.JSX.Element {
  const [editing, setEditing] = useState<{ card: StoryCard; isNew: boolean } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [custom, setCustom] = useState<string | null>(null)

  const setCards = (fn: (cur: StoryCard[]) => StoryCard[]): void => change((cur) => ({ cards: fn(cur.cards) }))
  const save = (card: StoryCard): void => setCards((cur) => (cur.some((c) => c.id === card.id) ? cur.map((c) => (c.id === card.id ? { ...card, updatedAt: Date.now() } : c)) : [...cur, card]))

  const forMe = async (f: CreatorField): Promise<void> => {
    setBusy(f.id)
    try {
      const res = await generateCard({ info: { ...info, cards: scenario.cards }, type: f.cardType, customType: f.customType ?? f.label, withNotes: true })
      save(newCard({ type: f.cardType, customType: f.cardType === 'custom' ? (f.customType ?? f.label) : undefined, name: res.name, entry: res.entry, triggers: res.triggers, notes: res.notes ?? '' }))
    } catch (err) {
      toast.error('Generation failed', errorText(err))
    } finally {
      setBusy(null)
    }
  }

  const addCustom = (label: string): void => {
    const l = label.trim()
    if (!l) return setCustom(null)
    change((cur) => ({ creatorFields: [...cur.creatorFields, { id: nanoid(8), label: l, cardType: 'custom' as StoryCardType, customType: l }] }))
    setCustom(null)
  }

  return (
    <div className="pb-2">
      <div className="mx-4 flex items-center gap-2 border-t border-line py-3.5">
        <span className="label-caps">Name</span>
        <span className="text-[12px] text-fg-3">Players always choose a name first</span>
        <code className="ml-auto rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10.5px] text-fg-2">{'${character.name}'}</code>
      </div>
      <AnimatePresence initial={false}>
        {scenario.creatorFields.map((f) => {
          const opts = fieldCards(scenario.cards, f)
          const singular = f.cardType === 'custom' ? f.label : (CARD_TYPES.find((t) => t.value === f.cardType)?.label ?? f.label)
          return (
            <motion.div key={f.id} layout initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.3, ease }} className="group mx-4 border-t border-line py-3.5">
              <div className="mb-2.5 flex items-center gap-2">
                <span className="label-caps">{plural(f)}</span>
                <code className="rounded bg-white/[0.05] px-1.5 font-mono text-[10px] text-fg-3">{`\${${characterKey(f.label)}}`}</code>
                <button onClick={() => change((cur) => ({ creatorFields: cur.creatorFields.filter((x) => x.id !== f.id) }))} className="ml-auto grid size-6 place-items-center rounded-md text-fg-3 opacity-0 transition group-hover:opacity-100 hover:bg-white/10 hover:text-fg" title="Remove field">
                  <X className="size-3.5" />
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <AnimatePresence initial={false}>
                  {opts.map((c) => (
                    <motion.button
                      key={c.id}
                      layout
                      initial={{ opacity: 0, scale: 0.9 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.9 }}
                      transition={spring}
                      onClick={() => setEditing({ card: c, isNew: false })}
                      className="flex h-8 items-center gap-1.5 rounded-full border border-line-strong bg-white/[0.06] px-3 text-[12.5px] font-medium transition hover:bg-white/[0.1] [&>svg]:size-3.5 [&>svg]:text-fg-3"
                    >
                      {CARD_ICON[c.type]}
                      {c.name || 'Untitled'}
                    </motion.button>
                  ))}
                </AnimatePresence>
                {busy === f.id && (
                  <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="shimmer flex h-8 items-center gap-2 rounded-full border border-line px-3 text-[12px] text-fg-2">
                    <Spinner className="size-3.5" /> Inventing a {singular.toLowerCase()}…
                  </motion.span>
                )}
                <Menu
                  trigger={
                    <button className="flex h-8 items-center gap-1.5 rounded-full bg-white/[0.08] px-3 text-[12px] font-semibold tracking-wide uppercase transition hover:bg-white/[0.12]">
                      <Plus className="size-3.5" /> Add {singular}
                    </button>
                  }
                >
                  <MenuItem onSelect={() => setEditing({ card: newCard({ type: f.cardType, customType: f.cardType === 'custom' ? (f.customType ?? f.label) : undefined, generator: { ...DEFAULT_GENERATOR } }), isNew: true })}>
                    Create new {singular.toLowerCase()}
                  </MenuItem>
                  <MenuItem right={<WandSparkles className="size-3.5 text-accent" />} onSelect={() => void forMe(f)}>
                    Create {singular.toLowerCase()} for me
                  </MenuItem>
                </Menu>
              </div>
            </motion.div>
          )
        })}
      </AnimatePresence>
      <div className="mx-4 border-t border-line py-3">
        <AnimatePresence mode="wait" initial={false}>
          {custom === null ? (
            <motion.button key="btn" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setCustom('')} className="flex items-center gap-1.5 text-[12px] font-semibold tracking-wide text-fg-2 uppercase transition hover:text-fg">
              <Plus className="size-4" /> Create custom field
            </motion.button>
          ) : (
            <motion.div key="in" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="flex items-center gap-2">
              <Input
                autoFocus
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') addCustom(custom)
                  if (e.key === 'Escape') setCustom(null)
                }}
                onBlur={() => addCustom(custom)}
                placeholder="Field name, e.g. Background, Weapon, Home planet"
                className="max-w-[320px]"
              />
              <span className="text-[11px] text-fg-3">Enter to add</span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <StoryCardModal
        state={editing}
        info={{ ...info, cards: scenario.cards }}
        onClose={() => setEditing(null)}
        onSave={save}
        onDelete={(id) => setCards((cur) => cur.filter((c) => c.id !== id))}
        onDuplicate={(c) => {
          const copy = { ...c, id: nanoid(10), name: `${c.name} (copy)`, createdAt: Date.now(), updatedAt: Date.now() }
          setCards((cur) => [...cur, copy])
          return copy
        }}
        onReplace={(c) => setEditing({ card: c, isNew: false })}
        onNew={(t, ct) => setEditing({ card: newCard({ type: t, customType: ct, generator: { ...DEFAULT_GENERATOR } }), isNew: true })}
      />
    </div>
  )
}
