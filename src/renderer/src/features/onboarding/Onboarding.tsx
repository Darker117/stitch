// First-run welcome: detect engines, pick a GPU layout and a look.
import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ArrowRight, Check, Cpu, Film, MessageSquareText, Sparkles } from 'lucide-react'
import type { DetectResult } from '@shared/ipc'
import type { LlmConnector } from '@shared/types'
import { SUNSET } from '@shared/theme'
import { invoke } from '@/lib/api'
import { cn } from '@/lib/utils'
import { ease, rise, spring, stagger } from '@/lib/motion'
import { LogoLockup } from '@/components/shell/logo'
import { Button } from '@/components/ui/button'
import { Orb } from '@/components/ui/orb'
import { Spinner, StatusDot } from '@/components/ui/misc'
import { useCollection } from '@/stores/db'
import { useGen } from '@/stores/gen'
import { useAppSettings, useSettings } from '@/stores/settings'

const STEPS = ['welcome', 'engines', 'models', 'done'] as const
type Step = (typeof STEPS)[number]

function Row({ ok, busy, title, body }: { ok: boolean; busy?: boolean; title: string; body: string }): React.JSX.Element {
  return (
    <motion.div variants={rise} className="flex items-start gap-3 rounded-xl border border-line bg-white/[0.03] p-3.5">
      <div className="mt-0.5">{busy ? <Spinner className="size-4 text-fg-3" /> : <StatusDot state={ok ? 'online' : 'offline'} />}</div>
      <div>
        <div className="text-[13px] font-semibold">{title}</div>
        <div className="mt-0.5 text-[12px] text-fg-3">{body}</div>
      </div>
    </motion.div>
  )
}

