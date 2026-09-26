// Story cards: board (filters, views, tiles) and the card editor modal.
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { AnimatePresence, motion } from 'motion/react'
import { Dialog as RD } from 'radix-ui'
import {
  Check,
  ChevronRight,
  Copy,
  Dna,
  Ellipsis,
  Flag,
  LayoutGrid,
  Link2,
  List,
  MapPin,
  Plus,
  Rows3,
  ScanFace,
  Shapes,
  Shield,
  SlidersHorizontal,
  Trash2,
  UserRound,
  WandSparkles,
  X
} from 'lucide-react'
import type { Character, StoryCard, StoryCardType } from '@shared/types'
import { Button, IconButton } from '@/components/ui/button'
import { Input, SearchField, Textarea } from '@/components/ui/input'
import { Dialog, Menu, MenuCheck, MenuItem, MenuLabel, MenuSeparator, Popover, Select } from '@/components/ui/overlay'
import { Segmented, SwitchRow } from '@/components/ui/controls'
import { Avatar, Badge, EmptyState, Field, Spinner } from '@/components/ui/misc'
import { errorText } from '@/lib/api'
import { cn } from '@/lib/utils'
import { ease, spring, springSoft } from '@/lib/motion'
import { db } from '@/stores/db'
import { toast } from '@/stores/toast'
import { nanoid } from 'nanoid'
import { CARD_TYPES, DEFAULT_GENERATOR, LIMITS, cardTypeLabel, newCard } from '../engine/defaults'
import { extractAppearance, generateCard, type StoryInfo } from '../engine/ai'
import { useCharacterFace, useCharacters, faceAssetId } from '../hooks'
import { useDoc } from '@/stores/db'
import { fileUrl } from '@/lib/api'

export const CARD_ICON: Record<StoryCardType, ReactNode> = {
  character: <UserRound />,
  class: <Shield />,
  race: <Dna />,
  location: <MapPin />,
  faction: <Flag />,
  custom: <Shapes />
}

type View = 'grid' | 'compact' | 'list'

// ─── Character link ──────────────────────────────────────────────────────────

function CharacterAvatar({ c, size = 28 }: { c: Character; size?: number }): React.JSX.Element {
  const asset = useDoc('assets', faceAssetId(c))
  return <Avatar src={asset ? fileUrl(asset.path) : undefined} name={c.name} size={size} />
}

export function CharacterLinkPicker({ value, onChange, children }: { value?: string; onChange: (id: string | undefined) => void; children: ReactNode }): React.JSX.Element {
  const characters = useCharacters()
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const list = characters.filter((c) => !q || c.name.toLowerCase().includes(q.toLowerCase()))
  return (
    <Popover open={open} onOpenChange={setOpen} trigger={children} className="w-[300px] p-2">
      <SearchField value={q} onChange={setQ} placeholder="Search characters" autoFocus />
      <div className="mt-2 max-h-[300px] overflow-y-auto">
        {value && (
          <button
            onClick={() => {
              onChange(undefined)
              setOpen(false)
            }}
            className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2 text-[12.5px] text-fg-2 hover:bg-white/[0.06] hover:text-fg"
          >
            <X className="size-3.5" /> Unlink character
          </button>
        )}
        {list.map((c) => (
          <button
            key={c.id}
            onClick={() => {
              onChange(c.id)
              setOpen(false)
            }}
            className={cn('flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-white/[0.06]', value === c.id && 'bg-white/[0.07]')}
          >
            <CharacterAvatar c={c} size={30} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12.5px] font-medium">{c.name}</div>
              <div className="truncate text-[11px] text-fg-3">{c.appearance || c.description || 'No description'}</div>
            </div>
            {c.locked && <Badge tone="accent">Locked</Badge>}
            {value === c.id && <Check className="size-3.5 text-accent" />}
          </button>
        ))}
        {!list.length && <div className="px-2 py-6 text-center text-[12px] text-fg-3">{characters.length ? 'No matches' : 'No characters yet — create one in Characters.'}</div>}
      </div>
    </Popover>
  )
}

