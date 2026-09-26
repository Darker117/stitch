// Phone studio: on-device chat, images and voice when the PC can't be reached (or before pairing).
// Chats and creations are kept on the phone and go to the PC library on the next connection.
import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ArrowLeft, ArrowUp, AudioLines, Cpu, ImageIcon, Laptop, MessageSquare, Pause, Play, Plus, Sparkles, Square } from 'lucide-react'
import { Capacitor } from '@capacitor/core'
import { nanoid } from 'nanoid'
import type { LlmMessage } from '@shared/ipc'
import type { GenJob } from '@shared/types'
import { Background } from '@/components/shell/background'
import { LogoMark } from '@/components/shell/logo'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/input'
import { Segmented } from '@/components/ui/controls'
import { ProgressRing, StatusDot } from '@/components/ui/misc'
import { Orb } from '@/components/ui/orb'
import { Select } from '@/components/ui/overlay'
import { ThinkingBlock } from '@/features/create/Messages'
import { errorText, invoke, on, streamLlm } from '@/lib/api'
import { cn } from '@/lib/utils'
import { ease, spring } from '@/lib/motion'
import { toast } from '@/stores/toast'
import { useLink } from '@mobile/bridge/connection'
import { PHONE_RECIPE } from '@mobile/device/image'
import { PHONE_LLM_ID } from '@mobile/device/llm'
import { readyModels, useDevice } from '@mobile/device/store'
import { PHONE_VOICE_ID, phoneVoices } from '@mobile/device/voice'
import { tap } from '@mobile/shell/haptics'
import { loadStudioChats, saveStudioChats, type StudioChat } from './sync'

type Tab = 'chat' | 'image' | 'voice'

function Empty({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }): React.JSX.Element {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
      <div className="grid size-12 place-items-center rounded-2xl border border-line bg-white/[0.04] text-fg-2 [&>svg]:size-5">{icon}</div>
      <div className="text-[14px] font-semibold">{title}</div>
      <p className="text-[12.5px] leading-relaxed text-fg-3">{body}</p>
    </div>
  )
}

// ─── Chat ────────────────────────────────────────────────────────────────────

