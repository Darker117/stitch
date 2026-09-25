// Details tab — cover, title, description, tags, rating, context budget and
// import/export. Shared by the scenario editor and the play panel.
import { useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Download, FileJson, FileText, ImagePlus, Images, Pencil, Plus, Trash2, Upload, WandSparkles, X } from 'lucide-react'
import type { GenJob } from '@shared/types'
import { Button, IconButton } from '@/components/ui/button'
import { Input, Textarea } from '@/components/ui/input'
import { Menu, MenuItem, MenuSeparator, Select } from '@/components/ui/overlay'
import { Field, ProgressBar } from '@/components/ui/misc'
import { AssetPicker } from '@/components/media'
import { errorText } from '@/lib/api'
import { sceneImageRequest } from '@/lib/characters'
import { cn } from '@/lib/utils'
import { ease, spring } from '@/lib/motion'
import { db } from '@/stores/db'
import { isActive, useGen, waitForJob } from '@/stores/gen'
import { toast } from '@/stores/toast'
import { DEFAULT_INSTRUCTIONS, LIMITS, RATING_OPTIONS } from '../engine/defaults'
import { coverPrompt, type StoryInfo } from '../engine/ai'
import { cardsToJson, importCards, saveFile } from '../engine/io'
import { tokens } from '../engine/text'
import type { StoryChange, StoryDoc } from '../hooks'
import { CoverArt } from './art'

export function Section({ title, children, className }: { title: ReactNode; children: ReactNode; className?: string }): React.JSX.Element {
  return (
    <div className={cn('flex flex-col gap-2.5', className)}>
      <div className="label-caps">{title}</div>
      {children}
    </div>
  )
}

function CoverEditor({ doc, collection, template, info }: { doc: StoryDoc; collection: 'scenarios' | 'adventures'; template?: string; info: StoryInfo }): React.JSX.Element {
  const [picker, setPicker] = useState(false)
  const [jobId, setJobId] = useState<string | null>(null)
  const [thinking, setThinking] = useState(false)
  const job = useGen((s) => (jobId ? s.jobs[jobId] : undefined))
  const submit = useGen((s) => s.submit)
  const setCover = (id: string | undefined): Promise<unknown> => db.update(collection, doc.id, (cur) => ({ ...cur, coverAssetId: id, updatedAt: Date.now() }))

  const generate = async (): Promise<void> => {
    setThinking(true)
    try {
      const prompt = await coverPrompt(info)
      const [j] = await submit({ ...sceneImageRequest({ prompt, characters: [], aspect: '16:9', projectId: doc.projectId }), label: `Cover · ${doc.title || 'Story'}` })
      setJobId(j.id)
      setThinking(false)
      const done: GenJob = await waitForJob(j.id)
      if (done.status === 'done' && done.outputs[0]) await setCover(done.outputs[0])
      else if (done.status === 'error') toast.error('Cover generation failed', done.error)
    } catch (err) {
      toast.error('Could not generate a cover', errorText(err))
    } finally {
      setThinking(false)
      setJobId(null)
    }
  }

  const running = thinking || (job && isActive(job))
  const pct = job?.progress?.max ? job.progress.value / job.progress.max : undefined
  return (
    <div className="group relative">
      <CoverArt coverAssetId={doc.coverAssetId} template={template} className="aspect-[16/8] w-full rounded-2xl ring-1 ring-line">
        <AnimatePresence>
          {job?.preview && running && <motion.img key="pv" src={job.preview} initial={{ opacity: 0 }} animate={{ opacity: 0.9 }} exit={{ opacity: 0 }} className="absolute inset-0 size-full object-cover blur-[2px]" />}
        </AnimatePresence>
        <AnimatePresence>
          {running && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/45 backdrop-blur-[2px]">
              <div className="text-[12.5px] font-medium text-white/90">{thinking ? 'Writing a cover prompt…' : job?.status === 'queued' ? 'Waiting in queue…' : 'Painting your cover…'}</div>
              <ProgressBar value={thinking ? undefined : pct} className="w-40" />
            </motion.div>
          )}
        </AnimatePresence>
      </CoverArt>
      <Menu
        align="end"
        trigger={
          <IconButton label="Edit cover" variant="glass" className="absolute top-3 right-3 rounded-full bg-black/40 text-white backdrop-blur-md">
            <Pencil className="size-4" />
          </IconButton>
        }
      >
        <MenuItem icon={<Images />} onSelect={() => setPicker(true)}>
          Choose from library
        </MenuItem>
        <MenuItem icon={<WandSparkles />} onSelect={() => void generate()} disabled={!!running}>
          Generate with AI
        </MenuItem>
        {doc.coverAssetId && (
          <>
            <MenuSeparator />
            <MenuItem icon={<Trash2 />} danger onSelect={() => void setCover(undefined)}>
              Remove cover
            </MenuItem>
          </>
        )}
      </Menu>
      {!doc.coverAssetId && !running && (
        <button onClick={() => setPicker(true)} className="absolute bottom-3 left-3 flex items-center gap-1.5 rounded-full bg-black/45 px-3 py-1.5 text-[11.5px] font-medium text-white/85 opacity-0 backdrop-blur-md transition group-hover:opacity-100 hover:text-white">
          <ImagePlus className="size-3.5" /> Add a cover
        </button>
      )}
      <AssetPicker open={picker} onClose={() => setPicker(false)} kinds={['image', 'video']} onPick={(a) => a[0] && void setCover(a[0].id)} title="Choose a cover" />
    </div>
  )
}

