import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ComponentType } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router'
import { AnimatePresence, motion } from 'motion/react'
import { create } from 'zustand'
import {
  AlertTriangle,
  AudioLines,
  ChevronDown,
  Clapperboard,
  Copy,
  Film,
  FolderOpen,
  ImageIcon,
  Mic2,
  Minus,
  Plus,
  RotateCcw,
  Sparkles,
  Trash2,
  Wand2,
  X
} from 'lucide-react'
import type { Asset, Character, GenJob, GenKind, RecipeInfo } from '@shared/types'
import { errorText, invoke, streamLlm } from '@/lib/api'
import { sceneImageRequest } from '@/lib/characters'
import { defaultLlm } from '@/lib/llm'
import { cn, formatEta } from '@/lib/utils'
import { ease, spring, springSoft } from '@/lib/motion'
import { Page } from '@/components/shell/page'
import { AssetLightbox, AssetThumb } from '@/components/media'
import { Button, IconButton } from '@/components/ui/button'
import { Segmented } from '@/components/ui/controls'
import { Textarea } from '@/components/ui/input'
import { Badge, EmptyState, Field, ProgressBar, Spinner } from '@/components/ui/misc'
import { Popover, Tooltip } from '@/components/ui/overlay'
import { db, useCollection } from '@/stores/db'
import { isActive, useGen } from '@/stores/gen'
import { toast } from '@/stores/toast'
import { CastPicker, ParamControl } from './params'

// Voice panel is built separately; load it only if present.
const voiceModules = import.meta.glob<{ VoicePanel: ComponentType }>('./VoicePanel.tsx')
const VoicePanel = voiceModules['./VoicePanel.tsx'] ? lazy(() => voiceModules['./VoicePanel.tsx']().then((m) => ({ default: m.VoicePanel }))) : null

type Tab = 'image' | 'video' | 'audio' | 'voice'

/** Form state survives tab switches and navigation. */
interface FormState {
  recipe: Partial<Record<GenKind, string>>
  params: Record<string, Record<string, unknown>>
  prompt: Partial<Record<GenKind, string>>
  cast: string[]
  count: number
  set: (fn: (s: FormState) => Partial<FormState>) => void
}
const useForm = create<FormState>((set) => ({ recipe: {}, params: {}, prompt: {}, cast: [], count: 1, set: (fn) => set(fn) }))

const TAB_META: Record<Tab, { label: string; icon: React.ReactNode }> = {
  image: { label: 'Image', icon: <ImageIcon /> },
  video: { label: 'Video', icon: <Clapperboard /> },
  audio: { label: 'Audio', icon: <AudioLines /> },
  voice: { label: 'Voice', icon: <Mic2 /> }
}

const ENHANCE: Record<string, string> = {
  image:
    'Rewrite the user idea as a single rich image-generation prompt: subject, action, setting, composition/camera, lighting, colour palette and style. 60–110 words, no preamble, no quotes.',
  video:
    'Rewrite the user idea as a MiniMax H3 video prompt. Use 1–3 shots like "[Shot 1] … [Shot 2] At 00:02.5 the camera cuts to …" with camera moves and action, keep people and places consistent across shots, then end with "Soundscape:" describing ambience, sound effects and music, and put any spoken lines in quotes with the speaker. 90–160 words, no preamble.',
  audio:
    'Rewrite the user idea as a concise music/sound generation prompt: genre, mood, instruments, tempo (BPM), production style — or for a sound effect, a vivid physical description. Under 50 words, no preamble.'
}

