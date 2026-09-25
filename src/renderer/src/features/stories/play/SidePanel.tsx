// Right side panel: ADVENTURE (plot / cards / details) and GAMEPLAY
// (AI models / appearance).
import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import {
  Accessibility,
  Brain,
  Film,
  Clapperboard,
  FlaskConical,
  ImageIcon,
  Mic,
  MousePointerClick,
  ScanSearch,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  X
} from 'lucide-react'
import type { Adventure, AdventureSettings, GenKind, LoraRef, Scenario } from '@shared/types'
import { LoraStack, ModelFilePicker } from '@/components/model-library'
import { Button, IconButton } from '@/components/ui/button'
import { Segmented, SliderField, SwitchRow, Tabs } from '@/components/ui/controls'
import { Input } from '@/components/ui/input'
import { Badge, Field, StatusDot } from '@/components/ui/misc'
import { Select } from '@/components/ui/overlay'
import { VoicePicker } from '@/components/voice-picker'
import { cn } from '@/lib/utils'
import { ease, spring } from '@/lib/motion'
import { contextWindow, LLM_KIND_LABEL, modelLabel, type LlmChoice } from '@/lib/llm'
import { db } from '@/stores/db'
import { useGen } from '@/stores/gen'
import { DEFAULT_CONTEXT, DEFAULT_RESPONSE, SAFETY_TEXT } from '../engine/defaults'
import type { StoryInfo } from '../engine/ai'
import { storyText } from '../engine/text'
import { saveFile } from '../engine/io'
import { StoryCardsBoard } from '../components/cards'
import { PlotComponentsEditor, PlotCard } from '../components/plot'
import { StoryDetails } from '../components/details'
import type { StoryChange } from '../hooks'
import { TEXT_STYLES, THEMES, type ThemeDef } from '../themes'
import { Accordion } from './bits'
import { ModelChooser } from './ModelChooser'

type Change = (p: Partial<Adventure> | ((cur: Adventure) => Partial<Adventure>)) => void

// ─── Adventure tab ───────────────────────────────────────────────────────────

