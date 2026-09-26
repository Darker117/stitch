// Phone chrome around the desktop pages: top bar, floating tab bar, drawer (the desktop sidebar),
// "More" sheet, PC link status, job tray and the PC folder picker.
import { useCallback, useEffect, useState } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router'
import { AnimatePresence, motion } from 'motion/react'
import { ArrowUpFromLine, Cpu, Menu, Search } from 'lucide-react'
import { AnimatedOutlet } from '@/App'
import { LogoMark, Wordmark } from '@/components/shell/logo'
import { Sidebar } from '@/components/shell/sidebar'
import { CommandPalette } from '@/components/shell/command'
import { ProgressRing } from '@/components/ui/misc'
import { cn } from '@/lib/utils'
import { ease, spring, stagger, rise } from '@/lib/motion'
import { useUploads } from '@mobile/bridge/system'
import { FolderPickerSheet } from './FolderPicker'
import { JobDock } from './JobDock'
import { LinkBanner, LinkSheet, PcPill } from './LinkStatus'
import { MORE } from './nav'
import { Sheet } from './Sheet'
import { TabBar } from './TabBar'
import { pushBack } from './back'
import { tap } from './haptics'

function TopBar({ onMenu, onSearch, onPc }: { onMenu: () => void; onSearch: () => void; onPc: () => void }): React.JSX.Element {
  const navigate = useNavigate()
  return (
    <header className="relative z-30 shrink-0 pt-[var(--sat)]">
      <div className="flex h-[var(--topbar)] items-center gap-1 px-2 min-[600px]:px-4">
        <button onClick={onMenu} className="grid size-10 place-items-center rounded-xl text-fg-2 transition active:scale-90 active:bg-white/[0.06] min-[600px]:size-12" aria-label="Menu">
          <Menu className="size-[18px] min-[600px]:size-[22px]" />
        </button>
        <button onClick={() => navigate('/')} className="flex origin-left items-center gap-1.5 rounded-xl px-1 py-1 active:scale-95 min-[600px]:scale-[1.15]">
          <LogoMark size={26} />
          <Wordmark height={14} className="mt-0.5 text-fg" />
        </button>
        <div className="flex-1" />
        <button onClick={onSearch} className="grid size-10 place-items-center rounded-xl text-fg-2 transition active:scale-90 active:bg-white/[0.06] min-[600px]:size-12" aria-label="Search">
          <Search className="size-[18px] min-[600px]:size-[22px]" />
        </button>
        <PcPill onClick={onPc} />
      </div>
    </header>
  )
}

function MoreSheet({ open, onClose }: { open: boolean; onClose: () => void }): React.JSX.Element {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  return (
    <Sheet open={open} onClose={onClose} title="Everything else">
      <motion.div variants={stagger(0.03, 0.05)} initial="initial" animate="animate" className="grid grid-cols-2 gap-2.5 px-4 pt-3 pb-5 min-[600px]:grid-cols-3 min-[600px]:gap-3 min-[600px]:px-5">
        {MORE.map((m) => {
          const active = m.match(pathname)
          return (
            <motion.button
              key={m.to}
              variants={rise}
              whileTap={{ scale: 0.96 }}
              onClick={() => {
                tap()
                onClose()
                navigate(m.to)
              }}
              className={cn('relative flex items-center gap-3 overflow-hidden rounded-2xl border p-3 text-left', active ? 'border-[color-mix(in_oklab,var(--accent)_45%,transparent)] bg-white/[0.07]' : 'border-line bg-white/[0.03]')}
            >
              <span className={cn('grid size-10 shrink-0 place-items-center rounded-xl border [&>svg]:size-[18px] min-[600px]:size-12 min-[600px]:[&>svg]:size-[22px]', active ? 'border-transparent bg-grad text-white' : 'border-line bg-white/[0.05] text-fg-2')}>{m.icon}</span>
              <span className="min-w-0">
                <span className="block truncate text-[13.5px] font-semibold">{m.label}</span>
                <span className="block truncate text-[11.5px] text-fg-3">{m.hint}</span>
              </span>
            </motion.button>
          )
        })}
      </motion.div>
    </Sheet>
  )
}

