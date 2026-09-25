import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { AnimatePresence, motion } from 'motion/react'
import { BookOpen, Clapperboard, Download, ImageIcon, Mic2, Music, ScanFace, Settings2, Sparkles, Wand2, Zap } from 'lucide-react'
import type { Chat } from '@shared/types'
import { invoke } from '@/lib/api'
import { cn } from '@/lib/utils'
import { ease, rise, spring, stagger } from '@/lib/motion'
import { defaultLlm, type LlmChoice } from '@/lib/llm'
import { Page } from '@/components/shell/page'
import { ModelPicker } from '@/components/model-picker'
import { AssetLightbox, AssetThumb } from '@/components/media'
import { Button, Chip } from '@/components/ui/button'
import { Segmented } from '@/components/ui/controls'
import { Orb } from '@/components/ui/orb'
import { db, useCollection, useDoc } from '@/stores/db'
import { toast } from '@/stores/toast'
import { Composer, type ComposerHandle } from './Composer'
import { Messages } from './Messages'
import { resolveApproval, send, startChat, stop, useRuntime } from './runtime'

const SUGGESTIONS = [
  { icon: <ImageIcon />, label: 'Create image', text: 'Create a cinematic image of ' },
  { icon: <Clapperboard />, label: 'Animate a scene', text: 'Make a 6-second video with sound of ' },
  { icon: <BookOpen />, label: 'Start a story', text: 'Write me an interactive story about ' },
  { icon: <ScanFace />, label: 'Design a character', text: 'Design a new character: ' },
  { icon: <Music />, label: 'Compose music', text: 'Compose a soundtrack that feels like ' },
  { icon: <Mic2 />, label: 'Voice a line', text: 'Voice this line: ' }
]

const SHOWCASE = [
  { title: 'Lock a character', body: 'One reference → a full sheet that stays on-model in every shot.', icon: <ScanFace />, to: '/characters', hue: 'from-sunset-1/50 via-sunset-3/25' },
  { title: 'Play a story', body: 'Text adventures that paint, animate and voice themselves.', icon: <BookOpen />, to: '/stories', hue: 'from-sunset-6/45 via-sunset-4/25' },
  { title: 'Direct a scene', body: 'MiniMax H3 video with native dialogue, SFX and music.', icon: <Clapperboard />, to: '/generate/video', hue: 'from-sunset-4/45 via-sunset-2/25' },
  { title: 'Cut it together', body: 'Edit every clip, voice line and track in the Studio.', icon: <Wand2 />, to: '/studio', hue: 'from-sunset-2/45 via-sunset-7/25' }
]

type Filter = 'all' | 'image' | 'video' | 'audio'

