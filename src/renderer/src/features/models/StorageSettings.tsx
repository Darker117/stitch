// Settings → Models & storage: the default models path (and how it's
// chosen), folders added through installs, making a ComfyUI you run
// yourself see Stitch's folders, and the Hugging Face token.
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { AnimatePresence, motion } from 'motion/react'
import { ArrowRight, Check, Copy, FolderOpen, Info, Unlink } from 'lucide-react'
import type { ModelsHome } from '@shared/types'
import { errorText, invoke, on } from '@/lib/api'
import { ease } from '@/lib/motion'
import { Button, IconButton } from '@/components/ui/button'
import { Field } from '@/components/ui/misc'
import { useGen } from '@/stores/gen'
import { useAppSettings } from '@/stores/settings'
import { toast } from '@/stores/toast'
import { HfMark, HfTokenDialog, homeLabel, useHfStatus } from './install'

export function ModelStorageSettings(): React.JSX.Element {
  const settings = useAppSettings()
  const navigate = useNavigate()
  const comfy = useGen((s) => s.comfy)
  const [home, setHome] = useState<ModelsHome | null>(null)
  const [yaml, setYaml] = useState<string>('')
  const [showYaml, setShowYaml] = useState(false)
  const [tokenOpen, setTokenOpen] = useState(false)
  const { status: hf, reload: reloadHf } = useHfStatus()
  const extras = settings.extraModelDirs ?? []

  const load = useCallback(() => {
    void invoke('models:home').then(setHome)
    void invoke('models:comfyYaml').then(setYaml)
  }, [])
  useEffect(() => {
    load()
    return on('models:changed', load)
  }, [load, settings.modelsDir, settings.extraModelDirs, settings.comfyDir])

  const external = comfy.some((c) => !c.managed)
  const nothingToAdd = /nothing to add/i.test(yaml)

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(yaml)
      toast.success('ComfyUI paths copied', 'Paste them into ComfyUI/extra_model_paths.yaml and restart ComfyUI.')
    } catch (err) {
      toast.error('Could not copy', errorText(err))
    }
  }

  const forget = async (dir: string): Promise<void> => {
    try {
      await invoke('models:forgetDir', dir)
      toast.info('Folder forgotten', 'Its files stay on disk.')
    } catch (err) {
      toast.error('Could not forget the folder', errorText(err))
    }
  }

  return (
    <div className="space-y-6">
      <Field
        label="Default models path"
        help="New downloads (Download model, Civitai) go here: the models folder above if you chose one, else Stability Matrix’s shared Models folder, else Stitch’s own folder in ComfyUI layout."
      >
        <div className="glass hairline flex items-center gap-3 rounded-xl px-3.5 py-3">
          <div className="min-w-0 flex-1">
            <div className="truncate font-mono text-[12px] text-fg" title={home?.path}>
              {home?.path ?? '…'}
            </div>
            {home && (
              <div className="mt-0.5 text-[11px] text-fg-3">
                {homeLabel(home.source)} · {home.layout === 'stability-matrix' ? 'Stability Matrix folder names (DiffusionModels, TextEncoders, VAE, Lora…)' : 'ComfyUI folder names (diffusion_models, text_encoders, vae, loras…)'}
              </div>
            )}
          </div>
          {home && (
            <IconButton label="Open folder" size="sm" onClick={() => void invoke('sys:openPath', home.path).catch(() => toast.info('Not created yet', 'It appears with the first download.'))}>
              <FolderOpen className="size-3.5" />
            </IconButton>
          )}
          <Button size="sm" variant="ghost" iconRight={<ArrowRight className="size-3.5" />} onClick={() => navigate('/models?tab=manage')}>
            Model manager
          </Button>
        </div>
      </Field>

      {extras.length > 0 && (
        <Field label="Added model folders" help="Folders you installed models into. Stitch lists their models and hands them to the ComfyUI it runs.">
          <div className="divide-y divide-line rounded-xl border border-line">
            {extras.map((d) => (
              <div key={d} className="flex items-center gap-2 px-3.5 py-2">
                <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg-2" title={d}>
                  {d}
                </span>
                <IconButton label="Open folder" size="xs" onClick={() => void invoke('sys:openPath', d)}>
                  <FolderOpen className="size-3.5" />
                </IconButton>
                <IconButton label="Forget (files stay)" size="xs" onClick={() => void forget(d)}>
                  <Unlink className="size-3.5" />
                </IconButton>
              </div>
            ))}
          </div>
        </Field>
      )}

      <Field label="ComfyUI you run yourself">
        <div className="rounded-xl border border-line p-3.5 text-[12.5px] leading-relaxed text-fg-2">
          {nothingToAdd ? (
            <div className="flex items-start gap-2">
              <Check className="mt-0.5 size-3.5 shrink-0 text-success" />
              <span>Your ComfyUI already reads every folder Stitch downloads into — nothing to set up.</span>
            </div>
          ) : (
            <>
              <div className="flex items-start gap-2">
                <Info className="mt-0.5 size-3.5 shrink-0 text-accent" />
                <span>
                  ComfyUI instances Stitch launches see all of Stitch’s model folders automatically.
                  {external ? ' The ComfyUI you run yourself doesn’t read' : ' A ComfyUI you run yourself wouldn’t read'} some of them yet: copy the paths, add them to <span className="font-mono text-[11.5px]">ComfyUI/extra_model_paths.yaml</span> and restart it.
                </span>
              </div>
              <div className="mt-3 flex gap-2">
                <Button size="sm" icon={<Copy className="size-3.5" />} onClick={() => void copy()}>
                  Copy ComfyUI paths
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setShowYaml((v) => !v)}>
                  {showYaml ? 'Hide' : 'Show'} YAML
                </Button>
              </div>
              <AnimatePresence initial={false}>
                {showYaml && (
                  <motion.pre
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.25, ease }}
                    className="selectable mt-3 max-h-56 overflow-auto rounded-lg bg-black/30 p-3 font-mono text-[11px] leading-relaxed text-fg-2"
                  >
                    {yaml}
                  </motion.pre>
                )}
              </AnimatePresence>
            </>
          )}
        </div>
      </Field>

      <Field label="Hugging Face" help="Only needed for gated models and higher rate limits. Stored encrypted; only sent to huggingface.co.">
        <div className="flex items-center gap-3 rounded-xl border border-line px-3.5 py-2.5">
          <HfMark size={24} />
          <span className="flex-1 text-[12.5px] text-fg-2">{hf?.hasToken ? (hf.username ? `Connected as ${hf.username}` : 'Token saved') : 'No token — public models download without one'}</span>
          <Button size="sm" onClick={() => setTokenOpen(true)}>
            {hf?.hasToken ? 'Change' : 'Add token'}
          </Button>
        </div>
      </Field>
      <HfTokenDialog
        open={tokenOpen}
        onOpenChange={(o) => {
          setTokenOpen(o)
          if (!o) reloadHf()
        }}
      />
    </div>
  )
}
