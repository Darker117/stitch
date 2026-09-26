// Pre-game setup: multiple-choice menus (nested), the character creator and
// `${…}` questions — then the adventure is finalized and begins.
import { useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ArrowLeft, ArrowRight, Dices, Play } from 'lucide-react'
import type { CreatorField, Scenario, StoryCard } from '@shared/types'
import { Button, IconButton } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { ease, spring } from '@/lib/motion'
import { db } from '@/stores/db'
import { CARD_TYPES } from '../engine/defaults'
import { mergeScenario, scenarioTexts } from '../engine/adventure'
import { characterKey, findPrompts, isNamePrompt, promptLabel } from '../engine/placeholders'
import { CARD_ICON } from '../components/cards'
import { LogoMark } from '@/components/shell/logo'

type Step = { kind: 'name' } | { kind: 'field'; field: CreatorField; options: StoryCard[] } | { kind: 'prompt'; key: string }

function optionsFor(s: Scenario, f: CreatorField): StoryCard[] {
  return s.cards.filter((c) => c.type === f.cardType && (f.cardType !== 'custom' || (c.customType ?? '').toLowerCase() === (f.customType ?? f.label).toLowerCase()) && c.name.trim())
}

/** Opening teaser without unfilled placeholders. */
function preview(text: string): string {
  const para = text.split(/\n{2,}/).find((p) => p.trim()) ?? ''
  return (para.match(/[^.!?]+[.!?]+["”’]?\s*/g) ?? [para]).filter((s) => !s.includes('${')).join('').trim()
}

function stepsFor(s: Scenario): Step[] {
  const steps: Step[] = []
  if (s.openingType === 'characterCreator') {
    steps.push({ kind: 'name' })
    for (const f of s.creatorFields) {
      const options = optionsFor(s, f)
      if (options.length) steps.push({ kind: 'field', field: f, options })
    }
  }
  for (const key of findPrompts(scenarioTexts(s))) steps.push({ kind: 'prompt', key })
  return steps
}

const slide = {
  initial: (d: number) => ({ opacity: 0, x: d * 28, filter: 'blur(4px)' }),
  animate: { opacity: 1, x: 0, filter: 'blur(0px)', transition: { duration: 0.42, ease } },
  exit: (d: number) => ({ opacity: 0, x: d * -28, filter: 'blur(4px)', transition: { duration: 0.2, ease } })
}

export function StartFlow({ root, defaultName, onDone }: { root: Scenario; defaultName: string; onDone: (resolved: Scenario, values: Record<string, string>, playerName: string) => void }): React.JSX.Element {
  const [path, setPath] = useState<Scenario[]>([root])
  const [resolved, setResolved] = useState<Scenario | null>(() => (root.openingType === 'multipleChoice' && root.choices.length ? null : root))
  const [step, setStep] = useState(0)
  const [dir, setDir] = useState(1)
  const [values, setValues] = useState<Record<string, string>>({ 'character.name': defaultName })
  const steps = useMemo(() => (resolved ? stepsFor(resolved) : []), [resolved])

  const node = path[path.length - 1]
  const merged = path.slice(1).reduce((acc, s) => mergeScenario(acc, s), path[0])

  const choose = (child: Scenario): void => {
    setDir(1)
    const nextPath = [...path, child]
    setPath(nextPath)
    if (child.openingType === 'multipleChoice' && child.choices.length) return
    const res = mergeScenario(merged, child)
    setResolved(res)
    setStep(0)
    if (!stepsFor(res).length) onDone(res, values, defaultName)
  }

  const back = (): void => {
    setDir(-1)
    if (resolved && step > 0) return setStep((s) => s - 1)
    if (resolved && path.length > 1) {
      setResolved(null)
      setPath((p) => p.slice(0, -1))
      return
    }
    if (!resolved && path.length > 1) setPath((p) => p.slice(0, -1))
  }

  const finish = (): void => {
    if (!resolved) return
    const nameKey = steps.find((s) => s.kind === 'prompt' && isNamePrompt(s.key))
    const name = values['character.name']?.trim() || (nameKey && nameKey.kind === 'prompt' ? values[nameKey.key] : '') || defaultName
    onDone(resolved, values, name)
  }

  const next = (): void => {
    setDir(1)
    if (step >= steps.length - 1) finish()
    else setStep((s) => s + 1)
  }

  const cur = resolved ? steps[step] : undefined
  const canBack = (resolved && step > 0) || path.length > 1
  const set = (k: string, v: string): void => setValues((x) => ({ ...x, [k]: v }))
  const valueOf = (s: Step): string => (s.kind === 'name' ? (values['character.name'] ?? '') : s.kind === 'field' ? (values[characterKey(s.field.label)] ?? '') : (values[s.key] ?? ''))
  const ready = cur ? valueOf(cur).trim().length > 0 : false

  const menu = !resolved ? node : null
  const menuChoices = menu ? menu.choices.map((id) => db.get('scenarios', id)).filter((s): s is Scenario => !!s) : []

  return (
    <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} transition={{ duration: 0.5, ease }} className="mx-auto flex min-h-screen w-full max-w-[640px] flex-col justify-center py-24 max-md:justify-start max-md:pt-[calc(var(--sat,0px)+76px)] max-md:pb-0">
      <div className="mb-6 flex items-center gap-3 max-md:mb-5">
        <LogoMark size={30} />
        <div className="min-w-0">
          <div className="label-caps">{menu ? 'Choose your path' : 'Before you begin'}</div>
          <div className="truncate font-serif text-[15px] font-semibold" style={{ color: 'var(--st-text)' }}>
            {root.title || 'Untitled adventure'}
          </div>
        </div>
        {resolved && steps.length > 1 && (
          <div className="ml-auto flex items-center gap-1.5">
            {steps.map((_, i) => (
              <motion.span key={i} animate={{ width: i === step ? 18 : 6, opacity: i <= step ? 1 : 0.35 }} transition={spring} className="h-1.5 rounded-full bg-accent" />
            ))}
          </div>
        )}
      </div>

      <div className="relative">
        <AnimatePresence mode="wait" custom={dir} initial={false}>
          {menu ? (
            <motion.div key={`menu-${menu.id}`} custom={dir} variants={slide} initial="initial" animate="animate" exit="exit">
              <h2 className="font-serif text-[26px] leading-snug font-semibold tracking-tight max-md:text-[23px]" style={{ color: 'var(--st-text)' }}>
                {menu.opening.trim() || 'Choose your scenario:'}
              </h2>
              <div className="mt-6 flex flex-col gap-2.5">
                {menuChoices.map((c, i) => (
                  <motion.button
                    key={c.id}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0, transition: { delay: 0.06 * i + 0.1, duration: 0.4, ease } }}
                    whileHover={{ x: 4 }}
                    whileTap={{ scale: 0.99 }}
                    onClick={() => choose(c)}
                    className="group flex items-center gap-4 rounded-2xl border border-line bg-[var(--panel)] px-4 py-3.5 text-left backdrop-blur-xl transition-colors hover:border-[color-mix(in_oklab,var(--accent)_45%,transparent)] max-md:gap-3 max-md:px-3.5 max-md:py-3"
                  >
                    <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-grad font-serif text-[15px] font-semibold text-white">{i + 1}</span>
                    <div className="min-w-0 flex-1">
                      <div className="font-serif text-[16.5px] font-semibold max-md:leading-snug">{c.title || `Choice ${i + 1}`}</div>
                      {c.description && <div className="mt-0.5 line-clamp-2 text-[12.5px] text-fg-2">{c.description}</div>}
                    </div>
                    <ArrowRight className="size-4 shrink-0 text-fg-3 transition group-hover:translate-x-0.5 group-hover:text-accent" />
                  </motion.button>
                ))}
                {!menuChoices.length && <div className="text-[13px] text-fg-3">This menu has no choices yet.</div>}
              </div>
            </motion.div>
          ) : cur ? (
            <motion.div key={`step-${step}`} custom={dir} variants={slide} initial="initial" animate="animate" exit="exit">
              {cur.kind === 'name' && (
                <>
                  <h2 className="font-serif text-[26px] font-semibold tracking-tight max-md:text-[23px] max-md:leading-snug" style={{ color: 'var(--st-text)' }}>
                    What is your name?
                  </h2>
                  {resolved?.opening && preview(resolved.opening) && <p className="mt-2 line-clamp-3 text-[13px] leading-relaxed text-fg-2">{preview(resolved.opening)}</p>}
                  <Input autoFocus value={valueOf(cur)} onChange={(e) => set('character.name', e.target.value)} onKeyDown={(e) => e.key === 'Enter' && ready && next()} placeholder="Your character's name" className="mt-6 h-12 font-serif text-[17px]" />
                </>
              )}
              {cur.kind === 'field' && (
                <>
                  <h2 className="font-serif text-[26px] font-semibold tracking-tight max-md:text-[23px] max-md:leading-snug" style={{ color: 'var(--st-text)' }}>
                    Choose your {cur.field.label.toLowerCase()}
                  </h2>
                  <div className="mt-6 grid grid-cols-2 gap-2.5 max-md:mt-5 max-md:gap-2">
                    {cur.options.map((o) => {
                      const k = characterKey(cur.field.label)
                      const active = values[k] === o.name
                      return (
                        <motion.button
                          key={o.id}
                          whileTap={{ scale: 0.98 }}
                          onClick={() => set(k, o.name)}
                          onDoubleClick={() => {
                            set(k, o.name)
                            next()
                          }}
                          className={cn(
                            'relative flex flex-col gap-1 rounded-2xl border p-4 text-left backdrop-blur-xl transition-colors max-md:p-3.5',
                            active ? 'border-[color-mix(in_oklab,var(--accent)_60%,transparent)] bg-[color-mix(in_oklab,var(--accent)_12%,var(--panel))]' : 'border-line bg-[var(--panel)] hover:border-line-strong'
                          )}
                        >
                          <div className="flex items-center gap-2">
                            <span className="text-fg-3 [&>svg]:size-3.5">{CARD_ICON[o.type]}</span>
                            <span className="min-w-0 font-serif text-[16px] font-semibold max-md:text-[15px] max-md:leading-snug">{o.name}</span>
                          </div>
                          <p className="line-clamp-3 text-[12px] leading-relaxed text-fg-2">{o.notes || o.entry}</p>
                          {active && <motion.span layoutId="creator-pick" className="absolute inset-0 rounded-2xl ring-2 ring-[color-mix(in_oklab,var(--accent)_55%,transparent)]" transition={spring} />}
                        </motion.button>
                      )
                    })}
                  </div>
                  <button
                    onClick={() => set(characterKey(cur.field.label), cur.options[Math.floor(Math.random() * cur.options.length)].name)}
                    className="mt-3 flex items-center gap-1.5 text-[12px] font-medium text-fg-3 transition hover:text-fg-2 max-md:-ml-1 max-md:mt-2 max-md:h-10 max-md:px-1"
                  >
                    <Dices className="size-3.5" /> Surprise me
                  </button>
                </>
              )}
              {cur.kind === 'prompt' && (
                <>
                  <h2 className="font-serif text-[26px] font-semibold tracking-tight max-md:text-[23px] max-md:leading-snug" style={{ color: 'var(--st-text)' }}>
                    {promptLabel(cur.key)}
                  </h2>
                  <Input autoFocus value={valueOf(cur)} onChange={(e) => set(cur.key, e.target.value)} onKeyDown={(e) => e.key === 'Enter' && ready && next()} placeholder="Type your answer" className="mt-6 h-12 font-serif text-[17px]" />
                </>
              )}
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>

      {resolved?.openingType === 'characterCreator' && cur?.kind === 'field' && (
        <div className="order-last mt-3 text-right text-[11px] text-fg-3 max-md:order-none max-md:mt-4 max-md:text-left">
          {CARD_TYPES.find((t) => t.value === cur.field.cardType)?.label} options come from this story&apos;s cards
        </div>
      )}
      <div className={cn('mt-8 flex items-center gap-2 max-md:sticky max-md:bottom-0 max-md:z-10 max-md:mt-auto max-md:-mx-5 max-md:bg-[linear-gradient(to_top,var(--st-bg)_55%,transparent)] max-md:px-5 max-md:pt-8 max-md:pb-[calc(var(--sab,0px)+14px)]', !canBack && !cur && 'max-md:hidden')}>
        {canBack && (
          <IconButton label="Back" variant="secondary" onClick={back} className="max-md:size-12 max-md:rounded-2xl">
            <ArrowLeft className="size-4" />
          </IconButton>
        )}
        <div className="flex-1 max-md:hidden" />
        {cur && (
          <Button variant="primary" size="lg" disabled={!ready} onClick={next} className="max-md:h-12 max-md:flex-1 max-md:rounded-2xl" iconRight={step >= steps.length - 1 ? <Play className="size-3.5 fill-current" /> : <ArrowRight className="size-4" />}>
            {step >= steps.length - 1 ? 'Begin' : 'Next'}
          </Button>
        )}
      </div>
    </motion.div>
  )
}
