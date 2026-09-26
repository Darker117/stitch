import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { AnimatePresence, motion } from 'motion/react'
import {
  ArrowUpDown,
  AudioLines,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Clapperboard,
  Clock,
  FileJson,
  Film,
  LayoutGrid,
  MessageSquareQuote,
  Mic2,
  Palette,
  Play,
  RefreshCw,
  Rocket,
  ScanFace,
  Sparkles,
  Trash2,
  Wand2,
  Zap
} from 'lucide-react'
import type { GenKind, SkillDoc } from '@shared/types'
import { errorText, invoke } from '@/lib/api'
import { themedHue } from '@/lib/theme'
import { cn, formatEta } from '@/lib/utils'
import { useCompact } from '@/lib/platform'
import { ease, rise, spring, stagger } from '@/lib/motion'
import { Page } from '@/components/shell/page'
import { Button } from '@/components/ui/button'
import { Switch, Tabs } from '@/components/ui/controls'
import { Input, SearchField, Textarea } from '@/components/ui/input'
import { Badge, EmptyState, Field } from '@/components/ui/misc'
import { Dialog, Menu, MenuCheck, MenuItem, Select } from '@/components/ui/overlay'
import { db, useCollection } from '@/stores/db'
import { useGen } from '@/stores/gen'
import { toast } from '@/stores/toast'
import { ParamControl } from '../generate/params'
import { startChat } from '../create/runtime'
import { WebSearchSkill } from './WebSearchSkill'

interface BuiltinSkill {
  id: string
  name: string
  blurb: string
  icon: React.ReactNode
  minutes: number
  type: 'Skill' | 'Use case'
  category: 'Characters' | 'Stories' | 'Video' | 'Audio' | 'Images'
  art: [string, string, string]
  run: (nav: ReturnType<typeof useNavigate>) => void | Promise<void>
}

const chat = (nav: ReturnType<typeof useNavigate>, text: string) => async (): Promise<void> => {
  const id = await startChat(text, [], { askBeforeGenerating: true })
  nav(`/chat/${id}`)
}

const BUILTIN: BuiltinSkill[] = [
  { id: 'charlock', name: 'Character Lock', blurb: 'One reference → a full character sheet that never drifts.', icon: <ScanFace />, minutes: 3, type: 'Skill', category: 'Characters', art: ['#6d65b8', '#ad849d', '#cc7b62'], run: (n) => n('/characters') },
  { id: 'story', name: 'Illustrated Adventure', blurb: 'Play a text adventure that paints and voices itself.', icon: <BookOpen />, minutes: 5, type: 'Use case', category: 'Stories', art: ['#8e3452', '#c85d56', '#312b47'], run: (n) => n('/stories/new') },
  { id: 'talking', name: 'Talking Character', blurb: 'A locked character speaks a line in an H3 shot with native audio.', icon: <MessageSquareQuote />, minutes: 4, type: 'Skill', category: 'Video', art: ['#cc7b62', '#8f78b2', '#312b47'], run: (n) => chat(n, 'Make a 6-second H3 video of one of my characters speaking a line to camera. Ask me which character and what they say.')() },
  { id: 'drama', name: 'Short-form Drama', blurb: 'Plan and shoot a 3-shot micro-drama with consistent cast and sound.', icon: <Clapperboard />, minutes: 10, type: 'Use case', category: 'Video', art: ['#312b47', '#6d65b8', '#aa3b51'], run: (n) => chat(n, 'Help me make a three-shot short-form drama (vertical 9:16). Plan the beats, then generate each shot with sound. Ask me for the premise first.')() },
  { id: 'scene', name: 'Story Scene', blurb: 'Stage your characters together in any setting, on-model.', icon: <Palette />, minutes: 1, type: 'Skill', category: 'Images', art: ['#ad849d', '#6d65b8', '#1b1830'], run: (n) => n('/generate/image') },
  { id: 'animate', name: 'Animate a Still', blurb: 'Bring any image to life with motion, dialogue and ambience.', icon: <Film />, minutes: 3, type: 'Skill', category: 'Video', art: ['#c85d56', '#cc7b62', '#8e3452'], run: (n) => n('/generate/video') },
  { id: 'score', name: 'Soundtrack', blurb: 'Compose a theme for a scene, faction or whole adventure.', icon: <AudioLines />, minutes: 2, type: 'Skill', category: 'Audio', art: ['#8f78b2', '#312b47', '#cc7b62'], run: (n) => n('/generate/audio') },
  { id: 'voice', name: 'Voice Clone', blurb: 'Clone a voice from a few seconds, or design one from words.', icon: <Mic2 />, minutes: 1, type: 'Skill', category: 'Audio', art: ['#aa3b51', '#ad849d', '#6d65b8'], run: (n) => n('/generate/voice') },
  { id: 'edit', name: 'Wardrobe & Relight', blurb: 'Change outfits, props or lighting while keeping identity.', icon: <Wand2 />, minutes: 1, type: 'Skill', category: 'Images', art: ['#6d65b8', '#cc7b62', '#aa3b51'], run: (n) => chat(n, 'I want to edit one of my images — change the outfit or lighting but keep the character identical. I will attach the image.')() }
]

