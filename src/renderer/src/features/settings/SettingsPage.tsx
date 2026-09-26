import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { AnimatePresence, motion } from 'motion/react'
import { Cpu, FolderCog, Info, Palette, SlidersHorizontal, Smartphone, Sparkles } from 'lucide-react'
import type { DetectResult } from '@shared/ipc'
import { invoke } from '@/lib/api'
import { cn } from '@/lib/utils'
import { ease, spring } from '@/lib/motion'
import { useCompact } from '@/lib/platform'
import { Page } from '@/components/shell/page'
import { LogoLockup } from '@/components/shell/logo'
import { ModelPicker } from '@/components/model-picker'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Field, SectionTitle } from '@/components/ui/misc'
import { Select } from '@/components/ui/overlay'
import { useCollection } from '@/stores/db'
import { useAppSettings, useSettings } from '@/stores/settings'
import { useUpdate } from '@/stores/update'
import { ModelStorageSettings } from '../models/StorageSettings'
import { AppearanceSettings } from './AppearanceSettings'
import { GpuSettings } from './GpuSettings'
import { PhoneSettings } from './PhoneSettings'
import { ProfileSettings } from './ProfileSettings'
import { UpdateSettings } from './UpdateSettings'

type Tab = 'general' | 'appearance' | 'gpus' | 'storage' | 'phone' | 'updates' | 'about'

const TABS: { value: Tab; label: string; icon: React.ReactNode }[] = [
  { value: 'general', label: 'General', icon: <SlidersHorizontal /> },
  { value: 'appearance', label: 'Appearance', icon: <Palette /> },
  { value: 'gpus', label: 'GPUs', icon: <Cpu /> },
  { value: 'storage', label: 'Models & storage', icon: <FolderCog /> },
  { value: 'phone', label: 'Phone', icon: <Smartphone /> },
  { value: 'updates', label: 'Updates', icon: <Sparkles /> },
  { value: 'about', label: 'About', icon: <Info /> }
]

function PathRow({ label, help, value, placeholder, onPick, onClear }: { label: string; help?: string; value?: string; placeholder?: string; onPick: () => void; onClear?: () => void }): React.JSX.Element {
  return (
    <Field label={label} help={help}>
      <div className="flex gap-2">
        <Input readOnly value={value ?? ''} placeholder={placeholder} className="flex-1 font-mono text-[12px]" />
        <Button onClick={onPick}>Browse</Button>
        {onClear && value && (
          <Button variant="ghost" onClick={onClear}>
            Clear
          </Button>
        )}
      </div>
    </Field>
  )
}

function General(): React.JSX.Element {
  const settings = useAppSettings()
  const update = useSettings((s) => s.update)
  const connectors = useCollection('connectors')
  const voices = connectors.filter((c) => c.category === 'voice')
  return (
    <div className="space-y-6">
      <ProfileSettings />
      <SectionTitle>General</SectionTitle>
      <Field label="Default text model" help="Used by chat, stories and prompt enhancement unless you pick another.">
        <div>
          <ModelPicker value={settings.defaultLlm} onChange={(defaultLlm) => void update({ defaultLlm })} />
        </div>
      </Field>
      <Field label="Default voice provider">
        <Select
          value={settings.defaultVoice?.connectorId ?? ''}
          onChange={(connectorId) => void update({ defaultVoice: { connectorId } })}
          options={voices.map((v) => ({ value: v.id, label: v.name }))}
          placeholder="Stitch Voice (local)"
        />
      </Field>
    </div>
  )
}

function Storage(): React.JSX.Element {
  const settings = useAppSettings()
  const update = useSettings((s) => s.update)
  const [detect, setDetect] = useState<DetectResult | null>(null)
  useEffect(() => {
    void invoke('sys:detect').then(setDetect)
  }, [])
  const pickFolder = async (title: string, defaultPath?: string): Promise<string | null> => invoke('sys:pickFolder', { title, defaultPath })
  return (
    <div className="space-y-6 max-md:[overflow-wrap:anywhere]">
      <SectionTitle>Models & storage</SectionTitle>
      {detect?.stabilityMatrix && (
        <div className="rounded-xl border border-success/20 bg-success/[0.06] p-3.5 text-[12.5px] text-fg-2">
          <b className="text-success">Stability Matrix detected.</b> ComfyUI at <span className="font-mono text-[11.5px]">{detect.stabilityMatrix.comfyDir ?? '—'}</span>, shared models in <span className="font-mono text-[11.5px]">{detect.stabilityMatrix.modelsDir}</span>.
        </div>
      )}
      <PathRow
        label="Models folder (optional)"
        help="Point Stitch at another folder of models (Stability Matrix-style or ComfyUI-style layout). Stitch adds it to the ComfyUI instances it runs, uses it to check which recipes are installed, and downloads new models into it."
        value={settings.modelsDir}
        placeholder={detect?.stabilityMatrix?.modelsDir ?? 'Using ComfyUI’s own folders'}
        onPick={async () => {
          const p = await pickFolder('Choose your models folder', settings.modelsDir ?? detect?.stabilityMatrix?.modelsDir)
          if (p) await update({ modelsDir: p })
        }}
        onClear={() => void update({ modelsDir: '' })}
      />
      <ModelStorageSettings />
      <PathRow
        label="ComfyUI folder"
        help="Used when Stitch launches ComfyUI itself. Detected from Stability Matrix automatically."
        value={settings.comfyDir}
        placeholder={detect?.stabilityMatrix?.comfyDir ?? 'Not found'}
        onPick={async () => {
          const p = await pickFolder('Choose the ComfyUI folder (contains main.py)', settings.comfyDir ?? detect?.stabilityMatrix?.comfyDir)
          if (p) await update({ comfyDir: p })
        }}
        onClear={() => void update({ comfyDir: '' })}
      />
      <PathRow
        label="Library folder"
        help="Where your generations, voice lines and exports are saved."
        value={settings.libraryDir}
        onPick={async () => {
          const p = await pickFolder('Choose the library folder', settings.libraryDir)
          if (p) await update({ libraryDir: p })
        }}
      />
      <Field label="ffmpeg" help={detect?.ffmpeg ? `Found: ${detect.ffmpeg}` : 'Needed for video posters and Studio export. Install with: winget install Gyan.FFmpeg'}>
        <div className="flex gap-2">
          <Input readOnly value={settings.ffmpegPath ?? detect?.ffmpeg ?? ''} placeholder="Not found" className="flex-1 font-mono text-[12px]" />
          <Button
            onClick={async () => {
              const [p] = await invoke('sys:pickFiles', { title: 'Locate ffmpeg.exe', filters: [{ name: 'ffmpeg', extensions: ['exe'] }] })
              if (p) await update({ ffmpegPath: p })
            }}
          >
            Browse
          </Button>
        </div>
      </Field>
      <div>
        <Button variant="ghost" onClick={() => invoke('sys:openPath', settings.libraryDir)}>
          Open library folder
        </Button>
      </div>
    </div>
  )
}