// ─── Tiles ───────────────────────────────────────────────────────────────────

function CardFace({ id, size = 26 }: { id?: string; size?: number }): React.JSX.Element | null {
  const { character, src } = useCharacterFace(id)
  if (!character) return null
  return (
    <span title={`Linked to ${character.name}`}>
      <Avatar src={src} name={character.name} size={size} className="ring-2 ring-[color-mix(in_oklab,var(--accent)_45%,transparent)]" />
    </span>
  )
}

function CardMenu({ card, onEdit, onDuplicate, onDelete }: { card: StoryCard; onEdit: () => void; onDuplicate: () => void; onDelete: () => void }): React.JSX.Element {
  return (
    <Menu
      align="end"
      trigger={
        <button onClick={(e) => e.stopPropagation()} className="grid size-7 place-items-center rounded-lg text-fg-3 opacity-70 transition hover:bg-white/10 hover:text-fg hover:opacity-100 max-md:-my-1 max-md:-mr-1 max-md:size-9 max-md:opacity-100" aria-label={`${card.name} options`}>
          <Ellipsis className="size-4" />
        </button>
      }
    >
      <MenuItem icon={<SlidersHorizontal />} onSelect={onEdit}>
        Edit
      </MenuItem>
      <MenuItem icon={<Copy />} onSelect={onDuplicate}>
        Duplicate
      </MenuItem>
      <MenuSeparator />
      <MenuItem icon={<Trash2 />} danger onSelect={onDelete}>
        Delete
      </MenuItem>
    </Menu>
  )
}

function CardTile({ card, view, onOpen, onDuplicate, onDelete }: { card: StoryCard; view: View; onOpen: () => void; onDuplicate: () => void; onDelete: () => void }): React.JSX.Element {
  const menu = <CardMenu card={card} onEdit={onOpen} onDuplicate={onDuplicate} onDelete={onDelete} />
  if (view === 'list') {
    return (
      <div onClick={onOpen} className="group flex h-12 cursor-default items-center gap-3 rounded-xl border border-line bg-white/[0.025] px-3 transition-colors hover:border-line-strong hover:bg-white/[0.05]">
        <span className="grid size-7 place-items-center rounded-lg bg-white/[0.06] text-fg-2 [&>svg]:size-3.5">{CARD_ICON[card.type]}</span>
        <span className="min-w-0 flex-1 truncate font-serif text-[14px] font-semibold">{card.name || 'Untitled card'}</span>
        <span className="hidden max-w-[40%] truncate text-[11.5px] text-fg-3 md:block">{card.triggers}</span>
        <CardFace id={card.characterId} size={22} />
        <Badge>{cardTypeLabel(card)}</Badge>
        {menu}
      </div>
    )
  }
  const compact = view === 'compact'
  return (
    <div
      onClick={onOpen}
      className={cn(
        'group relative flex cursor-default flex-col overflow-hidden rounded-2xl border border-line bg-white/[0.03] transition-[border-color,background,box-shadow,transform] duration-300 hover:-translate-y-0.5 hover:border-line-strong hover:bg-white/[0.055] hover:shadow-[0_18px_40px_-24px_rgb(0_0_0/0.9)]',
        compact ? 'h-[92px] p-3' : 'h-[178px] p-4 max-md:h-auto max-md:min-h-[120px]'
      )}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className={cn('font-serif leading-snug font-semibold break-words', compact ? 'truncate text-[14px]' : 'line-clamp-2 text-[16px]')}>{card.name || 'Untitled card'}</div>
        </div>
        <CardFace id={card.characterId} size={compact ? 22 : 26} />
        {menu}
      </div>
      {!compact && <p className="st-fade-mask mt-1.5 line-clamp-3 flex-1 text-[12.5px] leading-relaxed text-fg-2">{card.entry || <span className="text-fg-3 italic">No entry yet</span>}</p>}
      <div className={cn('flex items-center gap-1.5', compact ? 'mt-auto' : 'mt-2')}>
        <Badge className="gap-1 [&>svg]:size-3">
          {CARD_ICON[card.type]}
          {cardTypeLabel(card)}
        </Badge>
        {!card.entry.trim() && <Badge tone="warning">Empty</Badge>}
      </div>
    </div>
  )
}

