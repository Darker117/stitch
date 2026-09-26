// Local model library for the renderer: the shared `useLocalModels` hook and
// the rich pickers used wherever something is generated — `ModelFilePicker`
// (one file from a ComfyUI folder) and `LoraStack` (any number of LoRAs with
// strengths and activation keywords).
import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Slider as RS } from 'radix-ui'
import { Check, ChevronDown, Layers, Plus, TextCursorInput, Wand2, X } from 'lucide-react'
import type { LocalModel, LoraRef } from '@shared/types'
import { invoke, on } from '@/lib/api'
import { useCompact } from '@/lib/platform'
import { cn, formatBytes } from '@/lib/utils'
import { ease, spring } from '@/lib/motion'
import { useGen } from '@/stores/gen'
import { useSettings } from '@/stores/settings'
import { Button, IconButton } from './ui/button'
import { Switch } from './ui/controls'
import { SearchField } from './ui/input'
import { Badge, Spinner } from './ui/misc'
import { Dialog, Popover, Tooltip } from './ui/overlay'
import { BaseTag, KindTag, ModelThumb, modelTitle, WordChip } from './model-tags'

// ─── Shared store ────────────────────────────────────────────────────────────

let cache: LocalModel[] | null = null
let pending: Promise<LocalModel[]> | null = null
const listeners = new Set<(m: LocalModel[]) => void>()

function load(refresh = false): Promise<LocalModel[]> {
  if (pending && !refresh) return pending
  const before = cache
  const p = invoke('models:local', refresh)
    .then((list) => {
      cache = list
      for (const l of listeners) l(list)
      // Files appeared or disappeared: let recipes and model lists catch up.
      const sig = (l: LocalModel[] | null): string => (l ?? []).map((m) => m.path).join('|')
      if (before && sig(before) !== sig(list)) {
        const gen = useGen.getState()
        void gen.loadModels()
        void gen.refreshRecipes()
      }
      return list
    })
    .finally(() => {
      if (pending === p) pending = null
    })
  pending = p
  return p
}

let subscribed = false
function subscribe(): void {
  if (subscribed) return
  subscribed = true
  let t: ReturnType<typeof setTimeout> | undefined
  on('models:changed', () => {
    clearTimeout(t)
    t = setTimeout(() => void load(false), 150)
  })
  let dir = useSettings.getState().settings?.modelsDir
  useSettings.subscribe((s) => {
    if (s.settings && s.settings.modelsDir !== dir) {
      dir = s.settings.modelsDir
      void load(true)
    }
  })
}

/** Re-scan every models folder. */
export function refreshLocalModels(): Promise<LocalModel[]> {
  return load(true)
}

/** All local model files (optionally one ComfyUI folder), kept fresh. */
export function useLocalModels(folder?: string): { models: LocalModel[]; loading: boolean; refresh: () => void } {
  const [models, setModels] = useState<LocalModel[]>(cache ?? [])
  const [loading, setLoading] = useState(!cache)
  useEffect(() => {
    subscribe()
    const l = (m: LocalModel[]): void => {
      setModels(m)
      setLoading(false)
    }
    listeners.add(l)
    if (cache) l(cache)
    else void load().catch(() => setLoading(false))
    return () => {
      listeners.delete(l)
    }
  }, [])
  const list = useMemo(() => (folder ? models.filter((m) => m.folder === folder) : models), [models, folder])
  return { models: list, loading, refresh: () => void load(true) }
}

// ─── Compatibility ───────────────────────────────────────────────────────────

function compile(re?: string): RegExp | undefined {
  if (!re) return undefined
  try {
    return new RegExp(re, 'i')
  } catch {
    return undefined
  }
}

/** false only when the file's base model is known and doesn't match. */
function compatible(m: LocalModel | undefined, re: RegExp | undefined): boolean {
  if (!re || !m?.meta?.baseModel) return true
  return re.test(m.meta.baseModel)
}

