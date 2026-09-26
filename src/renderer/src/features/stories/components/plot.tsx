// Plot components (AI Instructions, Plot Essentials, Author's Note, Story
// Summary, Third Person) — shared by the scenario editor and the play panel.
import { useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { BookMarked, Bot, CircleHelp, Feather, Plus, ScrollText, Trash2, UserRound } from 'lucide-react'
import type { PlotComponents } from '@shared/types'
import { IconButton } from '@/components/ui/button'
import { Textarea } from '@/components/ui/input'
import { Dialog, Menu, MenuItem, Select } from '@/components/ui/overlay'
import { Switch } from '@/components/ui/controls'
import { cn } from '@/lib/utils'
import { ease, springSoft } from '@/lib/motion'
import { DEFAULT_INSTRUCTIONS, INSTRUCTION_PRESETS, LIMITS } from '../engine/defaults'
import { tokens } from '../engine/text'

type Key = 'aiInstructions' | 'plotEssentials' | 'authorsNote' | 'storySummary' | 'thirdPerson'

const META: Record<Key, { title: string; icon: ReactNode; help: string; placeholder?: string; max?: number }> = {
  aiInstructions: {
    title: 'AI Instructions',
    icon: <Bot />,
    help: 'How the AI should write. Leave empty to use the Stitch default.',
    placeholder: DEFAULT_INSTRUCTIONS,
    max: LIMITS.plot
  },
  plotEssentials: {
    title: 'Plot Essentials',
    icon: <BookMarked />,
    help: 'Facts the AI should always remember: the premise, the protagonist, key places and secrets.',
    placeholder: 'e.g. You are a courier in a city that never sleeps. Your sister vanished a week ago…',
    max: LIMITS.plot
  },
  authorsNote: {
    title: "Author's Note",
    icon: <Feather />,
    help: 'Style and tone direction placed right before the AI writes. Short and punchy works best.',
    placeholder: 'e.g. Tone: tense and atmospheric. Short paragraphs.',
    max: LIMITS.authorsNote
  },
  storySummary: {
    title: 'Story Summary',
    icon: <ScrollText />,
    help: 'A running summary of the story so far. Auto summarization keeps it up to date as older passages leave the context.',
    placeholder: 'Nothing has happened yet.',
    max: LIMITS.plot
  },
  thirdPerson: {
    title: 'Third Person',
    icon: <UserRound />,
    help: 'Write the story in third person, using the player’s name instead of “you”.'
  }
}

function isShown(k: Key, plot: PlotComponents, added: Set<Key>, always: boolean): boolean {
  if (added.has(k)) return true
  if (k === 'storySummary') return plot.enabled.storySummary || !!plot.storySummary.trim()
  if (k === 'thirdPerson') return plot.enabled.thirdPerson
  return always || !!plot[k].trim()
}

export function PlotCard({ title, icon, help, onRemove, action, children, className }: { title: ReactNode; icon?: ReactNode; help?: ReactNode; onRemove?: () => void; action?: ReactNode; children: ReactNode; className?: string }): React.JSX.Element {
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 10, scale: 0.99 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -6, scale: 0.98, transition: { duration: 0.18 } }}
      transition={springSoft}
      className={cn('group rounded-2xl border border-line bg-white/[0.03] hairline', className)}
    >
      <div className="flex items-center gap-2 px-4 pt-3.5">
        {icon && <span className="text-fg-3 [&>svg]:size-3.5">{icon}</span>}
        <span className="text-[11.5px] font-bold tracking-[0.06em] text-fg uppercase">{title}</span>
        <div className="ml-auto flex items-center gap-1">
          {action}
          {onRemove && (
            <IconButton label="Remove" size="sm" onClick={onRemove} className="opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100 max-md:size-8 max-md:opacity-100">
              <Trash2 className="size-3.5" />
            </IconButton>
          )}
        </div>
      </div>
      {help && <p className="px-4 pt-1 text-[11.5px] leading-snug text-fg-3">{help}</p>}
      <div className="px-4 pt-2 pb-3">{children}</div>
    </motion.div>
  )
}

export function Counter({ value, max }: { value: string; max: number }): React.JSX.Element {
  return (
    <div className="mt-1 flex shrink-0 justify-end gap-2 text-[10.5px] whitespace-nowrap text-fg-3 tabular-nums">
      <span>~{tokens(value)} tokens</span>
      <span className={cn(value.length > max && 'text-danger')}>
        <b className="font-semibold text-fg-2">{value.length}</b> / {max}
      </span>
    </div>
  )
}

