// The PC link, visible: a status pill in the top bar, a detail sheet, and a reconnect banner.
import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Globe, Laptop, Link2Off, RefreshCw, ScanLine, Unplug, X } from 'lucide-react'
import { cn, timeAgo } from '@/lib/utils'
import { spring } from '@/lib/motion'
import { Button } from '@/components/ui/button'
import { StatusDot } from '@/components/ui/misc'
import { invoke } from '@/lib/api'
import { link, useLink } from '@mobile/bridge/connection'
import { clearPairing, routeOf } from '@mobile/bridge/pairing'
import { Sheet } from './Sheet'
import { tap } from './haptics'

/** How long the reconnect banner stays before folding into the top bar's PC button. */
const BANNER_MS = 6000

/** Milliseconds the link has been down (ticks while down, 0 when connected). */
function useDownFor(): number {
  const downSince = useLink((s) => s.downSince)
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!downSince) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [downSince])
  return downSince ? Math.max(0, now - downSince) : 0
}

/**
 * The PC link at a glance: a laptop with a live status dot (details in LinkSheet). Once the PC has
 * been away for a while it becomes a small "Offline" chip — the quiet, permanent version of the banner.
 */
export function PcPill({ onClick }: { onClick: () => void }): React.JSX.Element {
  const state = useLink((s) => s.state)
  const route = useLink((s) => s.route)
  const downFor = useDownFor()
  const ready = state === 'ready'
  const away = !ready && state !== 'idle' && (state === 'unpaired' || downFor > BANNER_MS)
  return (
    <button
      onClick={() => {
        tap()
        onClick()
      }}
      aria-label={ready ? 'Connected to your PC' : 'PC connection'}
      className={cn(
        'relative flex h-10 min-w-10 items-center justify-center gap-1.5 rounded-xl text-fg-2 transition-[transform,background-color] active:scale-90 active:bg-white/[0.06] min-[600px]:h-12 min-[600px]:min-w-12',
        away && 'px-2.5'
      )}
    >
      <span className="relative grid place-items-center">
        {route === 'Internet' && ready ? <Globe className="size-[18px] min-[600px]:size-[22px]" /> : <Laptop className="size-[18px] min-[600px]:size-[22px]" />}
        <span className="absolute -right-[5px] -bottom-[4px] flex rounded-full bg-[#110f18] p-[2px]">
          <StatusDot state={ready ? 'online' : state === 'unpaired' ? 'offline' : 'warn'} />
        </span>
      </span>
      <AnimatePresence initial={false}>
        {away && (
          <motion.span
            initial={{ opacity: 0, x: -4 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -4 }}
            transition={spring}
            className="text-[11.5px] font-semibold whitespace-nowrap text-fg-2 min-[600px]:text-[12.5px]"
          >
            {state === 'unpaired' ? 'Unpaired' : 'Offline'}
          </motion.span>
        )}
      </AnimatePresence>
    </button>
  )
}

