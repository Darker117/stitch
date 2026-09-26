// Ctrl+K palette: jump anywhere, find characters, stories and chats.
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { AnimatePresence, motion } from 'motion/react'
import { BookOpen, Blocks, Clapperboard, FolderOpen, Image, Layers, MessageSquare, Music, Plus, ScanFace, Search, Settings, Sparkles, Video, Zap } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ease, springSoft } from '@/lib/motion'
import { useCompact } from '@/lib/platform'
import { useCollection } from '@/stores/db'
import { Kbd } from '../ui/misc'

interface Cmd {
  id: string
  label: string
  hint?: string
  icon: ReactNode
  group: string
  run: () => void
}

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }): React.JSX.Element {
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const [idx, setIdx] = useState(0)
  const characters = useCollection('characters')
  const adventures = useCollection('adventures')
  const scenarios = useCollection('scenarios')
  const chats = useCollection('chats')
  // Phone: a full-width search sheet that drops from the top, sized to the space above the keyboard.
  const compact = useCompact()

  const go = (to: string) => () => {
    navigate(to)
    onClose()
  }

  const all = useMemo<Cmd[]>(() => {
    const nav: Cmd[] = [
      { id: 'new', label: 'New chat', icon: <Plus />, group: 'Go to', run: go('/') },
      { id: 'img', label: 'Generate image', icon: <Image />, group: 'Go to', run: go('/generate/image') },
      { id: 'vid', label: 'Generate video', icon: <Video />, group: 'Go to', run: go('/generate/video') },
      { id: 'aud', label: 'Generate audio', icon: <Music />, group: 'Go to', run: go('/generate/audio') },
      { id: 'voi', label: 'Voices', icon: <Sparkles />, group: 'Go to', run: go('/generate/voice') },
      { id: 'sto', label: 'Stories', icon: <BookOpen />, group: 'Go to', run: go('/stories') },
      { id: 'newsto', label: 'New story', icon: <BookOpen />, group: 'Go to', run: go('/stories/new') },
      { id: 'cha', label: 'Characters', icon: <ScanFace />, group: 'Go to', run: go('/characters') },
      { id: 'stu', label: 'Studio', icon: <Clapperboard />, group: 'Go to', run: go('/studio') },
      { id: 'ass', label: 'Assets', icon: <FolderOpen />, group: 'Go to', run: go('/assets') },
      { id: 'pro', label: 'Projects', icon: <Layers />, group: 'Go to', run: go('/projects') },
      { id: 'ski', label: 'Skills', icon: <Zap />, group: 'Go to', run: go('/skills') },
      { id: 'con', label: 'Connectors', icon: <Blocks />, group: 'Go to', run: go('/connectors') },
      { id: 'set', label: 'Settings', icon: <Settings />, group: 'Go to', run: go('/settings') }
    ]
    return [
      ...nav,
      ...characters.map((c) => ({ id: `c-${c.id}`, label: c.name, hint: 'Character', icon: <ScanFace />, group: 'Characters', run: go(`/characters/${c.id}`) })),
      ...adventures.map((a) => ({ id: `a-${a.id}`, label: a.title, hint: 'Continue playing', icon: <BookOpen />, group: 'Adventures', run: go(`/play/${a.id}`) })),
      ...scenarios.filter((s) => !s.parentId).map((s) => ({ id: `s-${s.id}`, label: s.title || 'Untitled scenario', hint: 'Edit scenario', icon: <BookOpen />, group: 'Scenarios', run: go(`/stories/scenario/${s.id}`) })),
      ...chats.map((c) => ({ id: `ch-${c.id}`, label: c.title, hint: 'Chat', icon: <MessageSquare />, group: 'Chats', run: go(`/chat/${c.id}`) }))
    ]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [characters, adventures, scenarios, chats])

  const results = useMemo(() => {
    const t = q.trim().toLowerCase()
    const list = t ? all.filter((c) => c.label.toLowerCase().includes(t) || c.hint?.toLowerCase().includes(t)) : all.filter((c) => c.group === 'Go to')
    return list.slice(0, 40)
  }, [q, all])

  useEffect(() => {
    if (open) {
      setQ('')
      setIdx(0)
    }
  }, [open])
  useEffect(() => setIdx(0), [q])

  let lastGroup = ''
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[60] flex justify-center bg-black/40 pt-[14vh] backdrop-blur-[3px] max-md:items-start max-md:bg-black/55 max-md:px-1.5 max-md:pt-[calc(var(--sat,0px)+6px)] max-md:pb-1.5"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2, ease }}
          onClick={onClose}
        >
          <motion.div
            initial={compact ? { opacity: 0, y: -28 } : { opacity: 0, y: -12, scale: 0.97 }}
            animate={compact ? { opacity: 1, y: 0 } : { opacity: 1, y: 0, scale: 1 }}
            exit={compact ? { opacity: 0, y: -20 } : { opacity: 0, y: -8, scale: 0.98 }}
            transition={compact ? { type: 'spring', stiffness: 420, damping: 36, mass: 0.8 } : springSoft}
            className="glass-strong h-fit w-[560px] overflow-hidden rounded-2xl shadow-[var(--shadow-pop)] max-md:flex max-md:max-h-full max-md:w-full max-md:flex-col max-md:rounded-[22px]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2.5 border-b border-line px-4 max-md:shrink-0 max-md:gap-2 max-md:pr-1.5 max-md:pl-4">
              <Search className="size-4 text-fg-3 max-md:shrink-0" />
              <input
                autoFocus
                enterKeyHint="go"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault()
                    setIdx((i) => Math.min(results.length - 1, i + 1))
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault()
                    setIdx((i) => Math.max(0, i - 1))
                  } else if (e.key === 'Enter') results[idx]?.run()
                  else if (e.key === 'Escape') onClose()
                }}
                placeholder={compact ? 'Search or jump to a page' : 'Search characters, stories, chats… or jump to a page'}
                className="h-12 flex-1 bg-transparent text-[14px] outline-none placeholder:text-fg-3 max-md:h-13 max-md:min-w-0 max-md:text-[15px]"
              />
              {compact ? (
                <button onClick={onClose} className="h-10 shrink-0 rounded-xl px-3 text-[13px] font-medium text-fg-2 transition active:scale-95 active:bg-white/[0.06]">
                  Cancel
                </button>
              ) : (
                <Kbd>Esc</Kbd>
              )}
            </div>
            <div className="max-h-[52vh] overflow-y-auto p-1.5 max-md:max-h-none max-md:min-h-0 max-md:flex-1 max-md:overscroll-contain max-md:px-1.5 max-md:pb-2">
              {results.map((c, i) => {
                const header = c.group !== lastGroup ? c.group : null
                lastGroup = c.group
                return (
                  <div key={c.id}>
                    {header && <div className="label-caps px-2.5 pt-2.5 pb-1 max-md:px-3 max-md:pt-3">{header}</div>}
                    <button
                      onMouseEnter={() => setIdx(i)}
                      onClick={c.run}
                      className={cn(
                        'relative flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] max-md:h-11 max-md:gap-3 max-md:rounded-xl max-md:px-2 max-md:text-[13.5px] max-md:active:scale-[0.985] max-md:transition-transform',
                        i === idx ? 'text-fg' : 'text-fg-2'
                      )}
                    >
                      {i === idx && <motion.span layoutId="cmd-hl" className="absolute inset-0 rounded-lg bg-white/[0.08] max-md:rounded-xl" transition={springSoft} />}
                      <span className="relative text-fg-3 [&>svg]:size-3.5 max-md:grid max-md:size-7.5 max-md:shrink-0 max-md:place-items-center max-md:rounded-lg max-md:border max-md:border-line max-md:bg-white/[0.04] max-md:text-fg-2">{c.icon}</span>
                      <span className="relative flex-1 truncate">{c.label}</span>
                      {c.hint && <span className="relative text-[11px] text-fg-3 max-md:shrink-0">{c.hint}</span>}
                    </button>
                  </div>
                )
              })}
              {!results.length && <div className="py-10 text-center text-[12.5px] text-fg-3">Nothing matches “{q}”</div>}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
