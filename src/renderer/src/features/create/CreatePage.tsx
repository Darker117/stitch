import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { AnimatePresence, motion } from 'motion/react'
import { BookOpen, Clapperboard, Download, ImageIcon, Mic2, MoreHorizontal, Music, ScanFace, Settings2, Sparkles, Wand2, Zap } from 'lucide-react'
import type { Chat } from '@shared/types'
import { invoke } from '@/lib/api'
import { cn } from '@/lib/utils'
import { ease, rise, spring, stagger } from '@/lib/motion'
import { useCompact } from '@/lib/platform'
import { defaultLlm, type LlmChoice } from '@/lib/llm'
import { Page } from '@/components/shell/page'
import { ModelPicker } from '@/components/model-picker'
import { AssetLightbox, AssetThumb } from '@/components/media'
import { Button, Chip, IconButton } from '@/components/ui/button'
import { Segmented } from '@/components/ui/controls'
import { Orb } from '@/components/ui/orb'
import { Menu, MenuItem, MenuLabel, MenuSeparator } from '@/components/ui/overlay'
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
  { title: 'Lock a character', body: 'One reference → a full sheet that stays on-model in every shot.', icon: <ScanFace />, to: '/characters', hue: 'from-[color-mix(in_oklab,var(--accent-2)_50%,transparent)] via-[color-mix(in_oklab,var(--accent-2)_22%,transparent)]' },
  { title: 'Play a story', body: 'Text adventures that paint, animate and voice themselves.', icon: <BookOpen />, to: '/stories', hue: 'from-[color-mix(in_oklab,var(--accent)_45%,transparent)] via-[color-mix(in_oklab,color-mix(in_oklab,var(--accent)_50%,var(--accent-2))_22%,transparent)]' },
  { title: 'Direct a scene', body: 'MiniMax H3 video with native dialogue, SFX and music.', icon: <Clapperboard />, to: '/generate/video', hue: 'from-[color-mix(in_oklab,color-mix(in_oklab,var(--accent)_50%,var(--accent-2))_45%,transparent)] via-[color-mix(in_oklab,var(--accent-2)_22%,transparent)]' },
  { title: 'Cut it together', body: 'Edit every clip, voice line and track in the Studio.', icon: <Wand2 />, to: '/studio', hue: 'from-[color-mix(in_oklab,var(--accent-2)_45%,transparent)] via-[color-mix(in_oklab,var(--accent)_22%,transparent)]' }
]

type Filter = 'all' | 'image' | 'video' | 'audio'

