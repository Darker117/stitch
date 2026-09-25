// The prompt box from the reference: attach / project / ask-first on the left,
// mic + send on the right, a live waveform bar while recording.
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ArrowUp, Hand, Layers, Mic, Paperclip, Square, X } from 'lucide-react'
import type { Asset, ID } from '@shared/types'
import { cn } from '@/lib/utils'
import { spring, springSnappy } from '@/lib/motion'
import { AssetPicker, AssetThumb, DropZone } from '@/components/media'
import { Textarea } from '@/components/ui/input'
import { Menu, MenuItem, MenuSeparator } from '@/components/ui/overlay'
import { invoke } from '@/lib/api'
import { useCollection } from '@/stores/db'
import { toast } from '@/stores/toast'

export interface ComposerHandle {
  focus: () => void
  setText: (t: string) => void
}

function Pill({ icon, children, active, onClick, className }: { icon: React.ReactNode; children?: React.ReactNode; active?: boolean; onClick?: () => void; className?: string }): React.JSX.Element {
  return (
    <motion.button
      whileTap={{ scale: 0.95 }}
      transition={springSnappy}
      onClick={onClick}
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded-lg border px-2 text-[11.5px] font-medium transition-colors duration-200 [&>svg]:size-3.5',
        active ? 'border-[color-mix(in_oklab,var(--accent)_40%,transparent)] bg-[color-mix(in_oklab,var(--accent)_12%,transparent)] text-fg' : 'border-line bg-white/[0.03] text-fg-3 hover:border-line-strong hover:text-fg-2',
        className
      )}
    >
      {icon}
      {children}
    </motion.button>
  )
}

/** Mic capture with an analyser-driven waveform; saves the take as an audio asset. */
function useRecorder(onDone: (asset: Asset) => void): { recording: boolean; levels: number[]; start: () => void; stop: (keep: boolean) => void } {
  const [recording, setRecording] = useState(false)
  const [levels, setLevels] = useState<number[]>(() => Array(48).fill(0.05))
  const rec = useRef<{ mr: MediaRecorder; stream: MediaStream; ctx: AudioContext; raf: number; chunks: Blob[]; keep: boolean } | null>(null)

  const start = async (): Promise<void> => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const ctx = new AudioContext()
      const src = ctx.createMediaStreamSource(stream)
      const an = ctx.createAnalyser()
      an.fftSize = 256
      src.connect(an)
      const data = new Uint8Array(an.frequencyBinCount)
      const mr = new MediaRecorder(stream, { mimeType: 'audio/webm' })
      const state = { mr, stream, ctx, raf: 0, chunks: [] as Blob[], keep: true }
      rec.current = state
      mr.ondataavailable = (e) => e.data.size && state.chunks.push(e.data)
      mr.onstop = async () => {
        cancelAnimationFrame(state.raf)
        stream.getTracks().forEach((t) => t.stop())
        void ctx.close()
        setRecording(false)
        if (!state.keep || !state.chunks.length) return
        const bytes = new Uint8Array(await new Blob(state.chunks, { type: 'audio/webm' }).arrayBuffer())
        const asset = await invoke('assets:saveBytes', bytes, 'audio', 'webm', { name: 'Voice memo', source: 'imported' })
        onDone(asset)
      }
      mr.start()
      setRecording(true)
      let t = 0
      const tick = (): void => {
        state.raf = requestAnimationFrame(tick)
        if (++t % 3) return
        an.getByteTimeDomainData(data)
        let peak = 0
        for (const v of data) peak = Math.max(peak, Math.abs(v - 128) / 128)
        setLevels((l) => [...l.slice(1), Math.max(0.05, Math.min(1, peak * 2.4))])
      }
      tick()
    } catch {
      toast.error('Microphone unavailable', 'Allow microphone access in Windows privacy settings.')
    }
  }
  const stop = (keep: boolean): void => {
    if (!rec.current) return
    rec.current.keep = keep
    rec.current.mr.stop()
    rec.current = null
  }
  useEffect(() => () => stop(false), [])
  return { recording, levels, start: () => void start(), stop }
}

export const Composer = forwardRef<
  ComposerHandle,
  {
    onSend: (text: string, attachments: ID[]) => void
    running?: boolean
    onStop?: () => void
    askFirst: boolean
    onAskFirst: (v: boolean) => void
    projectId?: ID
    onProject?: (id: ID | undefined) => void
    placeholder?: string
    autoFocus?: boolean
    className?: string
  }