function About({ onUpdates }: { onUpdates: () => void }): React.JSX.Element {
  const update = useUpdate((s) => s.state)
  const init = useUpdate((s) => s.init)
  useEffect(() => {
    void init()
  }, [init])
  return (
    <div className="flex flex-col items-center gap-4 py-10 text-center">
      <LogoLockup height={88} className="text-fg" />
      <div className="flex items-center gap-2 text-[12.5px] text-fg-3">
        Version {update?.current ?? '—'}
        <span className="text-fg-3/50">·</span>
        <button onClick={onUpdates} className="font-medium text-fg-2 transition hover:text-fg">
          Check for updates
        </button>
      </div>
      <p className="max-w-md text-[13px] text-fg-2">A local studio for consistent characters, scenes, video, music and voices — stitched into stories you can play.</p>
    </div>
  )
}

export function SettingsPage(): React.JSX.Element {
  const [params, setParams] = useSearchParams()
  const updateReady = useUpdate((s) => s.state?.status === 'downloaded' || s.state?.status === 'available')
  const tab = (TABS.find((t) => t.value === params.get('tab'))?.value ?? 'general') as Tab
  const compact = useCompact()
  const rail = useRef<HTMLDivElement>(null)
  // Phone: the tab row scrolls sideways — keep the active pill in view.
  useEffect(() => {
    if (!compact) return
    const el = rail.current?.querySelector<HTMLElement>(`[data-tab="${tab}"]`)
    el?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' })
  }, [tab, compact])
  return (
    <Page scroll={false} className="flex max-md:flex-col">
      <nav className="w-[220px] shrink-0 border-r border-line p-4 max-md:w-full max-md:border-r-0 max-md:border-b max-md:px-0 max-md:pt-5 max-md:pb-3">
        <div className="display px-2 pb-4 text-[20px] max-md:px-4 max-md:pb-3 max-md:text-[23px]">Settings</div>
        <div ref={rail} className="max-md:flex max-md:gap-1.5 max-md:overflow-x-auto max-md:px-4 max-md:[scrollbar-width:none]">
          {TABS.map((t) => (
            <button
              key={t.value}
              data-tab={t.value}
              onClick={() => setParams({ tab: t.value }, { replace: compact })}
              className={cn(
                'relative flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-[13px] font-medium transition-colors',
                'max-md:h-10 max-md:w-auto max-md:shrink-0 max-md:gap-2 max-md:rounded-full max-md:border max-md:px-3.5 max-md:whitespace-nowrap',
                tab === t.value ? 'text-fg max-md:border-transparent' : 'text-fg-2 hover:text-fg max-md:border-line max-md:bg-white/[0.03]'
              )}
            >
              {tab === t.value && <motion.span layoutId="settings-tab" className="absolute inset-0 rounded-lg border border-line bg-white/[0.07] max-md:rounded-full max-md:border-[color-mix(in_oklab,var(--accent)_45%,transparent)] max-md:bg-[color-mix(in_oklab,var(--accent)_14%,transparent)]" transition={spring} />}
              <span className="relative [&>svg]:size-4">{t.icon}</span>
              <span className="relative">{t.label}</span>
              {t.value === 'updates' && updateReady && <span className="relative ml-auto size-1.5 rounded-full bg-accent shadow-[0_0_8px_var(--accent)]" />}
            </button>
          ))}
        </div>
      </nav>
      <div className="min-w-0 flex-1 overflow-y-auto max-md:min-h-0">
        <AnimatePresence mode="wait">
          <motion.div key={tab} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.28, ease }} className="mx-auto max-w-[860px] px-10 py-8 max-md:px-4 max-md:pt-5 max-md:pb-10">
            {tab === 'general' && <General />}
            {tab === 'appearance' && <AppearanceSettings />}
            {tab === 'gpus' && <GpuSettings />}
            {tab === 'storage' && <Storage />}
            {tab === 'phone' && <PhoneSettings />}
            {tab === 'updates' && <UpdateSettings />}
            {tab === 'about' && <About onUpdates={() => setParams({ tab: 'updates' })} />}
          </motion.div>
        </AnimatePresence>
      </div>
    </Page>
  )
}