function SkillArt({ colors, icon, className }: { colors: [string, string, string]; icon: React.ReactNode; className?: string }): React.JSX.Element {
  const [a, b, c] = colors.map(themedHue)
  return (
    <div className={cn('relative overflow-hidden', className)} style={{ background: `linear-gradient(135deg, ${a}, ${b} 55%, ${c})` }}>
      <div className="absolute inset-0 opacity-40" style={{ background: 'radial-gradient(circle at 25% 20%, rgb(255 255 255 / 0.5), transparent 45%)' }} />
      <div className="absolute inset-0 opacity-[0.12]" style={{ backgroundImage: 'radial-gradient(rgb(255 255 255) 1px, transparent 1px)', backgroundSize: '14px 14px' }} />
      <div className="absolute -right-6 -bottom-6 text-white/15 [&>svg]:size-40">{icon}</div>
      <div className="absolute inset-0 grid place-items-center text-white drop-shadow-[0_8px_20px_rgb(0_0_0/0.35)] [&>svg]:size-11">{icon}</div>
    </div>
  )
}

function ImportDialog({ open, onClose }: { open: boolean; onClose: () => void }): React.JSX.Element {
  const [doc, setDoc] = useState<SkillDoc | null>(null)
  const [enabled, setEnabled] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!open) {
      setDoc(null)
      setEnabled({})
    }
  }, [open])
  const pick = async (): Promise<void> => {
    const [path] = await invoke('sys:pickFiles', { title: 'Choose a ComfyUI workflow', filters: [{ name: 'Workflow', extensions: ['json'] }] })
    if (!path) return
    setBusy(true)
    try {
      const json = await invoke('sys:readText', path)
      const name = path.split(/[\\/]/).pop()!.replace(/\.json$/i, '').replace(/[_-]+/g, ' ')
      const d = await invoke('skills:analyze', json, name)
      setDoc(d)
      setEnabled(Object.fromEntries(d.bindings.map((b) => [b.key, true])))
    } catch (err) {
      toast.error('Could not import', errorText(err))
    } finally {
      setBusy(false)
    }
  }
  const save = async (): Promise<void> => {
    if (!doc) return
    await db.put('skills', { ...doc, bindings: doc.bindings.filter((b) => enabled[b.key]) })
    await useGen.getState().refreshRecipes()
    toast.success(`${doc.name} added`, 'It also appears in the Generate model list.')
    onClose()
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Create a skill from a ComfyUI workflow"
      description="Export your workflow from ComfyUI (Workflow → Export (API) works best) and pick which inputs to expose."
      width={640}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!doc} onClick={() => void save()}>
            Save skill
          </Button>
        </>
      }
    >
      <div className="space-y-4 p-5">
        {!doc ? (
          <button onClick={() => void pick()} className="flex h-40 w-full flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-line-strong text-fg-3 transition hover:border-[color-mix(in_oklab,var(--accent)_50%,transparent)] hover:text-fg-2">
            {busy ? <RefreshCw className="size-5 animate-spin" /> : <FileJson className="size-6" />}
            <span className="text-[13px] font-medium">{busy ? 'Reading workflow…' : 'Choose workflow .json'}</span>
          </button>
        ) : (
          <>
            <div className="grid grid-cols-[1fr_140px] gap-3 max-md:grid-cols-1">
              <Field label="Name">
                <Input value={doc.name} onChange={(e) => setDoc({ ...doc, name: e.target.value })} />
              </Field>
              <Field label="Output">
                <Select value={doc.kind} onChange={(v) => setDoc({ ...doc, kind: v as GenKind })} options={['image', 'video', 'audio'].map((k) => ({ value: k, label: k[0].toUpperCase() + k.slice(1) }))} />
              </Field>
            </div>
            <Field label="Description">
              <Textarea value={doc.description} onChange={(e) => setDoc({ ...doc, description: e.target.value })} minRows={2} />
            </Field>
            <Field label={`Exposed inputs (${doc.bindings.length} detected)`}>
              <div className="divide-y divide-line rounded-xl border border-line">
                {doc.bindings.map((b, i) => (
                  <div key={b.key} className="flex items-center gap-3 px-3 py-2 max-md:flex-wrap max-md:gap-2 max-md:py-2.5">
                    <Input
                      value={b.label}
                      onChange={(e) => setDoc({ ...doc, bindings: doc.bindings.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })}
                      className="h-8 flex-1 text-[12.5px] max-md:h-9 max-md:basis-full"
                    />
                    <Badge>{b.type}</Badge>
                    <span className="w-28 truncate font-mono text-[10.5px] text-fg-3 max-md:w-auto max-md:min-w-0 max-md:flex-1">
                      #{b.node}.{b.input}
                    </span>
                    <Switch size="sm" checked={enabled[b.key] ?? true} onChange={(v) => setEnabled((s) => ({ ...s, [b.key]: v }))} />
                  </div>
                ))}
                {!doc.bindings.length && <div className="p-3 text-[12px] text-fg-3">No inputs detected — the workflow will run as-is.</div>}
              </div>
            </Field>
          </>
        )}
      </div>
    </Dialog>
  )
}

