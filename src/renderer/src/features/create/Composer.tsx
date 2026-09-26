// The prompt box from the reference: attach / project / ask-first on the left,
// mic + send on the right, a live waveform bar while recording. On phones the left-hand
// controls fold into a "+" sheet and only active options stay visible as chips.
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ArrowUp, Check, CircleOff, FolderOpen, Hand, Layers, Mic, Paperclip, Plus, Square, Upload, X } from 'lucide-react'
import type { Asset, ID } from '@shared/types'
import { cn } from '@/lib/utils'
import { rise, spring, springSnappy, stagger } from '@/lib/motion'
import { isTouch, useCompact } from '@/lib/platform'
import { ACCEPT, AssetPicker, AssetThumb, DropZone, importFiles } from '@/components/media'
import { Switch } from '@/components/ui/controls'
import { Textarea } from '@/components/ui/input'
import { Dialog, Menu, MenuItem, MenuSeparator } from '@/components/ui/overlay'
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

function SheetRow({ icon, title, body, onClick, right, active, plain }: { icon: React.ReactNode; title: React.ReactNode; body?: React.ReactNode; onClick?: () => void; right?: React.ReactNode; active?: boolean; plain?: boolean }): React.JSX.Element {
  return (
    <motion.button
      variants={rise}
      whileTap={{ scale: 0.98 }}
      transition={springSnappy}
      onClick={onClick}
      className={cn('flex min-h-13 w-full items-center gap-3 rounded-2xl px-2.5 py-2 text-left transition-colors active:bg-white/[0.06]', active && 'bg-white/[0.05]')}
    >
      <span className={cn('grid size-9 shrink-0 place-items-center rounded-xl border [&>svg]:size-4', active && !plain ? 'border-transparent bg-grad text-white' : 'border-line bg-white/[0.05] text-fg-2')}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] font-medium">{title}</span>
        {body && <span className="block truncate text-[11.5px] text-fg-3">{body}</span>}
      </span>
      {right}
    </motion.button>
  )
}

/** Phone: attach / project / ask-first live in one bottom sheet behind the "+" button. */
function OptionsSheet({
  open,
  onClose,
  onLibrary,
  onUpload,
  askFirst,
  onAskFirst,
  projectId,
  onProject
}: {
  open: boolean
  onClose: () => void
  onLibrary: () => void
  onUpload: () => void
  askFirst: boolean
  onAskFirst: (v: boolean) => void
  projectId?: ID
  onProject?: (id: ID | undefined) => void
}): React.JSX.Element {
  const projects = useCollection('projects')
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} title="Add to your message">
      <motion.div variants={stagger(0.03, 0.08)} initial="initial" animate="animate" className="flex flex-col gap-1 px-2.5 pt-2 pb-4">
        <SheetRow icon={<FolderOpen />} title="Choose from your library" body="Images, videos and audio on your PC" onClick={onLibrary} />
        <SheetRow icon={<Upload />} title="Upload a file" body="Send a photo, clip or recording" onClick={onUpload} />
        <motion.label variants={rise} className="flex min-h-13 items-center gap-3 rounded-2xl px-2.5 py-2">
          <span className={cn('grid size-9 shrink-0 place-items-center rounded-xl border transition-colors [&>svg]:size-4', askFirst ? 'border-transparent bg-grad text-white' : 'border-line bg-white/[0.05] text-fg-2')}>
            <Hand />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[13.5px] font-medium">Ask before generating</span>
            <span className="block text-[11.5px] text-fg-3">Approve each image, video or voice line first</span>
          </span>
          <Switch checked={askFirst} onChange={onAskFirst} />
        </motion.label>
        {onProject && (
          <>
            <motion.div variants={rise} className="label-caps px-2.5 pt-3 pb-1">
              Project
            </motion.div>
            <SheetRow icon={<CircleOff />} title="No project" body="Results go to your general library" plain active={!projectId} right={!projectId && <Check className="size-4 text-accent" />} onClick={() => onProject(undefined)} />
            {projects.map((p) => (
              <SheetRow key={p.id} icon={<Layers />} title={p.name} active={projectId === p.id} right={projectId === p.id && <Check className="size-4 text-accent" />} onClick={() => onProject(p.id)} />
            ))}
          </>
        )}
      </motion.div>
    </Dialog>
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
    /** Docked under a chat transcript: starts as a single line on phones. */
    docked?: boolean
  }