function RecipePicker({ kind, recipes, value, onChange }: { kind: GenKind; recipes: RecipeInfo[]; value?: RecipeInfo; onChange: (id: string) => void }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const list = recipes.filter((r) => r.kind === kind)
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      className="w-[380px] p-1.5"
      trigger={
        <button className="group flex w-full items-center gap-3 rounded-xl border border-line bg-white/[0.03] p-2.5 text-left transition hover:border-line-strong hover:bg-white/[0.06]">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-grad text-white [&>svg]:size-4">{TAB_META[kind].icon}</span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-[13px] font-semibold">
              {value?.name ?? 'Choose a model'}
              {value && !value.available && <Badge tone="warning">Missing files</Badge>}
            </div>
            <div className="truncate text-[11.5px] text-fg-3">{value ? `${value.family} · ${value.estSeconds ? formatEta(value.estSeconds) : ''}` : ''}</div>
          </div>
          <ChevronDown className="size-4 text-fg-3 transition-transform duration-300 group-data-[state=open]:rotate-180" />
        </button>
      }
    >
      <div className="max-h-[420px] overflow-y-auto">
        {list.map((r) => (
          <button
            key={r.id}
            onClick={() => {
              onChange(r.id)
              setOpen(false)
            }}
            className={cn('relative flex w-full items-start gap-3 rounded-xl p-2.5 text-left transition-colors', value?.id === r.id ? 'text-fg' : 'text-fg-2 hover:bg-white/[0.05]')}
          >
            {value?.id === r.id && <motion.span layoutId="recipe-active" className="absolute inset-0 rounded-xl bg-white/[0.07]" transition={springSoft} />}
            <div className="relative min-w-0 flex-1">
              <div className="flex items-center gap-2 text-[13px] font-semibold text-fg">
                {r.name}
                {!r.builtin && <Badge tone="accent">Skill</Badge>}
                {!r.available && <Badge tone="warning">Not installed</Badge>}
              </div>
              <div className="mt-0.5 text-[11.5px] leading-snug text-fg-3">{r.description}</div>
              {!r.available && r.missing?.length ? <div className="mt-1 text-[11px] text-warning/90">Needs: {r.missing.join(', ')}</div> : null}
            </div>
            {r.estSeconds ? <span className="relative mt-0.5 text-[11px] text-fg-3 tabular-nums">{formatEta(r.estSeconds)}</span> : null}
          </button>
        ))}
      </div>
    </Popover>
  )
}

