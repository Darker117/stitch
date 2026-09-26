// Floating glass tab bar. The active tab's gradient chip glides between tabs.
import { useLocation, useNavigate } from 'react-router'
import { AnimatePresence, motion } from 'motion/react'
import { LayoutGrid } from 'lucide-react'
import { cn } from '@/lib/utils'
import { spring } from '@/lib/motion'
import { MORE, TABS } from './nav'
import { tap } from './haptics'
import { useKeyboard } from './insets'

function TabButton({ label, icon, active, onClick }: { label: string; icon: React.ReactNode; active: boolean; onClick: () => void }): React.JSX.Element {
  return (
    <button onClick={onClick} className="relative flex h-full flex-1 flex-col items-center justify-center gap-1 outline-none min-[600px]:gap-1.5" aria-current={active ? 'page' : undefined}>
      <span className="relative grid h-8 w-12 place-items-center min-[600px]:h-9 min-[600px]:w-14">
        {active && (
          <motion.span
            layoutId="tab-active"
            className="absolute inset-0 rounded-full bg-grad shadow-[0_6px_20px_-6px_color-mix(in_oklab,var(--accent)_85%,transparent)]"
            transition={spring}
          />
        )}
        <motion.span
          className={cn('relative [&>svg]:size-[18px] min-[600px]:[&>svg]:size-[22px]', active ? 'text-white' : 'text-fg-2')}
          animate={{ scale: active ? 1 : 0.94, y: active ? 0 : 1 }}
          transition={spring}
        >
          {icon}
        </motion.span>
      </span>
      <span className={cn('text-[10.5px] font-semibold tracking-wide transition-colors duration-300 min-[600px]:text-[12px]', active ? 'text-fg' : 'text-fg-2')}>{label}</span>
    </button>
  )
}

export function TabBar({ onMore, moreOpen, hidden }: { onMore: () => void; moreOpen: boolean; hidden?: boolean }): React.JSX.Element {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const keyboard = useKeyboard((s) => s.open)
  const inMore = MORE.some((m) => m.match(pathname))
  return (
    <AnimatePresence initial={false}>
      {!keyboard && !hidden && (
        <motion.nav
          key="tabbar"
          initial={{ y: 90, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 90, opacity: 0 }}
          transition={spring}
          className="relative z-30 shrink-0 px-3 pt-1.5 pb-[calc(var(--sab)+8px)] min-[600px]:pb-[calc(var(--sab)+14px)]"
        >
          {/* Tablets: a centred bar with bigger icons instead of one stretched edge to edge. */}
          <div className="glass-strong hairline flex h-[var(--tabbar)] items-stretch rounded-[24px] px-1 shadow-[0_18px_50px_-18px_rgb(0_0_0/0.9)] min-[600px]:mx-auto min-[600px]:max-w-[640px] min-[600px]:rounded-[28px] min-[600px]:px-2">
            {TABS.map((t) => (
              <TabButton
                key={t.to}
                label={t.label}
                icon={t.icon}
                active={!moreOpen && t.match(pathname)}
                onClick={() => {
                  tap()
                  if (!t.match(pathname)) navigate(t.to)
                }}
              />
            ))}
            <TabButton
              label="More"
              icon={<LayoutGrid />}
              active={moreOpen || inMore}
              onClick={() => {
                tap()
                onMore()
              }}
            />
          </div>
        </motion.nav>
      )}
    </AnimatePresence>
  )
}