function haystack(m: LocalModel): string {
  const meta = m.meta
  return `${modelTitle(m)} ${m.name} ${meta?.versionName ?? ''} ${meta?.baseModel ?? ''} ${meta?.trainedWords.join(' ') ?? ''} ${meta?.tags.join(' ') ?? ''}`.toLowerCase()
}

// ─── Rich list (shared by both pickers) ──────────────────────────────────────

function ModelRow({
  m,
  active,
  added,
  incompatible,
  showKind,
  multi,
  onClick
}: {
  m: LocalModel
  active: boolean
  added?: boolean
  incompatible: boolean
  showKind: boolean
  multi?: boolean
  onClick: () => void
}): React.JSX.Element {
  const words = m.meta?.trainedWords ?? []
  return (
    <button
      onClick={onClick}
      disabled={added}
      className={cn(
        'group relative flex w-full items-center gap-2.5 rounded-xl p-1.5 text-left transition-colors duration-150 max-md:gap-3 max-md:p-2',
        active ? 'bg-[color-mix(in_oklab,var(--accent)_12%,transparent)]' : 'hover:bg-white/[0.06]',
        added && 'opacity-55'
      )}
    >
      <ModelThumb model={m} compact className="size-11 shrink-0 rounded-lg ring-1 ring-line" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className={cn('truncate text-[12.5px] font-medium', incompatible && 'text-fg-2')}>{modelTitle(m)}</span>
          {m.meta?.versionName && <span className="truncate text-[10.5px] text-fg-3">{m.meta.versionName}</span>}
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-1">
          {showKind && <KindTag kind={m.kind} />}
          <BaseTag base={m.meta?.baseModel} />
          {incompatible && <span className="text-[10px] font-medium text-warning">Other base</span>}
          <span className="ml-auto shrink-0 pl-1 text-[10px] text-fg-3 tabular-nums">{formatBytes(m.size)}</span>
        </div>
        {words.length > 0 && <div className="mt-1 truncate font-mono text-[10px] text-fg-3">{words.join(' · ')}</div>}
      </div>
      <span
        className={cn(
          'grid size-4.5 shrink-0 place-items-center transition-all duration-200',
          multi ? cn('rounded-md border', active || added ? 'border-transparent bg-grad text-white' : 'border-line-strong text-transparent') : active ? 'text-accent' : 'text-transparent'
        )}
      >
        <Check className="size-3" strokeWidth={3} />
      </span>
    </button>
  )
}

