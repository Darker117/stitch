// Gen Space: a compact generator inside the editor. Jobs are tagged with the
// timeline as origin; finished media lands in the Assets panel.
import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { AlertTriangle, AudioLines, Check, Film, ImageIcon, RotateCcw, Sparkles, X } from 'lucide-react'
import type { Asset, GenJob, ParamSpec, RecipeInfo } from '@shared/types'
import { errorText, fileUrl } from '@/lib/api'
import { cn, formatEta } from '@/lib/utils'
import { ease, spring } from '@/lib/motion'
import { useDoc } from '@/stores/db'
import { isActive, useGen } from '@/stores/gen'
import { toast } from '@/stores/toast'
import { MediaList, MediaSlot } from '@/components/media'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/input'
import { Segmented, Slider } from '@/components/ui/controls'
import { Select } from '@/components/ui/overlay'
import { Badge, ProgressBar, StatusDot } from '@/components/ui/misc'
import { endAssetDrag, startAssetDrag } from './helpers'
import { appendAsset } from './actions'
import { editor, useEditor } from './store'

type GenKindUi = 'video' | 'image' | 'audio'

function defaultsOf(r: RecipeInfo): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const p of r.params) if (p.default !== undefined) out[p.key] = p.default
  return out
}

function aspectFor(w: number, h: number, options: string[]): string | undefined {
  const target = w / h
  let best: string | undefined
  let bestD = Infinity
  for (const o of options) {
    const [a, b] = o.split(':').map(Number)
    if (!a || !b) continue
    const d = Math.abs(Math.log(a / b / target))
    if (d < bestD) {
      bestD = d
      best = o
    }
  }
  return best
}