// ─── Board ───────────────────────────────────────────────────────────────────

export function StoryCardsBoard({
  cards,
  onChange,
  info,
  columns = 3,
  toolbarExtra
}: {
  cards: StoryCard[]
  onChange: (cards: StoryCard[] | ((cur: StoryCard[]) => StoryCard[])) => void
  info: StoryInfo
  columns?: 2 | 3
  toolbarExtra?: ReactNode
}): React.JSX.Element {
  const [types, setTypes] = useState<StoryCardType[]>([])
  const [view, setView] = useState<View>('grid')
  const [q, setQ] = useState('')
  const [editing, setEditing] = useState<{ card: StoryCard; isNew: boolean } | null>(null)

  const list = useMemo(() => {
    const ql = q.trim().toLowerCase()
    return cards
      .filter((c) => !types.length || types.includes(c.type))
      .filter((c) => !ql || c.name.toLowerCase().includes(ql) || c.triggers.toLowerCase().includes(ql) || c.entry.toLowerCase().includes(ql))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }, [cards, types, q])

  const save = (card: StoryCard): void => onChange((cur) => (cur.some((c) => c.id === card.id) ? cur.map((c) => (c.id === card.id ? { ...card, updatedAt: Date.now() } : c)) : [...cur, { ...card, updatedAt: Date.now() }]))
  const remove = (id: string): void => onChange((cur) => cur.filter((c) => c.id !== id))
  const duplicate = (card: StoryCard): StoryCard => {
    const copy = { ...card, id: nanoid(10), name: `${card.name} (copy)`, createdAt: Date.now(), updatedAt: Date.now() }
    onChange((cur) => [...cur, copy])
    return copy
  }

  const cols = view === 'list' ? 'grid-cols-1' : view === 'compact' ? (columns === 3 ? 'grid-cols-4' : 'grid-cols-3') : columns === 3 ? 'grid-cols-3' : 'grid-cols-2'
  // Phones: rich tiles in one column, compact tiles two-up.
  const phoneCols = view === 'compact' ? 'max-md:grid-cols-2' : 'max-md:grid-cols-1'

  return (
    <div className="flex flex-col gap-3">
      {/* Phones: search gets its own row above the filters and view switch. */}
      <div className="flex items-center gap-2 max-md:flex-wrap">
        <Menu
          trigger={
            <Button size="sm" variant="secondary" icon={<SlidersHorizontal className="size-3.5" />} className="tracking-wide uppercase max-md:h-9">
              Filters{types.length ? ` · ${types.length}` : ''}
            </Button>
          }
        >
          <MenuLabel>Card types</MenuLabel>
          {CARD_TYPES.map((t) => (
            <MenuCheck key={t.value} checked={types.includes(t.value)} onChange={(v) => setTypes((s) => (v ? [...s, t.value] : s.filter((x) => x !== t.value)))}>
              {t.label}
            </MenuCheck>
          ))}
          {types.length > 0 && (
            <>
              <MenuSeparator />
              <MenuItem icon={<X />} onSelect={() => setTypes([])}>
                Clear filters
              </MenuItem>
            </>
          )}
        </Menu>
        <SearchField value={q} onChange={setQ} placeholder="Search cards" className="w-[200px] max-w-[40%] max-md:order-first max-md:w-full max-md:max-w-none" />
        <div className="flex-1" />
        {toolbarExtra}
        <Segmented
          size="sm"
          value={view}
          onChange={setView}
          className="max-md:[&>button]:h-7.5 max-md:[&>button]:px-3"
          items={[
            { value: 'grid', label: <LayoutGrid className="size-3.5" /> },
            { value: 'compact', label: <Rows3 className="size-3.5" /> },
            { value: 'list', label: <List className="size-3.5" /> }
          ]}
        />
      </div>

      <motion.div layout className={cn('grid gap-2.5', cols, phoneCols)}>
        <motion.button
          layout
          whileTap={{ scale: 0.98 }}
          onClick={() => setEditing({ card: newCard({ type: types.length === 1 ? types[0] : 'character', generator: { ...DEFAULT_GENERATOR } }), isNew: true })}
          className={cn(
            'group flex items-center justify-center gap-2 rounded-2xl border border-dashed border-[color-mix(in_oklab,var(--accent)_40%,transparent)] bg-[color-mix(in_oklab,var(--accent)_7%,transparent)] px-5 text-center text-[13px] font-semibold text-accent transition-colors hover:bg-[color-mix(in_oklab,var(--accent)_12%,transparent)]',
            view === 'grid' ? 'h-[178px] flex-col max-md:h-14 max-md:flex-row' : view === 'compact' ? 'h-[92px] flex-col' : 'h-12'
          )}
        >
          <span className="grid size-8 place-items-center rounded-full bg-[color-mix(in_oklab,var(--accent)_16%,transparent)] transition-transform duration-300 group-hover:scale-110 group-hover:rotate-90">
            <Plus className="size-4" />
          </span>
          <span className={cn('max-w-[220px] leading-snug', view === 'compact' && 'text-[12px]', view === 'grid' && 'max-md:text-left')}>{view === 'list' ? 'Add a story card' : 'Add character info, location, faction, and more'}</span>
        </motion.button>
        <AnimatePresence initial={false} mode="popLayout">
          {list.map((c) => (
            <motion.div key={c.id} layout initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.94 }} transition={springSoft}>
              <CardTile card={c} view={view} onOpen={() => setEditing({ card: c, isNew: false })} onDuplicate={() => duplicate(c)} onDelete={() => remove(c.id)} />
            </motion.div>
          ))}
        </AnimatePresence>
      </motion.div>
      {!cards.length && (
        <p className="px-1 text-[12px] leading-relaxed text-fg-3">
          Story cards hold facts about characters, places and factions. When one of a card&apos;s triggers shows up in the story, its entry is added to the AI&apos;s context.
        </p>
      )}
      {cards.length > 0 && !list.length && <EmptyState title="No cards match" body="Try clearing the filters or search." className="py-8" />}

      <StoryCardModal
        state={editing}
        info={{ ...info, cards }}
        onClose={() => setEditing(null)}
        onSave={save}
        onDelete={remove}
        onDuplicate={duplicate}
        onReplace={(card) => setEditing({ card, isNew: false })}
        onNew={(type, customType) => setEditing({ card: newCard({ type, customType, generator: editing?.card.generator ?? { ...DEFAULT_GENERATOR } }), isNew: true })}
      />
    </div>
  )
}