>(function Composer({ onSend, running, onStop, askFirst, onAskFirst, projectId, onProject, placeholder = 'Ask anything, or describe what to create…', autoFocus, className }, ref) {
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<ID[]>([])
  const [picker, setPicker] = useState(false)
  const [focused, setFocused] = useState(false)
  const input = useRef<HTMLTextAreaElement>(null)
  const assets = useCollection('assets')
  const projects = useCollection('projects')
  const project = projects.find((p) => p.id === projectId)
  const recorder = useRecorder((a) => setAttachments((x) => [...x, a.id]))

  useImperativeHandle(ref, () => ({
    focus: () => input.current?.focus(),
    setText: (t) => {
      setText(t)
      requestAnimationFrame(() => {
        input.current?.focus()
        input.current?.setSelectionRange(t.length, t.length)
      })
    }
  }))

  const submit = (): void => {
    const t = text.trim()
    if (!t && !attachments.length) return
    onSend(t, attachments)
    setText('')
    setAttachments([])
  }

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <AnimatePresence initial={false}>
        {recorder.recording && (
          <motion.div
            initial={{ opacity: 0, y: 8, height: 0 }}
            animate={{ opacity: 1, y: 0, height: 44 }}
            exit={{ opacity: 0, y: 6, height: 0 }}
            transition={spring}
            className="glass hairline flex items-center gap-3 overflow-hidden rounded-xl px-3"
          >
            <span className="flex items-center gap-2 text-[12px] text-fg-2">
              <span className="size-2 animate-pulse rounded-full bg-danger" /> Recording…
            </span>
            <div className="flex h-6 flex-1 items-center justify-center gap-[2px]">
              {recorder.levels.map((l, i) => (
                <span key={i} className="w-[3px] rounded-full bg-gradient-to-t from-[var(--accent-2)] to-[var(--accent)] transition-[height] duration-75" style={{ height: `${Math.round(l * 100)}%`, opacity: 0.35 + l * 0.65 }} />
              ))}
            </div>
            <button onClick={() => recorder.stop(false)} className="grid size-7 place-items-center rounded-full text-fg-3 hover:bg-white/10 hover:text-fg" title="Discard">
              <X className="size-3.5" />
            </button>
            <button onClick={() => recorder.stop(true)} className="grid size-7 place-items-center rounded-full bg-white/[0.1] text-fg hover:bg-white/[0.16]" title="Attach recording">
              <Square className="size-3 fill-current" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      <DropZone kinds={['image', 'video', 'audio']} onAssets={(a) => setAttachments((x) => [...x, ...a.map((y) => y.id)])} className="rounded-[18px]">
        <div
          data-active={focused || undefined}
          className={cn('glow-border glass hairline rounded-[18px] transition-[box-shadow] duration-500', focused && 'shadow-[0_18px_60px_-20px_color-mix(in_oklab,var(--accent)_45%,transparent)]')}
        >
          <AnimatePresence initial={false}>
            {attachments.length > 0 && (
              <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={spring} className="overflow-hidden">
                <div className="flex flex-wrap gap-2 px-3.5 pt-3">
                  {attachments.map((id) => {
                    const a = assets.find((x) => x.id === id)
                    if (!a) return null
                    return (
                      <motion.div key={id} layout initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={spring}>
                        <AssetThumb asset={a} className="size-14" rounded="rounded-lg" hoverPlay={false}>
                          <button onClick={() => setAttachments((x) => x.filter((y) => y !== id))} className="absolute top-0.5 right-0.5 grid size-5 place-items-center rounded-md bg-black/60 text-white opacity-0 transition group-hover:opacity-100">
                            <X className="size-3" />
                          </button>
                        </AssetThumb>
                      </motion.div>
                    )
                  })}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          <Textarea
            ref={input}
            bare
            autoFocus={autoFocus}
            minRows={2}
            maxRows={12}
            value={text}
            placeholder={placeholder}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                if (!running) submit()
              }
            }}
            className="px-4 pt-3.5 text-[14px] leading-relaxed"
          />
          <div className="flex items-center gap-1.5 px-3 pt-1 pb-3">
            <Pill icon={<Paperclip />} onClick={() => setPicker(true)}>
              Attach
            </Pill>
            {onProject && (
              <Menu
                trigger={
                  <span>
                    <Pill icon={<Layers />} active={!!project}>
                      {project?.name ?? 'No project'}
                    </Pill>
                  </span>
                }
              >
                <MenuItem onSelect={() => onProject(undefined)}>No project</MenuItem>
                {projects.length > 0 && <MenuSeparator />}
                {projects.map((p) => (
                  <MenuItem key={p.id} onSelect={() => onProject(p.id)}>
                    {p.name}
                  </MenuItem>
                ))}
              </Menu>
            )}
            <Pill icon={<Hand />} active={askFirst} onClick={() => onAskFirst(!askFirst)}>
              Ask before generating
            </Pill>
            <div className="flex-1" />
            <motion.button
              whileTap={{ scale: 0.9 }}
              onClick={() => (recorder.recording ? recorder.stop(true) : recorder.start())}
              className={cn('grid size-8.5 place-items-center rounded-full border border-line transition-colors', recorder.recording ? 'bg-danger/20 text-danger' : 'bg-white/[0.04] text-fg-2 hover:bg-white/[0.08] hover:text-fg')}
              title="Record audio"
            >
              <Mic className="size-4" />
            </motion.button>
            <AnimatePresence mode="popLayout" initial={false}>
              {running ? (
                <motion.button key="stop" initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.6, opacity: 0 }} transition={springSnappy} onClick={onStop} className="grid size-8.5 place-items-center rounded-full bg-white text-[#111]" title="Stop">
                  <Square className="size-3 fill-current" />
                </motion.button>
              ) : (
                <motion.button
                  key="send"
                  initial={{ scale: 0.6, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  exit={{ scale: 0.6, opacity: 0 }}
                  whileTap={{ scale: 0.9 }}
                  transition={springSnappy}
                  onClick={submit}
                  disabled={!text.trim() && !attachments.length}
                  className="grid size-8.5 place-items-center rounded-full bg-grad text-white shadow-[0_6px_20px_-6px_color-mix(in_oklab,var(--accent)_80%,transparent)] transition-opacity disabled:opacity-35"
                  title="Send (Enter)"
                >
                  <ArrowUp className="size-4" strokeWidth={2.5} />
                </motion.button>
              )}
            </AnimatePresence>
          </div>
        </div>
      </DropZone>
      <AssetPicker open={picker} onClose={() => setPicker(false)} kinds={['image', 'video', 'audio']} multiple onPick={(a) => setAttachments((x) => [...x, ...a.map((y) => y.id)])} />
    </div>
  )
})