function JobCard({ job, onOpen, onReuse, onAnimate }: { job: GenJob; onOpen: (id: string) => void; onReuse: (j: GenJob) => void; onAnimate: (assetId: string) => void }): React.JSX.Element {
  const assets = useCollection('assets')
  const cancel = useGen((s) => s.cancel)
  const outs = job.outputs.map((id) => assets.find((a) => a.id === id)).filter(Boolean) as Asset[]
  const pct = job.progress?.max ? job.progress.value / job.progress.max : undefined
  const aspect = String(job.params.aspect ?? (job.kind === 'video' ? '16:9' : '1:1')).replace(':', ' / ')

  return (
    <motion.div layout initial={{ opacity: 0, scale: 0.97, y: 10 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.96 }} transition={spring} className="group relative">
      {outs.length ? (
        outs.map((a) => (
          <div key={a.id} style={{ aspectRatio: a.kind === 'audio' ? '16 / 7' : a.width && a.height ? `${a.width} / ${a.height}` : aspect }}>
          <AssetThumb asset={a} onClick={() => onOpen(a.id)} className="size-full" fit="cover">
            <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-3 pt-10 opacity-0 transition-opacity duration-300 group-hover:opacity-100">
              <div className="line-clamp-2 text-[11.5px] text-white/85">{a.prompt}</div>
            </div>
            <div className="absolute top-2 right-2 flex gap-1 opacity-0 transition-opacity duration-200 group-hover:opacity-100" onClick={(e) => e.stopPropagation()}>
              {a.kind === 'image' && (
                <Tooltip content="Animate with H3">
                  <IconButton label="Animate" size="sm" variant="glass" onClick={() => onAnimate(a.id)}>
                    <Film className="size-3.5" />
                  </IconButton>
                </Tooltip>
              )}
              <Tooltip content="Reuse settings">
                <IconButton label="Reuse" size="sm" variant="glass" onClick={() => onReuse(job)}>
                  <RotateCcw className="size-3.5" />
                </IconButton>
              </Tooltip>
              <Tooltip content="Show in folder">
                <IconButton label="Show in folder" size="sm" variant="glass" onClick={() => invoke('sys:showInFolder', a.path)}>
                  <FolderOpen className="size-3.5" />
                </IconButton>
              </Tooltip>
              <Tooltip content="Delete">
                <IconButton label="Delete" size="sm" variant="glass" onClick={() => void invoke('assets:delete', a.id, true)}>
                  <Trash2 className="size-3.5" />
                </IconButton>
              </Tooltip>
            </div>
          </AssetThumb>
          </div>
        ))
      ) : (
        <div className="relative overflow-hidden rounded-xl bg-white/[0.03] ring-1 ring-line" style={{ aspectRatio: job.kind === 'audio' ? '16 / 7' : aspect }}>
          {job.preview ? <img src={job.preview} className="absolute inset-0 size-full object-cover" /> : <div className="shimmer absolute inset-0" />}
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 to-transparent p-3 pt-12">
            {job.status === 'error' ? (
              <div className="flex items-start gap-2 text-[11.5px] text-danger">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                <span className="line-clamp-3">{job.error}</span>
              </div>
            ) : job.status === 'canceled' ? (
              <div className="text-[11.5px] text-white/60">Canceled</div>
            ) : (
              <>
                <div className="mb-1.5 flex items-center justify-between text-[11px] font-medium text-white/85">
                  <span>{job.status === 'queued' ? 'Queued' : job.progress ? `Step ${job.progress.value}/${job.progress.max}` : 'Loading models…'}</span>
                  <span className="tabular-nums">{pct !== undefined ? `${Math.round(pct * 100)}%` : ''}</span>
                </div>
                <ProgressBar value={pct} />
              </>
            )}
          </div>
          {isActive(job) && (
            <button onClick={() => void cancel(job.id)} className="absolute top-2 right-2 grid size-7 place-items-center rounded-lg bg-black/50 text-white/80 opacity-0 backdrop-blur transition group-hover:opacity-100 hover:text-white" title="Cancel">
              <X className="size-3.5" />
            </button>
          )}
          {!isActive(job) && (
            <button onClick={() => void invoke('db:delete', 'jobs', job.id).then(() => useGen.setState((s) => { const j = { ...s.jobs }; delete j[job.id]; return { jobs: j } }))} className="absolute top-2 right-2 grid size-7 place-items-center rounded-lg bg-black/50 text-white/80 opacity-0 backdrop-blur transition group-hover:opacity-100" title="Dismiss">
              <X className="size-3.5" />
            </button>
          )}
        </div>
      )}
    </motion.div>
  )
}