// ─── Modal ───────────────────────────────────────────────────────────────────

function AiLink({ onClick, busy, children }: { onClick: () => void; busy: boolean; children: ReactNode }): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className="ml-auto flex items-center gap-1.5 text-[12px] font-semibold text-accent transition hover:brightness-125 disabled:opacity-60 max-md:min-h-9"
    >
      {busy ? <Spinner className="size-3.5" /> : <WandSparkles className="size-3.5" />}
      {children}
    </button>
  )
}

export function StoryCardModal({
  state,
  info,
  onClose,
  onSave,
  onDelete,
  onDuplicate,
  onReplace,
  onNew
}: {
  state: { card: StoryCard; isNew: boolean } | null
  info: StoryInfo
  onClose: () => void
  onSave: (c: StoryCard) => void
  onDelete: (id: string) => void
  onDuplicate: (c: StoryCard) => StoryCard
  onReplace: (c: StoryCard) => void
  onNew: (type: StoryCardType, customType?: string) => void
}): React.JSX.Element {
  const navigate = useNavigate()
  const [draft, setDraft] = useState<StoryCard | null>(state?.card ?? null)
  const [tab, setTab] = useState<'details' | 'generator'>('details')
  const [busy, setBusy] = useState<'name' | 'entry' | 'character' | null>(null)
  useEffect(() => {
    if (state) {
      setDraft(state.card)
      setTab('details')
    }
  }, [state])

  const gen = draft?.generator ?? DEFAULT_GENERATOR
  const set = (patch: Partial<StoryCard>): void => setDraft((d) => (d ? { ...d, ...patch } : d))
  const setGen = (patch: Partial<typeof gen>): void => setDraft((d) => (d ? { ...d, generator: { ...(d.generator ?? DEFAULT_GENERATOR), ...patch } } : d))
  const dirtyEmpty = !!draft && !draft.name.trim() && !draft.entry.trim()

  const finish = (next: 'close' | 'new'): void => {
    if (!draft) return
    if (!dirtyEmpty) onSave(draft)
    if (next === 'new') onNew(draft.type, draft.customType)
    else onClose()
  }

  const log = (text: string): string => (gen.logInNotes ? `${draft?.notes ? `${draft.notes}\n\n` : ''}[AI · ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}] ${text}` : (draft?.notes ?? ''))

  const runGen = async (mode: 'name' | 'entry'): Promise<void> => {
    if (!draft) return
    setBusy(mode)
    try {
      const res = await generateCard({
        info,
        type: draft.type,
        customType: draft.customType,
        name: mode === 'entry' && draft.name.trim() ? draft.name.trim() : undefined,
        entry: mode === 'entry' ? draft.entry : undefined,
        generator: gen
      })
      setDraft((d) =>
        d
          ? {
              ...d,
              name: mode === 'name' ? res.name : d.name || res.name,
              entry: res.entry,
              triggers: mode === 'name' || !d.triggers.trim() ? res.triggers : d.triggers,
              notes: log(`${mode === 'name' ? `${res.name}: ` : ''}${res.entry}`)
            }
          : d
      )
    } catch (err) {
      toast.error('Generation failed', errorText(err))
    } finally {
      setBusy(null)
    }
  }

  const createCharacter = async (): Promise<void> => {
    if (!draft) return
    if (!draft.name.trim()) {
      toast.error('Give the card a name first')
      return
    }
    setBusy('character')
    try {
      let looks = { appearance: '', description: draft.entry.slice(0, 300) }
      if (draft.entry.trim()) {
        try {
          looks = await extractAppearance(draft)
        } catch (err) {
          toast.info('Created without AI details', errorText(err))
        }
      }
      const now = Date.now()
      const c: Character = {
        id: nanoid(10),
        name: draft.name.trim(),
        description: looks.description,
        appearance: looks.appearance,
        createdAt: now,
        updatedAt: now,
        sheet: {},
        sheetDetail: 'compact',
        locked: false,
        tags: ['story']
      }
      await db.put('characters', c)
      onSave({ ...draft, characterId: c.id })
      onClose()
      toast.success(`${c.name} created`, 'Add a reference image and lock the sheet.')
      navigate(`/characters/${c.id}`)
    } catch (err) {
      toast.error('Could not create the character', errorText(err))
    } finally {
      setBusy(null)
    }
  }

  const title = state?.isNew ? 'New Story Card' : 'Edit Story Card'
  return (
    <Dialog open={!!state} onOpenChange={(o) => !o && finish('close')} width={560} hideClose className="rounded-[22px]">
      <RD.Title className="sr-only">{title}</RD.Title>
      {draft && (
        <div className="flex h-[min(84vh,780px)] flex-col">
          <div className="flex items-center gap-3 border-b border-line px-4 py-3.5">
            <Menu
              trigger={
                <IconButton label="Card options" variant="secondary" size="md" className="rounded-full">
                  <Ellipsis className="size-4" />
                </IconButton>
              }
            >
              <MenuItem right={<ChevronRight className="size-3.5 text-fg-3" />} onSelect={() => finish('new')}>
                Finish and Start New Card
              </MenuItem>
              <MenuItem right={<X className="size-3.5 text-fg-3" />} onSelect={() => finish('close')}>
                Finish and Close
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                right={<Copy className="size-3.5 text-fg-3" />}
                onSelect={() => {
                  if (!dirtyEmpty) onSave(draft)
                  onReplace(onDuplicate(draft))
                }}
              >
                Duplicate
              </MenuItem>
              <MenuItem
                danger
                right={<Trash2 className="size-3.5" />}
                onSelect={() => {
                  onDelete(draft.id)
                  onClose()
                }}
              >
                Delete
              </MenuItem>
            </Menu>
            <div className="flex-1 text-center text-[14px] font-semibold">{title}</div>
            <Button variant="primary" onClick={() => finish(gen.speedCreate ? 'new' : 'close')} className="min-w-[88px] tracking-wide uppercase">
              {gen.speedCreate ? 'Next' : 'Finish'}
            </Button>
          </div>

          <div className="px-5 pt-4 max-md:px-4">
            <Segmented
              caps
              value={tab}
              onChange={setTab}
              className="max-md:flex max-md:w-full max-md:[&>button]:h-9 max-md:[&>button]:flex-1 max-md:[&>button]:justify-center"
              items={[
                { value: 'details', label: 'Details' },
                {
                  value: 'generator',
                  label: (
                    <>
                      <span className="max-md:hidden">Generator settings</span>
                      <span className="md:hidden">Generator</span>
                    </>
                  )
                }
              ]}
            />
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-4 pb-5 max-md:px-4">
            <AnimatePresence mode="wait" initial={false}>
              {tab === 'details' ? (
                <motion.div key="d" initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -10 }} transition={{ duration: 0.22, ease }} className="flex flex-col gap-4">
                  <div className={cn('grid gap-2', draft.type === 'custom' ? 'grid-cols-[1fr_auto]' : 'grid-cols-1')}>
                    <Field label="Type">
                      <Select
                        value={draft.type}
                        onChange={(v) => set({ type: v as StoryCardType })}
                        options={CARD_TYPES.map((t) => ({ value: t.value, label: t.label, icon: CARD_ICON[t.value] }))}
                      />
                    </Field>
                    {draft.type === 'custom' && (
                      <Field label="Category">
                        <Input value={draft.customType ?? ''} onChange={(e) => set({ customType: e.target.value })} placeholder="e.g. Item, Spell" className="w-[160px] max-md:w-[128px]" />
                      </Field>
                    )}
                  </div>
                  <Field label="Name">
                    <Input value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder="Enter a name…" autoFocus />
                    <div className="flex">
                      <AiLink busy={busy === 'name'} onClick={() => void runGen('name')}>
                        Generate New Name &amp; Entry with AI
                      </AiLink>
                    </div>
                  </Field>
                  <Field label="Entry" count={draft.entry.length} max={LIMITS.entry}>
                    <Textarea
                      value={draft.entry}
                      onChange={(e) => set({ entry: e.target.value })}
                      minRows={4}
                      maxRows={12}
                      placeholder="The AI uses this for context whenever one of the trigger words below is used in the story."
                    />
                  </Field>
                  <div className="-mt-2 flex">
                    <AiLink busy={busy === 'entry'} onClick={() => void runGen('entry')}>
                      Generate New Entry with AI
                    </AiLink>
                  </div>
                  <Field label="Triggers" help="Comma separated. The card name also counts as a trigger.">
                    <Input value={draft.triggers} onChange={(e) => set({ triggers: e.target.value })} placeholder="Enter a comma separated list of triggers. This is how the AI will know to use this card." />
                  </Field>
                  <Field label="Notes">
                    <Textarea value={draft.notes} onChange={(e) => set({ notes: e.target.value })} minRows={2} maxRows={8} placeholder="Notes for this story element. These are not visible to the AI but will be visible to players during character creation." />
                  </Field>
                  {draft.type === 'character' && (
                    <motion.div layout initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={spring} className="rounded-2xl border border-line bg-white/[0.025] p-3.5">
                      <div className="label-caps mb-2.5 flex items-center gap-1.5">
                        <ScanFace className="size-3.5" /> Stitch character
                      </div>
                      <LinkedCharacterRow card={draft} onLink={(id) => set({ characterId: id })} />
                      {!draft.characterId && (
                        <Button size="sm" variant="ghost" className="mt-2 -ml-1 text-accent" loading={busy === 'character'} icon={<Plus className="size-3.5" />} onClick={() => void createCharacter()}>
                          Create character from this card
                        </Button>
                      )}
                    </motion.div>
                  )}
                </motion.div>
              ) : (
                <motion.div key="g" initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 10 }} transition={{ duration: 0.22, ease }} className="flex flex-col gap-4">
                  <SwitchRow label="Speed create mode" help={'The "Finish" button changes to "Next". Tap it to save your current card and make a new card of the same type.'} checked={gen.speedCreate} onChange={(v) => setGen({ speedCreate: v })} />
                  <SwitchRow label="Include story summary" help="Consider the information stored in the Story Summary plot component when generating info on the Story Card." checked={gen.includeSummary} onChange={(v) => setGen({ includeSummary: v })} />
                  <SwitchRow label="Log generations in notes" help="All AI generations and subsequent retries get auto-added to notes. New entries are appended to the end of notes." checked={gen.logInNotes} onChange={(v) => setGen({ logInNotes: v })} />
                  <Field label="AI instructions">
                    <Textarea value={gen.aiInstructions} onChange={(e) => setGen({ aiInstructions: e.target.value })} minRows={4} placeholder="Customize the way the AI generates story cards by giving it instructions clarifying what type of result you want. Instructions could include notes about style, story details, etc." />
                  </Field>
                  <Field label="Story information">
                    <Textarea value={gen.storyInfo} onChange={(e) => setGen({ storyInfo: e.target.value })} minRows={4} placeholder="Provide key information about your story for the AI to consider when generating a story card." />
                  </Field>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      )}
    </Dialog>
  )
}