function Drawer({ open, onClose, onSearch }: { open: boolean; onClose: () => void; onSearch: () => void }): React.JSX.Element {
  useEffect(() => (open ? pushBack(onClose) : undefined), [open, onClose])
  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[75]">
          <motion.div className="absolute inset-0 bg-black/50 backdrop-blur-[2px]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.25, ease }} onClick={onClose} />
          <motion.div
            className="glass-strong absolute inset-y-0 left-0 flex w-[min(300px,84vw)] flex-col overflow-hidden rounded-r-[26px] border-l-0 pt-[var(--sat)] pb-[var(--sab)] shadow-[30px_0_80px_-20px_rgb(0_0_0/0.8)]"
            initial={{ x: '-100%' }}
            animate={{ x: 0 }}
            exit={{ x: '-100%' }}
            transition={{ type: 'spring', stiffness: 360, damping: 38, mass: 0.9 }}
            drag="x"
            dragConstraints={{ left: 0, right: 0 }}
            dragElastic={{ left: 0.9, right: 0.02 }}
            onDragEnd={(_, info) => {
              if (info.offset.x < -80 || info.velocity.x < -500) onClose()
            }}
          >
            <div className="phone-sidebar min-h-0 flex-1 [&>aside]:!w-full">
              <Sidebar
                collapsed={false}
                onToggle={onClose}
                onSearch={() => {
                  onClose()
                  onSearch()
                }}
                extraNav={[{ to: '/phone', label: 'This phone', icon: <Cpu />, match: (p) => p.startsWith('/phone') }]}
              />
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  )
}

function UploadPill(): React.JSX.Element {
  const active = useUploads((s) => s.active)
  const cur = active[0]
  return (
    <AnimatePresence>
      {cur && (
        <motion.div initial={{ y: 30, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 30, opacity: 0 }} transition={spring} className="pointer-events-none fixed inset-x-0 bottom-[calc(var(--tabbar)+var(--sab)+24px)] z-50 flex justify-center">
          <div className="glass-strong flex items-center gap-2.5 rounded-full py-2 pr-4 pl-2.5 text-[12px] font-medium shadow-[var(--shadow-pop)]">
            <ProgressRing value={cur.progress} size={20} />
            <ArrowUpFromLine className="size-3.5 text-accent" />
            <span className="max-w-[180px] truncate">Sending {cur.name} to your PC</span>
            {active.length > 1 && <span className="text-fg-3">+{active.length - 1}</span>}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/**
 * Detail screens (a character, a scenario, the composer, a project, the video editor) bring their own header
 * with a back button — like a pushed screen, they get the whole display without the app bars.
 */
const DETAIL = /^\/(characters\/[^/]+|stories\/(scenario\/[^/]+|compose|new)|projects\/[^/]+|studio\/[^/]+)/

export function MobileShell({ onPair }: { onPair: () => void }): React.JSX.Element {
  const [drawer, setDrawer] = useState(false)
  const [more, setMore] = useState(false)
  const [pc, setPc] = useState(false)
  const [palette, setPalette] = useState(false)
  const { pathname } = useLocation()
  const detail = DETAIL.test(pathname)

  // Close menus when a page changes.
  useEffect(() => {
    setDrawer(false)
    setMore(false)
  }, [pathname])
  const closeDrawer = useCallback(() => setDrawer(false), [])
  const closeMore = useCallback(() => setMore(false), [])
  const closePalette = useCallback(() => setPalette(false), [])
  useEffect(() => (palette ? pushBack(closePalette) : undefined), [palette, closePalette])

  return (
    <div className="relative flex h-full flex-col pr-[var(--sar)] pl-[var(--sal)]">
      {/* One continuous frosted surface on phones — no window-in-window frame. */}
      <div className="phone-wash pointer-events-none absolute inset-0" />
      <AnimatePresence initial={false}>
        {!detail && (
          <motion.div key="top" initial={{ opacity: 0, y: -12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -12 }} transition={{ duration: 0.28, ease }} className="relative z-30">
            <TopBar
              onMenu={() => {
                tap()
                setDrawer(true)
              }}
              onSearch={() => setPalette(true)}
              onPc={() => setPc(true)}
            />
          </motion.div>
        )}
      </AnimatePresence>
      {/* No z-index here: page overlays (lightbox, sheets) must be able to rise above the bars. */}
      <main className={cn('relative min-h-0 flex-1 overflow-hidden', detail && 'pt-[var(--sat)] pb-[var(--sab)]')}>
        <AnimatedOutlet />
      </main>
      <JobDock />
      <TabBar onMore={() => setMore((m) => !m)} moreOpen={more} hidden={detail} />
      <LinkBanner onPair={onPair} />
      <UploadPill />
      <Drawer open={drawer} onClose={closeDrawer} onSearch={() => setPalette(true)} />
      <MoreSheet open={more} onClose={closeMore} />
      <LinkSheet open={pc} onClose={() => setPc(false)} />
      <FolderPickerSheet />
      <CommandPalette open={palette} onClose={closePalette} />
    </div>
  )
}

/** Full-screen pages (story player): only the link banner and jobs on top. */
export function MobileImmersive({ onPair }: { onPair: () => void }): React.JSX.Element {
  return (
    <div className="relative h-full">
      <Outlet />
      <LinkBanner onPair={onPair} />
      <JobDock floating />
    </div>
  )
}
