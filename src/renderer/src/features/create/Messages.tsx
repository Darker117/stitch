// Chat transcript: markdown replies, attachments and live tool cards.
import { memo, useEffect, useRef, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { AnimatePresence, motion } from 'motion/react'
import { AlertTriangle, AudioLines, BookOpen, Brain, Check, ChevronDown, Clapperboard, ImageIcon, Mic2, PenLine, ScanFace, Users, X } from 'lucide-react'
import { useNavigate } from 'react-router'
import type { ChatMessage, ChatToolCall, ID } from '@shared/types'
import { cn } from '@/lib/utils'
import { ease, spring } from '@/lib/motion'
import { AssetLightbox, AssetThumb } from '@/components/media'
import { Button } from '@/components/ui/button'
import { ProgressBar, Spinner } from '@/components/ui/misc'
import { Orb } from '@/components/ui/orb'
import { useCollection } from '@/stores/db'
import { useGen } from '@/stores/gen'

const TOOL_META: Record<string, { label: string; icon: React.ReactNode }> = {
  generate_image: { label: 'Generating image', icon: <ImageIcon /> },
  edit_image: { label: 'Editing image', icon: <PenLine /> },
  generate_video: { label: 'Generating video', icon: <Clapperboard /> },
  generate_audio: { label: 'Generating audio', icon: <AudioLines /> },
  speak: { label: 'Voicing line', icon: <Mic2 /> },
  list_characters: { label: 'Checking characters', icon: <Users /> },
  create_character: { label: 'Creating character', icon: <ScanFace /> },
  create_story: { label: 'Writing a story', icon: <BookOpen /> }
}

function parseResult(r?: string): { ok?: boolean; id?: string; title?: string; name?: string; error?: string } {
  try {
    return r ? JSON.parse(r) : {}
  } catch {
    return {}
  }
}

function ToolCard({ call, onApprove, pending, onOpen }: { call: ChatToolCall; onApprove?: (ok: boolean) => void; pending: boolean; onOpen: (id: ID) => void }): React.JSX.Element {
  const jobs = useGen((s) => s.jobs)
  const assets = useCollection('assets')
  const navigate = useNavigate()
  const meta = TOOL_META[call.name] ?? { label: call.name, icon: <Check /> }
  const callJobs = (call.jobIds ?? []).map((id) => jobs[id]).filter(Boolean)
  const outputs = callJobs.flatMap((j) => j.outputs).map((id) => assets.find((a) => a.id === id)).filter(Boolean)
  const res = parseResult(call.result)
  const prompt = String(call.args.prompt ?? call.args.instruction ?? call.args.text ?? call.args.name ?? call.args.title ?? '')
  const running = call.status === 'running'
  const active = callJobs.find((j) => j.status === 'running') ?? callJobs.find((j) => j.status === 'queued')
  const pct = active?.progress?.max ? active.progress.value / active.progress.max : undefined
  const voiceAsset = call.name === 'speak' && call.status === 'done' ? assets.find((a) => res && call.result?.includes(a.id)) : undefined

  return (
    <motion.div layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={spring} className="glass hairline overflow-hidden rounded-2xl">
      <div className="flex items-center gap-2.5 px-3.5 py-2.5 max-md:px-3">
        <span className={cn('grid size-7 shrink-0 place-items-center rounded-lg [&>svg]:size-3.5', call.status === 'error' ? 'bg-danger/15 text-danger' : 'bg-grad text-white')}>{meta.icon}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[12.5px] font-medium">
            {call.status === 'done' ? meta.label.replace(/^(\w+)ing\b/, (m) => ({ Generating: 'Generated', Editing: 'Edited', Voicing: 'Voiced', Checking: 'Checked', Creating: 'Created', Writing: 'Wrote' })[m] ?? m) : meta.label}
            {running && <Spinner className="size-3 text-fg-3" />}
            {call.status === 'done' && <Check className="size-3.5 text-success" />}
            {call.status === 'rejected' && <span className="text-[11px] text-fg-3">skipped</span>}
          </div>
          {prompt && <div className="truncate text-[11.5px] text-fg-3">{prompt}</div>}
        </div>
      </div>

      {pending && onApprove && (
        <div className="flex items-center gap-2 border-t border-line px-3.5 py-2.5 max-md:flex-wrap max-md:px-3">
          <span className="flex-1 text-[12px] text-fg-2 max-md:basis-full max-md:pb-0.5">Run this generation?</span>
          <Button size="sm" variant="ghost" icon={<X className="size-3.5" />} onClick={() => onApprove(false)} className="max-md:h-10 max-md:flex-1 max-md:rounded-xl max-md:border max-md:border-line">
            Skip
          </Button>
          <Button size="sm" variant="primary" icon={<Check className="size-3.5" />} onClick={() => onApprove(true)} className="max-md:h-10 max-md:flex-[2] max-md:rounded-xl">
            Generate
          </Button>
        </div>
      )}

      {(running || outputs.length > 0) && callJobs.length > 0 && (
        <div className="border-t border-line p-2.5">
          <div className={cn('grid gap-2', outputs.length > 1 || callJobs.length > 1 ? 'grid-cols-2' : 'grid-cols-1')}>
            {callJobs.map((j) => {
              const out = assets.find((a) => a.id === j.outputs[0])
              if (out) return <AssetThumb key={j.id} asset={out} className={out.kind === 'audio' ? 'h-24' : 'aspect-video max-h-[360px]'} fit="cover" onClick={() => onOpen(out.id)} />
              return (
                <div key={j.id} className="relative aspect-video overflow-hidden rounded-xl bg-white/[0.03] ring-1 ring-line">
                  {j.preview ? <motion.img initial={{ opacity: 0 }} animate={{ opacity: 1 }} src={j.preview} className="size-full object-cover blur-[1px]" /> : <div className="shimmer size-full" />}
                  <div className="absolute inset-x-3 bottom-3">
                    <div className="mb-1.5 text-[11px] font-medium text-white/85 drop-shadow">
                      {j.status === 'queued' ? 'Queued' : j.progress ? `Step ${j.progress.value}/${j.progress.max}` : j.status === 'error' ? j.error : 'Loading models…'}
                    </div>
                    {(j.status === 'running' || j.status === 'queued') && <ProgressBar value={j === active ? pct : undefined} />}
                  </div>
                  {j.status === 'error' && (
                    <div className="absolute inset-0 grid place-items-center bg-black/50 p-4 text-center text-[11.5px] text-danger">
                      <AlertTriangle className="mx-auto mb-1 size-4" />
                      {j.error}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {voiceAsset && (
        <div className="border-t border-line p-2.5">
          <AssetThumb asset={voiceAsset} className="h-20" onClick={() => onOpen(voiceAsset.id)} />
        </div>
      )}

      {call.status === 'error' && <div className="border-t border-line px-3.5 py-2 text-[11.5px] text-danger">{call.result}</div>}
      {call.status === 'done' && (call.name === 'create_character' || call.name === 'create_story') && res.id && (
        <div className="border-t border-line px-3.5 py-2.5 max-md:px-3">
          <Button size="sm" className="max-md:h-9 max-md:w-full" onClick={() => navigate(call.name === 'create_character' ? `/characters/${res.id}` : `/stories/scenario/${res.id}`)}>
            Open {call.name === 'create_character' ? 'character' : 'story'}
          </Button>
        </div>
      )}
    </motion.div>
  )
}

/** Collapsed-by-default view of the model's hidden thinking. */
export function ThinkingBlock({ reasoning, ms, live }: { reasoning: string; ms?: number; live: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const body = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (open && live && body.current) body.current.scrollTop = body.current.scrollHeight
  }, [reasoning, open, live])
  const seconds = ms ? Math.max(1, Math.round(ms / 1000)) : undefined
  return (
    <div className="flex flex-col">
      <button onClick={() => setOpen((o) => !o)} className="group flex w-fit items-center gap-1.5 rounded-lg py-0.5 pr-2 text-[12.5px] font-medium text-fg-3 transition-colors hover:text-fg-2 max-md:-my-1.5 max-md:min-h-9 max-md:py-1.5">
        <Brain className={cn('size-3.5', live && 'text-accent')} />
        {live ? (
          <span className="bg-[linear-gradient(90deg,var(--fg-3)_0%,var(--fg)_50%,var(--fg-3)_100%)] bg-[length:200%_100%] bg-clip-text text-transparent [animation:shimmer_1.8s_linear_infinite]">Thinking…</span>
        ) : (
          <span>{seconds ? `Thought for ${seconds}s` : 'Thoughts'}</span>
        )}
        <span className="text-fg-3/80 group-hover:text-fg-3">· {open ? 'Hide thinking' : 'Show thinking'}</span>
        <ChevronDown className={cn('size-3.5 transition-transform duration-300', open && 'rotate-180')} />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.3, ease }} className="overflow-hidden">
            <div ref={body} className="selectable mt-1.5 max-h-[320px] overflow-y-auto max-md:max-h-[260px] max-md:pl-3 border-l-2 border-[color-mix(in_oklab,var(--accent)_35%,transparent)] py-1 pl-3.5 text-[12.5px] leading-relaxed whitespace-pre-wrap text-fg-3">
              {reasoning}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// Wide tables scroll inside their own box on phones instead of pushing the page sideways.
const MD_COMPONENTS: Components = {
  table: ({ node: _node, ...props }) => (
    <div className="max-md:overflow-x-auto">
      <table {...props} />
    </div>
  )
}

const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="prose-stitch selectable max-md:break-words">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  )
})

export function Messages({
  messages,
  running,
  approvalFor,
  onApprove
}: {
  messages: ChatMessage[]
  running: boolean
  approvalFor?: string
  onApprove: (ok: boolean) => void
}): React.JSX.Element {
  const assets = useCollection('assets')
  const [lightbox, setLightbox] = useState<string | null>(null)
  const visible = messages.filter((m) => m.role !== 'tool')
  const last = visible[visible.length - 1]
  const thinking = running && last?.role === 'assistant' && !last.content && !last.toolCalls?.length && !last.reasoning

  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-6 px-6 pt-6 pb-10 max-md:gap-5 max-md:px-4 max-md:pt-4 max-md:pb-4">
      <AnimatePresence initial={false}>
        {visible.map((m) =>
          m.role === 'user' ? (
            <motion.div key={m.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease }} className="flex flex-col items-end gap-2">
              {(m.attachments?.length ?? 0) > 0 && (
                <div className="flex flex-wrap justify-end gap-2">
                  {m.attachments!.map((id) => {
                    const a = assets.find((x) => x.id === id)
                    return a ? <AssetThumb key={id} asset={a} className="size-20 max-md:size-24" onClick={() => setLightbox(id)} /> : null
                  })}
                </div>
              )}
              {m.content && <div className="selectable max-w-[85%] rounded-2xl rounded-br-md border border-line bg-white/[0.07] px-4 py-2.5 text-[13.5px] leading-relaxed whitespace-pre-wrap max-md:max-w-[88%] max-md:px-3.5 max-md:break-words">{m.content}</div>}
            </motion.div>
          ) : (
            <motion.div key={m.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease }} className="flex gap-3 max-md:gap-2.5">
              <div className="mt-0.5 shrink-0">
                <Orb size={22} density={0.25} state={running && m.id === last?.id ? 'thinking' : 'idle'} />
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-3 pt-0.5">
                {m.reasoning && <ThinkingBlock reasoning={m.reasoning} ms={m.thinkingMs} live={running && m.id === last?.id && !m.content && !m.toolCalls?.length} />}
                {m.content && <Markdown text={m.content} />}
                {m.toolCalls?.map((t) => (
                  <ToolCard key={t.id} call={t} pending={approvalFor === t.id} onApprove={onApprove} onOpen={setLightbox} />
                ))}
                {thinking && m.id === last?.id && (
                  <div className="flex items-center gap-1.5 pt-1.5">
                    {[0, 1, 2].map((i) => (
                      <motion.span key={i} className="size-1.5 rounded-full bg-fg-3" animate={{ opacity: [0.25, 1, 0.25], y: [0, -2, 0] }} transition={{ duration: 1.1, repeat: Infinity, delay: i * 0.15 }} />
                    ))}
                  </div>
                )}
              </div>
            </motion.div>
          )
        )}
      </AnimatePresence>
      <AssetLightbox assetId={lightbox} onClose={() => setLightbox(null)} />
    </div>
  )
}
