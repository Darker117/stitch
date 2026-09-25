// Controls for recipe parameters.
import { useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Check, Dice5, Plus, UserRound } from 'lucide-react'
import type { Character, LoraRef, ParamSpec } from '@shared/types'
import { LoraStack, ModelFilePicker } from '@/components/model-library'
import { fileUrl } from '@/lib/api'
import { characterRefs } from '@/lib/characters'
import { cn } from '@/lib/utils'
import { spring } from '@/lib/motion'
import { MediaList, MediaSlot } from '@/components/media'
import { Input, Textarea } from '@/components/ui/input'
import { Select } from '@/components/ui/overlay'
import { Segmented, Slider, Switch } from '@/components/ui/controls'
import { Field } from '@/components/ui/misc'
import { db, useCollection } from '@/stores/db'
import { useGen } from '@/stores/gen'

const RATIOS: Record<string, [number, number]> = {
  '1:1': [1, 1],
  '16:9': [16, 9],
  '9:16': [9, 16],
  '4:3': [4, 3],
  '3:4': [3, 4],
  '3:2': [3, 2],
  '2:3': [2, 3],
  '21:9': [21, 9]
}

export function AspectPicker({ value, onChange, options }: { value: string; onChange: (v: string) => void; options?: string[] }): React.JSX.Element {
  const list = options ?? Object.keys(RATIOS)
  return (
    <div className="grid grid-cols-4 gap-1.5">
      {list.map((r) => {
        const [w, h] = RATIOS[r] ?? [1, 1]
        const scale = 18 / Math.max(w, h)
        const active = value === r
        return (
          <button
            key={r}
            onClick={() => onChange(r)}
            className={cn('relative flex h-14 flex-col items-center justify-center gap-1.5 rounded-xl border text-[11px] font-medium transition-colors', active ? 'border-transparent text-fg' : 'border-line bg-white/[0.02] text-fg-3 hover:bg-white/[0.05] hover:text-fg-2')}
          >
            {active && <motion.span layoutId="aspect-active" className="absolute inset-0 rounded-xl border border-[color-mix(in_oklab,var(--accent)_50%,transparent)] bg-[color-mix(in_oklab,var(--accent)_12%,transparent)]" transition={spring} />}
            <span className={cn('relative rounded-[3px] border-[1.5px]', active ? 'border-accent' : 'border-current')} style={{ width: w * scale, height: h * scale }} />
            <span className="relative">{r}</span>
          </button>
        )
      })}
    </div>
  )
}

/** Choose saved characters to keep on-model. */
export function CastPicker({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }): React.JSX.Element {
  const characters = useCollection('characters')
  if (!characters.length) {
    return <div className="rounded-xl border border-dashed border-line px-3 py-2.5 text-[12px] text-fg-3">No characters yet — lock one in Characters to keep them consistent.</div>
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {characters.map((c: Character) => {
        const active = value.includes(c.id)
        const ref = characterRefs(c, 1)[0]
        const refAsset = ref ? db.get('assets', ref) : undefined
        return (
          <motion.button
            key={c.id}
            whileTap={{ scale: 0.95 }}
            onClick={() => onChange(active ? value.filter((x) => x !== c.id) : [...value, c.id])}
            className={cn('flex h-8 items-center gap-1.5 rounded-full border py-0.5 pr-3 pl-0.5 text-[12px] font-medium transition-colors', active ? 'border-[color-mix(in_oklab,var(--accent)_50%,transparent)] bg-[color-mix(in_oklab,var(--accent)_14%,transparent)] text-fg' : 'border-line bg-white/[0.03] text-fg-2 hover:text-fg')}
          >
            <span className="relative size-7 overflow-hidden rounded-full bg-white/10">
              {refAsset ? <img src={fileUrl(refAsset.path)} className="size-full object-cover" /> : <UserRound className="m-auto mt-1.5 size-4 text-fg-3" />}
              {active && (
                <span className="absolute inset-0 grid place-items-center bg-black/45">
                  <Check className="size-3.5 text-white" strokeWidth={3} />
                </span>
              )}
            </span>
            {c.name}
          </motion.button>
        )
      })}
    </div>
  )
}