function Memories({ adv, change }: { adv: Adventure; change: Change }): React.JSX.Element | null {
  if (!adv.settings.memoryBank && !adv.memories.length) return null
  return (
    <PlotCard title="Memory bank" icon={<Brain />} help={adv.memories.length ? 'Durable facts the AI recalls when they become relevant.' : 'Every few turns the AI saves durable facts here.'} action={<Badge>{adv.memories.length}</Badge>}>
      <div className="flex max-h-[260px] flex-col gap-1.5 overflow-y-auto">
        <AnimatePresence initial={false}>
          {[...adv.memories].reverse().map((m) => (
            <motion.div key={m.id} layout initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, height: 0 }} className="group/m flex items-start gap-2 rounded-lg bg-white/[0.03] px-2.5 py-2 text-[12px] leading-snug text-fg-2">
              <span className="mt-1.5 size-1 shrink-0 rounded-full bg-accent" />
              <span className="flex-1">{m.text}</span>
              <button onClick={() => change((cur) => ({ memories: cur.memories.filter((x) => x.id !== m.id) }))} className="text-fg-3 opacity-0 transition group-hover/m:opacity-100 hover:text-danger">
                <Trash2 className="size-3" />
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </PlotCard>
  )
}

function AdventureTab({ adv, change, scenario, info, onStudio, studioBusy }: { adv: Adventure; change: Change; scenario?: Scenario; info: StoryInfo; onStudio: () => void; studioBusy: boolean }): React.JSX.Element {
  const [sub, setSub] = useState<'plot' | 'cards' | 'details'>('plot')
  const mediaCount = adv.actions.reduce((n, a) => n + (a.media?.length ?? 0), 0)
  return (
    <div className="flex flex-col gap-4">
      <Segmented
        caps
        size="sm"
        className="self-start"
        value={sub}
        onChange={setSub}
        items={[
          { value: 'plot', label: 'Plot' },
          { value: 'cards', label: 'Story cards', count: adv.cards.length },
          { value: 'details', label: 'Details' }
        ]}
      />
      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={sub} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.22, ease }}>
          {sub === 'plot' && (
            <div className="flex flex-col gap-3">
              <PlotComponentsEditor plot={adv.plot} onChange={(plot) => change({ plot })} always presets scenarioInstructions={scenario?.plot.aiInstructions} />
              <Memories adv={adv} change={change} />
            </div>
          )}
          {sub === 'cards' && <StoryCardsBoard columns={2} cards={adv.cards} onChange={(next) => change((cur) => ({ cards: typeof next === 'function' ? next(cur.cards) : next }))} info={info} />}
          {sub === 'details' && (
            <StoryDetails
              doc={adv}
              change={change as unknown as StoryChange}
              collection="adventures"
              template={scenario?.template}
              info={info}
              onExportBackup={() => void saveFile(adv.title || 'adventure', JSON.stringify({ kind: 'stitch-adventure', version: 1, adventure: adv }, null, 2), 'json')}
              onExportText={() => void saveFile(adv.title || 'adventure', `${adv.title}\n\n${storyText(adv.actions)}\n`, 'txt')}
              extra={
                <div className="flex items-center gap-3 rounded-2xl border border-line bg-grad-soft p-4">
                  <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-white/10 text-fg">
                    <Clapperboard className="size-4.5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-semibold">Send to Studio</div>
                    <div className="text-[11.5px] leading-snug text-fg-2">{mediaCount ? `Build a timeline from ${mediaCount} image${mediaCount === 1 ? '' : 's'}, clips and narration.` : 'See, Animate or Narrate some turns first.'}</div>
                  </div>
                  <Button size="sm" variant="primary" disabled={!mediaCount} loading={studioBusy} onClick={onStudio}>
                    Send
                  </Button>
                </div>
              }
            />
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  )
}

// ─── Gameplay: AI models ─────────────────────────────────────────────────────

type SceneMode = 'off' | 'images' | 'video' | 'both'

const SCENE_HELP: Record<SceneMode, string> = {
  off: 'Nothing renders on its own — use See and Animate on any passage whenever you want.',
  images: 'A still is rendered for every new AI passage.',
  video: 'Every new AI passage becomes a short clip with native sound.',
  both: 'Each passage gets a still first, then a clip animated from that still so they match.'
}

type GenPrefs = { model?: string; loras?: LoraRef[]; trigger?: string; duration?: number }

/** Recipe, checkpoint, LoRA stack and trigger words for one media kind. */
function SceneModel({ kind, recipeId, prefs, onRecipe, onPrefs }: { kind: GenKind; recipeId?: string; prefs: GenPrefs; onRecipe: (id: string | undefined) => void; onPrefs: (p: GenPrefs) => void }): React.JSX.Element {
  const all = useGen((st) => st.recipes)
  const recipes = useMemo(() => all.filter((r) => r.kind === kind && r.mode !== 'image-edit'), [all, kind])
  const recipe = recipes.find((r) => r.id === recipeId)
  const modelSpec = recipe?.params.find((p) => p.type === 'model')
  const hasLoras = !!recipe?.params.some((p) => p.type === 'loras')
  const [trigger, setTrigger] = useState(prefs.trigger ?? '')
  useEffect(() => setTrigger(prefs.trigger ?? ''), [prefs.trigger])
  const auto = kind === 'image' ? 'Best installed model; locked characters are used as references.' : 'Reference video when characters are locked and its weights are installed, otherwise FastH3 from the scene still.'
  return (
    <div className="flex flex-col gap-4">
      <Field label={kind === 'image' ? 'Image model' : 'Video model'}>
        <Select
          value={recipeId ?? '__auto'}
          onChange={(v) => onRecipe(v === '__auto' ? undefined : v)}
          options={[
            { value: '__auto', label: 'Automatic', icon: <StatusDot state="online" /> },
            ...recipes.map((r) => ({ value: r.id, label: r.name, hint: r.available ? r.family : 'Missing models', icon: <StatusDot state={r.available ? 'online' : 'offline'} /> }))
          ]}
        />
      </Field>
      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={recipe?.id ?? 'auto'} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.2, ease }} className="flex flex-col gap-4">
          {!recipe && <p className="-mt-2 text-[12px] leading-relaxed text-fg-3">{auto} Pick a specific model to choose checkpoints and LoRAs.</p>}
          {recipe && !recipe.available && <p className="-mt-2 text-[12px] text-warning">Missing: {recipe.missing?.join(', ') || 'model files'} — grab them from the Models page.</p>}
          {modelSpec && (
            <Field label={modelSpec.label === 'Model' ? 'Checkpoint' : modelSpec.label} help={recipe?.baseModelMatch ? 'Only files from this model family are listed.' : undefined}>
              <ModelFilePicker folder={modelSpec.folder ?? 'diffusion_models'} value={prefs.model} onChange={(model) => onPrefs({ model })} baseModelMatch={recipe?.baseModelMatch} />
            </Field>
          )}
          {hasLoras && (
            <Field label="LoRAs" help="Stack as many as you like — each has its own strength.">
              <LoraStack
                value={prefs.loras ?? []}
                onChange={(loras) => onPrefs({ loras })}
                baseModelMatch={recipe?.baseModelMatch}
                onInsertWords={(words) => {
                  const have = trigger.split(',').map((w) => w.trim().toLowerCase())
                  const next = [trigger.trim(), ...words.filter((w) => !have.includes(w.trim().toLowerCase()))].filter(Boolean).join(', ')
                  setTrigger(next)
                  onPrefs({ trigger: next || undefined })
                }}
              />
            </Field>
          )}
          {hasLoras && (
            <Field label="Always add to the prompt" help="LoRA activation words or style tags, appended to every scene.">
              <Input value={trigger} placeholder="e.g. ghibli style, film grain" onChange={(e) => setTrigger(e.target.value)} onBlur={() => onPrefs({ trigger: trigger.trim() || undefined })} />
            </Field>
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  )
}

function ScenesSection({ s, set }: { s: AdventureSettings; set: (p: Partial<AdventureSettings>) => void }): React.JSX.Element {
  const mode: SceneMode = s.autoSee && s.autoAnimate ? 'both' : s.autoSee ? 'images' : s.autoAnimate ? 'video' : 'off'
  const [tab, setTab] = useState<'image' | 'video'>(mode === 'video' ? 'video' : 'image')
  return (
    <>
      <div className="flex flex-col gap-2">
        <div className="label-caps">Generate after each turn</div>
        <Segmented
          caps
          className="w-full [&>button]:flex-1 [&>button]:justify-center"
          value={mode}
          onChange={(m) => {
            set({ autoSee: m === 'images' || m === 'both', autoAnimate: m === 'video' || m === 'both' })
            if (m === 'video') setTab('video')
            else if (m === 'images') setTab('image')
          }}
          items={[
            { value: 'off', label: 'Off' },
            { value: 'images', label: 'Images' },
            { value: 'video', label: 'Video' },
            { value: 'both', label: 'Both' }
          ]}
        />
        <AnimatePresence mode="wait" initial={false}>
          <motion.p key={mode} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.2 }} className="text-[12px] text-fg-2">
            {SCENE_HELP[mode]}
          </motion.p>
        </AnimatePresence>
      </div>
      <div className="h-px bg-line" />
      <Segmented
        size="sm"
        className="self-start"
        value={tab}
        onChange={setTab}
        items={[
          { value: 'image', label: 'Stills', icon: <ImageIcon className="size-3.5" /> },
          { value: 'video', label: 'Clips', icon: <Film className="size-3.5" /> }
        ]}
      />
      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={tab} initial={{ opacity: 0, x: tab === 'video' ? 12 : -12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: tab === 'video' ? -12 : 12 }} transition={{ duration: 0.22, ease }}>
          {tab === 'image' ? (
            <SceneModel kind="image" recipeId={s.imageRecipeId} prefs={s.imageGen ?? {}} onRecipe={(imageRecipeId) => set({ imageRecipeId, imageGen: { ...s.imageGen, model: undefined } })} onPrefs={(p) => set({ imageGen: { ...s.imageGen, ...p } })} />
          ) : (
            <div className="flex flex-col gap-4">
              <SceneModel kind="video" recipeId={s.videoRecipeId} prefs={s.videoGen ?? {}} onRecipe={(videoRecipeId) => set({ videoRecipeId, videoGen: { ...s.videoGen, model: undefined } })} onPrefs={(p) => set({ videoGen: { ...s.videoGen, ...p } })} />
              <SliderField
                label="Clip length"
                help="Longer clips take proportionally longer to render."
                value={s.videoGen?.duration ?? 5}
                onChange={(duration) => set({ videoGen: { ...s.videoGen, duration } })}
                min={2}
                max={15}
                step={0.5}
                defaultValue={5}
                format={(v) => `${v} s`}
              />
            </div>
          )}
        </motion.div>
      </AnimatePresence>
    </>
  )
}