function ModelList({
  models,
  baseModelMatch,
  selected,
  onPick,
  multi,
  added = [],
  onConfirm,
  auto,
  emptyLabel,
  className
}: {
  models: LocalModel[]
  baseModelMatch?: string
  selected: string[]
  onPick?: (m: LocalModel) => void
  multi?: boolean
  added?: string[]
  onConfirm?: (names: string[]) => void
  auto?: { label: string; active: boolean; onPick: () => void }
  emptyLabel: string
  className?: string
}): React.JSX.Element {
  const compact = useCompact()
  const [q, setQ] = useState('')
  const [showAll, setShowAll] = useState(false)
  const [picked, setPicked] = useState<string[]>([])
  const re = compile(baseModelMatch)
  const incompatibleCount = useMemo(() => models.filter((m) => !compatible(m, re)).length, [models, re])
  const showKind = useMemo(() => new Set(models.map((m) => m.kind)).size > 1, [models])
  const list = useMemo(() => {
    const t = q.trim().toLowerCase()
    const pool = showAll || !re ? models : models.filter((m) => compatible(m, re))
    const hits = t ? pool.filter((m) => t.split(/\s+/).every((w) => haystack(m).includes(w))) : pool
    // Files whose base matches first, then unknown bases, then incompatible ones.
    const rank = (m: LocalModel): number => (!re ? (m.meta?.baseModel ? 0 : 1) : !m.meta?.baseModel ? 1 : re.test(m.meta.baseModel) ? 0 : 2)
    return [...hits].sort((a, b) => rank(a) - rank(b) || modelTitle(a).localeCompare(modelTitle(b)))
  }, [models, q, showAll, re])

  return (
    <div className={cn('flex max-h-[min(520px,72vh)] w-full flex-col', className)}>
      <div className="space-y-2 border-b border-line p-2 max-md:px-3">
        <SearchField
          autoFocus={!compact}
          value={q}
          onChange={setQ}
          placeholder="Search names, bases, keywords"
        />
        {re && incompatibleCount > 0 && (
          <label className="flex items-center justify-between gap-3 px-1 text-[11.5px] text-fg-3">
            <span>
              Show incompatible <span className="tabular-nums">({incompatibleCount})</span>
            </span>
            <Switch size="sm" checked={showAll} onChange={setShowAll} />
          </label>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5 max-md:px-2">
        {auto && !q && (
          <button onClick={auto.onPick} className={cn('flex w-full items-center gap-2.5 rounded-xl p-1.5 text-left transition-colors max-md:gap-3 max-md:p-2', auto.active ? 'bg-[color-mix(in_oklab,var(--accent)_12%,transparent)]' : 'hover:bg-white/[0.06]')}>
            <span className="grid size-11 shrink-0 place-items-center rounded-lg border border-dashed border-line-strong text-fg-3">
              <Wand2 className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[12.5px] font-medium">{auto.label}</div>
              <div className="text-[10.5px] text-fg-3">Let the recipe pick its default</div>
            </div>
            {auto.active && <Check className="size-3.5 text-accent" strokeWidth={3} />}
          </button>
        )}
        {list.map((m) => {
          const isAdded = added.includes(m.name)
          const active = multi ? picked.includes(m.name) : selected.includes(m.name)
          return (
            <ModelRow
              key={m.path}
              m={m}
              multi={multi}
              active={active}
              added={isAdded}
              incompatible={!compatible(m, re)}
              showKind={showKind}
              onClick={() => {
                if (multi) setPicked((p) => (p.includes(m.name) ? p.filter((x) => x !== m.name) : [...p, m.name]))
                else onPick?.(m)
              }}
            />
          )
        })}
        {!list.length && (
          <div className="px-4 py-10 text-center text-[12px] text-fg-3">
            {models.length ? (
              <>
                Nothing matches.
                {re && incompatibleCount > 0 && !showAll && (
                  <button className="ml-1 font-medium text-accent hover:brightness-125" onClick={() => setShowAll(true)}>
                    Show incompatible
                  </button>
                )}
              </>
            ) : (
              emptyLabel
            )}
          </div>
        )}
      </div>
      {multi && (
        <div className="flex items-center justify-between gap-2 border-t border-line px-3 py-2 max-md:py-3">
          <span className="text-[11.5px] text-fg-3">{picked.length ? `${picked.length} selected` : 'Pick one or more'}</span>
          <Button size="sm" variant="primary" disabled={!picked.length} icon={<Plus className="size-3.5" />} onClick={() => onConfirm?.(picked)} className="max-md:h-10 max-md:px-4">
            {picked.length > 1 ? `Add ${picked.length} LoRAs` : 'Add LoRA'}
          </Button>
        </div>
      )}
    </div>
  )
}

// ─── ModelFilePicker ─────────────────────────────────────────────────────────

export function ModelFilePicker({
  folder,
  value,
  onChange,
  baseModelMatch,
  placeholder = 'Automatic'
}: {
  folder: string
  value: string | undefined
  onChange: (name: string | undefined) => void
  baseModelMatch?: string
  placeholder?: string
}): React.JSX.Element {
  const { models, loading } = useLocalModels(folder)
  const [open, setOpen] = useState(false)
  // Phones pick from a bottom sheet instead of a popover.
  const compact = useCompact()
  const current = value ? models.find((m) => m.name === value) : undefined
  const re = compile(baseModelMatch)
  const trigger = (
    <button
      {...(compact ? { onClick: () => setOpen(true) } : {})}
      className={cn(
        'group flex h-11 w-full min-w-0 items-center gap-2.5 rounded-[10px] border border-line bg-white/[0.035] pr-3 pl-1.5 text-left outline-none transition-[border-color,background] duration-200 hover:border-line-strong hover:bg-white/[0.06]',
        open && 'border-line-strong bg-white/[0.06]'
      )}
    >
      {current ? (
        <ModelThumb model={current} compact className="size-8 shrink-0 rounded-lg ring-1 ring-line" />
      ) : (
        <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-dashed border-line-strong text-fg-3">{loading ? <Spinner className="size-3.5" /> : <Wand2 className="size-3.5" />}</span>
      )}
      <div className="min-w-0 flex-1">
        <div className={cn('truncate text-[12.5px] font-medium', !value && 'text-fg-2')}>{current ? modelTitle(current) : (value ?? placeholder)}</div>
        <div className="truncate text-[10.5px] text-fg-3">
          {current
            ? `${current.meta?.baseModel ?? 'Unknown base'} · ${formatBytes(current.size)}`
            : value
              ? 'Not found in your models folders'
              : re
                ? `${models.filter((m) => compatible(m, re)).length} of ${models.length} compatible`
                : `${models.length} available`}
        </div>
      </div>
      {value && !current && <Badge tone="warning">Missing</Badge>}
      {current && !compatible(current, re) && <Badge tone="warning">Other base</Badge>}
      <ChevronDown className={cn('size-3.5 shrink-0 text-fg-3 transition-transform duration-300', open && 'rotate-180')} />
    </button>
  )
  const list = (
    <ModelList
      models={models}
      baseModelMatch={baseModelMatch}
      selected={value ? [value] : []}
      emptyLabel="No files in this folder yet — download some from the Models page."
      className={compact ? 'h-[min(620px,70vh)] max-h-none' : undefined}
      auto={{
        label: placeholder,
        active: !value,
        onPick: () => {
          onChange(undefined)
          setOpen(false)
        }
      }}
      onPick={(m) => {
        onChange(m.name)
        setOpen(false)
      }}
    />
  )
  if (compact) {
    return (
      <>
        {trigger}
        <Dialog open={open} onOpenChange={setOpen} title="Choose a model" description={current ? modelTitle(current) : placeholder}>
          {list}
        </Dialog>
      </>
    )
  }
  return (
    <Popover open={open} onOpenChange={setOpen} className="w-[min(460px,calc(100vw-32px))] p-0" trigger={trigger}>
      {list}
    </Popover>
  )
}

// ─── LoraStack ───────────────────────────────────────────────────────────────

/** −2…2 slider whose fill grows from zero, so negative weights read clearly. */
function StrengthSlider({ value, onChange }: { value: number; onChange: (v: number) => void }): React.JSX.Element {
  const pct = (v: number): number => ((v + 2) / 4) * 100
  const lo = Math.min(pct(0), pct(value))
  const hi = Math.max(pct(0), pct(value))
  return (
    <RS.Root value={[value]} min={-2} max={2} step={0.05} onValueChange={(v) => onChange(Math.round(v[0] * 100) / 100)} className="relative flex h-5 w-full touch-none items-center select-none max-md:h-8">
      <RS.Track className="relative h-[3px] grow overflow-hidden rounded-full bg-white/[0.1]">
        <div className="absolute inset-y-0 rounded-full bg-grad" style={{ left: `${lo}%`, width: `${hi - lo}%` }} />
      </RS.Track>
      <span className="pointer-events-none absolute top-1/2 left-1/2 h-2 w-px -translate-y-1/2 bg-white/25" />
      <RS.Thumb
        aria-label="Strength"
        onDoubleClick={() => onChange(1)}
        className="block size-3.5 rounded-full bg-white shadow-[0_2px_10px_rgb(0_0_0/0.4),0_0_0_4px_color-mix(in_oklab,var(--accent)_22%,transparent)] transition-transform duration-150 outline-none hover:scale-110 focus-visible:scale-110 max-md:size-5 max-md:active:scale-110"
      />
    </RS.Root>
  )
}

function StrengthInput({ value, onChange }: { value: number; onChange: (v: number) => void }): React.JSX.Element {
  const [text, setText] = useState(value.toFixed(2))
  const focused = useRef(false)
  useEffect(() => {
    if (!focused.current) setText(value.toFixed(2))
  }, [value])
  const commit = (): void => {
    const n = Number(text)
    if (Number.isFinite(n)) onChange(Math.max(-2, Math.min(2, Math.round(n * 100) / 100)))
    else setText(value.toFixed(2))
  }
  return (
    <input
      value={text}
      inputMode="decimal"
      onFocus={(e) => {
        focused.current = true
        e.target.select()
      }}
      onBlur={() => {
        focused.current = false
        commit()
      }}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault()
          onChange(Math.max(-2, Math.min(2, Math.round((value + (e.key === 'ArrowUp' ? 0.05 : -0.05)) * 100) / 100)))
        }
      }}
      className={cn(
        'h-6 w-12 shrink-0 rounded-md border border-transparent bg-white/[0.05] text-center font-mono text-[11px] tabular-nums outline-none transition-colors hover:border-line focus:border-[color-mix(in_oklab,var(--accent)_55%,transparent)] max-md:h-8 max-md:w-14 max-md:rounded-lg max-md:text-[12px]',
        value < 0 && 'text-warning'
      )}
    />
  )
}