function Gallery(): React.JSX.Element {
  const assets = useCollection('assets')
  const [filter, setFilter] = useState<Filter>('all')
  const [lightbox, setLightbox] = useState<string | null>(null)
  const navigate = useNavigate()
  const list = useMemo(() => assets.filter((a) => a.source !== 'imported' && (filter === 'all' || a.kind === filter)).slice(0, 24), [assets, filter])
  const hasAny = assets.some((a) => a.source !== 'imported')

  return (
    <div className="mx-auto w-full max-w-[1180px] px-8 pb-16">
      <div className="mb-5 flex items-center justify-center">
        <Segmented
          value={filter}
          onChange={setFilter}
          items={[
            { value: 'all', label: 'All', icon: <Sparkles /> },
            { value: 'image', label: 'Images', icon: <ImageIcon /> },
            { value: 'video', label: 'Videos', icon: <Clapperboard /> },
            { value: 'audio', label: 'Audio', icon: <Music /> }
          ]}
        />
      </div>
      {!hasAny ? (
        <motion.div variants={stagger(0.06, 0.1)} initial="initial" animate="animate" className="grid grid-cols-4 gap-3">
          {SHOWCASE.map((s) => (
            <motion.button
              key={s.title}
              variants={rise}
              whileHover={{ y: -3 }}
              transition={spring}
              onClick={() => navigate(s.to)}
              className={cn('glass hairline group relative flex h-[190px] flex-col justify-end overflow-hidden rounded-2xl p-4 text-left')}
            >
              <div className={cn('absolute inset-0 bg-gradient-to-br to-transparent opacity-70 transition-opacity duration-500 group-hover:opacity-100', s.hue)} />
              <div className="absolute top-4 left-4 grid size-9 place-items-center rounded-xl border border-white/15 bg-white/10 text-white backdrop-blur [&>svg]:size-4">{s.icon}</div>
              <div className="relative">
                <div className="text-[14px] font-semibold">{s.title}</div>
                <div className="mt-1 text-[12px] leading-snug text-fg-2">{s.body}</div>
              </div>
            </motion.button>
          ))}
        </motion.div>
      ) : (
        <motion.div layout className="columns-4 gap-3 [&>*]:mb-3">
          <AnimatePresence mode="popLayout">
            {list.map((a, i) => (
              <motion.div
                key={a.id}
                layout
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0, transition: { duration: 0.5, ease, delay: Math.min(i, 12) * 0.03 } }}
                exit={{ opacity: 0, scale: 0.96 }}
                className="break-inside-avoid"
              >
                <div style={{ aspectRatio: a.kind === 'audio' ? '16 / 7' : a.width && a.height ? `${a.width} / ${a.height}` : '1 / 1' }}>
                  <AssetThumb asset={a} onClick={() => setLightbox(a.id)} className="size-full" fit="cover" />
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
        </motion.div>
      )}
      <AssetLightbox assetId={lightbox} onClose={() => setLightbox(null)} />
    </div>
  )
}

function Hero(): React.JSX.Element {
  const navigate = useNavigate()
  const composer = useRef<ComposerHandle>(null)
  const [askFirst, setAskFirst] = useState(false)
  const [projectId, setProjectId] = useState<string>()
  const [llm, setLlm] = useState<LlmChoice | undefined>(() => defaultLlm())
  useCollection('connectors')
  useEffect(() => {
    if (!llm) setLlm(defaultLlm())
  })

  return (
    <Page className="relative">
      <div className="absolute top-3 left-4 z-10 flex items-center gap-2">
        <ModelPicker value={llm} onChange={setLlm} />
      </div>
      <div className="absolute top-3 right-4 z-10 flex items-center gap-2">
        <Button size="sm" variant="glass" icon={<Settings2 className="size-3.5" />} onClick={() => navigate('/connectors')}>
          Configuration
        </Button>
      </div>
      <div className="flex min-h-[calc(100%-40px)] flex-col items-center justify-center px-8 pt-16 pb-10">
        <motion.div initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 1.1, ease }}>
          <Orb size={128} />
        </motion.div>
        <motion.h1 initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.7, ease, delay: 0.15 }} className="display mt-3 text-center text-[30px]">
          What are we creating today?
        </motion.h1>
        <motion.div variants={stagger(0.04, 0.3)} initial="initial" animate="animate" className="mt-5 flex flex-wrap justify-center gap-2">
          {SUGGESTIONS.map((s) => (
            <motion.div key={s.label} variants={rise}>
              <Chip icon={s.icon} onClick={() => composer.current?.setText(s.text)}>
                {s.label}
              </Chip>
            </motion.div>
          ))}
        </motion.div>
        <motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.7, ease, delay: 0.35 }} className="mt-5 w-full max-w-[680px]">
          <Composer
            ref={composer}
            autoFocus
            askFirst={askFirst}
            onAskFirst={setAskFirst}
            projectId={projectId}
            onProject={setProjectId}
            onSend={async (text, attachments) => {
              if (!llm) {
                toast.error('No text model', 'Add OpenAI, Anthropic, OpenRouter, Ollama or LM Studio under Connectors.')
                navigate('/connectors')
                return
              }
              const id = await startChat(text, attachments, { askBeforeGenerating: askFirst, projectId, llm })
              navigate(`/chat/${id}`)
            }}
          />
          <div className="mt-3 flex items-center justify-center gap-4 text-[12px] text-fg-3">
            <button onClick={() => navigate('/skills')} className="flex items-center gap-1.5 transition hover:text-fg-2">
              <Zap className="size-3.5" /> Skills
            </button>
            <span className="h-3 w-px bg-line" />
            <button onClick={() => navigate('/stories/new')} className="flex items-center gap-1.5 transition hover:text-fg-2">
              <BookOpen className="size-3.5" /> New story
            </button>
            <span className="h-3 w-px bg-line" />
            <button onClick={() => navigate('/characters')} className="flex items-center gap-1.5 transition hover:text-fg-2">
              <ScanFace className="size-3.5" /> Characters
            </button>
          </div>
        </motion.div>
      </div>
      <Gallery />
    </Page>
  )
}