function TagsField({ tags, onChange }: { tags: string[]; onChange: (t: string[]) => void }): React.JSX.Element {
  const [v, setV] = useState('')
  const add = (): void => {
    const t = v.trim().replace(/^#/, '').toLowerCase()
    if (t && !tags.includes(t) && tags.length < LIMITS.tags) onChange([...tags, t])
    setV('')
  }
  return (
    <Field label="Tags" count={tags.length} max={LIMITS.tags}>
      <div className="flex gap-2">
        <Input value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} placeholder="Add a tag…" disabled={tags.length >= LIMITS.tags} />
        <IconButton label="Add tag" variant="secondary" onClick={add} disabled={!v.trim() || tags.length >= LIMITS.tags}>
          <Plus className="size-4" />
        </IconButton>
      </div>
      {tags.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1.5">
          <AnimatePresence initial={false}>
            {tags.map((t) => (
              <motion.span key={t} layout initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.8 }} transition={spring} className="flex h-7 items-center gap-1 rounded-full border border-line bg-white/[0.05] pr-1 pl-2.5 text-[12px] text-fg-2">
                #{t}
                <button onClick={() => onChange(tags.filter((x) => x !== t))} className="grid size-5 place-items-center rounded-full text-fg-3 hover:bg-white/10 hover:text-fg">
                  <X className="size-3" />
                </button>
              </motion.span>
            ))}
          </AnimatePresence>
        </div>
      )}
    </Field>
  )
}