function RunDialog({ skill, onClose }: { skill: SkillDoc | null; onClose: () => void }): React.JSX.Element {
  const submit = useGen((s) => s.submit)
  const navigate = useNavigate()
  const [values, setValues] = useState<Record<string, unknown>>({})
  useEffect(() => setValues({}), [skill?.id])
  return (
    <Dialog
      open={!!skill}
      onOpenChange={(o) => !o && onClose()}
      title={skill?.name}
      description={skill?.description}
      width={560}
      footer={
        <Button
          variant="primary"
          icon={<Play className="size-3.5" />}
          onClick={async () => {
            if (!skill) return
            try {
              await submit({ recipeId: `skill:${skill.id}`, params: values, label: skill.name })
              toast.success(`${skill.name} started`)
              onClose()
              navigate(`/generate/${skill.kind}`)
            } catch (err) {
              toast.error('Could not run', errorText(err))
            }
          }}
        >
          Run skill
        </Button>
      }
    >
      <div className="space-y-4 p-5">
        {skill?.bindings.map((b) => (
          <ParamControl key={b.key} spec={{ key: b.key, label: b.label, type: b.type, default: b.default, min: b.min, max: b.max, options: b.options }} value={values[b.key]} onChange={(v) => setValues((s) => ({ ...s, [b.key]: v }))} />
        ))}
      </div>
    </Dialog>
  )
}

type Cat = BuiltinSkill['category']
const CATS: Cat[] = ['Characters', 'Stories', 'Video', 'Images', 'Audio']