function ChatTab(): React.JSX.Element {
  const models = readyModels('text')
  const [model, setModel] = useState(models[0]?.id)
  const [chat, setChat] = useState<StudioChat>(() => ({ id: nanoid(10), title: 'Phone chat', createdAt: Date.now(), updatedAt: Date.now(), model: models[0]?.id ?? '', messages: [] }))
  const [input, setInput] = useState('')
  const [live, setLive] = useState<{ text: string; reasoning: string } | null>(null)
  const abort = useRef<(() => void) | null>(null)
  const scroller = useRef<HTMLDivElement>(null)

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' })
  }, [chat.messages.length, live?.text])

  if (!models.length) return <Empty icon={<MessageSquare />} title="No text model on the phone yet" body="Connect to your PC once and download one in More → This phone — or it's already downloading." />

  const persist = async (next: StudioChat): Promise<void> => {
    const all = (await loadStudioChats()).filter((c) => c.id !== next.id)
    await saveStudioChats([next, ...all])
  }

  const send = (): void => {
    const text = input.trim()
    if (!text || live) return
    tap()
    const user = { id: nanoid(8), role: 'user' as const, content: text, createdAt: Date.now() }
    const base: StudioChat = { ...chat, model: model!, title: chat.messages.length ? chat.title : text.slice(0, 48), messages: [...chat.messages, user], updatedAt: Date.now() }
    setChat(base)
    setInput('')
    setLive({ text: '', reasoning: '' })
    const t0 = Date.now()
    const msgs: LlmMessage[] = base.messages.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }))
    const h = streamLlm(
      { connectorId: PHONE_LLM_ID, model: model!, system: 'You are Stitch, a warm, concise creative assistant running on the user’s phone.', messages: msgs, maxTokens: 768, temperature: 0.8 },
      (full) => setLive((l) => ({ text: full, reasoning: l?.reasoning ?? '' })),
      (r) => setLive((l) => ({ text: l?.text ?? '', reasoning: r }))
    )
    abort.current = h.abort
    void h.done
      .then((r) => {
        const next: StudioChat = { ...base, messages: [...base.messages, { id: nanoid(8), role: 'assistant', content: r.text, reasoning: r.reasoning, thinkingMs: r.reasoning ? Date.now() - t0 : undefined, createdAt: Date.now() }], updatedAt: Date.now() }
        setChat(next)
        void persist(next)
      })
      .catch((err) => toast.error('The phone model stopped', errorText(err)))
      .finally(() => setLive(null))
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 px-4 pb-2">
        {models.length > 1 ? <Select value={model ?? ''} onChange={setModel} options={models.map((m) => ({ value: m.id, label: m.name }))} /> : <span className="text-[12px] text-fg-3">{models[0].name}</span>}
        <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} className="ml-auto" onClick={() => setChat({ id: nanoid(10), title: 'Phone chat', createdAt: Date.now(), updatedAt: Date.now(), model: model!, messages: [] })}>
          New
        </Button>
      </div>
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-4">
        {!chat.messages.length && !live ? (
          <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
            <Orb size={96} state="idle" />
            <div className="text-[17px] font-semibold">Ask the phone anything</div>
            <p className="max-w-[260px] text-[12.5px] text-fg-3">Runs fully on this phone. The chat moves to your PC next time you connect.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-4 py-2">
            {chat.messages.map((m) => (
              <Bubble key={m.id} role={m.role} text={m.content} reasoning={m.reasoning} ms={m.thinkingMs} />
            ))}
            {live && <Bubble role="assistant" text={live.text} reasoning={live.reasoning} live />}
          </div>
        )}
      </div>
      <div className="px-3 pt-2 pb-[calc(var(--sab)+10px)]">
        <div className="glass-strong glow-border flex items-end gap-2 rounded-[22px] p-2 pl-3.5" data-active={!!live}>
          <Textarea value={input} onChange={(e) => setInput(e.target.value)} placeholder="Message the phone…" rows={1} className="max-h-32 min-h-9 flex-1 border-0 bg-transparent px-0 py-2 text-[14px] focus:shadow-none" />
          {live ? (
            <button onClick={() => abort.current?.()} className="grid size-9 shrink-0 place-items-center rounded-full bg-white/10 text-fg active:scale-90">
              <Square className="size-3.5 fill-current" />
            </button>
          ) : (
            <button onClick={send} disabled={!input.trim()} className="grid size-9 shrink-0 place-items-center rounded-full bg-grad text-white shadow-[0_6px_18px_-6px_var(--accent)] transition active:scale-90 disabled:opacity-40">
              <ArrowUp className="size-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function Bubble({ role, text, reasoning, ms, live }: { role: string; text: string; reasoning?: string; ms?: number; live?: boolean }): React.JSX.Element {
  if (role === 'user') {
    return (
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={spring} className="selectable ml-auto max-w-[85%] rounded-[18px] rounded-br-md border border-line bg-white/[0.07] px-3.5 py-2.5 text-[13.5px] leading-relaxed whitespace-pre-wrap">
        {text}
      </motion.div>
    )
  }
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={spring} className="flex flex-col gap-1.5">
      {reasoning && <ThinkingBlock reasoning={reasoning} ms={ms} live={!!live && !text} />}
      <div className="selectable prose-sm text-[13.5px] leading-relaxed text-fg [&_li]:my-0.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-1.5 [&_strong]:font-semibold [&_ul]:list-disc [&_ul]:pl-5">
        {text ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown> : live && !reasoning ? <span className="inline-block size-2 animate-pulse rounded-full bg-accent" /> : null}
      </div>
    </motion.div>
  )
}

// ─── Images ──────────────────────────────────────────────────────────────────