function LoraCard({
  lora,
  model,
  incompatible,
  onChange,
  onRemove,
  onInsertWords
}: {
  lora: LoraRef
  model: LocalModel | undefined
  incompatible: boolean
  onChange: (l: LoraRef) => void
  onRemove: () => void
  onInsertWords?: (words: string[]) => void
}): React.JSX.Element {
  const words = model?.meta?.trainedWords ?? []
  const title = model ? modelTitle(model) : lora.name.split('/').pop()!.replace(/\.(safetensors|gguf|ckpt|pt)$/i, '')
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.18, ease } }}
      transition={spring}
      className={cn('rounded-xl border border-line bg-white/[0.03] p-2 hairline', lora.strength === 0 && 'opacity-60')}
    >
      <div className="flex items-start gap-2.5">
        {model ? (
          <ModelThumb model={model} compact className="size-10 shrink-0 rounded-lg ring-1 ring-line" />
        ) : (
          <span className="grid size-10 shrink-0 place-items-center rounded-lg border border-dashed border-warning/40 text-warning">
            <Layers className="size-4" />
          </span>
        )}
        <div className="min-w-0 flex-1 pt-px">
          <div className="truncate text-[12.5px] leading-tight font-medium" title={lora.name}>
            {title}
          </div>
          <div className="mt-1.5 flex min-w-0 items-center gap-1">
            <BaseTag base={model?.meta?.baseModel} className="min-w-0" />
            {!model && <Badge tone="warning">Missing</Badge>}
            {model && incompatible && <Badge tone="warning">Other base</Badge>}
          </div>
        </div>
        <IconButton label="Remove LoRA" size="xs" onClick={onRemove} className="max-md:-mt-1 max-md:-mr-1 max-md:size-8">
          <X className="size-3.5" />
        </IconButton>
      </div>
      <div className="mt-2 flex items-center gap-2 pl-0.5">
        <StrengthSlider value={lora.strength} onChange={(s) => onChange({ ...lora, strength: s })} />
        <StrengthInput value={lora.strength} onChange={(s) => onChange({ ...lora, strength: s })} />
      </div>
      {words.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1 max-md:gap-1.5">
          {words.map((w) => (
            <WordChip key={w} word={w} onClick={onInsertWords ? (x) => onInsertWords([x]) : undefined} />
          ))}
          {onInsertWords && (
            <Tooltip content={`Add ${words.length === 1 ? 'this activation word' : `all ${words.length} activation words`} to the prompt`}>
              <motion.button
                whileTap={{ scale: 0.95 }}
                onClick={() => onInsertWords(words)}
                className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[10.5px] font-medium text-fg-3 transition hover:bg-white/[0.06] hover:text-fg max-md:h-7.5 max-md:px-2 max-md:text-[11px]"
              >
                <TextCursorInput className="size-3" /> Add words
              </motion.button>
            </Tooltip>
          )}
        </div>
      )}
    </motion.div>
  )
}