function LinkedCharacterRow({ card, onLink }: { card: StoryCard; onLink: (id: string | undefined) => void }): React.JSX.Element {
  const navigate = useNavigate()
  const { character, src } = useCharacterFace(card.characterId)
  return (
    <div className="flex items-center gap-3">
      {character ? (
        <>
          <Avatar src={src} name={character.name} size={40} className="ring-2 ring-[color-mix(in_oklab,var(--accent)_45%,transparent)]" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-semibold">{character.name}</div>
            <div className="truncate text-[11.5px] text-fg-3">{character.locked ? 'Locked — stays consistent in See, Animate and Narrate' : 'Not locked yet'}</div>
          </div>
          <Button size="sm" variant="ghost" onClick={() => navigate(`/characters/${character.id}`)}>
            Open
          </Button>
          <CharacterLinkPicker value={card.characterId} onChange={onLink}>
            <Button size="sm" variant="secondary" icon={<Link2 className="size-3.5" />}>
              Change
            </Button>
          </CharacterLinkPicker>
        </>
      ) : (
        <>
          <div className="grid size-10 place-items-center rounded-full border border-dashed border-line-strong text-fg-3">
            <UserRound className="size-4" />
          </div>
          <div className="min-w-0 flex-1 text-[12px] leading-snug text-fg-2">Link a locked character to keep their face and voice consistent in scenes.</div>
          <CharacterLinkPicker value={card.characterId} onChange={onLink}>
            <Button size="sm" variant="secondary" icon={<Link2 className="size-3.5" />}>
              Link
            </Button>
          </CharacterLinkPicker>
        </>
      )}
    </div>
  )
}