export function TokenMeter({ plot, extra }: { plot: StoryDoc['plot']; extra?: { label: string; value: number }[] }): React.JSX.Element {
  const parts = [
    { label: 'AI Instructions', value: tokens(plot.aiInstructions.trim() || DEFAULT_INSTRUCTIONS), color: 'var(--accent-2)' },
    { label: 'Plot Essentials', value: tokens(plot.plotEssentials), color: 'color-mix(in oklab, var(--accent-2) 50%, var(--accent))' },
    { label: "Author's Note", value: tokens(plot.authorsNote), color: 'var(--accent)' },
    { label: 'Story Summary', value: tokens(plot.storySummary), color: 'color-mix(in oklab, var(--accent) 60%, #fff)' },
    ...(extra ?? []).map((e) => ({ ...e, color: 'rgb(255 255 255 / 0.35)' }))
  ].filter((p) => p.value > 0)
  const total = parts.reduce((n, p) => n + p.value, 0)
  const max = LIMITS.plotTokens
  const over = total > max
  return (
    <div className="rounded-2xl border border-line bg-white/[0.03] p-4">
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-[12.5px] font-semibold">Plot components</div>
        <div className={cn('text-[12px] tabular-nums', over ? 'text-warning' : 'text-fg-2')}>
          <b className="font-semibold text-fg">{total.toLocaleString()}</b> of {max.toLocaleString()} tokens
        </div>
      </div>
      <div className="mt-3 flex h-2 overflow-hidden rounded-full bg-white/[0.07]">
        {parts.map((p) => (
          <motion.div key={p.label} initial={{ width: 0 }} animate={{ width: `${(p.value / Math.max(total, max)) * 100}%` }} transition={{ duration: 0.6, ease }} style={{ background: p.color }} className="h-full first:rounded-l-full" />
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
        {parts.map((p) => (
          <span key={p.label} className="flex items-center gap-1.5 text-[11.5px] text-fg-2">
            <span className="size-2 rounded-full" style={{ background: p.color }} />
            {p.label} <span className="text-fg-3 tabular-nums">{p.value}</span>
          </span>
        ))}
      </div>
      <p className="mt-2.5 text-[11.5px] leading-snug text-fg-3">
        {over ? 'These always ride along with every turn — trimming them leaves more room for story history and cards.' : 'Always included every turn. Whatever is left of the context goes to recent story, then triggered story cards.'}
      </p>
    </div>
  )
}

export function StoryDetails({
  doc,
  change,
  collection,
  template,
  info,
  onExportBackup,
  onExportText,
  extra
}: {
  doc: StoryDoc
  change: StoryChange
  collection: 'scenarios' | 'adventures'
  template?: string
  info: StoryInfo
  onExportBackup: () => void
  onExportText: () => void
  extra?: ReactNode
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-5">
      <CoverEditor doc={doc} collection={collection} template={template} info={info} />
      <Field label="Title" count={doc.title.length} max={LIMITS.title}>
        <Input value={doc.title} onChange={(e) => change({ title: e.target.value.slice(0, LIMITS.title + 20) })} placeholder="Give your story a name" className="h-10 font-serif text-[15px]" />
      </Field>
      <Field label="Description" count={doc.description.length} max={LIMITS.description}>
        <Textarea value={doc.description} onChange={(e) => change({ description: e.target.value })} minRows={3} maxRows={12} placeholder="What is this story about? Shown on the story card." />
      </Field>
      <TagsField tags={doc.tags} onChange={(tags) => change({ tags })} />
      <Field label="Content rating">
        <Select value={doc.contentRating} onChange={(v) => change({ contentRating: v as StoryDoc['contentRating'] })} options={RATING_OPTIONS.map((r) => ({ value: r.value, label: r.label, hint: r.hint }))} />
      </Field>
      <TokenMeter plot={doc.plot} />
      {extra}
      <Section title="Story card management">
        <div className="flex flex-wrap gap-2">
          <Button
            icon={<Upload className="size-3.5" />}
            onClick={async () => {
              const cards = await importCards()
              if (cards.length) change((cur) => ({ cards: [...cur.cards, ...cards] }))
            }}
          >
            Import
          </Button>
          <Button icon={<FileJson className="size-3.5" />} disabled={!doc.cards.length} onClick={() => void saveFile(`${doc.title || 'story'} cards`, cardsToJson(doc.cards), 'json')}>
            Export
          </Button>
        </div>
      </Section>
      <Section title="Download">
        <div className="flex flex-wrap gap-2">
          <Button icon={<Download className="size-3.5" />} onClick={onExportBackup}>
            Export Backup (JSON)
          </Button>
          <Button icon={<FileText className="size-3.5" />} onClick={onExportText}>
            Export Text
          </Button>
        </div>
      </Section>
    </div>
  )
}