function GeneratorPanel({ kind }: { kind: GenKind }): React.JSX.Element {
  const navigate = useNavigate()
  const location = useLocation()
  const recipes = useGen((s) => s.recipes)
  const submit = useGen((s) => s.submit)
  const jobs = useGen((s) => s.jobs)
  const form = useForm()
  const [advanced, setAdvanced] = useState(false)
  const [busy, setBusy] = useState(false)
  const [enhancing, setEnhancing] = useState(false)
  const [lightbox, setLightbox] = useState<string | null>(null)
  const kindRecipes = recipes.filter((r) => r.kind === kind)
  const recipe = kindRecipes.find((r) => r.id === form.recipe[kind]) ?? kindRecipes.find((r) => r.available) ?? kindRecipes[0]
  const params = (recipe && form.params[recipe.id]) ?? {}
  const prompt = form.prompt[kind] ?? ''
  const promptSpec = recipe?.params.find((p) => p.type === 'prompt')
  const hasRefs = !!recipe?.params.some((p) => p.type === 'images')
  const setParam = (key: string, v: unknown): void => {
    if (!recipe) return
    form.set((s) => ({ params: { ...s.params, [recipe.id]: { ...(s.params[recipe.id] ?? {}), [key]: v } } }))
  }

  // Arrive with a cast from a character page.
  const incomingCast = (location.state as { cast?: string[] } | null)?.cast
  useEffect(() => {
    if (incomingCast?.length) form.set(() => ({ cast: incomingCast }))
  }, [incomingCast]) // eslint-disable-line react-hooks/exhaustive-deps

  // Arrive with a first frame from "Animate".
  const incoming = (location.state as { firstFrame?: string } | null)?.firstFrame
  const consumed = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (kind !== 'video' || !incoming || consumed.current === incoming) return
    consumed.current = incoming
    const h3 = kindRecipes.find((r) => r.id === 'h3-fast')
    if (h3) {
      form.set((s) => ({ recipe: { ...s.recipe, video: h3.id }, params: { ...s.params, [h3.id]: { ...(s.params[h3.id] ?? {}), firstFrame: incoming } } }))
    }
  }, [kind, incoming, kindRecipes, form])

  const feed = useMemo(() => Object.values(jobs).filter((j) => j.kind === kind).sort((a, b) => b.createdAt - a.createdAt).slice(0, 60), [jobs, kind])
  const running = feed.filter(isActive).length

  const enhance = async (): Promise<void> => {
    const llm = defaultLlm()
    if (!llm) return toast.error('No text model', 'Add one in Connectors to enhance prompts.')
    if (!prompt.trim()) return
    setEnhancing(true)
    const original = prompt
    try {
      const h = streamLlm({ connectorId: llm.connectorId, model: llm.model, system: ENHANCE[kind] ?? ENHANCE.image, messages: [{ role: 'user', content: original }], maxTokens: 400, temperature: 0.8 }, (full) =>
        form.set((s) => ({ prompt: { ...s.prompt, [kind]: full } }))
      )
      const r = await h.done
      form.set((s) => ({ prompt: { ...s.prompt, [kind]: r.text.trim() || original } }))
    } catch (err) {
      form.set((s) => ({ prompt: { ...s.prompt, [kind]: original } }))
      toast.error('Enhance failed', errorText(err))
    } finally {
      setEnhancing(false)
    }
  }

  const generate = async (): Promise<void> => {
    if (!recipe) return
    if (promptSpec && !prompt.trim()) return toast.info('Write a prompt first')
    setBusy(true)
    try {
      const cast = form.cast.map((id) => db.get('characters', id)).filter((c): c is Character => !!c)
      if (kind === 'image' && cast.length) {
        const req = sceneImageRequest({ prompt, characters: cast, aspect: String(params.aspect ?? '3:4') })
        await submit({ ...req, batch: form.count, label: undefined })
      } else {
        const p = { ...params }
        if (promptSpec) p[promptSpec.key] = prompt
        // Characters on a reference recipe: prepend their references.
        if (cast.length && hasRefs) {
          const refs = cast.flatMap((c) => (c.referenceAssetId ? [c.referenceAssetId] : c.sheet.front ? [c.sheet.front] : []))
          p.images = [...refs, ...((p.images as string[]) ?? [])]
        }
        await submit({ recipeId: recipe.id, params: p, batch: kind === 'image' ? form.count : 1, characterIds: form.cast })
      }
    } catch (err) {
      toast.error('Could not start', errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const reuse = (j: GenJob): void => {
    const r = recipes.find((x) => x.id === j.recipeId)
    if (!r) return
    const pKey = r.params.find((p) => p.type === 'prompt')?.key ?? 'prompt'
    const { [pKey]: pr, ...rest } = j.params
    form.set((s) => ({ recipe: { ...s.recipe, [kind]: r.id }, params: { ...s.params, [r.id]: { ...rest, seed: -1 } }, prompt: { ...s.prompt, [kind]: String(pr ?? '') } }))
  }

  // LoRA activation words go at the end of the prompt, without duplicates.
  const insertWords = (words: string[]): void => {
    const cur = form.prompt[kind] ?? ''
    const add = words.filter((w) => w && !cur.toLowerCase().includes(w.toLowerCase()))
    if (!add.length) return
    form.set((s) => ({ prompt: { ...s.prompt, [kind]: [cur.trim(), add.join(', ')].filter(Boolean).join(cur.trim() ? ', ' : '') } }))
  }

  const mainParams = recipe?.params.filter((p) => !p.advanced && p.type !== 'prompt') ?? []
  const advParams = recipe?.params.filter((p) => p.advanced) ?? []

  return (
    <div className="flex h-full min-h-0">
      {/* Controls */}
      <div className="flex w-[380px] shrink-0 flex-col border-r border-line">
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
          <RecipePicker kind={kind} recipes={recipes} value={recipe} onChange={(id) => form.set((s) => ({ recipe: { ...s.recipe, [kind]: id } }))} />
          {recipe && !recipe.available && (
            <div className="rounded-xl border border-warning/25 bg-warning/[0.07] p-3 text-[12px] text-fg-2">
              <div className="mb-1 flex items-center gap-1.5 font-semibold text-warning">
                <AlertTriangle className="size-3.5" /> Model files not found
              </div>
              {recipe.missing?.join(', ')}. Put them in your ComfyUI models folder (or set a models folder in Settings) and they'll be picked up automatically.
            </div>
          )}
          {promptSpec && (
            <Field
              label="Prompt"
              help={promptSpec.help}
              action={
                <button onClick={() => void enhance()} disabled={enhancing || !prompt.trim()} className="flex items-center gap-1 text-[11.5px] font-semibold text-accent transition hover:brightness-125 disabled:opacity-40">
                  {enhancing ? <Spinner className="size-3" /> : <Wand2 className="size-3" />} Enhance
                </button>
              }
            >
              <div className="glow-border rounded-[12px]" data-active={enhancing || undefined}>
                <Textarea
                  value={prompt}
                  minRows={5}
                  maxRows={14}
                  placeholder={kind === 'video' ? 'Describe the shots, motion and the sound…' : kind === 'audio' ? 'Describe the music or sound…' : 'Describe what you want to see…'}
                  onChange={(e) => form.set((s) => ({ prompt: { ...s.prompt, [kind]: e.target.value } }))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void generate()
                  }}
                />
              </div>
            </Field>
          )}
          {(kind === 'image' || hasRefs) && (
            <Field label="Cast" help={form.cast.length ? 'Locked references keep these characters on-model.' : undefined}>
              <CastPicker value={form.cast} onChange={(cast) => form.set(() => ({ cast }))} />
            </Field>
          )}
          {mainParams.map((spec) => (
            <ParamControl key={`${recipe!.id}-${spec.key}`} spec={spec} value={params[spec.key]} onChange={(v) => setParam(spec.key, v)} baseModelMatch={recipe!.baseModelMatch} onInsertWords={insertWords} />
          ))}
          {advParams.length > 0 && (
            <div className="rounded-xl border border-line">
              <button onClick={() => setAdvanced((a) => !a)} className="flex h-10 w-full items-center justify-between px-3.5 text-[12px] font-semibold text-fg-2 hover:text-fg">
                Advanced
                <ChevronDown className={cn('size-3.5 transition-transform duration-300', advanced && 'rotate-180')} />
              </button>
              <AnimatePresence initial={false}>
                {advanced && (
                  <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.3, ease }} className="overflow-hidden">
                    <div className="space-y-4 border-t border-line p-3.5">
                      {advParams.map((spec) => (
                        <ParamControl key={`${recipe!.id}-${spec.key}`} spec={spec} value={params[spec.key]} onChange={(v) => setParam(spec.key, v)} baseModelMatch={recipe!.baseModelMatch} onInsertWords={insertWords} />
                      ))}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 border-t border-line p-4">
          {kind === 'image' && (
            <div className="flex h-11 items-center rounded-xl border border-line">
              <button onClick={() => form.set((s) => ({ count: Math.max(1, s.count - 1) }))} className="grid h-full w-8 place-items-center text-fg-3 hover:text-fg">
                <Minus className="size-3.5" />
              </button>
              <span className="w-5 text-center text-[13px] font-semibold tabular-nums">{form.count}</span>
              <button onClick={() => form.set((s) => ({ count: Math.min(4, s.count + 1) }))} className="grid h-full w-8 place-items-center text-fg-3 hover:text-fg">
                <Plus className="size-3.5" />
              </button>
            </div>
          )}
          <Button variant="primary" size="lg" className="flex-1" loading={busy} disabled={!recipe || !recipe.available} icon={<Sparkles className="size-4" />} onClick={() => void generate()}>
            Generate
            {recipe?.estSeconds ? <span className="ml-1 text-[12px] font-medium opacity-75">{formatEta(recipe.estSeconds)}</span> : null}
          </Button>
        </div>
      </div>

      {/* Results */}
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="sticky top-0 z-10 flex h-12 items-center justify-between border-b border-line bg-[color-mix(in_oklab,var(--panel-solid)_80%,transparent)] px-5 backdrop-blur-xl">
          <div className="text-[12.5px] font-medium text-fg-2">
            {feed.length ? `${feed.length} generation${feed.length === 1 ? '' : 's'}` : 'Your generations'}
            {running > 0 && <span className="ml-2 text-accent">· {running} running</span>}
          </div>
          {feed.some((j) => !isActive(j)) && (
            <Button size="sm" variant="ghost" icon={<Copy className="size-3.5" />} onClick={() => navigate('/assets')}>
              Open library
            </Button>
          )}
        </div>
        {feed.length === 0 ? (
          <EmptyState
            className="h-[calc(100%-48px)]"
            icon={TAB_META[kind].icon}
            title={kind === 'video' ? 'Direct your first shot' : kind === 'audio' ? 'Make some noise' : 'Paint your first image'}
            body={kind === 'video' ? 'MiniMax H3 renders video with synced dialogue, effects and music on your GPU.' : 'Results appear here as they render, with live previews.'}
          />
        ) : (
          <div className={cn('grid gap-3 p-5', kind === 'video' ? 'grid-cols-2' : kind === 'audio' ? 'grid-cols-3' : 'grid-cols-3 xl:grid-cols-4')}>
            <AnimatePresence initial={false} mode="popLayout">
              {feed.map((j) => (
                <JobCard key={j.id} job={j} onOpen={setLightbox} onReuse={reuse} onAnimate={(id) => navigate('/generate/video', { state: { firstFrame: id } })} />
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>
      <AssetLightbox assetId={lightbox} onClose={() => setLightbox(null)} />
    </div>
  )
}

export function GeneratePage(): React.JSX.Element {
  const { kind = 'image' } = useParams()
  const navigate = useNavigate()
  const tab = (['image', 'video', 'audio', 'voice'].includes(kind) ? kind : 'image') as Tab
  useCollection('characters')
  useCollection('assets')

  return (
    <Page scroll={false} className="flex flex-col">
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-line px-5">
        <Segmented value={tab} onChange={(t) => navigate(`/generate/${t}`)} items={(Object.keys(TAB_META) as Tab[]).map((t) => ({ value: t, label: TAB_META[t].label, icon: TAB_META[t].icon }))} />
        <div className="text-[12px] text-fg-3">Ctrl+Enter to generate</div>
      </div>
      <div className="relative min-h-0 flex-1">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={tab} className="absolute inset-0" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.28, ease }}>
            {tab === 'voice' ? (
              VoicePanel ? (
                <Suspense fallback={<div className="grid h-full place-items-center"><Spinner /></div>}>
                  <VoicePanel />
                </Suspense>
              ) : (
                <EmptyState className="h-full" icon={<Mic2 />} title="Voice studio is being set up" body="Local Qwen3-TTS cloning plus ElevenLabs, OpenAI and Azure voices." />
              )
            ) : (
              <GeneratorPanel kind={tab} />
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </Page>
  )
}