export function PlotComponentsEditor({
  plot,
  onChange,
  always = false,
  scenarioInstructions,
  presets = false
}: {
  plot: PlotComponents
  onChange: (plot: PlotComponents) => void
  /** Always show AI Instructions, Plot Essentials and Author's Note (play panel). */
  always?: boolean
  /** Enables the "Scenario Default" preset. */
  scenarioInstructions?: string
  presets?: boolean
}): React.JSX.Element {
  const [added, setAdded] = useState<Set<Key>>(new Set())
  const [help, setHelp] = useState(false)
  const keys: Key[] = ['aiInstructions', 'plotEssentials', 'authorsNote', 'storySummary', 'thirdPerson']
  const shown = keys.filter((k) => isShown(k, plot, added, always))
  const missing = keys.filter((k) => !shown.includes(k))

  const add = (k: Key): void => {
    setAdded((s) => new Set(s).add(k))
    if (k === 'storySummary') onChange({ ...plot, enabled: { ...plot.enabled, storySummary: true } })
    if (k === 'thirdPerson') onChange({ ...plot, thirdPerson: true, enabled: { ...plot.enabled, thirdPerson: true } })
  }
  const remove = (k: Key): void => {
    setAdded((s) => {
      const n = new Set(s)
      n.delete(k)
      return n
    })
    if (k === 'storySummary') onChange({ ...plot, storySummary: '', enabled: { ...plot.enabled, storySummary: false } })
    else if (k === 'thirdPerson') onChange({ ...plot, thirdPerson: false, enabled: { ...plot.enabled, thirdPerson: false } })
    else onChange({ ...plot, [k]: '' })
  }

  const presetValue = (): string => {
    if (scenarioInstructions !== undefined && plot.aiInstructions === scenarioInstructions) return 'scenario'
    if (!plot.aiInstructions.trim()) return 'stitch'
    return INSTRUCTION_PRESETS.find((p) => p.text === plot.aiInstructions)?.id ?? 'custom'
  }

  return (
    <div className="flex flex-col gap-3">
      <AnimatePresence initial={false} mode="popLayout">
        {shown.map((k) => {
          const m = META[k]
          if (k === 'thirdPerson') {
            return (
              <PlotCard key={k} title={m.title} icon={m.icon} onRemove={() => remove(k)}>
                <label className="flex items-center justify-between gap-4 max-md:gap-3">
                  <span className="text-[12.5px] text-fg-2">{m.help}</span>
                  <Switch checked={plot.thirdPerson} onChange={(v) => onChange({ ...plot, thirdPerson: v })} />
                </label>
              </PlotCard>
            )
          }
          const value = plot[k]
          return (
            <PlotCard
              key={k}
              title={m.title}
              icon={m.icon}
              help={m.help}
              onRemove={always && k !== 'storySummary' ? undefined : () => remove(k)}
              action={
                k === 'aiInstructions' && presets ? (
                  <Select
                    size="sm"
                    align="end"
                    className="w-[168px] max-md:w-[140px]"
                    value={presetValue()}
                    onChange={(v) => {
                      if (v === 'scenario') onChange({ ...plot, aiInstructions: scenarioInstructions ?? '' })
                      else if (v === 'custom') return
                      else onChange({ ...plot, aiInstructions: INSTRUCTION_PRESETS.find((p) => p.id === v)?.text ?? '' })
                    }}
                    options={[
                      ...(scenarioInstructions !== undefined ? [{ value: 'scenario', label: 'Scenario Default', hint: 'The instructions this story shipped with' }] : []),
                      ...INSTRUCTION_PRESETS.map((p) => ({ value: p.id, label: p.label, hint: p.hint })),
                      { value: 'custom', label: 'Custom', hint: 'Your own edits', disabled: true }
                    ]}
                  />
                ) : undefined
              }
            >
              <Textarea bare value={value} onChange={(e) => onChange({ ...plot, [k]: e.target.value })} minRows={k === 'authorsNote' ? 2 : 4} maxRows={k === 'aiInstructions' ? 14 : 18} placeholder={m.placeholder} className="leading-relaxed" />
              <Counter value={value} max={m.max ?? LIMITS.plot} />
            </PlotCard>
          )
        })}
      </AnimatePresence>

      <div className="flex flex-col items-center gap-2 pt-2">
        {missing.length > 0 && (
          <Menu
            align="center"
            trigger={
              <motion.button
                whileTap={{ scale: 0.97 }}
                className="flex h-10 items-center gap-2 rounded-full border border-[color-mix(in_oklab,var(--accent)_30%,transparent)] bg-[color-mix(in_oklab,var(--accent)_10%,transparent)] px-5 text-[12.5px] font-semibold tracking-wide text-accent uppercase transition-colors hover:bg-[color-mix(in_oklab,var(--accent)_16%,transparent)]"
              >
                <Plus className="size-4" /> Add plot component
              </motion.button>
            }
          >
            {missing.map((k) => (
              <MenuItem key={k} icon={META[k].icon} onSelect={() => add(k)} hint={k === 'thirdPerson' ? 'toggle' : undefined}>
                {META[k].title}
              </MenuItem>
            ))}
          </Menu>
        )}
        <button onClick={() => setHelp(true)} className="flex items-center gap-1.5 text-[12px] font-medium text-fg-3 transition hover:text-fg-2 max-md:h-9">
          <CircleHelp className="size-3.5" /> Plot Components Help
        </button>
      </div>

      <Dialog open={help} onOpenChange={setHelp} title="Plot components" description="What the AI reads every turn, in this order." width={560}>
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3, ease }} className="flex flex-col gap-3 p-5">
          {keys.map((k) => (
            <div key={k} className="flex gap-3">
              <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg bg-white/[0.06] text-fg-2 [&>svg]:size-3.5">{META[k].icon}</span>
              <div>
                <div className="text-[13px] font-semibold">{META[k].title}</div>
                <div className="text-[12px] leading-relaxed text-fg-2">{META[k].help}</div>
              </div>
            </div>
          ))}
          <div className="mt-1 rounded-xl border border-line bg-white/[0.03] p-3 text-[12px] leading-relaxed text-fg-2">
            Story cards fill the remaining space when their triggers appear in the last few turns. Use <code className="rounded bg-white/10 px-1">{'${character.name}'}</code> in the Character Creator, or <code className="rounded bg-white/10 px-1">{'${enter a country...}'}</code> anywhere to ask the player before the story starts.
          </div>
        </motion.div>
      </Dialog>
    </div>
  )
}