function ChatView({ id }: { id: string }): React.JSX.Element {
  const navigate = useNavigate()
  const stored = useDoc('chats', id)
  const live = useRuntime((s) => s.live[id])
  const running = useRuntime((s) => !!s.running[id])
  const approval = useRuntime((s) => s.approvals[id])
  const chat: Chat | undefined = live ?? stored
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  const lastContent = chat?.messages[chat.messages.length - 1]?.content.length ?? 0
  useEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTo({ top: el.scrollHeight, behavior: running ? 'auto' : 'smooth' })
  }, [chat?.messages.length, lastContent, running, approval])

  if (!chat) {
    return (
      <Page className="grid place-items-center">
        <div className="text-fg-3">This chat no longer exists.</div>
      </Page>
    )
  }

  const exportChat = async (): Promise<void> => {
    const path = await invoke('sys:saveDialog', { defaultPath: `${chat.title}.md`, filters: [{ name: 'Markdown', extensions: ['md'] }] })
    if (!path) return
    const md = chat.messages
      .filter((m) => m.role !== 'tool')
      .map((m) => `**${m.role === 'user' ? 'You' : 'Stitch'}:** ${m.content}${m.attachments?.length ? `\n\n_${m.attachments.length} attachment(s)_` : ''}`)
      .join('\n\n')
    await invoke('sys:writeText', path, `# ${chat.title}\n\n${md}\n`)
    toast.success('Chat exported')
  }

  return (
    <Page scroll={false} className="flex flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
        <ModelPicker value={chat.llm ?? defaultLlm()} onChange={(llm) => void db.patch('chats', id, { llm })} />
        <div className="min-w-0 flex-1 truncate text-center text-[13px] font-medium text-fg-2">{chat.title}</div>
        <Button size="sm" variant="ghost" icon={<Settings2 className="size-3.5" />} onClick={() => navigate('/connectors')}>
          Configuration
        </Button>
        <Button size="sm" variant="ghost" icon={<Download className="size-3.5" />} onClick={() => void exportChat()}>
          Export
        </Button>
      </div>
      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-y-auto"
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
        }}
      >
        <Messages messages={chat.messages} running={running} approvalFor={approval?.call.id} onApprove={(ok) => resolveApproval(id, ok)} />
      </div>
      <div className="shrink-0 px-6 pb-5">
        <div className="mx-auto max-w-[760px]">
          <Composer
            running={running}
            onStop={() => stop(id)}
            askFirst={chat.askBeforeGenerating}
            onAskFirst={(v) => void db.patch('chats', id, { askBeforeGenerating: v })}
            placeholder="Reply, or ask for changes…"
            onSend={(text, attachments) => {
              stick.current = true
              void send(id, text, attachments)
            }}
          />
        </div>
      </div>
    </Page>
  )
}

export function CreatePage(): React.JSX.Element {
  const { id } = useParams()
  useCollection('chats')
  useCollection('assets')
  return (
    <AnimatePresence mode="wait" initial={false}>
      {id ? <ChatView key={id} id={id} /> : <Hero key="hero" />}
    </AnimatePresence>
  )
}

