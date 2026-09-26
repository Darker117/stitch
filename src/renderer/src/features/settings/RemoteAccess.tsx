// Settings → Phone → Access from anywhere: a public HTTPS address so the phone works away from home.
import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { AlertTriangle, Check, Cloud, Copy, ExternalLink, Globe, Link2, Lock, Network, WifiOff } from 'lucide-react'
import type { AnywhereMode, RemoteStatus } from '@shared/ipc'
import { errorText, invoke } from '@/lib/api'
import { cn } from '@/lib/utils'
import { ease, spring } from '@/lib/motion'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge, ProgressBar, SectionTitle, Spinner, StatusDot } from '@/components/ui/misc'
import { toast } from '@/stores/toast'

interface Option {
  mode: AnywhereMode
  title: string
  body: string
  icon: React.ReactNode
  badge?: string
}

function options(status: RemoteStatus): Option[] {
  const ts = status.anywhere.tailscale
  return [
    { mode: 'off', title: 'Home network only', body: 'Phones connect over your Wi-Fi (or Tailscale, if the phone has it too).', icon: <WifiOff /> },
    {
      mode: 'cloudflare',
      title: 'Public link',
      body: 'Zero setup — a secure Cloudflare tunnel. The address changes when Stitch restarts; paired phones follow it automatically.',
      icon: <Cloud />,
      badge: 'Easiest'
    },
    {
      mode: 'tailscale',
      title: 'Tailscale Funnel',
      body: ts?.dnsName ? `A permanent address at ${ts.dnsName}. The phone doesn't need Tailscale.` : 'A permanent https://<pc>.ts.net address through Tailscale on this PC. The phone doesn’t need Tailscale.',
      icon: <Network />,
      badge: 'Permanent'
    },
    { mode: 'custom', title: 'Your own address', body: 'Already run a tunnel or reverse proxy to this PC? Point it at the phone port and enter its public URL.', icon: <Link2 /> }
  ]
}