export function SkillsPage(): React.JSX.Element {
  const navigate = useNavigate()
  const mine = useCollection('skills')
  const [tab, setTab] = useState<'explore' | 'mine'>('explore')
  const [q, setQ] = useState('')
  const [cats, setCats] = useState<Cat[]>(CATS)
  const [sort, setSort] = useState<'relevance' | 'fastest'>('relevance')
  const [slide, setSlide] = useState(0)
  const [importing, setImporting] = useState(false)
  const [running, setRunning] = useState<SkillDoc | null>(null)
  const featured = BUILTIN.slice(0, 5)

  useEffect(() => {
    const t = setInterval(() => setSlide((s) => (s + 1) % featured.length), 6000)
    return () => clearInterval(t)
  }, [featured.length])

  const list = useMemo(() => {
    const l = BUILTIN.filter((s) => cats.includes(s.category) && (!q || `${s.name} ${s.blurb}`.toLowerCase().includes(q.toLowerCase())))
    return sort === 'fastest' ? [...l].sort((a, b) => a.minutes - b.minutes) : l
  }, [cats, q, sort])

  const f = featured[slide]
  const compact = useCompact()
  return (
    <Page>
      {compact ? (
        // Phones: a plain header and one swipeable featured card instead of the landing hero.
        <div className="px-4 pt-5">
          <div className="flex items-center gap-2">
            <h1 className="display min-w-0 flex-1 truncate text-[23px]">Skills</h1>
            <Button variant="primary" className="h-10 rounded-xl px-4" icon={<Sparkles className="size-4" />} onClick={() => setImporting(true)}>
              Create
            </Button>
          </div>
          <motion.div
            className="relative mt-4 h-[168px] touch-pan-y overflow-hidden rounded-[20px] ring-1 ring-line"
            drag="x"
            dragConstraints={{ left: 0, right: 0 }}
            dragElastic={0.18}
            onDragEnd={(_, info) => {
              if (info.offset.x < -50) setSlide((s) => (s + 1) % featured.length)
              else if (info.offset.x > 50) setSlide((s) => (s - 1 + featured.length) % featured.length)
            }}
          >
            <AnimatePresence mode="sync" initial={false}>
              <motion.div key={f.id} className="absolute inset-0" initial={{ opacity: 0, scale: 1.05 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.6, ease }}>
                <SkillArt colors={f.art} icon={f.icon} className="absolute inset-0" />
                <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/20 to-transparent" />
              </motion.div>
            </AnimatePresence>
            <div className="absolute top-3.5 right-3.5 flex gap-1.5">
              {featured.map((s, i) => (
                <button key={s.id} onClick={() => setSlide(i)} className="relative h-1 w-5 overflow-hidden rounded-full bg-white/25" aria-label={s.name}>
                  {i === slide && <motion.span layoutId="skill-dot-m" className="absolute inset-0 rounded-full bg-white" transition={spring} />}
                </button>
              ))}
            </div>
            <AnimatePresence mode="wait" initial={false}>
              <motion.div key={f.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.35, ease }} className="absolute inset-x-4 bottom-3.5 flex items-end gap-3">
                <div className="min-w-0 flex-1">
                  <div className="label-caps text-white/60">Featured</div>
                  <div className="truncate text-[16px] font-semibold text-white">{f.name}</div>
                  <div className="line-clamp-1 text-[12px] text-white/70">{f.blurb}</div>
                </div>
                <button onClick={() => void f.run(navigate)} className="flex h-9 shrink-0 items-center gap-1 rounded-full bg-white/15 px-4 text-[12.5px] font-semibold text-white backdrop-blur active:scale-95">
                  Open <ChevronRight className="size-3.5" />
                </button>
              </motion.div>
            </AnimatePresence>
          </motion.div>
        </div>
      ) : (
      <>
      {/* Hero carousel */}
      <div className="relative h-[330px] overflow-hidden border-b border-line max-md:h-auto">
        <AnimatePresence mode="sync">
          <motion.div key={f.id} className="absolute inset-0" initial={{ opacity: 0, scale: 1.04 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.9, ease }}>
            <SkillArt colors={f.art} icon={f.icon} className="absolute inset-y-0 right-0 w-[70%] opacity-80 max-md:w-full max-md:opacity-70" />
            <div className="absolute inset-0 bg-gradient-to-r from-[var(--panel-solid)] via-[color-mix(in_oklab,var(--panel-solid)_85%,transparent)] to-transparent max-md:bg-gradient-to-b max-md:from-[color-mix(in_oklab,var(--panel-solid)_94%,transparent)] max-md:via-[color-mix(in_oklab,var(--panel-solid)_78%,transparent)] max-md:to-[color-mix(in_oklab,var(--panel-solid)_25%,transparent)]" />
          </motion.div>
        </AnimatePresence>
        <div className="relative z-10 flex h-full flex-col justify-center gap-5 px-10 max-md:h-auto max-md:gap-4 max-md:px-5 max-md:pt-7 max-md:pb-6">
          <h1 className="display text-[34px] uppercase max-md:text-[28px]">Explore skills</h1>
          <ul className="space-y-2 text-[13px] text-fg-3">
            <li className="flex items-center gap-2.5">
              <Zap className="size-3.5 shrink-0 text-fg-2" />
              <span>
                <b className="font-semibold text-fg">A skill</b> is one ready-made ability, like locking a character
              </span>
            </li>
            <li className="flex items-center gap-2.5">
              <FileJson className="size-3.5 shrink-0 text-fg-2" />
              <span>
                <b className="font-semibold text-fg">Any ComfyUI workflow</b> can become a one-click skill
              </span>
            </li>
            <li className="flex items-center gap-2.5">
              <Rocket className="size-3.5 shrink-0 text-fg-2" />
              <span>
                <b className="font-semibold text-fg">Runs locally</b> on your own GPUs
              </span>
            </li>
          </ul>
          <div>
            <Button variant="primary" icon={<Sparkles className="size-4" />} onClick={() => setImporting(true)}>
              Create new
            </Button>
          </div>
        </div>
        <div className="absolute right-8 bottom-6 z-10 flex items-end gap-4 text-right max-md:relative max-md:right-auto max-md:bottom-auto max-md:mx-5 max-md:mb-5 max-md:min-h-[88px] max-md:pr-24 max-md:text-left">
          <div className="max-md:min-w-0">
            <div className="text-[15px] font-semibold">{f.name}</div>
            <div className="text-[12px] text-fg-2">{f.blurb}</div>
            <button onClick={() => void f.run(navigate)} className="mt-2 inline-flex items-center gap-1 rounded-full bg-black/40 px-3 py-1 text-[12px] font-medium backdrop-blur hover:bg-black/60 max-md:mt-3 max-md:h-9 max-md:px-4">
              Open <ChevronRight className="size-3.5" />
            </button>
          </div>
        </div>
        <div className="absolute top-5 right-8 z-10 flex gap-1.5 max-md:top-4 max-md:right-5">
          {featured.map((s, i) => (
            <button key={s.id} onClick={() => setSlide(i)} className="relative h-1 w-6 overflow-hidden rounded-full bg-white/20">
              {i === slide && <motion.span layoutId="skill-dot" className="absolute inset-0 rounded-full bg-white" transition={spring} />}
            </button>
          ))}
        </div>
        <button onClick={() => setSlide((s) => (s - 1 + featured.length) % featured.length)} className="absolute top-1/2 left-[46%] z-10 grid size-9 -translate-y-1/2 place-items-center rounded-full bg-black/35 text-white backdrop-blur transition hover:bg-black/55 max-md:top-auto max-md:right-[68px] max-md:bottom-5 max-md:left-auto max-md:size-10 max-md:translate-y-0">
          <ChevronLeft className="size-4" />
        </button>
        <button onClick={() => setSlide((s) => (s + 1) % featured.length)} className="absolute top-1/2 right-6 z-10 grid size-9 -translate-y-1/2 place-items-center rounded-full bg-black/35 text-white backdrop-blur transition hover:bg-black/55 max-md:top-auto max-md:right-5 max-md:bottom-5 max-md:size-10 max-md:translate-y-0">
          <ChevronRight className="size-4" />
        </button>
      </div>
      </>
      )}

      <div className="px-10 pt-6 pb-16 max-md:px-4 max-md:pt-4 max-md:pb-10">
        <Tabs
          value={tab}
          onChange={setTab}
          className="max-md:[&>button]:h-10"
          items={[
            { value: 'explore', label: 'Explore' },
            { value: 'mine', label: 'My skills', count: mine.length }
          ]}
        />
        <div className="mt-5 flex items-center justify-between gap-3 max-md:mt-4 max-md:flex-wrap max-md:gap-2">
          <SearchField value={q} onChange={setQ} className="w-[280px] max-md:w-full" />
          <div className="flex gap-2 max-md:w-full max-md:[&>button]:h-9 max-md:[&>button]:flex-1">
            <Menu
              align="end"
              trigger={
                <Button variant="outline" size="sm" icon={<LayoutGrid className="size-3.5" />}>
                  Category
                </Button>
              }
            >
              {CATS.map((c) => (
                <MenuCheck key={c} checked={cats.includes(c)} onChange={(v) => setCats((x) => (v ? [...x, c] : x.filter((y) => y !== c)))}>
                  {c}
                </MenuCheck>
              ))}
            </Menu>
            <Menu
              align="end"
              trigger={
                <Button variant="outline" size="sm" icon={<ArrowUpDown className="size-3.5" />}>
                  {sort === 'relevance' ? 'Relevance' : 'Fastest'}
                </Button>
              }
            >
              <MenuItem onSelect={() => setSort('relevance')}>Relevance</MenuItem>
              <MenuItem onSelect={() => setSort('fastest')}>Fastest</MenuItem>
            </Menu>
          </div>
        </div>

        <AnimatePresence mode="wait">
          {tab === 'explore' ? (
            <motion.div key="explore" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.3, ease }}>
              <div className="mt-8 mb-4 flex items-center gap-2 text-[15px] font-bold tracking-tight uppercase max-md:mt-6 max-md:mb-3 max-md:text-[14px]">
                <span className="grid size-5 place-items-center rounded-full bg-grad text-white">
                  <Zap className="size-3" />
                </span>
                For your text models
              </div>
              <WebSearchSkill />
              <div className="mt-10 mb-4 flex items-center gap-2 text-[15px] font-bold tracking-tight uppercase max-md:mt-8 max-md:mb-3 max-md:text-[14px]">
                <span className="grid size-5 place-items-center rounded-full bg-grad text-white">
                  <Zap className="size-3" />
                </span>
                Skills by Stitch
              </div>
              <motion.div variants={stagger(0.04)} initial="initial" animate="animate" className="grid grid-cols-3 gap-4 max-md:grid-cols-2 max-md:gap-x-3 max-md:gap-y-4">
                {list.map((s) => (
                  <motion.button key={s.id} variants={rise} whileHover={{ y: -4 }} transition={spring} onClick={() => void s.run(navigate)} className="group text-left">
                    <SkillArt colors={s.art} icon={s.icon} className="aspect-[16/9] rounded-2xl ring-1 ring-line transition-transform duration-500 max-md:aspect-[4/3]" />
                    <div className="mt-3 flex items-center gap-2.5 max-md:mt-2 max-md:flex-wrap max-md:gap-x-2.5 max-md:gap-y-0.5">
                      <span className="grid size-7 place-items-center rounded-lg border border-line bg-white/[0.05] text-fg-2 max-md:hidden [&>svg]:size-3.5">{s.icon}</span>
                      <span className="flex-1 truncate text-[14px] font-semibold max-md:basis-full max-md:text-[13px]">{s.name}</span>
                      <span className="flex items-center gap-1 text-[11.5px] text-fg-3">
                        <Clock className="size-3" /> {s.minutes} min
                      </span>
                      <span className="flex items-center gap-1 text-[11.5px] text-fg-3">
                        <Zap className="size-3" /> {s.type}
                      </span>
                    </div>
                  </motion.button>
                ))}
              </motion.div>
            </motion.div>
          ) : (
            <motion.div key="mine" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.3, ease }} className="mt-6">
              {mine.length ? (
                <div className="grid grid-cols-3 gap-4 max-md:grid-cols-1 max-md:gap-2.5">
                  {mine.map((s) => (
                    <div key={s.id} className="glass hairline group rounded-2xl p-4">
                      <div className="flex items-start gap-3">
                        <span className="grid size-10 place-items-center rounded-xl bg-grad text-white">
                          <FileJson className="size-4.5" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[13.5px] font-semibold">{s.name}</div>
                          <div className="line-clamp-2 text-[12px] text-fg-3">{s.description}</div>
                        </div>
                      </div>
                      <div className="mt-4 flex items-center gap-2 max-md:flex-wrap">
                        <Badge>{s.kind}</Badge>
                        <Badge>{s.bindings.length} inputs</Badge>
                        {s.estSeconds && <span className="text-[11px] text-fg-3">{formatEta(s.estSeconds)}</span>}
                        <div className="flex-1" />
                        <Button size="xs" variant="ghost" className="max-md:h-9 max-md:px-3" icon={<Trash2 className="size-3" />} onClick={() => void db.remove('skills', s.id).then(() => useGen.getState().refreshRecipes())}>
                          Remove
                        </Button>
                        <Button size="sm" variant="primary" className="max-md:h-9 max-md:px-4" icon={<Play className="size-3" />} onClick={() => setRunning(s)}>
                          Run
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <EmptyState icon={<FileJson />} title="No custom skills yet" body="Turn any ComfyUI workflow into a one-click skill." action={<Button variant="primary" icon={<Sparkles className="size-3.5" />} onClick={() => setImporting(true)}>Create new</Button>} />
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <ImportDialog open={importing} onClose={() => setImporting(false)} />
      <RunDialog skill={running} onClose={() => setRunning(null)} />
    </Page>
  )
}