function ImageTab(): React.JSX.Element {
  const models = readyModels('image')
  const [model, setModel] = useState(models[0]?.id)
  const [prompt, setPrompt] = useState('')
  const [aspect, setAspect] = useState('1:1')
  const [jobs, setJobs] = useState<Record<string, GenJob>>({})
  useEffect(() => on('gen:job', (j) => j.id.startsWith('phone-') && setJobs((s) => ({ ...s, [j.id]: j }))), [])
  const list = useMemo(() => Object.values(jobs).sort((a, b) => b.createdAt - a.createdAt), [jobs])
  if (!models.length) return <Empty icon={<ImageIcon />} title="No image model on the phone yet" body="Connect to your PC once and download one in More → This phone." />
  const m = models.find((x) => x.id === model) ?? models[0]
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-[calc(var(--sab)+16px)]">
      {models.length > 1 && <Select value={m.id} onChange={setModel} options={models.map((x) => ({ value: x.id, label: x.name }))} />}
      <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} placeholder="Describe what you want to see…" />
      <div className="flex flex-wrap gap-1.5">
        {['1:1', '3:4', '4:3', '9:16', '16:9'].map((a) => (
          <button key={a} onClick={() => setAspect(a)} className={cn('relative h-8 rounded-full border px-3 text-[12px] font-medium', aspect === a ? 'border-transparent text-fg' : 'border-line text-fg-2')}>
            {aspect === a && <motion.span layoutId="studio-aspect" className="absolute inset-0 rounded-full border border-line-strong bg-white/[0.1]" transition={spring} />}
            <span className="relative">{a}</span>
          </button>
        ))}
      </div>
      <Button
        size="lg"
        variant="primary"
        disabled={!prompt.trim()}
        icon={<Sparkles className="size-4" />}
        onClick={() => {
          tap()
          void invoke('gen:submit', { recipeId: PHONE_RECIPE + m.id, params: { prompt, aspect, backend: 'auto', steps: m.steps, cfg: m.guidance, seed: -1 }, label: m.name })
        }}
      >
        Generate on phone
      </Button>
      <div className="grid grid-cols-2 gap-2">
        <AnimatePresence initial={false}>
          {list.map((j) => {
            const pct = j.progress?.max ? j.progress.value / j.progress.max : undefined
            return (
              <motion.div key={j.id} layout initial={{ opacity: 0, scale: 0.94 }} animate={{ opacity: 1, scale: 1 }} transition={spring} className="relative aspect-square overflow-hidden rounded-2xl bg-white/[0.04] ring-1 ring-line">
                {j.preview ? <img src={j.preview} className="size-full object-cover" /> : <div className="shimmer size-full" />}
                {(j.status === 'running' || j.status === 'queued') && (
                  <div className="absolute right-2 bottom-2">
                    <ProgressRing value={pct} size={24} />
                  </div>
                )}
                {j.status === 'error' && <div className="absolute inset-x-0 bottom-0 bg-black/60 p-2 text-[11px] text-danger">{j.error}</div>}
              </motion.div>
            )
          })}
        </AnimatePresence>
      </div>
    </div>
  )
}

// ─── Voice ───────────────────────────────────────────────────────────────────