export function LoraStack({
  value,
  onChange,
  baseModelMatch,
  onInsertWords
}: {
  value: LoraRef[]
  onChange: (v: LoraRef[]) => void
  baseModelMatch?: string
  onInsertWords?: (words: string[]) => void
}): React.JSX.Element {
  const { models } = useLocalModels('loras')
  const [open, setOpen] = useState(false)
  // Phones pick from a bottom sheet instead of a popover.
  const compact = useCompact()
  const re = compile(baseModelMatch)
  const byName = useMemo(() => new Map(models.map((m) => [m.name, m])), [models])
  const allWords = useMemo(() => [...new Set(value.filter((l) => l.strength !== 0).flatMap((l) => byName.get(l.name)?.meta?.trainedWords ?? []))], [value, byName])

  const addButton = (
    <button
      {...(compact ? { onClick: () => setOpen(true) } : {})}
      className={cn(
        'flex h-9 flex-1 items-center justify-center gap-1.5 rounded-[10px] border border-dashed border-line-strong text-[12px] font-medium text-fg-2 transition-[background,border-color,color] duration-200 hover:border-[color-mix(in_oklab,var(--accent)_45%,transparent)] hover:bg-[color-mix(in_oklab,var(--accent)_7%,transparent)] hover:text-fg max-md:h-11 max-md:basis-full',
        open && 'border-[color-mix(in_oklab,var(--accent)_45%,transparent)] text-fg'
      )}
    >
      <Plus className="size-3.5" /> Add LoRA
      {value.length > 0 && <span className="text-fg-3">· {value.length} added</span>}
    </button>
  )
  const list = (
    <ModelList
      multi
      models={models}
      baseModelMatch={baseModelMatch}
      selected={[]}
      added={value.map((v) => v.name)}
      emptyLabel="No LoRAs yet — find some on the Models page."
      className={compact ? 'h-[min(620px,70vh)] max-h-none' : undefined}
      onConfirm={(names) => {
        const fresh = names.filter((n) => !value.some((v) => v.name === n)).map((name) => ({ name, strength: 0.8 }))
        onChange([...value, ...fresh])
        setOpen(false)
      }}
    />
  )

  return (
    <div className="flex flex-col gap-2">
      <AnimatePresence initial={false}>
        {value.map((l, i) => (
          <LoraCard
            key={l.name}
            lora={l}
            model={byName.get(l.name)}
            incompatible={!compatible(byName.get(l.name), re)}
            onChange={(next) => onChange(value.map((x, j) => (j === i ? next : x)))}
            onRemove={() => onChange(value.filter((_, j) => j !== i))}
            onInsertWords={onInsertWords}
          />
        ))}
      </AnimatePresence>
      <motion.div layout transition={spring} className="flex items-center gap-2 max-md:flex-wrap">
        {compact ? (
          <>
            {addButton}
            <Dialog open={open} onOpenChange={setOpen} title="Add LoRAs" description="Pick one or more — each starts at 0.80 strength.">
              {list}
            </Dialog>
          </>
        ) : (
          <Popover open={open} onOpenChange={setOpen} className="w-[min(460px,calc(100vw-32px))] p-0" trigger={addButton}>
            {list}
          </Popover>
        )}
        {onInsertWords && allWords.length > 0 && (
          <Button size="sm" variant="ghost" icon={<TextCursorInput className="size-3.5" />} onClick={() => onInsertWords(allWords)} title={allWords.join(', ')} className="max-md:h-9 max-md:flex-1">
            Insert keywords
          </Button>
        )}
      </motion.div>
    </div>
  )
}
