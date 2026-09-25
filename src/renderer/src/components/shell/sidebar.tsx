import { useMemo, useState, type ReactNode } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router'
import { AnimatePresence, motion } from 'motion/react'
import {
  BookOpen,
  Blocks,
  Boxes,
  ChevronDown,
  Clapperboard,
  FolderOpen,
  Layers,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RotateCw,
  ScanFace,
  Search,
  Settings,
  Sparkles,
  Trash2,
  Zap
} from 'lucide-react'
import { cn, timeAgo } from '@/lib/utils'
import { ease, spring } from '@/lib/motion'
import { db, useCollection } from '@/stores/db'
import { useGen } from '@/stores/gen'
import { useAppSettings } from '@/stores/settings'
import { useUpdate } from '@/stores/update'
import { Avatar, StatusDot } from '../ui/misc'
import { Tooltip } from '../ui/overlay'
import { LogoMark, Wordmark } from './logo'

interface NavDef {
  to: string
  label: string
  icon: ReactNode
  match?: (path: string) => boolean
}

const NAV: NavDef[] = [
  { to: '/', label: 'New chat', icon: <Plus />, match: (p) => p === '/' },
  { to: '/stories', label: 'Stories', icon: <BookOpen />, match: (p) => p.startsWith('/stories') },
  { to: '/characters', label: 'Characters', icon: <ScanFace />, match: (p) => p.startsWith('/characters') },
  { to: '/generate/image', label: 'Generate', icon: <Sparkles />, match: (p) => p.startsWith('/generate') },
  { to: '/studio', label: 'Studio', icon: <Clapperboard />, match: (p) => p.startsWith('/studio') },
  { to: '/assets', label: 'Assets', icon: <FolderOpen />, match: (p) => p.startsWith('/assets') }
]

const NAV_MORE: NavDef[] = [
  { to: '/projects', label: 'Projects', icon: <Layers />, match: (p) => p.startsWith('/projects') },
  { to: '/models', label: 'Models', icon: <Boxes />, match: (p) => p.startsWith('/models') },
  { to: '/skills', label: 'Skills', icon: <Zap />, match: (p) => p.startsWith('/skills') },
  { to: '/connectors', label: 'Connectors', icon: <Blocks />, match: (p) => p.startsWith('/connectors') }
]

function NavItem({ item, active, collapsed }: { item: NavDef; active: boolean; collapsed: boolean }): React.JSX.Element {
  const body = (
    <NavLink
      to={item.to}
      className={cn('no-drag group relative flex h-9 items-center gap-2.5 rounded-[10px] px-1.5 text-[13px] font-medium transition-colors duration-200', active ? 'text-fg' : 'text-fg-2 hover:text-fg')}
    >
      {active && <motion.span layoutId="nav-active" className="absolute inset-0 rounded-[10px] border border-line bg-white/[0.07] hairline" transition={spring} />}
      {!active && <span className="absolute inset-0 rounded-[10px] bg-white/0 transition-colors duration-200 group-hover:bg-white/[0.04]" />}
      <span
        className={cn(
          'relative grid size-6.5 shrink-0 place-items-center rounded-lg border transition-all duration-300 [&>svg]:size-3.5',
          active ? 'border-transparent bg-grad text-white shadow-[0_4px_14px_-4px_color-mix(in_oklab,var(--accent)_80%,transparent)]' : 'border-line bg-white/[0.05] text-fg-2 group-hover:text-fg'
        )}
      >
        {item.icon}
      </span>
      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.span initial={{ opacity: 0, x: -4 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -4 }} transition={{ duration: 0.2, ease }} className="relative truncate">
            {item.label}
          </motion.span>
        )}
      </AnimatePresence>
    </NavLink>
  )
  return collapsed ? (
    <Tooltip content={item.label} side="right">
      {body}
    </Tooltip>
  ) : (
    body
  )
}