export function RemoteAccess({ status, onStatus }: { status: RemoteStatus; onStatus: (s: RemoteStatus) => void }): React.JSX.Element {
  const a = status.anywhere
  const [busy, setBusy] = useState<AnywhereMode | null>(null)
  const [custom, setCustom] = useState(a.mode === 'custom' ? (a.url ?? '') : '')
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (a.mode === 'custom' && a.url) setCustom(a.url)
  }, [a.mode, a.url])

  const choose = async (mode: AnywhereMode, customUrl?: string): Promise<void> => {
    if (mode === 'custom' && !customUrl) return
    setBusy(mode)
    try {
      onStatus(await invoke('remote:setAnywhere', mode, customUrl))
    } catch (err) {
      toast.error('Access from anywhere', errorText(err))
    } finally {
      setBusy(null)
    }
  }

  const copy = (): void => {
    if (!a.url) return
    void navigator.clipboard.writeText(a.url)
    setCopied(true)
    setTimeout(() => setCopied(false), 1400)
  }

  return (
    <div className="space-y-3">
      <SectionTitle icon={<Globe />}>Access from anywhere</SectionTitle>
      <p className="-mt-1 text-[12.5px] leading-relaxed text-fg-2">Use Stitch on your phone away from home — on mobile data or any Wi-Fi. Your PC still does all the work.</p>

      <div className="grid gap-2 sm:grid-cols-2">
        {options(status).map((o) => {
          const active = a.mode === o.mode
          return (
            <button
              key={o.mode}
              onClick={() => (o.mode === 'custom' ? void choose('custom', custom.trim() || undefined) : void choose(o.mode))}
              disabled={!!busy}
              className={cn('relative flex items-start gap-3 rounded-2xl border p-3.5 text-left transition-colors', active ? 'border-transparent' : 'border-line bg-white/[0.02] hover:bg-white/[0.04]')}
            >
              {active && (
                <motion.span
                  layoutId="anywhere-active"
                  className="absolute inset-0 rounded-2xl border border-[color-mix(in_oklab,var(--accent)_50%,transparent)] bg-[color-mix(in_oklab,var(--accent)_9%,transparent)]"
                  transition={spring}
                />
              )}
              <span className={cn('relative grid size-9 shrink-0 place-items-center rounded-xl border [&>svg]:size-4', active ? 'border-transparent bg-grad text-white' : 'border-line bg-white/[0.05] text-fg-2')}>
                {busy === o.mode ? <Spinner className="size-4" /> : o.icon}
              </span>
              <span className="relative min-w-0">
                <span className="flex items-center gap-2 text-[13px] font-semibold">
                  {o.title}
                  {o.badge && <Badge tone={active ? 'accent' : 'default'}>{o.badge}</Badge>}
                </span>
                <span className="mt-0.5 block text-[12px] leading-snug text-fg-3">{o.body}</span>
              </span>
            </button>
          )
        })}
      </div>

      <AnimatePresence initial={false}>
        {a.mode === 'custom' && (
          <motion.div key="custom" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.3, ease }} className="overflow-hidden">
            <div className="flex gap-2 pt-1 max-md:flex-col">
              <Input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="https://stitch.example.com" className="flex-1 font-mono text-[12px]" />
              <Button onClick={() => void choose('custom', custom.trim())} disabled={!/^https?:\/\/\S+$/i.test(custom.trim())}>
                Use address
              </Button>
            </div>
            <div className="mt-1.5 text-[11.5px] text-fg-3">
              Forward it to <span className="font-mono text-fg-2">http://127.0.0.1:{status.port}</span> (WebSockets on). Use HTTPS.
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence mode="wait" initial={false}>
        {a.mode !== 'off' && (
          <motion.div key={`${a.mode}-${a.state}`} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.28, ease }}>
            {a.state === 'ready' && a.url ? (
              <div className="rounded-2xl border border-success/25 bg-success/[0.06] p-3.5">
                <div className="flex items-center gap-2 text-[12.5px] font-semibold text-success">
                  <StatusDot state="online" /> Reachable from anywhere
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <div className="selectable min-w-0 flex-1 truncate rounded-xl border border-line bg-black/20 px-3 py-2 font-mono text-[12px]">{a.url}</div>
                  <Button size="sm" icon={copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />} onClick={copy}>
                    {copied ? 'Copied' : 'Copy'}
                  </Button>
                </div>
                {a.error && <div className="mt-2 text-[11.5px] text-fg-3">{a.error}</div>}
                <div className="mt-2 text-[11.5px] leading-relaxed text-fg-3">Paired phones pick this up automatically. New phones get it from the pairing QR code.</div>
              </div>
            ) : a.state === 'downloading' ? (
              <div className="rounded-2xl border border-line bg-white/[0.03] p-3.5">
                <div className="text-[12.5px] font-medium">Getting the secure tunnel (Cloudflare’s cloudflared, one time)…</div>
                <ProgressBar value={a.progress} className="mt-2" />
              </div>
            ) : a.state === 'starting' ? (
              <div className="flex items-center gap-2.5 rounded-2xl border border-line bg-white/[0.03] p-3.5 text-[12.5px]">
                <Spinner className="size-4" />
                <span>{a.error ?? (a.url ? `Checking ${a.url} from the outside…` : 'Opening a secure public address…')}</span>
              </div>
            ) : a.state === 'needs-action' ? (
              <div className="flex items-start gap-3 rounded-2xl border border-warning/25 bg-warning/[0.07] p-3.5 text-[12.5px]">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
                <div className="min-w-0 flex-1">
                  <div className="text-fg">{a.error}</div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {a.actionUrl && (
                      <Button size="sm" variant="primary" icon={<ExternalLink className="size-3.5" />} onClick={() => void invoke('sys:openExternal', a.actionUrl!)}>
                        {a.actionLabel ?? 'Open'}
                      </Button>
                    )}
                    <Button size="sm" onClick={() => void choose(a.mode, a.mode === 'custom' ? custom : undefined)}>
                      Try again
                    </Button>
                  </div>
                </div>
              </div>
            ) : a.state === 'error' ? (
              <div className="flex items-start gap-3 rounded-2xl border border-danger/25 bg-danger/[0.07] p-3.5 text-[12.5px]">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" />
                <div className="min-w-0 flex-1">
                  <div className="text-fg">{a.error ?? 'Something went wrong'}</div>
                  <Button size="sm" className="mt-2" onClick={() => void choose(a.mode, a.mode === 'custom' ? custom : undefined)}>
                    Try again
                  </Button>
                </div>
              </div>
            ) : null}
          </motion.div>
        )}
      </AnimatePresence>

      <div className="flex items-start gap-2.5 text-[11.5px] leading-relaxed text-fg-3">
        <Lock className="mt-0.5 size-3.5 shrink-0" />
        <span>Connections use HTTPS (with the public link they pass through Cloudflare; with Funnel, through Tailscale). Only phones you paired can get in — unpair one here and it's cut off everywhere.</span>
      </div>
    </div>
  )
}
