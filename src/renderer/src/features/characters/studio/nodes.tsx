// Character Studio nodes: the card chrome shared by the canvas and the phone's step list, and each
// node's controls. Settings save straight into the workflow doc; runs live in run.ts.
import { createContext, lazy, Suspense, useContext, useEffect, useMemo, useRef, useState, type ComponentType } from 'react'
import { useNavigate } from 'react-router'
import { AnimatePresence, motion } from 'motion/react'
import { AlertTriangle, Boxes, Check, Copy, ImagePlus, Layers, LayoutGrid, Lightbulb, Lock, Maximize2, Mic2, MoreHorizontal, Play, ScanFace, Sparkles, Trash2, UserRoundCheck, Wand2 } from 'lucide-react'
import type { CharacterFlow, CharacterVoice, FlowNode, FlowNodeKind, ID } from '@shared/types'
import { errorText, thumbUrl } from '@/lib/api'
import { slotsFor, takesImages } from '@/lib/characters'
import { cn } from '@/lib/utils'
import { ease, spring } from '@/lib/motion'
import { ModelFilePicker, useLocalModels } from '@/components/model-library'
import { MediaSlot } from '@/components/media'
import { Button } from '@/components/ui/button'
import { Segmented, Slider, Switch } from '@/components/ui/controls'
import { Input, Textarea } from '@/components/ui/input'
import { ProgressRing, Spinner } from '@/components/ui/misc'
import { Menu, MenuItem, MenuSeparator, Select, Tooltip } from '@/components/ui/overlay'
import { db, useDoc } from '@/stores/db'
import { isActive, useGen } from '@/stores/gen'
import { toast } from '@/stores/toast'
import { useSlotJobs } from '../sheet'
import { inputsOf, PORT_COLOR, SPECS, type Brief, type ModelValue, type PortSpec } from './graph'
import { expandIdea, patchNode, runNode, useRuns } from './run'

type VoicePickerProps = { value: CharacterVoice | undefined; onChange: (v: CharacterVoice) => void; characterName?: string }
const pickerModules = import.meta.glob<{ VoicePicker: ComponentType<VoicePickerProps> }>('../../../components/voice-picker.tsx')
const pickerLoader = Object.values(pickerModules)[0]
const VoicePicker = pickerLoader ? lazy(() => pickerLoader().then((m) => ({ default: m.VoicePicker }))) : null

export const NODE_ICON: Record<FlowNodeKind, React.ReactNode> = {
  idea: <Lightbulb />,
  reference: <ImagePlus />,
  model: <Boxes />,
  lora: <Layers />,
  portrait: <ScanFace />,
  edit: <Wand2 />,
  voice: <Mic2 />,
  character: <UserRoundCheck />,
  sheet: <LayoutGrid />
}

/** Icon chip tint per group — theme accents only. */
const GROUP_TINT: Record<string, string> = {
  Start: 'color-mix(in oklab, var(--fg) 14%, transparent)',
  Look: 'color-mix(in oklab, var(--accent-2) 26%, transparent)',
  Make: 'color-mix(in oklab, var(--accent) 26%, transparent)',
  Finish: 'color-mix(in oklab, var(--accent) 16%, color-mix(in oklab, var(--accent-2) 18%, transparent))'
}

export interface StudioCtx {
  flow: CharacterFlow
  openAsset: (id: ID) => void
  removeNode: (id: string) => void
  duplicateNode: (id: string) => void
}

export const FlowContext = createContext<StudioCtx | null>(null)

export function useStudio(): StudioCtx {
  const c = useContext(FlowContext)
  if (!c) throw new Error('Studio context missing')
  return c
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** A text setting with local state, saved to the doc after a short pause (and kept in sync with outside changes). */
function useText(node: FlowNode, key: string): [string, (v: string) => void] {
  const { flow } = useStudio()
  const outside = str(node.data[key])
  const [v, setV] = useState(outside)
  const sent = useRef(outside)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => {
    if (outside !== sent.current) {
      sent.current = outside
      setV(outside)
    }
  }, [outside])
  useEffect(() => () => clearTimeout(timer.current), [])
  return [
    v,
    (next) => {
      setV(next)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => {
        sent.current = next
        void patchNode(flow.id, node.id, { [key]: next })
      }, 350)
    }
  ]
}