function Gallery(): React.JSX.Element {
  const assets = useCollection('assets')
  const [filter, setFilter] = useState<Filter>('all')
  const [lightbox, setLightbox] = useState<string | null>(null)
  const navigate = useNavigate()
  const list = useMemo(() => assets.filter((a) => a.source !== 'imported' && (filter === 'all' || a.kind === filter)).slice(0, 24), [assets, filter])
  const hasAny = assets.some((a) => a.source !== 'imported')
  const compact = useCompact()

  return (
    <div className="mx-auto w-full max-w-[1180px] px-8 pb-16 max-md:px-3 max-md:pb-6">
      <div className="mb-5 flex items-center justify-center max-md:mb-3">
        <Segmented
          value={filter}
          onChange={setFilter}
          className="max-md:[&>button]:h-8.5 max-md:[&>button]:px-3.5"
          items={[
            { value: 'all', label: 'All', icon: <Sparkles /> },
            { value: 'image', label: 'Images', icon: compact ? undefined : <ImageIcon /> },
            { value: 'video', label: 'Videos', icon: compact ? undefined : <Clapperboard /> },
            { value: 'audio', label: 'Audio', icon: compact ? undefined : <Music /> }
          ]}
        />
      </div>
      {!hasAny ? (
        <motion.div variants={stagger(0.06, 0.1)} initial="initial" animate="animate" className="grid grid-cols-4 gap-3 max-md:grid-cols-2 max-md:gap-2.5">
          {SHOWCASE.map((s) => (
            <motion.button
              key={s.title}
              variants={rise}
              whileHover={{ y: -3 }}
              transition={spring}
              onClick={() => navigate(s.to)}
              className={cn('glass hairline group relative flex h-[190px] flex-col justify-end overflow-hidden rounded-2xl p-4 text-left max-md:h-[172px] max-md:p-3.5')}
            >
              <div className={cn('absolute inset-0 bg-gradient-to-br to-transparent opacity-70 transition-opacity duration-500 group-hover:opacity-100', s.hue)} />
              <div className="absolute top-4 left-4 grid size-9 max-md:top-3.5 max-md:left-3.5 place-items-center rounded-xl border border-white/15 bg-white/10 text-white backdrop-blur [&>svg]:size-4">{s.icon}</div>
              <div className="relative">
                <div className="text-[14px] font-semibold">{s.title}</div>
                <div className="mt-1 text-[12px] leading-snug text-fg-2">{s.body}</div>
              </div>
            </motion.button>
          ))}
        </motion.div>
      ) : (
        <motion.div layout className="columns-4 gap-3 [&>*]:mb-3 max-md:columns-2 max-md:gap-2 max-md:[&>*]:mb-2">
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
  const compact = useCompact()
  useCollection('connectors')
  useEffect(() => {
    if (!llm) setLlm(defaultLlm())
  })

  const send = async (text: string, attachments: Parameters<typeof startChat>[1]): Promise<void> => {
    if (!llm) {
      toast.error('No text model', 'Add OpenAI, Anthropic, OpenRouter, Ollama or LM Studio under Connectors.')
      navigate('/connectors')
      return
    }
    const id = await startChat(text, attachments, { askBeforeGenerating: askFirst, projectId, llm })
    navigate(`/chat/${id}`)
  }

  // Phones: a chat-app layout — model in the header, a calm centre, suggestions and the composer at the bottom.
  if (compact) {
    return (
      <Page scroll={false} className="flex flex-col">
        <div className="flex h-13 shrink-0 items-center gap-1 pr-1.5 pl-3">
          <ModelPicker value={llm} onChange={setLlm} className="h-9 max-w-[70%]" />
          <div className="flex-1" />
          <IconButton label="Configuration" className="size-10 rounded-xl" onClick={() => navigate('/connectors')}>
            <Settings2 className="size-[18px]" />
          </IconButton>
        </div>
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-6 pb-4">
          <motion.div initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 1.1, ease }}>
            <Orb size={96} />
          </motion.div>
          <motion.h1 initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.7, ease, delay: 0.15 }} className="display mt-3 max-w-[280px] text-center text-[25px] leading-[1.15]">
            What are we creating today?
          </motion.h1>
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.6, ease, delay: 0.3 }} className="mt-4 flex items-center gap-1 text-[12.5px] text-fg-3">
            {[
              { icon: <BookOpen className="size-3.5" />, label: 'New story', to: '/stories/new' },
              { icon: <ScanFace className="size-3.5" />, label: 'Characters', to: '/characters' },
              { icon: <Zap className="size-3.5" />, label: 'Skills', to: '/skills' }
            ].map((l) => (
              <button key={l.to} onClick={() => navigate(l.to)} className="flex h-9 items-center gap-1.5 rounded-full px-3 transition active:bg-white/[0.06]">
                {l.icon} {l.label}
              </button>
            ))}
          </motion.div>
        </div>
        <motion.div
          variants={stagger(0.04, 0.3)}
          initial="initial"
          animate="animate"
          className="flex shrink-0 gap-2 overflow-x-auto px-3 pb-2.5 [scrollbar-width:none] [mask-image:linear-gradient(90deg,transparent,#000_12px,#000_calc(100%-12px),transparent)]"
        >
          {SUGGESTIONS.map((s) => (
            <motion.div key={s.label} variants={rise} className="shrink-0">
              <Chip icon={s.icon} onClick={() => composer.current?.setText(s.text)} className="h-9 rounded-xl px-3.5 text-[12.5px]">
                {s.label}
              </Chip>
            </motion.div>
          ))}
        </motion.div>
        <div className="shrink-0 px-2 pb-2">
          <Composer ref={composer} docked askFirst={askFirst} onAskFirst={setAskFirst} projectId={projectId} onProject={setProjectId} onSend={send} />
        </div>
      </Page>
    )
  }

  return (
    <Page className="relative">
      <div className="absolute top-3 left-4 z-10 flex items-center gap-2 max-md:right-15 max-md:left-3">
        <ModelPicker value={llm} onChange={setLlm} className="max-md:h-9 max-md:max-w-full" />
      </div>
      <div className="absolute top-3 right-4 z-10 flex items-center gap-2 max-md:right-3">
        {compact ? (
          <IconButton label="Configuration" variant="glass" className="size-9 rounded-xl" onClick={() => navigate('/connectors')}>
            <Settings2 className="size-4" />
          </IconButton>
        ) : (
          <Button size="sm" variant="glass" icon={<Settings2 className="size-3.5" />} onClick={() => navigate('/connectors')}>
            Configuration
          </Button>
        )}
      </div>
      <div className="flex min-h-[calc(100%-40px)] flex-col items-center justify-center px-8 pt-16 pb-10 max-md:min-h-[calc(100%-68px)] max-md:px-4 max-md:pt-16 max-md:pb-6">
        <motion.div initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 1.1, ease }}>
          <Orb size={compact ? 100 : 128} />
        </motion.div>
        <motion.h1 initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.7, ease, delay: 0.15 }} className="display mt-3 text-center text-[30px] max-md:mt-2 max-md:max-w-[300px] max-md:text-[25px] max-md:leading-[1.15]">
          What are we creating today?
        </motion.h1>
        <motion.div
          variants={stagger(0.04, 0.3)}
          initial="initial"
          animate="animate"
          className="mt-5 flex flex-wrap justify-center gap-2 max-md:-mx-4 max-md:w-[calc(100%+2rem)] max-md:flex-nowrap max-md:justify-start max-md:overflow-x-auto max-md:px-4 max-md:py-0.5 max-md:[scrollbar-width:none]! max-md:[&::-webkit-scrollbar]:hidden max-md:[mask-image:linear-gradient(90deg,transparent,#000_16px,#000_calc(100%-16px),transparent)]"
        >
          {SUGGESTIONS.map((s) => (
            <motion.div key={s.label} variants={rise} className="max-md:shrink-0">
              <Chip icon={s.icon} onClick={() => composer.current?.setText(s.text)} className="max-md:h-9 max-md:rounded-xl max-md:px-3.5 max-md:text-[12.5px]">
                {s.label}
              </Chip>
            </motion.div>
          ))}
        </motion.div>
        <motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.7, ease, delay: 0.35 }} className="mt-5 w-full max-w-[680px] max-md:mt-4">
          <Composer
            ref={composer}
            autoFocus={!compact}
            askFirst={askFirst}
            onAskFirst={setAskFirst}
            projectId={projectId}
            onProject={setProjectId}
            onSend={send}
          />
          <div className="mt-3 flex items-center justify-center gap-4 text-[12px] text-fg-3 max-md:mt-1.5 max-md:gap-2 max-md:[&>button]:h-10 max-md:[&>button]:px-1.5">
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
  const compact = useCompact()
  // Keeps the model label current when the chat follows the default model and connectors load late.
  useCollection('connectors')

  const lastContent = chat?.messages[chat.messages.length - 1]?.content.length ?? 0
  useEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTo({ top: el.scrollHeight, behavior: running ? 'auto' : 'smooth' })
  }, [chat?.messages.length, lastContent, running, approval])

  // Phone: the transcript shrinks when the keyboard opens or the composer grows — stay pinned to the latest message.
  useEffect(() => {
    const el = scroller.current
    if (!compact || !el) return
    let last = el.clientHeight
    const ro = new ResizeObserver(() => {
      if (el.clientHeight < last && stick.current) el.scrollTop = el.scrollHeight
      last = el.clientHeight
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [compact, !!chat])

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
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4 max-md:h-13 max-md:gap-1 max-md:pr-1.5 max-md:pl-3">
        <ModelPicker value={chat.llm ?? defaultLlm()} onChange={(llm) => void db.patch('chats', id, { llm })} className="max-md:h-9 max-md:max-w-[58%]" />
        <div className="min-w-0 flex-1 truncate text-center text-[13px] font-medium text-fg-2 max-md:px-1 max-md:text-right max-md:text-[12px] max-md:text-fg-3">{chat.title}</div>
        {compact ? (
          <Menu
            align="end"
            trigger={
              <IconButton label="Chat options" className="size-10 rounded-xl">
                <MoreHorizontal className="size-[18px]" />
              </IconButton>
            }
          >
            <MenuLabel>
              <span className="block max-w-[230px] truncate">{chat.title}</span>
            </MenuLabel>
            <MenuSeparator />
            <MenuItem icon={<Settings2 />} onSelect={() => navigate('/connectors')}>
              Configuration
            </MenuItem>
            <MenuItem icon={<Download />} onSelect={() => void exportChat()}>
              Export as Markdown
            </MenuItem>
          </Menu>
        ) : (
          <>
            <Button size="sm" variant="ghost" icon={<Settings2 className="size-3.5" />} onClick={() => navigate('/connectors')}>
              Configuration
            </Button>
            <Button size="sm" variant="ghost" icon={<Download className="size-3.5" />} onClick={() => void exportChat()}>
              Export
            </Button>
          </>
        )}
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
      <div className="shrink-0 px-6 pb-5 max-md:px-2 max-md:pb-2">
        <div className="mx-auto max-w-[760px]">
          <Composer
            docked
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