function AiModelsTab({ adv, set, model, onModel, onInspect }: { adv: Adventure; set: (p: Partial<AdventureSettings>) => void; model?: LlmChoice; onModel: (c: LlmChoice) => void; onInspect: () => void }): React.JSX.Element {
  const s = adv.settings
  const [changing, setChanging] = useState(false)
  const conn = model ? db.get('connectors', model.connectorId) : undefined
  const window = contextWindow(model)
  const maxCtx = Math.max(2048, window ?? 131072)
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-2xl border border-line bg-white/[0.03] p-4">
        <div className="label-caps">Story generator</div>
        <div className="mt-2 flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="truncate font-serif text-[17px] font-semibold">{modelLabel(model)}</div>
            <div className="truncate text-[11.5px] text-fg-3">
              {conn ? `${conn.name}${conn.category === 'llm' && LLM_KIND_LABEL[conn.kind] !== conn.name ? ` · ${LLM_KIND_LABEL[conn.kind]}` : ''}` : 'Pick a model to play'}
              {window ? ` · ${Math.round(window / 1024)}k context` : ''}
            </div>
          </div>
          <Button size="sm" variant={changing ? 'secondary' : 'glass'} onClick={() => setChanging((c) => !c)}>
            {changing ? 'Close' : 'Change'}
          </Button>
        </div>
        <AnimatePresence initial={false}>
          {changing && (
            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.3, ease }} className="overflow-hidden">
              <div className="pt-4">
                <ModelChooser current={model} onUse={onModel} onDone={() => setChanging(false)} />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <Accordion title="Memory system" icon={<Brain />} defaultOpen>
        <SliderField
          label="Context length"
          help="How much of the story the AI can see at once."
          value={Math.min(s.contextLength, maxCtx)}
          onChange={(v) => set({ contextLength: v })}
          min={1024}
          max={maxCtx}
          step={256}
          defaultValue={Math.min(DEFAULT_CONTEXT, maxCtx)}
          format={(v) => `${v.toLocaleString()} tokens`}
        />
        <SwitchRow label="Memory bank" help="Save durable facts every few turns and recall them when relevant." checked={s.memoryBank} onChange={(v) => set({ memoryBank: v })} />
        <SwitchRow label="Auto summarization" help="Fold older passages into the Story Summary as they leave the context." checked={s.autoSummarize} onChange={(v) => set({ autoSummarize: v })} />
      </Accordion>

      <Accordion title="Model settings" icon={<SlidersHorizontal />}>
        <SliderField label="Response length" help="Maximum length of each AI reply." value={s.responseLength} onChange={(v) => set({ responseLength: v })} min={32} max={1024} step={8} defaultValue={DEFAULT_RESPONSE} format={(v) => `${v} tokens`} />
        <SliderField label="Temperature" help="Higher is more surprising, lower is more focused." value={s.temperature} onChange={(v) => set({ temperature: v })} min={0} max={2} step={0.05} defaultValue={0.9} format={(v) => v.toFixed(2)} />
        <SliderField label="Top K" help="Only sample from the K most likely words. 0 turns it off." value={s.topK} onChange={(v) => set({ topK: v })} min={0} max={200} step={1} defaultValue={40} format={(v) => (v === 0 ? 'Off' : String(v))} />
        <SliderField label="Top P" help="Nucleus sampling — lower keeps the AI on the likeliest paths." value={s.topP} onChange={(v) => set({ topP: v })} min={0.05} max={1} step={0.01} defaultValue={0.95} format={(v) => v.toFixed(2)} />
      </Accordion>

      <Accordion title="Safety" icon={<ShieldCheck />} aside={<Badge>{SAFETY_TEXT[s.safety].label}</Badge>}>
        <Segmented
          caps
          className="w-full [&>button]:flex-1 [&>button]:justify-center"
          value={s.safety}
          onChange={(v) => set({ safety: v })}
          items={(['safe', 'moderate', 'mature'] as const).map((k) => ({ value: k, label: SAFETY_TEXT[k].label }))}
        />
        <AnimatePresence mode="wait" initial={false}>
          <motion.p key={s.safety} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.2 }} className="-mt-2 text-[12px] text-fg-2">
            {SAFETY_TEXT[s.safety].description}
          </motion.p>
        </AnimatePresence>
      </Accordion>

      <Accordion title="Scenes while playing" icon={<ImageIcon />} aside={s.autoSee || s.autoAnimate ? <Badge tone="accent">{s.autoSee && s.autoAnimate ? 'Stills + clips' : s.autoSee ? 'Stills' : 'Clips'}</Badge> : undefined}>
        <ScenesSection s={s} set={set} />
      </Accordion>

      <Accordion title="Narration" icon={<Mic />}>
        <VoicePicker value={s.narrator} onChange={(v) => set({ narrator: v })} previewText={adv.actions[adv.actions.length - 1]?.text.slice(0, 220) || 'The story begins.'} name={`${adv.title} narrator`} lab={false} />
        <SwitchRow label="Auto Narrate" help="Read every new AI passage aloud." checked={s.autoNarrate} onChange={(v) => set({ autoNarrate: v })} />
      </Accordion>

      <Accordion title="Testing & feedback" icon={<FlaskConical />}>
        <SwitchRow label="Raw model output" help="Show exactly what the model wrote — no trimming to full sentences." checked={s.rawOutput} onChange={(v) => set({ rawOutput: v })} />
        <SwitchRow label="Context warning" help="Show ⚠ when triggered story cards didn't fit in the context." checked={s.contextWarning} onChange={(v) => set({ contextWarning: v })} />
        <Button icon={<ScanSearch className="size-3.5" />} onClick={onInspect} className="self-start tracking-wide uppercase">
          Inspect input
        </Button>
      </Accordion>
    </div>
  )
}