function useSet(node: FlowNode): (patch: Record<string, unknown>) => void {
  const { flow } = useStudio()
  return (patch) => void patchNode(flow.id, node.id, patch)
}

function Label({ children, className }: { children: React.ReactNode; className?: string }): React.JSX.Element {
  return <div className={cn('mb-1.5 text-[10.5px] font-semibold tracking-[0.08em] text-fg-3 uppercase', className)}>{children}</div>
}

// ─── Live run state ──────────────────────────────────────────────────────────

export function useNodeRun(nodeId: string): { status?: 'running' | 'done' | 'error'; error?: string; progress?: number; previews: string[]; queued: number } {
  const run = useRuns((s) => s.nodes[nodeId])
  const jobs = useGen((s) => s.jobs)
  return useMemo(() => {
    const list = (run?.jobIds ?? []).map((id) => jobs[id]).filter(Boolean)
    const active = list.filter(isActive)
    const pcts = list.map((j) => (j.status === 'done' ? 1 : j.progress?.max ? j.progress.value / j.progress.max : 0))
    return {
      status: run?.status,
      error: run?.error,
      progress: list.length ? pcts.reduce((a, b) => a + b, 0) / list.length : undefined,
      previews: active.map((j) => j.preview).filter((p): p is string => !!p),
      queued: active.length
    }
  }, [run, jobs])
}

function StatusBadge({ node }: { node: FlowNode }): React.JSX.Element | null {
  const run = useNodeRun(node.id)
  if (run.status === 'running') return run.progress !== undefined && run.progress > 0 ? <ProgressRing value={run.progress} size={18} /> : <Spinner className="size-3.5 text-accent" />
  if (run.status === 'error')
    return (
      <Tooltip content={run.error}>
        <span className="grid size-5 place-items-center rounded-md bg-danger/15 text-danger">
          <AlertTriangle className="size-3" />
        </span>
      </Tooltip>
    )
  if (run.status === 'done') return <Check className="size-3.5 text-success" />
  return null
}

// ─── Card chrome ─────────────────────────────────────────────────────────────