export function ParamControl({
  spec,
  value,
  onChange,
  baseModelMatch,
  onInsertWords
}: {
  spec: ParamSpec
  value: unknown
  onChange: (v: unknown) => void
  /** Regex source to filter model/LoRA pickers to compatible files. */
  baseModelMatch?: string
  /** Called with LoRA activation words the user wants in the prompt. */
  onInsertWords?: (words: string[]) => void
}): React.JSX.Element | null {
  const models = useGen((s) => s.models)
  const folderOptions = useMemo(() => (spec.folder ? models[spec.folder] ?? [] : []), [models, spec.folder])
  const v = value ?? spec.default

  switch (spec.type) {
    case 'prompt':
    case 'text':
      if (spec.key === 'lyrics') return <LyricsField label={spec.label} help={spec.help} value={String(v ?? '')} onChange={onChange} />
      return (
        <Field label={spec.label} help={spec.help}>
          <Textarea value={String(v ?? '')} onChange={(e) => onChange(e.target.value)} minRows={spec.type === 'prompt' ? 4 : 2} maxRows={10} />
        </Field>
      )
    case 'number':
    case 'int':
      if (spec.min !== undefined && spec.max !== undefined && spec.max - spec.min <= 300) {
        return (
          <Field label={spec.label} help={spec.help} action={<span className="text-[12px] font-semibold tabular-nums">{Number(v ?? spec.min)}</span>}>
            <Slider value={Number(v ?? spec.min)} min={spec.min} max={spec.max} step={spec.step ?? (spec.type === 'int' ? 1 : 0.1)} onChange={onChange} />
          </Field>
        )
      }
      return (
        <Field label={spec.label} help={spec.help}>
          <Input type="number" value={String(v ?? '')} min={spec.min} max={spec.max} step={spec.step} onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))} />
        </Field>
      )
    case 'seed':
      return (
        <Field label={spec.label} help={spec.help}>
          <Input
            type="number"
            value={String(v ?? -1)}
            onChange={(e) => onChange(Number(e.target.value))}
            suffix={
              <button onClick={() => onChange(Math.floor(Math.random() * 2 ** 31))} className="grid size-7 place-items-center rounded-md text-fg-3 hover:bg-white/10 hover:text-fg" title="Random seed">
                <Dice5 className="size-3.5" />
              </button>
            }
          />
        </Field>
      )
    case 'select':
      return (
        <Field label={spec.label} help={spec.help}>
          <Select value={String(v ?? '')} onChange={onChange} options={spec.options ?? []} />
        </Field>
      )
    case 'aspect':
      return (
        <Field label={spec.label}>
          <AspectPicker value={String(v ?? '1:1')} onChange={onChange} options={spec.options?.map((o) => o.value)} />
        </Field>
      )
    case 'bool':
      return (
        <label className="flex items-center justify-between gap-3">
          <span className="label-caps">{spec.label}</span>
          <Switch checked={v === true} onChange={onChange} />
        </label>
      )
    case 'model':
      return (
        <Field label={spec.label} help={spec.help}>
          <ModelFilePicker folder={spec.folder ?? 'diffusion_models'} value={typeof v === 'string' ? v : undefined} onChange={onChange} baseModelMatch={baseModelMatch} />
        </Field>
      )
    case 'lora':
      return (
        <Field label={spec.label} help={spec.help}>
          <Select
            value={String(v ?? '')}
            onChange={(x) => onChange(x === '__none' ? undefined : x)}
            options={[{ value: '__none', label: 'None' }, ...folderOptions.map((m) => ({ value: m, label: m.replace(/\.(safetensors|gguf|ckpt)$/i, '') }))]}
          />
        </Field>
      )
    case 'loras':
      return (
        <Field label={spec.label} help={spec.help}>
          <LoraStack value={Array.isArray(v) ? (v as LoraRef[]) : []} onChange={onChange} baseModelMatch={baseModelMatch} onInsertWords={onInsertWords} />
        </Field>
      )
    case 'image':
      return (
        <Field label={spec.label} help={spec.help}>
          <MediaSlot kind="image" value={v as string | undefined} onChange={onChange} label="Add image" />
        </Field>
      )
    case 'audio':
      return (
        <Field label={spec.label} help={spec.help}>
          <MediaSlot kind="audio" value={v as string | undefined} onChange={onChange} label="Add audio" />
        </Field>
      )
    case 'images':
    case 'audios':
      return (
        <Field label={spec.label} help={spec.help}>
          <MediaList kind={spec.type === 'images' ? 'image' : 'audio'} value={(v as string[] | undefined) ?? []} onChange={onChange} max={spec.maxItems ?? 9} />
        </Field>
      )
    default:
      return null
  }
}