export function Onboarding(): React.JSX.Element | null {
  const settings = useAppSettings()
  const update = useSettings((s) => s.update)
  const comfy = useGen((s) => s.comfy)
  const connectors = useCollection('connectors')
  const [step, setStep] = useState<Step>('welcome')
  const [detect, setDetect] = useState<DetectResult | null>(null)
  const [layout, setLayout] = useState<'managed-all' | 'managed-one' | 'external'>('managed-all')

  useEffect(() => {
    void invoke('sys:detect').then((d) => {
      setDetect(d)
      if (d.gpus.length < 2) setLayout('managed-one')
    })
  }, [])

  if (settings.onboardingDone) return null

  const comfyOnline = comfy.some((c) => c.online)
  const llms = connectors.filter((c): c is LlmConnector => c.category === 'llm' && !!c.models?.length)
  const next = (): void => setStep(STEPS[Math.min(STEPS.length - 1, STEPS.indexOf(step) + 1)])

  const finish = async (): Promise<void> => {
    if (layout !== 'external' && detect?.stabilityMatrix?.comfyDir) {
      const enabled = layout === 'managed-all' ? detect.gpus.map((g) => g.index) : detect.gpus.slice(0, 1).map((g) => g.index)
      // Heaviest work (video) on the biggest card, everything else on the other.
      const byVram = [...detect.gpus].filter((g) => enabled.includes(g.index)).sort((a, b) => b.memoryMB - a.memoryMB || b.index - a.index)
      const video = byVram[0]?.index
      const other = byVram[1]?.index ?? video
      await update({
        gpu: { managed: true, enabled, assign: { video: video ?? 'auto', image: other ?? 'auto', audio: other ?? 'auto', voice: other ?? 'auto' } },
        comfyAutoLaunch: true,
        onboardingDone: true
      })
      await invoke('gpu:apply')
    } else {
      await update({ onboardingDone: true, theme: { accent: SUNSET.accent, accent2: SUNSET.accent2 } })
    }
  }

  return (
    <motion.div className="fixed inset-0 z-[80] grid place-items-center bg-black/60 backdrop-blur-xl" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.5, ease }}>
      <div className="drag absolute inset-x-0 top-0 h-10" />
      <motion.div initial={{ opacity: 0, y: 20, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ ...spring, delay: 0.1 }} className="glass-strong relative w-[620px] overflow-hidden rounded-[26px] shadow-[var(--shadow-pop)]">
        <div className="pointer-events-none absolute -top-32 left-1/2 size-80 -translate-x-1/2 rounded-full bg-grad opacity-20 blur-3xl" />
        <div className="relative flex gap-1.5 px-7 pt-6">
          {STEPS.map((s, i) => (
            <div key={s} className="h-1 flex-1 overflow-hidden rounded-full bg-white/10">
              <motion.div className="h-full bg-grad" initial={false} animate={{ width: STEPS.indexOf(step) >= i ? '100%' : '0%' }} transition={{ duration: 0.5, ease }} />
            </div>
          ))}
        </div>
        <div className="relative min-h-[420px] px-7 pt-6 pb-7">
          <AnimatePresence mode="wait">
            {step === 'welcome' && (
              <motion.div key="w" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} transition={{ duration: 0.35, ease }} className="flex flex-col items-center pt-4 text-center">
                <Orb size={120} />
                <div className="label-caps mt-3">Welcome to</div>
                <LogoLockup height={46} className="mt-3 text-fg" />
                <p className="mt-3 max-w-md text-[13.5px] leading-relaxed text-fg-2">
                  Lock characters, direct scenes with native sound, voice every line and play stories that illustrate themselves — all on your own GPUs.
                </p>
                <Button variant="primary" size="lg" className="mt-8" iconRight={<ArrowRight className="size-4" />} onClick={next}>
                  Get started
                </Button>
              </motion.div>
            )}
            {step === 'engines' && (
              <motion.div key="e" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} transition={{ duration: 0.35, ease }}>
                <h2 className="display flex items-center gap-2 text-[22px]">
                  <Cpu className="size-5 text-accent" /> Your generation engine
                </h2>
                <p className="mt-1.5 text-[12.5px] text-fg-3">Stitch drives ComfyUI for images, H3 video and audio.</p>
                <motion.div variants={stagger(0.05)} initial="initial" animate="animate" className="mt-5 space-y-2">
                  <Row ok={!!detect?.stabilityMatrix?.comfyDir} busy={!detect} title="Stability Matrix ComfyUI" body={detect?.stabilityMatrix?.comfyDir ?? 'Not found — you can point Stitch at ComfyUI later in Settings.'} />
                  <Row ok={!!detect?.gpus.length} busy={!detect} title={`${detect?.gpus.length ?? 0} NVIDIA GPU${detect?.gpus.length === 1 ? '' : 's'}`} body={detect?.gpus.map((g) => `${g.name.replace('NVIDIA GeForce ', '')} (${Math.round(g.memoryMB / 1024)} GB)`).join(' · ') || '—'} />
                  <Row ok={comfyOnline} title="ComfyUI server" body={comfyOnline ? `Running on ${comfy.find((c) => c.online)?.gpu ?? 'GPU'}` : 'Not running right now'} />
                </motion.div>
                <div className="label-caps mt-6 mb-2">How should Stitch run ComfyUI?</div>
                <div className="space-y-2">
                  {(
                    [
                      { v: 'managed-all', t: 'Use all my GPUs', d: 'Stitch starts one ComfyUI per GPU — video on the biggest card, images and voice on the other.', show: (detect?.gpus.length ?? 0) > 1 },
                      { v: 'managed-one', t: 'Use one GPU', d: 'Stitch starts and manages a single ComfyUI for you.', show: true },
                      { v: 'external', t: "I'll run ComfyUI myself", d: 'Keep launching it from Stability Matrix (port 8188).', show: true }
                    ] as const
                  )
                    .filter((o) => o.show)
                    .map((o) => (
                      <button key={o.v} onClick={() => setLayout(o.v)} className={cn('flex w-full items-center gap-3 rounded-xl border p-3.5 text-left transition-colors', layout === o.v ? 'border-[color-mix(in_oklab,var(--accent)_50%,transparent)] bg-[color-mix(in_oklab,var(--accent)_8%,transparent)]' : 'border-line hover:bg-white/[0.04]')}>
                        <span className={cn('grid size-5 place-items-center rounded-full border', layout === o.v ? 'border-transparent bg-grad' : 'border-line-strong')}>{layout === o.v && <Check className="size-3 text-white" strokeWidth={3} />}</span>
                        <div>
                          <div className="text-[13px] font-semibold">{o.t}</div>
                          <div className="text-[12px] text-fg-3">{o.d}</div>
                        </div>
                      </button>
                    ))}
                </div>
                <div className="mt-6 flex justify-end">
                  <Button variant="primary" iconRight={<ArrowRight className="size-4" />} onClick={next}>
                    Continue
                  </Button>
                </div>
              </motion.div>
            )}
            {step === 'models' && (
              <motion.div key="m" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} transition={{ duration: 0.35, ease }}>
                <h2 className="display flex items-center gap-2 text-[22px]">
                  <MessageSquareText className="size-5 text-accent" /> Story & chat models
                </h2>
                <p className="mt-1.5 text-[12.5px] text-fg-3">Local servers are connected automatically. Add cloud keys any time under Connectors.</p>
                <motion.div variants={stagger(0.05)} initial="initial" animate="animate" className="mt-5 space-y-2">
                  {connectors
                    .filter((c): c is LlmConnector => c.category === 'llm')
                    .map((c) => (
                      <Row key={c.id} ok={!!c.models?.length} title={c.name} body={c.models?.length ? `${c.models.length} models ready — e.g. ${c.models[0].id}` : 'Not running (optional)'} />
                    ))}
                </motion.div>
                {!llms.length && <p className="mt-4 text-[12px] text-warning">No text model is running. Start LM Studio or Ollama, or add an OpenAI / Anthropic / OpenRouter key under Connectors.</p>}
                <div className="mt-6 flex justify-end">
                  <Button variant="primary" iconRight={<ArrowRight className="size-4" />} onClick={next}>
                    Continue
                  </Button>
                </div>
              </motion.div>
            )}
            {step === 'done' && (
              <motion.div key="d" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} transition={{ duration: 0.35, ease }} className="flex flex-col items-center pt-6 text-center">
                <motion.div initial={{ scale: 0.6, rotate: -20 }} animate={{ scale: 1, rotate: 0 }} transition={spring} className="grid size-16 place-items-center rounded-2xl bg-grad text-white shadow-lg">
                  <Sparkles className="size-7" />
                </motion.div>
                <h2 className="display mt-5 text-[26px]">You're all set</h2>
                <p className="mt-2 max-w-sm text-[13px] text-fg-2">
                  {layout === 'external' ? 'Start ComfyUI from Stability Matrix whenever you want to generate.' : 'Stitch will start ComfyUI on your GPUs now and every time it opens.'} Make it yours with a Wallpaper Engine background in Settings → Appearance.
                </p>
                <div className="mt-8 flex gap-2">
                  <Button variant="primary" size="lg" icon={<Film className="size-4" />} onClick={() => void finish()}>
                    Start creating
                  </Button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>
    </motion.div>
  )
}