/** Header (title, status, run + menu) and body. `ports` renders the canvas handles; the step list passes source pickers instead. */
export function NodeCard({ node, inputs, outputs, className, dragHandle }: { node: FlowNode; inputs?: React.ReactNode; outputs?: React.ReactNode; className?: string; dragHandle?: boolean }): React.JSX.Element {
  const spec = SPECS[node.kind]
  const { flow, removeNode, duplicateNode } = useStudio()
  const run = useNodeRun(node.id)
  const running = run.status === 'running'
  const go = (): void => {
    runNode(flow.id, node.id).catch((err) => toast.error(`${spec.title} didn't run`, errorText(err)))
  }
  return (
    <div className={cn('glass-strong hairline relative rounded-[18px] shadow-[0_24px_60px_-28px_rgb(0_0_0/0.85)]', running && 'ring-1 ring-[color-mix(in_oklab,var(--accent)_55%,transparent)]', className)}>
      <div className={cn('flex items-center gap-2 border-b border-line px-3 py-2.5', dragHandle && 'node-drag cursor-grab active:cursor-grabbing')}>
        <span className="grid size-7 shrink-0 place-items-center rounded-lg border border-line text-fg [&>svg]:size-3.5" style={{ background: GROUP_TINT[spec.group] }}>
          {NODE_ICON[node.kind]}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] leading-tight font-semibold">{spec.title}</div>
          <div className="truncate text-[10.5px] text-fg-3">{spec.group}</div>
        </div>
        <StatusBadge node={node} />
        {spec.runs && (
          <Tooltip content={running ? 'Running…' : `Run ${spec.title.toLowerCase()}`}>
            <button onClick={go} disabled={running} className="nodrag grid size-7 place-items-center rounded-lg text-fg-2 transition hover:bg-white/[0.08] hover:text-fg disabled:opacity-40 max-md:size-9" aria-label={`Run ${spec.title}`}>
              <Play className="size-3.5 fill-current" />
            </button>
          </Tooltip>
        )}
        <Menu
          align="end"
          trigger={
            <button className="nodrag grid size-7 place-items-center rounded-lg text-fg-3 transition hover:bg-white/[0.08] hover:text-fg max-md:size-9" aria-label="Node options">
              <MoreHorizontal className="size-4" />
            </button>
          }
        >
          {spec.runs && (
            <MenuItem icon={<Play />} onSelect={go} disabled={running}>
              Run this step
            </MenuItem>
          )}
          <MenuItem icon={<Copy />} onSelect={() => duplicateNode(node.id)}>
            Duplicate
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon={<Trash2 />} danger onSelect={() => removeNode(node.id)}>
            Delete
          </MenuItem>
        </Menu>
      </div>
      {inputs}
      <div className="nodrag space-y-3 px-3 py-3 [&_.label-caps]:text-[10.5px]">
        <NodeBody node={node} />
        <AnimatePresence initial={false}>
          {run.status === 'error' && run.error && (
            <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="rounded-lg border border-danger/25 bg-danger/10 px-2.5 py-2 text-[11.5px] leading-snug text-danger">
              {run.error}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      {outputs}
    </div>
  )
}

/** A port label row (the canvas puts a handle on its edge). */
export function PortRow({ port, dir, connected, children }: { port: PortSpec; dir: 'in' | 'out'; connected?: boolean; children?: React.ReactNode }): React.JSX.Element {
  return (
    <div className={cn('relative flex h-7 items-center gap-2 px-3 text-[11.5px]', dir === 'out' && 'flex-row-reverse text-right')}>
      <span className="size-1.5 shrink-0 rounded-full" style={{ background: PORT_COLOR[port.type], opacity: connected ? 1 : 0.45 }} />
      <span className={cn('font-medium', connected ? 'text-fg-2' : 'text-fg-3')}>
        {port.label}
        {port.required && dir === 'in' && !connected && <span className="text-accent"> *</span>}
      </span>
      {children}
    </div>
  )
}

// ─── Bodies ──────────────────────────────────────────────────────────────────

function NodeBody({ node }: { node: FlowNode }): React.JSX.Element {
  switch (node.kind) {
    case 'idea':
      return <IdeaBody node={node} />
    case 'reference':
      return <ReferenceBody node={node} />
    case 'model':
      return <ModelBody node={node} />
    case 'lora':
      return <LoraBody node={node} />
    case 'portrait':
      return <PortraitBody node={node} />
    case 'edit':
      return <EditBody node={node} />
    case 'voice':
      return <VoiceBody node={node} />
    case 'character':
      return <CharacterBody node={node} />
    case 'sheet':
      return <SheetBody node={node} />
  }
}

function IdeaBody({ node }: { node: FlowNode }): React.JSX.Element {
  const { flow } = useStudio()
  const [concept, setConcept] = useText(node, 'concept')
  const [name, setName] = useText(node, 'name')
  const [appearance, setAppearance] = useText(node, 'appearance')
  const [personality, setPersonality] = useText(node, 'personality')
  const [voice, setVoice] = useText(node, 'voice')
  const [busy, setBusy] = useState(false)
  const expand = async (): Promise<void> => {
    setBusy(true)
    try {
      // Let pending keystrokes land first.
      await patchNode(flow.id, node.id, { concept, name })
      await expandIdea(flow.id, node.id)
    } catch (err) {
      toast.error("Couldn't fill in the details", errorText(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <div>
        <Label>Idea</Label>
        <Textarea value={concept} onChange={(e) => setConcept(e.target.value)} minRows={2} placeholder="A retired sky-pirate who now runs a floating tea shop" />
      </div>
      <Button size="sm" className="w-full max-md:h-10" icon={<Sparkles className="size-3.5" />} loading={busy} disabled={!concept.trim() && !name.trim()} onClick={() => void expand()}>
        {appearance ? 'Reimagine with AI' : 'Fill in with AI'}
      </Button>
      <div>
        <Label>Name</Label>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" />
      </div>
      <div>
        <Label>Appearance</Label>
        <Textarea value={appearance} onChange={(e) => setAppearance(e.target.value)} minRows={3} placeholder="Age, build, face, hair, outfit, marks…" />
      </div>
      <div>
        <Label>Personality</Label>
        <Textarea value={personality} onChange={(e) => setPersonality(e.target.value)} minRows={2} placeholder="Temperament, history, what they want" />
      </div>
      <div>
        <Label>Voice</Label>
        <Input value={voice} onChange={(e) => setVoice(e.target.value)} placeholder="Low, unhurried, faint northern accent" />
      </div>
    </>
  )
}

function ReferenceBody({ node }: { node: FlowNode }): React.JSX.Element {
  const set = useSet(node)
  return <MediaSlot kind="image" value={str(node.data.assetId) || undefined} onChange={(assetId) => set({ assetId: assetId ?? null })} label="Add a reference image" aspect="aspect-[4/5] max-md:aspect-[4/3]" />
}

function useImageRecipes(): ReturnType<typeof useGen.getState>['recipes'] {
  const recipes = useGen((s) => s.recipes)
  return useMemo(() => recipes.filter((r) => r.kind === 'image'), [recipes])
}

function ModelBody({ node }: { node: FlowNode }): React.JSX.Element {
  const set = useSet(node)
  const recipes = useImageRecipes()
  const recipeId = str(node.data.recipeId)
  const recipe = recipes.find((r) => r.id === recipeId)
  const modelParam = recipe?.params.find((p) => p.type === 'model')
  return (
    <>
      <div>
        <Label>Model family</Label>
        <Select
          value={recipeId || 'auto'}
          onChange={(v) => set({ recipeId: v === 'auto' ? '' : v, model: '' })}
          options={[
            { value: 'auto', label: 'Automatic', hint: 'Best installed' },
            ...recipes.map((r) => ({ value: r.id, label: r.name, hint: !r.available ? 'Not installed' : takesImages(r) ? 'Text + refs' : 'Text', disabled: !r.available && r.id !== recipeId }))
          ]}
        />
      </div>
      {recipe && modelParam && (
        <div>
          <Label>{modelParam.label === 'Model' ? 'Checkpoint' : modelParam.label}</Label>
          <ModelFilePicker folder={modelParam.folder ?? 'diffusion_models'} value={str(node.data.model) || undefined} onChange={(m) => set({ model: m ?? '' })} baseModelMatch={recipe.baseModelMatch} />
        </div>
      )}
      <p className="text-[11.5px] leading-snug text-fg-3">{recipe ? recipe.description : 'Stitch picks the best installed model for each step: a text-to-image model for portraits, an edit model for sheets and edits.'}</p>
    </>
  )
}

function LoraBody({ node }: { node: FlowNode }): React.JSX.Element {
  const { flow } = useStudio()
  const set = useSet(node)
  const { models } = useLocalModels('loras')
  const upstream = inputsOf(flow, node).model as ModelValue | undefined
  const recipe = useGen((s) => s.recipes.find((r) => r.id === upstream?.recipeId))
  const name = str(node.data.name)
  const strength = typeof node.data.strength === 'number' ? node.data.strength : 0.8
  const words = Array.isArray(node.data.words) ? (node.data.words as string[]) : []
  return (
    <>
      <div>
        <Label>LoRA</Label>
        <ModelFilePicker
          folder="loras"
          value={name || undefined}
          placeholder="Choose a LoRA"
          baseModelMatch={recipe?.baseModelMatch}
          onChange={(n) => set({ name: n ?? '', words: models.find((m) => m.name === n)?.meta?.trainedWords?.slice(0, 8) ?? [] })}
        />
      </div>
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <Label className="mb-0">Strength</Label>
          <span className="font-mono text-[11px] text-fg-2 tabular-nums">{strength.toFixed(2)}</span>
        </div>
        <Slider value={strength} min={-2} max={2} step={0.05} onChange={(v) => set({ strength: Math.round(v * 100) / 100 })} className="max-md:h-8" />
      </div>
      {words.length > 0 && (
        <div className="space-y-2">
          <label className="flex items-center justify-between gap-2 text-[12px] text-fg-2">
            Add trigger words
            <Switch checked={node.data.useWords !== false} onChange={(v) => set({ useWords: v })} />
          </label>
          <div className="flex flex-wrap gap-1">
            {words.map((w) => (
              <span key={w} className="rounded-md border border-line bg-white/[0.04] px-1.5 py-0.5 font-mono text-[10.5px] text-fg-2">
                {w}
              </span>
            ))}
          </div>
        </div>
      )}
      {!upstream && <p className="text-[11.5px] text-fg-3">Connect an Image model (or another LoRA) into this one.</p>}
    </>
  )
}

function Results({ node }: { node: FlowNode }): React.JSX.Element | null {
  const { flow, openAsset } = useStudio()
  const run = useNodeRun(node.id)
  const results = Array.isArray(node.data.results) ? (node.data.results as ID[]) : []
  const selected = str(node.data.selected) || results[0]
  const running = run.status === 'running'
  if (!results.length && !running) return null
  const tiles = running ? Math.max(1, run.queued) : 0
  return (
    <div>
      <Label>{results.length ? 'Pick one' : 'Rendering'}</Label>
      <div className="grid grid-cols-2 gap-1.5">
        {Array.from({ length: tiles }).map((_, i) => (
          <div key={`p${i}`} className="relative aspect-[3/4] overflow-hidden rounded-lg border border-[color-mix(in_oklab,var(--accent)_40%,transparent)] bg-white/[0.03]">
            {run.previews[i] ? <img src={run.previews[i]} className="absolute inset-0 size-full object-cover opacity-80" /> : <div className="sheen absolute inset-0" />}
            <div className="absolute inset-0 grid place-items-center">
              <ProgressRing value={run.progress} size={26} />
            </div>
          </div>
        ))}
        {results.slice(0, 8).map((id) => (
          <ResultTile key={id} id={id} picked={id === selected} onPick={() => void patchNode(flow.id, node.id, { selected: id })} onOpen={() => openAsset(id)} />
        ))}
      </div>
    </div>
  )
}

function ResultTile({ id, picked, onPick, onOpen }: { id: ID; picked: boolean; onPick: () => void; onOpen: () => void }): React.JSX.Element | null {
  const asset = useDoc('assets', id)
  if (!asset) return null
  return (
    <motion.button
      layout
      transition={spring}
      onClick={onPick}
      onDoubleClick={onOpen}
      className={cn('group relative aspect-[3/4] overflow-hidden rounded-lg border transition-[border-color,box-shadow] duration-300', picked ? 'border-transparent shadow-[0_0_0_2px_var(--accent)]' : 'border-line hover:border-line-strong')}
    >
      <motion.img initial={{ opacity: 0, scale: 1.04 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.5, ease }} src={thumbUrl(asset.path, 360)} className="absolute inset-0 size-full object-cover" />
      <AnimatePresence>
        {picked && (
          <motion.span initial={{ scale: 0.5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.5, opacity: 0 }} transition={spring} className="absolute top-1.5 left-1.5 grid size-5 place-items-center rounded-full bg-grad text-white shadow">
            <Check className="size-3" />
          </motion.span>
        )}
      </AnimatePresence>
      <span
        role="button"
        onClick={(e) => {
          e.stopPropagation()
          onOpen()
        }}
        className="absolute top-1.5 right-1.5 grid size-6 place-items-center rounded-md bg-black/55 text-white opacity-0 backdrop-blur transition group-hover:opacity-100 max-md:size-7 max-md:opacity-100"
      >
        <Maximize2 className="size-3" />
      </span>
    </motion.button>
  )
}

const COUNTS = [
  { value: '1', label: '1' },
  { value: '2', label: '2' },
  { value: '4', label: '4' }
]

function PortraitBody({ node }: { node: FlowNode }): React.JSX.Element {
  const { flow } = useStudio()
  const set = useSet(node)
  const [style, setStyle] = useText(node, 'style')
  const inputs = inputsOf(flow, node)
  const mv = inputs.model as ModelValue | undefined
  const recipe = useGen((s) => s.recipes.find((r) => r.id === mv?.recipeId))
  const refIgnored = !!inputs.image && !!recipe && !takesImages(recipe)
  return (
    <>
      <div className="grid grid-cols-[1fr_auto] gap-2">
        <div>
          <Label>Framing</Label>
          <Segmented
            size="sm"
            className="w-full [&>button]:flex-1 max-md:[&>button]:h-8"
            value={str(node.data.framing) || 'half'}
            onChange={(framing) => set({ framing })}
            items={[
              { value: 'head', label: 'Head' },
              { value: 'half', label: 'Half' },
              { value: 'full', label: 'Full' }
            ]}
          />
        </div>
        <div>
          <Label>Count</Label>
          <Segmented size="sm" className="max-md:[&>button]:h-8" value={String(node.data.count ?? 4)} onChange={(v) => set({ count: Number(v) })} items={COUNTS} />
        </div>
      </div>
      <div className="grid grid-cols-[1fr_92px] gap-2">
        <div>
          <Label>Style</Label>
          <Input value={style} onChange={(e) => setStyle(e.target.value)} placeholder="Painterly fantasy, 35mm film…" />
        </div>
        <div>
          <Label>Shape</Label>
          <Select
            value={str(node.data.aspect) || '3:4'}
            onChange={(aspect) => set({ aspect })}
            options={['3:4', '2:3', '1:1', '9:16'].map((a) => ({ value: a, label: a }))}
          />
        </div>
      </div>
      {refIgnored && <p className="text-[11.5px] leading-snug text-warning">{recipe?.name} can't use reference images — the reference is ignored. Pick an edit model to keep the face.</p>}
      <Results node={node} />
    </>
  )
}

function EditBody({ node }: { node: FlowNode }): React.JSX.Element {
  const set = useSet(node)
  const [instruction, setInstruction] = useText(node, 'instruction')
  return (
    <>
      <div>
        <Label>Change</Label>
        <Textarea value={instruction} onChange={(e) => setInstruction(e.target.value)} minRows={2} placeholder="Give them a red leather jacket and short silver hair" />
      </div>
      <div className="flex items-center justify-between gap-2">
        <Label className="mb-0">Versions</Label>
        <Segmented size="sm" className="max-md:[&>button]:h-8" value={String(node.data.count ?? 2)} onChange={(v) => set({ count: Number(v) })} items={COUNTS} />
      </div>
      <Results node={node} />
    </>
  )
}

function VoiceBody({ node }: { node: FlowNode }): React.JSX.Element {
  const { flow } = useStudio()
  const set = useSet(node)
  const brief = useMemo(() => {
    const e = flow.edges.find((x) => x.fromPort === 'voice' && x.from === node.id)
    const char = e ? flow.nodes.find((n) => n.id === e.to) : undefined
    return char ? (inputsOf(flow, char).brief as Brief | undefined) : undefined
  }, [flow, node.id])
  if (!VoicePicker) return <div className="rounded-xl border border-dashed border-line px-3 py-3 text-[12px] text-fg-3">Voice tools are being set up.</div>
  return (
    <Suspense fallback={<Spinner />}>
      <VoicePicker value={node.data.voice as CharacterVoice | undefined} onChange={(voice) => set({ voice })} characterName={brief?.name || 'New character'} />
    </Suspense>
  )
}

function CharacterBody({ node }: { node: FlowNode }): React.JSX.Element {
  const { flow } = useStudio()
  const navigate = useNavigate()
  const c = useDoc('characters', str(node.data.characterId) || undefined)
  const inputs = inputsOf(flow, node)
  const brief = inputs.brief as Brief | undefined
  const refId = c?.referenceAssetId ?? (str(inputs.image) || undefined)
  const ref = useDoc('assets', refId)
  return (
    <div className="flex items-center gap-3">
      <div className="relative size-16 shrink-0 overflow-hidden rounded-xl border border-line bg-white/[0.03]">
        {ref ? <img src={thumbUrl(ref.path, 200)} className="size-full object-cover" /> : <UserRoundCheck className="absolute inset-0 m-auto size-5 text-fg-3" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13.5px] font-semibold">{c?.name ?? (brief?.name || 'New character')}</div>
        <div className="text-[11.5px] text-fg-3">{c ? (c.locked ? 'Locked in your cast' : 'In your cast') : 'Run to add them to your cast'}</div>
        {c && (
          <button onClick={() => navigate(`/characters/${c.id}`)} className="mt-1 text-[11.5px] font-semibold text-accent hover:brightness-125 max-md:py-1">
            Open character →
          </button>
        )}
      </div>
    </div>
  )
}

function SheetBody({ node }: { node: FlowNode }): React.JSX.Element {
  const { flow, openAsset } = useStudio()
  const set = useSet(node)
  const id = str(inputsOf(flow, node).character) || undefined
  const c = useDoc('characters', id)
  const jobs = useSlotJobs(id)
  const detail = node.data.detail === 'compact' ? 'compact' : 'studio'
  const slots = slotsFor(detail)
  const filled = c ? slots.filter((s) => c.sheet[s.slot]).length : 0
  const rendering = Object.values(jobs).filter((j) => j && isActive(j)).length
  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <Segmented
          size="sm"
          className="max-md:[&>button]:h-8"
          value={detail}
          onChange={(v) => set({ detail: v })}
          items={[
            { value: 'compact', label: '9 angles' },
            { value: 'studio', label: 'Full studio' }
          ]}
        />
        <span className="text-[11.5px] text-fg-3 tabular-nums">
          {filled}/{slots.length}
        </span>
      </div>
      {c ? (
        <>
          <div className="grid grid-cols-5 gap-1">
            {slots.slice(0, 10).map((s) => (
              <SheetThumb key={s.slot} id={c.sheet[s.slot]} busy={!!jobs[s.slot] && isActive(jobs[s.slot]!)} onOpen={openAsset} />
            ))}
          </div>
          <div className="flex items-center gap-2">
            {rendering > 0 && (
              <span className="flex items-center gap-1.5 text-[11.5px] text-fg-2">
                <Spinner className="size-3" /> {rendering} rendering
              </span>
            )}
            <div className="flex-1" />
            {filled >= Math.min(3, slots.length) && !c.locked && (
              <Button size="sm" variant="secondary" className="max-md:h-9" icon={<Lock className="size-3" />} onClick={() => void db.patch('characters', c.id, { locked: true, updatedAt: Date.now() })}>
                Lock
              </Button>
            )}
          </div>
        </>
      ) : (
        <p className="text-[11.5px] leading-snug text-fg-3">Renders every angle{detail === 'studio' ? ', expression and lighting setup' : ''} from the character's reference once they're saved.</p>
      )}
    </>
  )
}

function SheetThumb({ id, busy, onOpen }: { id?: ID; busy: boolean; onOpen: (id: ID) => void }): React.JSX.Element {
  const a = useDoc('assets', id)
  return (
    <button disabled={!a} onClick={() => a && onOpen(a.id)} className={cn('relative aspect-square overflow-hidden rounded-md border bg-white/[0.03]', busy ? 'border-[color-mix(in_oklab,var(--accent)_50%,transparent)]' : 'border-line')}>
      {a && <img src={thumbUrl(a.path, 120)} className="absolute inset-0 size-full object-cover" />}
      {busy && <div className="sheen absolute inset-0" />}
    </button>
  )
}

/** Short summary of what a node holds — used by pickers in the step list. */
export function nodeLabel(flow: CharacterFlow, id: string): string {
  const n = flow.nodes.find((x) => x.id === id)
  if (!n) return 'Missing'
  const same = flow.nodes.filter((x) => x.kind === n.kind)
  const idx = same.length > 1 ? ` ${same.indexOf(n) + 1}` : ''
  const d = n.data
  const hint = n.kind === 'idea' ? str(d.name) : n.kind === 'lora' ? str(d.name).split('/').pop()?.replace(/\.(safetensors|ckpt|pt)$/i, '') : ''
  return `${SPECS[n.kind].title}${idx}${hint ? ` · ${hint}` : ''}`
}