>(function Composer({ onSend, running, onStop, askFirst, onAskFirst, projectId, onProject, placeholder = 'Ask anything, or describe what to create…', autoFocus, className, docked }, ref) {
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<ID[]>([])
  const [picker, setPicker] = useState(false)
  const [sheet, setSheet] = useState(false)
  const [focused, setFocused] = useState(false)
  const compact = useCompact()
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

  const upload = async (): Promise<void> => {
    const paths = await invoke('sys:pickFiles', { multi: true, filters: [{ name: 'Media', extensions: [...ACCEPT.image, ...ACCEPT.video, ...ACCEPT.audio] }] })
    if (!paths.length) return
    const imported = await importFiles(paths)
    setAttachments((x) => [...x, ...imported.map((a) => a.id)])
  }

  const micButton = (
    <motion.button
      whileTap={{ scale: 0.9 }}
      onClick={() => (recorder.recording ? recorder.stop(true) : recorder.start())}
      className={cn('grid size-8.5 place-items-center rounded-full border border-line transition-colors max-md:size-9.5 max-md:shrink-0', recorder.recording ? 'bg-danger/20 text-danger' : 'bg-white/[0.04] text-fg-2 hover:bg-white/[0.08] hover:text-fg')}
      title="Record audio"
    >
      <Mic className="size-4" />
    </motion.button>
  )

  const sendButton = (
    <AnimatePresence mode="popLayout" initial={false}>
      {running ? (
        <motion.button key="stop" initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.6, opacity: 0 }} transition={springSnappy} onClick={onStop} className="grid size-8.5 place-items-center rounded-full bg-white text-[#111] max-md:size-9.5 max-md:shrink-0" title="Stop">
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
          className="grid size-8.5 place-items-center rounded-full bg-grad text-white shadow-[0_6px_20px_-6px_color-mix(in_oklab,var(--accent)_80%,transparent)] transition-opacity disabled:opacity-35 max-md:size-9.5 max-md:shrink-0"
          title="Send (Enter)"
        >
          <ArrowUp className="size-4" strokeWidth={2.5} />
        </motion.button>
      )}
    </AnimatePresence>
  )

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <AnimatePresence initial={false}>
        {recorder.recording && (
          <motion.div
            initial={{ opacity: 0, y: 8, height: 0 }}
            animate={{ opacity: 1, y: 0, height: compact ? 48 : 44 }}
            exit={{ opacity: 0, y: 6, height: 0 }}
            transition={spring}
            className="glass hairline flex items-center gap-3 overflow-hidden rounded-xl px-3"
          >
            <span className="flex items-center gap-2 text-[12px] text-fg-2">
              <span className="size-2 animate-pulse rounded-full bg-danger" /> Recording…
            </span>
            <div className="flex h-6 min-w-0 flex-1 items-center justify-center gap-[2px] overflow-hidden">
              {recorder.levels.map((l, i) => (
                <span key={i} className="w-[3px] rounded-full bg-gradient-to-t from-[var(--accent-2)] to-[var(--accent)] transition-[height] duration-75" style={{ height: `${Math.round(l * 100)}%`, opacity: 0.35 + l * 0.65 }} />
              ))}
            </div>
            <button onClick={() => recorder.stop(false)} className="grid size-7 shrink-0 place-items-center rounded-full text-fg-3 hover:bg-white/10 hover:text-fg max-md:size-9" title="Discard">
              <X className="size-3.5" />
            </button>
            <button onClick={() => recorder.stop(true)} className="grid size-7 shrink-0 place-items-center rounded-full bg-white/[0.1] text-fg hover:bg-white/[0.16] max-md:size-9" title="Attach recording">
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
                          <button onClick={() => setAttachments((x) => x.filter((y) => y !== id))} className="absolute top-0.5 right-0.5 grid size-5 place-items-center rounded-md bg-black/60 text-white opacity-0 transition group-hover:opacity-100 max-md:size-6 max-md:rounded-full max-md:opacity-100">
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
            minRows={compact && docked ? 1 : 2}
            maxRows={compact ? 7 : 12}
            value={text}
            placeholder={placeholder}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              // Touch keyboards have no Shift+Enter: there Enter adds a line and the send button sends.
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !isTouch) {
                e.preventDefault()
                if (!running) submit()
              }
            }}
            className="px-4 pt-3.5 text-[14px] leading-relaxed max-md:px-3.5 max-md:pt-3 max-md:text-[15px]"
          />
          {compact ? (
            <div className="flex items-center gap-1.5 px-2.5 pt-1 pb-2.5">
              <motion.button
                whileTap={{ scale: 0.9 }}
                transition={springSnappy}
                onClick={() => setSheet(true)}
                aria-label="Attach, project and options"
                className={cn('grid size-9.5 shrink-0 place-items-center rounded-full border border-line bg-white/[0.04] text-fg-2 transition-colors', sheet && 'bg-white/[0.1] text-fg')}
              >
                <motion.span animate={{ rotate: sheet ? 45 : 0 }} transition={springSnappy} className="grid place-items-center">
                  <Plus className="size-[18px]" />
                </motion.span>
              </motion.button>
              <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto [scrollbar-width:none]! [mask-image:linear-gradient(90deg,#000_calc(100%-14px),transparent)] [&::-webkit-scrollbar]:hidden">
                <AnimatePresence initial={false} mode="popLayout">
                  {project && (
                    <motion.span key="project" layout initial={{ opacity: 0, scale: 0.85 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.85 }} transition={springSnappy} className="shrink-0">
                      <Pill icon={<Layers />} active onClick={() => setSheet(true)} className="h-8 max-w-[150px]">
                        <span className="truncate">{project.name}</span>
                      </Pill>
                    </motion.span>
                  )}
                  {askFirst && (
                    <motion.span key="ask" layout initial={{ opacity: 0, scale: 0.85 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.85 }} transition={springSnappy} className="shrink-0">
                      <Pill icon={<Hand />} active onClick={() => onAskFirst(false)} className="h-8 whitespace-nowrap">
                        Ask first
                        <X className="text-fg-3" />
                      </Pill>
                    </motion.span>
                  )}
                </AnimatePresence>
              </div>
              {micButton}
              {sendButton}
            </div>
          ) : (
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
              {micButton}
              {sendButton}
            </div>
          )}
        </div>
      </DropZone>
      <AssetPicker open={picker} onClose={() => setPicker(false)} kinds={['image', 'video', 'audio']} multiple onPick={(a) => setAttachments((x) => [...x, ...a.map((y) => y.id)])} />
      {compact && (
        <OptionsSheet
          open={sheet}
          onClose={() => setSheet(false)}
          onLibrary={() => {
            setSheet(false)
            setTimeout(() => setPicker(true), 180)
          }}
          onUpload={() => {
            setSheet(false)
            void upload()
          }}
          askFirst={askFirst}
          onAskFirst={onAskFirst}
          projectId={projectId}
          onProject={
            onProject &&
            ((id) => {
              onProject(id)
              setSheet(false)
            })
          }
        />
      )}
    </div>
  )
})