export function Sidebar({ collapsed, onToggle, onSearch }: { collapsed: boolean; onToggle: () => void; onSearch: () => void }): React.JSX.Element {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const settings = useAppSettings()
  const chats = useCollection('chats')
  const comfy = useGen((s) => s.comfy)
  const [chatsOpen, setChatsOpen] = useState(true)
  const online = comfy.filter((c) => c.online)
  const gpuLabel = useMemo(() => {
    if (!comfy.length) return 'No ComfyUI'
    if (!online.length) return 'ComfyUI offline'
    return online.length > 1 ? `${online.length} GPUs ready` : (online[0].gpu ?? 'ComfyUI ready').replace(/NVIDIA GeForce /i, '')
  }, [comfy.length, online])

  return (
    <motion.aside
      animate={{ width: collapsed ? 64 : 248 }}
      transition={spring}
      className="sidebar-scrim drag relative z-10 flex h-full shrink-0 flex-col overflow-hidden pt-2 pb-3"
    >
      {/* Brand row */}
      <div className={cn('flex h-10 items-center gap-2 px-3', collapsed && 'justify-center px-0')}>
        <button onClick={() => navigate('/')} className="no-drag flex min-w-0 items-center gap-2 rounded-xl px-1.5 py-1 transition hover:bg-white/[0.05]">
          <LogoMark size={28} className="-my-1" />
          {!collapsed && (
            <>
              <Wordmark height={15} className="mt-0.5 text-fg" />
              <ChevronDown className="size-3.5 text-fg-3" />
            </>
          )}
        </button>
        {!collapsed && (
          <div className="no-drag ml-auto flex items-center">
            <button onClick={onSearch} className="grid size-7 place-items-center rounded-lg text-fg-3 transition hover:bg-white/[0.06] hover:text-fg" title="Search (Ctrl+K)">
              <Search className="size-3.5" />
            </button>
            <button onClick={onToggle} className="grid size-7 place-items-center rounded-lg text-fg-3 transition hover:bg-white/[0.06] hover:text-fg" title="Collapse sidebar">
              <PanelLeftClose className="size-3.5" />
            </button>
          </div>
        )}
      </div>
      {collapsed && (
        <button onClick={onToggle} className="no-drag mx-auto mt-1 grid size-7 place-items-center rounded-lg text-fg-3 transition hover:bg-white/[0.06] hover:text-fg" title="Expand sidebar">
          <PanelLeftOpen className="size-3.5" />
        </button>
      )}

      <nav className="no-drag mt-3 flex flex-col gap-0.5 px-2.5">
        {NAV.map((n) => (
          <NavItem key={n.to} item={n} active={n.match ? n.match(pathname) : pathname === n.to} collapsed={collapsed} />
        ))}
        <div className="mx-2 my-2 h-px bg-line" />
        {NAV_MORE.map((n) => (
          <NavItem key={n.to} item={n} active={n.match ? n.match(pathname) : pathname === n.to} collapsed={collapsed} />
        ))}
      </nav>

      {/* Chats */}
      {!collapsed && (
        <div className="no-drag mt-4 flex min-h-0 flex-1 flex-col px-2.5">
          <button onClick={() => setChatsOpen((o) => !o)} className="flex items-center justify-between px-2 py-1 text-[11.5px] font-medium text-fg-3 hover:text-fg-2">
            Chats
            <ChevronDown className={cn('size-3 transition-transform duration-300', !chatsOpen && '-rotate-90')} />
          </button>
          <AnimatePresence initial={false}>
            {chatsOpen && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.3, ease }}
                className="scroll-fade min-h-0 flex-1 overflow-y-auto"
              >
                {chats.length === 0 && (
                  <div className="flex flex-col items-center gap-2 px-3 py-6 text-center">
                    <div className="relative">
                      <div className="size-10 rotate-6 rounded-xl border border-line bg-white/[0.04]" />
                      <div className="absolute inset-0 -rotate-6 rounded-xl border border-line bg-white/[0.06]" />
                      <MessageSquare className="absolute inset-0 m-auto size-4 text-fg-3" />
                    </div>
                    <div className="text-[12px] font-medium text-fg-2">No chats yet</div>
                    <div className="text-[11px] text-fg-3">Create one to get started</div>
                  </div>
                )}
                {chats.slice(0, 40).map((c) => {
                  const active = pathname === `/chat/${c.id}`
                  return (
                    <NavLink
                      key={c.id}
                      to={`/chat/${c.id}`}
                      className={cn('group flex h-8 items-center gap-2 rounded-lg px-2 text-[12.5px] transition-colors', active ? 'bg-white/[0.07] text-fg' : 'text-fg-2 hover:bg-white/[0.04] hover:text-fg')}
                    >
                      <span className="min-w-0 flex-1 truncate">{c.title}</span>
                      <span className="text-[10.5px] text-fg-3 group-hover:hidden">{timeAgo(c.updatedAt)}</span>
                      <button
                        onClick={(e) => {
                          e.preventDefault()
                          void db.remove('chats', c.id)
                          if (active) navigate('/')
                        }}
                        className="hidden size-5 place-items-center rounded text-fg-3 hover:text-danger group-hover:grid"
                      >
                        <Trash2 className="size-3" />
                      </button>
                    </NavLink>
                  )
                })}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}
      {collapsed && <div className="flex-1" />}

      {/* Footer */}
      <div className="no-drag mt-2 flex flex-col gap-1.5 px-2.5">
        <UpdatePill collapsed={collapsed} />
        <NavLink
          to="/settings?tab=gpus"
          className={cn('flex h-9 items-center gap-2.5 rounded-[10px] border border-line bg-white/[0.03] px-2.5 text-[12px] font-medium text-fg-2 transition hover:bg-white/[0.06] hover:text-fg', collapsed && 'justify-center px-0')}
        >
          <StatusDot state={online.length ? 'online' : comfy.length ? 'warn' : 'offline'} />
          {!collapsed && <span className="truncate">{gpuLabel}</span>}
        </NavLink>
        <div className={cn('flex items-center gap-2 rounded-[10px] px-1.5 py-1', collapsed && 'flex-col')}>
          <Avatar name={settings?.userName} size={30} className="ring-2 ring-[color-mix(in_oklab,var(--accent)_45%,transparent)]" />
          {!collapsed && <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{settings?.userName}</span>}
          <NavLink to="/settings" className={({ isActive }) => cn('grid size-7 place-items-center rounded-lg text-fg-3 transition hover:bg-white/[0.06] hover:text-fg', isActive && 'text-fg')}>
            <Settings className="size-3.5" />
          </NavLink>
        </div>
      </div>
    </motion.aside>
  )
}

/** Shown after "Later": one click restarts into the downloaded update. */
function UpdatePill({ collapsed }: { collapsed: boolean }): React.JSX.Element {
  const state = useUpdate((s) => s.state)
  const install = useUpdate((s) => s.install)
  const show = state?.status === 'downloaded' && state.deferred
  return (
    <AnimatePresence initial={false}>
      {show && (
        <motion.button
          key="update-pill"
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 36 }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.3, ease }}
          onClick={() => void install()}
          title={`Restart to update to Stitch ${state.version}`}
          className={cn(
            'relative flex shrink-0 items-center gap-2.5 overflow-hidden rounded-[10px] border border-[color-mix(in_oklab,var(--accent)_45%,transparent)] bg-[color-mix(in_oklab,var(--accent)_12%,transparent)] px-2.5 text-[12px] font-medium text-fg transition hover:bg-[color-mix(in_oklab,var(--accent)_20%,transparent)]',
            collapsed && 'justify-center px-0'
          )}
        >
          <RotateCw className="size-3.5 text-accent" />
          {!collapsed && <span className="truncate">Restart to update · {state.version}</span>}
        </motion.button>
      )}
    </AnimatePresence>
  )
}