// ─── Gameplay: appearance ────────────────────────────────────────────────────

function ThemeTile({ t, active, onClick, dynamicVars }: { t: ThemeDef; active: boolean; onClick: () => void; dynamicVars: CSSProperties }): React.JSX.Element {
  const vars = (t.id === 'dynamic' ? { ...dynamicVars, ...t.vars } : t.vars) as CSSProperties
  return (
    <motion.button whileTap={{ scale: 0.98 }} onClick={onClick} className={cn('relative flex items-center gap-3 rounded-2xl border p-2 text-left transition-colors', active ? 'border-transparent' : 'border-line hover:border-line-strong')}>
      {active && <motion.span layoutId="theme-active" className="absolute inset-0 rounded-2xl ring-2 ring-[color-mix(in_oklab,var(--accent)_60%,transparent)]" transition={spring} />}
      <div style={{ ...vars, background: t.backdrop }} className="relative flex h-16 w-24 shrink-0 flex-col items-center justify-center gap-1.5 overflow-hidden rounded-xl ring-1 ring-black/20">
        <span className="font-serif text-[18px] leading-none font-semibold" style={{ color: 'var(--st-text)' }}>
          Aa
        </span>
        <span className="h-3 w-12" style={{ borderRadius: t.button.radius === '999px' ? 999 : 3, clipPath: t.button.clip ? 'polygon(4px 0,100% 0,100% calc(100% - 4px),calc(100% - 4px) 100%,0 100%,0 4px)' : undefined, background: 'var(--grad)', ...(t.id === 'dynamic' ? {} : { background: t.button.primary.background as string }) }} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-semibold">{t.name}</div>
        <div className="text-[11.5px] text-fg-3">{t.tagline}</div>
      </div>
    </motion.button>
  )
}