function VoiceTab(): React.JSX.Element {
  const voices = phoneVoices()
  const [voice, setVoice] = useState(voices[0]?.id)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [clips, setClips] = useState<{ id: string; text: string; url: string }[]>([])
  const [playing, setPlaying] = useState<string | null>(null)
  const audio = useRef<HTMLAudioElement>(null)
  if (!voices.length) return <Empty icon={<AudioLines />} title="No voice on the phone yet" body="System voices appear here automatically; neural voices download in More → This phone." />
  const play = (id: string, url: string): void => {
    if (!audio.current) return
    if (playing === id) {
      audio.current.pause()
      return
    }
    audio.current.src = url
    void audio.current.play()
    setPlaying(id)
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-[calc(var(--sab)+16px)]">
      <Select value={voice ?? ''} onChange={setVoice} options={voices.map((v) => ({ value: v.id, label: `${v.name} · ${v.labels?.model ?? ''}` }))} />
      <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder="Type a line to speak…" />
      <Button
        size="lg"
        variant="primary"
        loading={busy}
        disabled={!text.trim()}
        icon={<AudioLines className="size-4" />}
        onClick={async () => {
          setBusy(true)
          try {
            const a = (await invoke('voice:speak', { connectorId: PHONE_VOICE_ID, text, voice: { connectorId: PHONE_VOICE_ID, voiceId: voice } })) as { id: string; path: string }
            const url = a.path.startsWith('/') ? Capacitor.convertFileSrc(a.path) : ''
            const clip = { id: a.id, text, url }
            setClips((c) => [clip, ...c])
            if (url) play(clip.id, url)
          } catch (err) {
            toast.error('On-device speech failed', errorText(err))
          } finally {
            setBusy(false)
          }
        }}
      >
        Speak
      </Button>
      <div className="flex flex-col gap-2">
        {clips.map((c) => (
          <motion.button key={c.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} onClick={() => c.url && play(c.id, c.url)} className="flex items-center gap-3 rounded-2xl border border-line bg-white/[0.03] p-3 text-left">
            <span className="grid size-9 shrink-0 place-items-center rounded-full bg-grad text-white">{playing === c.id ? <Pause className="size-4" /> : <Play className="size-4" />}</span>
            <span className="line-clamp-2 text-[12.5px] text-fg-2">{c.text}</span>
          </motion.button>
        ))}
      </div>
      <audio ref={audio} onEnded={() => setPlaying(null)} onPause={() => setPlaying(null)} />
    </div>
  )
}

// ─── Screen ──────────────────────────────────────────────────────────────────

export function PhoneStudio({ onExit, onOpenApp }: { onExit: () => void; onOpenApp: () => void }): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('chat')
  const native = useDevice((s) => s.native)
  useDevice((s) => s.status)
  const linkReady = useLink((s) => s.state === 'ready')
  const pcName = useLink((s) => s.pcName)
  return (
    <div className="relative isolate flex h-full flex-col pt-[var(--sat)]">
      <Background bg={{ type: 'gradient', dim: 0.35, blur: 0 }} />
      <header className="flex h-[var(--topbar)] shrink-0 items-center gap-2 px-2">
        <button onClick={onExit} className="grid size-10 place-items-center rounded-xl text-fg-2 active:scale-90" aria-label="Back">
          <ArrowLeft className="size-[18px]" />
        </button>
        <LogoMark size={24} />
        <div className="text-[14px] font-semibold">Phone studio</div>
        <span className="ml-1 flex items-center gap-1 rounded-full border border-line bg-white/[0.05] px-2 py-0.5 text-[10.5px] font-semibold tracking-wide text-fg-2 uppercase">
          <Cpu className="size-3" /> On-device
        </span>
      </header>
      <AnimatePresence>
        {linkReady && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.3, ease }} className="overflow-hidden px-3">
            <button onClick={onOpenApp} className="mb-2 flex w-full items-center gap-2.5 rounded-2xl border border-[color-mix(in_oklab,var(--accent)_40%,transparent)] bg-[color-mix(in_oklab,var(--accent)_10%,transparent)] px-3.5 py-2.5 text-left text-[12.5px]">
              <StatusDot state="online" />
              <Laptop className="size-4 text-accent" />
              <span className="flex-1 font-medium">Connected to {pcName} — open Stitch</span>
            </button>
          </motion.div>
        )}
      </AnimatePresence>
      <div className="px-4 pb-3">
        <Segmented
          value={tab}
          onChange={setTab}
          items={[
            { value: 'chat', label: 'Chat', icon: <MessageSquare /> },
            { value: 'image', label: 'Images', icon: <ImageIcon /> },
            { value: 'voice', label: 'Voice', icon: <AudioLines /> }
          ]}
          className="w-full [&>button]:flex-1 [&>button]:justify-center"
        />
      </div>
      {!native ? (
        <Empty icon={<Cpu />} title="Needs the Android app" body="On-device models run inside Stitch for Android." />
      ) : (
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={tab} initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -12 }} transition={{ duration: 0.25, ease }} className="flex min-h-0 flex-1 flex-col">
            {tab === 'chat' && <ChatTab />}
            {tab === 'image' && <ImageTab />}
            {tab === 'voice' && <VoiceTab />}
          </motion.div>
        </AnimatePresence>
      )}
    </div>
  )
}