export function LinkSheet({ open, onClose }: { open: boolean; onClose: () => void }): React.JSX.Element {
  const s = useLink()
  const [confirm, setConfirm] = useState(false)
  useEffect(() => {
    if (!open) setConfirm(false)
  }, [open])
  const ready = s.state === 'ready'
  return (
    <Sheet open={open} onClose={onClose}>
      <div className="flex flex-col gap-5 px-5 pt-2 pb-5">
        <div className="flex items-center gap-3.5">
          <div className={cn('grid size-12 place-items-center rounded-2xl border border-line', ready ? 'bg-grad text-white shadow-[0_10px_30px_-10px_var(--accent)]' : 'bg-white/[0.05] text-fg-2')}>
            <Laptop className="size-5" />
          </div>
          <div className="min-w-0">
            <div className="truncate text-[16px] font-semibold">{s.pcName || 'Your PC'}</div>
            <div className="flex items-center gap-1.5 text-[12px] text-fg-2">
              <StatusDot state={ready ? 'online' : 'warn'} />
              {ready ? `Connected over ${s.route === 'LAN' ? 'Wi-Fi' : s.route === 'Tailscale' ? 'Tailscale' : 'the internet'} · ${s.host}` : s.state === 'unpaired' ? 'Not paired' : `Looking for your PC… ${s.host ?? ''}`}
            </div>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 text-[12px]">
          <Info label="Stitch on PC" value={s.pcVersion ? `v${s.pcVersion}` : '—'} />
          <Info label="Paired" value={s.pairing?.pairedAt ? timeAgo(s.pairing.pairedAt) : '—'} />
          <Info label="Addresses" value={s.pairing?.endpoints.map((e) => e.replace(/^https?:\/\//, '')).join(', ') ?? '—'} wide />
        </div>
        <p className="text-[12px] leading-relaxed text-fg-3">
          Everything you do here runs on the PC and stays in its library.{' '}
          {s.pairing?.endpoints.some((e) => routeOf(e) === 'Internet')
            ? 'Away from home, Stitch reaches your PC through its secure public address and switches back to Wi-Fi when you’re home.'
            : 'To use it away from home, turn on “Access from anywhere” on the PC (Settings → Phone).'}
        </p>
        <div className="flex flex-col gap-2">
          <Button size="lg" icon={<RefreshCw className="size-4" />} onClick={() => link.kick()}>
            Reconnect
          </Button>
          <AnimatePresence mode="wait" initial={false}>
            {!confirm ? (
              <motion.div key="a" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                <Button size="lg" variant="ghost" className="w-full" icon={<Unplug className="size-4" />} onClick={() => setConfirm(true)}>
                  Unpair this phone
                </Button>
              </motion.div>
            ) : (
              <motion.div key="b" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="flex gap-2">
                <Button size="lg" variant="ghost" className="flex-1" onClick={() => setConfirm(false)}>
                  Keep
                </Button>
                <Button
                  size="lg"
                  variant="danger"
                  className="flex-1"
                  icon={<Link2Off className="size-4" />}
                  onClick={async () => {
                    await invoke('remote:forgetMe').catch(() => {})
                    await clearPairing()
                    link.stop()
                    location.reload()
                  }}
                >
                  Unpair
                </Button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </Sheet>
  )
}

function Info({ label, value, wide }: { label: string; value: string; wide?: boolean }): React.JSX.Element {
  return (
    <div className={cn('rounded-xl border border-line bg-white/[0.03] px-3 py-2.5', wide && 'col-span-2')}>
      <div className="label-caps">{label}</div>
      <div className="mt-0.5 truncate font-medium text-fg">{value}</div>
    </div>
  )
}

/**
 * Slides down under the top bar when the link drops, then gets out of the way: after a few seconds
 * (or a tap on ×) it folds into the PC button, and Stitch keeps reconnecting quietly. On-device
 * features keep working meanwhile.
 */
export function LinkBanner({ onPair }: { onPair: () => void }): React.JSX.Element {
  const state = useLink((s) => s.state)
  const downSince = useLink((s) => s.downSince)
  const name = useLink((s) => s.pcName)
  const error = useLink((s) => s.error)
  const downFor = useDownFor()
  // Dismissals last for this outage (or this unpairing) only.
  const [dismissed, setDismissed] = useState<string | null>(null)
  const outage = state === 'unpaired' ? `unpaired:${error ?? ''}` : String(downSince ?? '')
  const show = dismissed !== outage && (state === 'unpaired' || (state !== 'ready' && !!downSince && downFor > 1200 && downFor <= BANNER_MS))
  const close = (
    <button onClick={() => setDismissed(outage)} className="grid size-7 place-items-center rounded-full text-fg-3 transition hover:text-fg active:scale-90" aria-label="Hide">
      <X className="size-3.5" />
    </button>
  )
  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ y: -40, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: -40, opacity: 0 }}
          transition={spring}
          className="pointer-events-none absolute inset-x-0 top-[calc(var(--sat)+var(--topbar)+6px)] z-50 flex justify-center px-4"
        >
          <div className="glass-strong pointer-events-auto flex items-center gap-2.5 rounded-full py-1.5 pr-1.5 pl-3.5 text-[12px] shadow-[var(--shadow-pop)]">
            {state === 'unpaired' ? (
              <>
                <Link2Off className="size-3.5 text-danger" />
                <span className="font-medium">Unpaired from {name || 'the PC'}</span>
                <Button size="xs" variant="primary" icon={<ScanLine className="size-3" />} onClick={onPair}>
                  Pair again
                </Button>
                {close}
              </>
            ) : (
              <>
                <motion.span animate={{ rotate: 360 }} transition={{ duration: 1.2, repeat: Infinity, ease: 'linear' }}>
                  <RefreshCw className="size-3.5 text-accent" />
                </motion.span>
                <span className="font-medium">Reconnecting to {name || 'your PC'}…</span>
                <Button size="xs" variant="ghost" onClick={() => link.kick()}>
                  Retry
                </Button>
                {close}
              </>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