function AppearanceTab({ s, set, dynamicVars }: { s: AdventureSettings; set: (p: Partial<AdventureSettings>) => void; dynamicVars: CSSProperties }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <div className="label-caps">Default</div>
        {THEMES.filter((t) => t.group === 'default').map((t) => (
          <ThemeTile key={t.id} t={t} active={s.theme === t.id} onClick={() => set({ theme: t.id })} dynamicVars={dynamicVars} />
        ))}
        <div className="label-caps mt-2">Styled</div>
        {THEMES.filter((t) => t.group === 'styled').map((t) => (
          <ThemeTile key={t.id} t={t} active={s.theme === t.id} onClick={() => set({ theme: t.id })} dynamicVars={dynamicVars} />
        ))}
      </div>
      <div className="flex flex-col gap-2">
        <div className="label-caps">Text style</div>
        <Segmented
          className="w-full [&>button]:flex-1 [&>button]:justify-center"
          value={s.textStyle}
          onChange={(v) => set({ textStyle: v })}
          items={TEXT_STYLES.map((t) => ({ value: t.value, label: <span style={{ fontFamily: t.font }}>{t.label}</span> }))}
        />
      </div>
      <Accordion title="Accessibility" icon={<Accessibility />}>
        <SwitchRow label="Text animation" help="Fade new words in as the story is written." checked={s.textAnimation} onChange={(v) => set({ textAnimation: v })} />
        <SwitchRow label="Larger accessibility sizes" help="Bigger story text and controls." checked={s.largeText} onChange={(v) => set({ largeText: v })} />
      </Accordion>
      <Accordion title="Behavior" icon={<MousePointerClick />}>
        <SwitchRow label="Sticky turn input" help="Keep the input open after you take a turn." checked={s.stickyInput} onChange={(v) => set({ stickyInput: v })} />
        <SwitchRow label="Compact buttons" help="Hide labels on the command buttons." checked={s.compactButtons} onChange={(v) => set({ compactButtons: v })} />
      </Accordion>
    </div>
  )
}