// ─── Music ───────────────────────────────────────────────────────────────────

const STYLE_TAGS: Record<string, string[]> = {
  Genre: ['pop', 'rock', 'hip-hop', 'R&B', 'electronic', 'synthwave', 'lo-fi', 'jazz', 'folk', 'country', 'metal', 'orchestral', 'cinematic', 'ambient', 'k-pop'],
  Mood: ['uplifting', 'melancholic', 'dark', 'epic', 'dreamy', 'energetic', 'romantic', 'tense', 'playful', 'nostalgic'],
  Vocals: ['female vocals', 'male vocals', 'duet', 'choir', 'whispered vocals', 'raspy vocals', 'instrumental'],
  Sound: ['piano', 'acoustic guitar', 'electric guitar', 'strings', 'brass', '808 bass', 'synth pads', 'war drums', 'polished production'],
  Tempo: ['70 BPM', '90 BPM', '110 BPM', '128 BPM', '150 BPM']
}

const tokens = (text: string): string[] =>
  text
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)

/** Clickable genre / mood / vocal / tempo tags that add to (or remove from) a comma-separated style prompt. */
export function StyleTags({ value, onChange }: { value: string; onChange: (v: string) => void }): React.JSX.Element {
  const [group, setGroup] = useState('Genre')
  const current = tokens(value).map((t) => t.toLowerCase())
  const toggle = (tag: string): void => {
    const list = tokens(value)
    const i = list.findIndex((t) => t.toLowerCase() === tag.toLowerCase())
    if (i >= 0) list.splice(i, 1)
    else list.push(tag)
    onChange(list.join(', '))
  }
  return (
    <div className="space-y-2">
      <Segmented size="sm" value={group} onChange={setGroup} items={Object.keys(STYLE_TAGS).map((g) => ({ value: g, label: g }))} />
      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={group} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -2 }} transition={{ duration: 0.18 }} className="flex flex-wrap gap-1">
          {STYLE_TAGS[group].map((t) => {
            const on = current.includes(t.toLowerCase())
            return (
              <motion.button
                key={t}
                whileTap={{ scale: 0.94 }}
                onClick={() => toggle(t)}
                className={cn(
                  'inline-flex h-6.5 items-center gap-1 rounded-full border px-2.5 text-[11.5px] font-medium transition-colors',
                  on ? 'border-[color-mix(in_oklab,var(--accent)_50%,transparent)] bg-[color-mix(in_oklab,var(--accent)_14%,transparent)] text-fg' : 'border-line bg-white/[0.03] text-fg-2 hover:text-fg'
                )}
              >
                {on ? <Check className="size-3" /> : <Plus className="size-3 text-fg-3" />}
                {t}
              </motion.button>
            )
          })}
        </motion.div>
      </AnimatePresence>
    </div>
  )
}

const SECTIONS = ['[Intro]', '[Verse]', '[Pre-Chorus]', '[Chorus]', '[Bridge]', '[Outro]']

/** Lyrics editor with one-click section markers. */
function LyricsField({ label, help, value, onChange }: { label: string; help?: string; value: string; onChange: (v: unknown) => void }): React.JSX.Element {
  const add = (tag: string): void => {
    const cur = value.replace(/\s+$/, '')
    onChange(cur ? `${cur}\n\n${tag}\n` : `${tag}\n`)
  }
  return (
    <Field label={label} help={help}>
      <Textarea value={value} onChange={(e) => onChange(e.target.value)} minRows={6} maxRows={18} placeholder={'[Verse]\nFirst line of your song…\n\n[Chorus]\n…'} className="leading-relaxed" />
      <div className="flex flex-wrap gap-1">
        {SECTIONS.map((t) => (
          <button key={t} onClick={() => add(t)} className="h-6 rounded-md border border-line bg-white/[0.03] px-2 font-mono text-[10.5px] text-fg-3 transition-colors hover:border-line-strong hover:text-fg">
            {t}
          </button>
        ))}
      </div>
    </Field>
  )
}