export function GenSpace(): React.JSX.Element {
  const recipes = useGen((s) => s.recipes)
  const jobs = useGen((s) => s.jobs)
  const comfy = useGen((s) => s.comfy)
  const submit = useGen((s) => s.submit)
  const tl = useEditor((s) => s.tl)!
  const [kind, setKind] = useState<GenKindUi>('video')
  const [recipeId, setRecipeId] = useState<Record<GenKindUi, string | undefined>>({ video: undefined, image: undefined, audio: undefined })
  const [prompt, setPrompt] = useState('')
  const [params, setParams] = useState<Record<string, unknown>>({})
  const [batch, setBatch] = useState(1)
  const [busy, setBusy] = useState(false)

  const list = useMemo(() => recipes.filter((r) => r.kind === kind), [recipes, kind])
  const recipe = list.find((r) => r.id === recipeId[kind]) ?? list.find((r) => r.available !== false) ?? list[0]
  const online = comfy.some((c) => c.online)

  // reset params when the recipe changes; aspect follows the timeline frame
  useEffect(() => {
    if (!recipe) return
    const d = defaultsOf(recipe)
    const aspect = recipe.params.find((p) => p.type === 'aspect')
    if (aspect?.options) {
      const a = aspectFor(tl.width, tl.height, aspect.options.map((o) => o.value))
      if (a) d[aspect.key] = a
    }
    setParams(d)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recipe?.id])

  const keyParams = useMemo<ParamSpec[]>(() => {
    if (!recipe) return []
    return recipe.params.filter((p) => !p.advanced && p.type !== 'prompt' && ['aspect', 'number', 'int', 'select', 'image', 'images', 'audio'].includes(p.type)).slice(0, 5)
  }, [recipe])

  const mine = useMemo(
    () =>
      Object.values(jobs)
        .filter((j) => j.origin?.type === 'timeline' && j.origin.id === tl.id)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 12),
    [jobs, tl.id]
  )

  const missingRequired = recipe?.params.find((p) => p.required && p.type !== 'prompt' && (params[p.key] === undefined || (Array.isArray(params[p.key]) && !(params[p.key] as unknown[]).length)))

  const go = async (): Promise<void> => {
    if (!recipe || !prompt.trim()) return
    setBusy(true)
    try {
      const promptKey = recipe.params.find((p) => p.type === 'prompt')?.key ?? 'prompt'
      await submit({
        recipeId: recipe.id,
        params: { ...params, [promptKey]: prompt.trim() },
        label: prompt.trim().slice(0, 48),
        origin: { type: 'timeline', id: tl.id },
        projectId: tl.projectId,
        batch
      })
      toast.success(batch > 1 ? `${batch} jobs queued` : 'Generation queued', 'Results land in Assets as they finish.')
    } catch (err) {
      toast.error('Could not queue', errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-3.5 pt-3 pb-3">
        <div className="flex flex-col gap-2">
          <Segmented
            size="sm"
            className="w-full [&>button]:flex-1 [&>button]:justify-center"
            value={kind}
            onChange={setKind}
            items={[
              { value: 'video', label: 'Video', icon: <Film /> },
              { value: 'image', label: 'Image', icon: <ImageIcon /> },
              { value: 'audio', label: 'Audio', icon: <AudioLines /> }
            ]}
          />
          <div className="min-w-0">
            <Select
              size="sm"
              value={recipe?.id}
              onChange={(v) => setRecipeId((r) => ({ ...r, [kind]: v }))}
              placeholder="No recipes"
              options={list.map((r) => ({ value: r.id, label: r.name, hint: r.available === false ? `Missing ${r.missing?.length ?? ''} model file(s)` : r.family }))}
            />
          </div>
        </div>

        {!online && (
          <div className="mt-2.5 flex items-center gap-2 rounded-lg border border-warning/20 bg-warning/[0.06] px-2.5 py-1.5 text-[11px] text-fg-2">
            <StatusDot state="warn" />
            ComfyUI is offline — jobs wait in the queue until it's up.
          </div>
        )}
        {recipe?.available === false && (
          <div className="mt-2.5 flex items-start gap-2 rounded-lg border border-danger/20 bg-danger/[0.06] px-2.5 py-1.5 text-[11px] text-fg-2">
            <AlertTriangle className="mt-0.5 size-3 shrink-0 text-danger" />
            <span className="min-w-0">Missing: {recipe.missing?.slice(0, 2).join(', ')}</span>
          </div>
        )}

        <div className="glow-border mt-2.5 rounded-xl border border-line bg-white/[0.03] p-2.5 transition-colors focus-within:bg-white/[0.045]">
          <Textarea
            bare
            minRows={3}
            maxRows={7}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void go()
            }}
            placeholder={kind === 'video' ? 'A lantern-lit alley in the rain, the courier turns and says “we’re late”…' : kind === 'audio' ? 'Slow cinematic synth pads, distant thunder, 80 BPM' : 'Wide shot of a desert caravan at golden hour…'}
            className="text-[12.5px] leading-relaxed"
          />
          {recipe?.description && <div className="mt-1 line-clamp-1 text-[10.5px] text-fg-3">{recipe.description}</div>}
        </div>

        {keyParams.length > 0 && (
          <div className="mt-2.5 grid grid-cols-2 gap-2">
            {keyParams.map((p) => (
              <ParamControl key={p.key} spec={p} value={params[p.key]} onChange={(v) => setParams((s) => ({ ...s, [p.key]: v }))} />
            ))}
          </div>
        )}

        <div className="mt-3 flex items-center gap-2">
          <div className="flex items-center rounded-lg border border-line bg-white/[0.03] p-0.5">
            {[1, 2, 4].map((n) => (
              <button
                key={n}
                onClick={() => setBatch(n)}
                className={cn('relative h-6.5 w-7 rounded-md text-[11px] font-semibold transition-colors', batch === n ? 'text-fg' : 'text-fg-3 hover:text-fg-2')}
              >
                {batch === n && <motion.span layoutId="gen-batch" className="absolute inset-0 rounded-md bg-white/[0.1]" transition={spring} />}
                <span className="relative">×{n}</span>
              </button>
            ))}
          </div>
          <div className="flex-1 text-[10.5px] text-fg-3">{recipe?.estSeconds ? `${formatEta(recipe.estSeconds * batch)}` : ''}</div>
          <Button variant="primary" size="sm" icon={<Sparkles className="size-3.5" />} loading={busy} disabled={!recipe || !prompt.trim() || !!missingRequired} onClick={() => void go()}>
            Generate
          </Button>
        </div>
        {missingRequired && <div className="mt-1.5 text-right text-[10.5px] text-fg-3">Add {missingRequired.label.toLowerCase()} first</div>}

        <div className="mt-4 flex items-center justify-between">
          <span className="label-caps">From this timeline</span>
          {mine.length > 0 && <span className="text-[10.5px] text-fg-3">{mine.filter(isActive).length} running</span>}
        </div>
        {mine.length === 0 ? (
          <div className="mt-2 rounded-xl border border-dashed border-line px-3 py-5 text-center text-[11.5px] text-fg-3">Generations started here show up live, then drop into Assets.</div>
        ) : (
          <div className="mt-2 grid grid-cols-2 gap-2">
            <AnimatePresence initial={false}>
              {mine.map((j) => (
                <JobCard key={j.id} job={j} />
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>
    </div>
  )
}

function ParamControl({ spec, value, onChange }: { spec: ParamSpec; value: unknown; onChange: (v: unknown) => void }): React.JSX.Element {
  const label = <div className="mb-1 truncate text-[10.5px] font-semibold tracking-wide text-fg-3 uppercase">{spec.label}</div>
  if (spec.type === 'image' || spec.type === 'audio') {
    return (
      <div className="col-span-1">
        {label}
        <MediaSlot kind={spec.type} value={typeof value === 'string' ? value : undefined} onChange={onChange} label={spec.type === 'image' ? 'Drop an image' : 'Drop audio'} aspect="aspect-[16/10]" />
      </div>
    )
  }
  if (spec.type === 'images') {
    return (
      <div className="col-span-2">
        {label}
        <MediaList kind="image" value={Array.isArray(value) ? (value as string[]) : []} onChange={onChange} max={spec.maxItems ?? 4} />
      </div>
    )
  }
  if (spec.type === 'number' || spec.type === 'int') {
    const v = typeof value === 'number' ? value : Number(spec.default ?? spec.min ?? 0)
    return (
      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="truncate text-[10.5px] font-semibold tracking-wide text-fg-3 uppercase">{spec.label}</span>
          <span className="font-mono text-[11px] text-fg tabular-nums">{v}</span>
        </div>
        <Slider value={v} min={spec.min ?? 0} max={spec.max ?? 100} step={spec.step ?? (spec.type === 'int' ? 1 : 0.5)} onChange={onChange} className="h-7" />
      </div>
    )
  }
  const options = spec.options ?? []
  return (
    <div>
      {label}
      <Select size="sm" value={value === undefined ? undefined : String(value)} onChange={onChange} options={options.map((o) => ({ value: o.value, label: o.label }))} />
    </div>
  )
}

function JobCard({ job }: { job: GenJob }): React.JSX.Element {
  const output = useDoc('assets', job.outputs[0] ?? null)
  const cancel = useGen((s) => s.cancel)
  const p = job.progress ? job.progress.value / Math.max(1, job.progress.max) : undefined
  return (
    <motion.div layout initial={{ opacity: 0, scale: 0.92 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.92 }} transition={spring}>
      {output ? <DoneTile asset={output} /> : (
        <div className={cn('group relative aspect-video overflow-hidden rounded-[10px] bg-black/40 ring-1', job.status === 'error' ? 'ring-danger/40' : 'ring-line')} title={String(job.params.prompt ?? '')}>
          {job.preview ? <img src={job.preview} alt="" className="size-full object-cover" /> : isActive(job) ? <div className="shimmer size-full" /> : null}
          <div className="absolute inset-x-0 bottom-0 flex flex-col gap-1 bg-gradient-to-t from-black/80 to-transparent px-2 pt-4 pb-1.5">
            <div className="flex items-center gap-1 text-[10px] font-medium text-white/90">
              {job.status === 'error' ? <AlertTriangle className="size-2.5 text-danger" /> : job.status === 'canceled' ? <X className="size-2.5" /> : null}
              <span className="truncate">{job.status === 'error' ? (job.error ?? 'Failed') : job.status === 'queued' ? 'Queued' : job.status === 'canceled' ? 'Canceled' : `${job.progress?.node ?? 'Rendering'}…`}</span>
            </div>
            {isActive(job) && <ProgressBar value={job.status === 'queued' ? undefined : p} />}
          </div>
          {isActive(job) && (
            <button onClick={() => void cancel(job.id)} className="absolute top-1 right-1 grid size-5 place-items-center rounded-md bg-black/55 text-white opacity-0 transition group-hover:opacity-100" title="Cancel">
              <X className="size-3" />
            </button>
          )}
          {job.status === 'error' && (
            <button
              onClick={() => void useGen.getState().submit({ recipeId: job.recipeId, params: job.params, label: job.label, origin: job.origin, projectId: job.projectId })}
              className="absolute top-1 right-1 grid size-5 place-items-center rounded-md bg-black/55 text-white"
              title="Retry"
            >
              <RotateCcw className="size-3" />
            </button>
          )}
        </div>
      )}
    </motion.div>
  )
}

function DoneTile({ asset }: { asset: Asset }): React.JSX.Element {
  const poster = asset.kind === 'image' ? fileUrl(asset.path) : asset.thumbPath ? fileUrl(asset.thumbPath) : ''
  return (
    <div
      draggable
      onDragStart={(e) => startAssetDrag(e, asset)}
      onDragEnd={endAssetDrag}
      onClick={() => editor.setSource(asset.id)}
      onDoubleClick={() => appendAsset(asset)}
      className="group relative aspect-video cursor-grab overflow-hidden rounded-[10px] bg-black/40 ring-1 ring-line transition hover:ring-line-strong active:cursor-grabbing"
      title={asset.prompt ?? asset.name}
    >
      {poster ? (
        <motion.img initial={{ opacity: 0, scale: 1.06 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.6, ease }} src={poster} alt="" draggable={false} className="pointer-events-none size-full object-cover" />
      ) : (
        <div className="grid size-full place-items-center bg-grad-soft text-fg-2">{asset.kind === 'audio' ? <AudioLines className="size-4" /> : <Film className="size-4" />}</div>
      )}
      <Badge tone="success" className="absolute top-1 left-1 h-4.5 gap-0.5 bg-black/55 px-1 text-[9.5px] backdrop-blur">
        <Check className="size-2.5" /> Ready
      </Badge>
    </div>
  )
}