// ─── Panel ───────────────────────────────────────────────────────────────────

export function SidePanel({
  open,
  onClose,
  adv,
  change,
  scenario,
  model,
  onModel,
  onInspect,
  onStudio,
  studioBusy,
  dynamicVars
}: {
  open: boolean
  onClose: () => void
  adv: Adventure
  change: Change
  scenario?: Scenario
  model?: LlmChoice
  onModel: (c: LlmChoice) => void
  onInspect: () => void
  onStudio: () => void
  studioBusy: boolean
  dynamicVars: CSSProperties
}): React.JSX.Element {
  const [tab, setTab] = useState<'adventure' | 'gameplay'>('adventure')
  const [sub, setSub] = useState<'models' | 'appearance'>('models')
  const set = (p: Partial<AdventureSettings>): void => change((cur) => ({ settings: { ...cur.settings, ...p } }))
  const info: StoryInfo = useMemo(
    () => ({ title: adv.title, description: adv.description, opening: adv.actions[0]?.text ?? '', plot: adv.plot, cards: adv.cards }),
    [adv.title, adv.description, adv.actions, adv.plot, adv.cards]
  )
  return (
    <AnimatePresence>
      {open && (
        <motion.aside
          initial={{ x: 440, opacity: 0.4 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: 440, opacity: 0.4 }}
          transition={{ type: 'spring', stiffness: 320, damping: 34 }}
          className="absolute top-[52px] right-2.5 bottom-2.5 z-40 flex w-[400px] flex-col overflow-hidden rounded-[20px] border border-line-strong bg-[var(--panel)] shadow-[0_30px_80px_-24px_rgb(0_0_0/0.75)] backdrop-blur-2xl"
        >
          <div className="flex items-center gap-2 px-4 pt-2">
            <Tabs
              className="flex-1 border-b-0"
              value={tab}
              onChange={setTab}
              items={[
                { value: 'adventure', label: <span className="tracking-[0.06em] uppercase">Adventure</span> },
                { value: 'gameplay', label: <span className="tracking-[0.06em] uppercase">Gameplay</span> }
              ]}
            />
            <IconButton label="Close panel" onClick={onClose}>
              <X className="size-4" />
            </IconButton>
          </div>
          <div className="h-px bg-line" />
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-4 pb-6">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div key={tab} initial={{ opacity: 0, x: tab === 'adventure' ? -12 : 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: tab === 'adventure' ? -12 : 12 }} transition={{ duration: 0.22, ease }}>
                {tab === 'adventure' ? (
                  <AdventureTab adv={adv} change={change} scenario={scenario} info={info} onStudio={onStudio} studioBusy={studioBusy} />
                ) : (
                  <div className="flex flex-col gap-4">
                    <Segmented
                      caps
                      size="sm"
                      className="self-start"
                      value={sub}
                      onChange={setSub}
                      items={[
                        { value: 'models', label: 'AI models' },
                        { value: 'appearance', label: 'Appearance' }
                      ]}
                    />
                    <AnimatePresence mode="wait" initial={false}>
                      <motion.div key={sub} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.22, ease }}>
                        {sub === 'models' ? <AiModelsTab adv={adv} set={set} model={model} onModel={onModel} onInspect={onInspect} /> : <AppearanceTab s={adv.settings} set={set} dynamicVars={dynamicVars} />}
                      </motion.div>
                    </AnimatePresence>
                  </div>
                )}
              </motion.div>
            </AnimatePresence>
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  )
}
