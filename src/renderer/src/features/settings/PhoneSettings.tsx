// Settings → Phone: let the Stitch Android app drive this PC over the LAN (or Tailscale).
import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Check, Globe, QrCode, Radio, ShieldCheck, Smartphone, Trash2, Wifi, X } from 'lucide-react'
import type { PairingInfo, RemoteDevice, RemoteStatus } from '@shared/ipc'
import { errorText, invoke, on } from '@/lib/api'
import { cn, timeAgo } from '@/lib/utils'
import { ease, pop, spring } from '@/lib/motion'
import { Button, IconButton } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge, Field, SectionTitle, StatusDot } from '@/components/ui/misc'
import { SwitchRow } from '@/components/ui/controls'
import { toast } from '@/stores/toast'
import { useAppSettings, useSettings } from '@/stores/settings'
import { RemoteAccess } from './RemoteAccess'
import { isPhone } from '@/lib/platform'

function useRemote(): [RemoteStatus | null, (s: RemoteStatus) => void] {
  const [status, setStatus] = useState<RemoteStatus | null>(null)
  useEffect(() => {
    void invoke('remote:status').then(setStatus)
    return on('remote:changed', setStatus)
  }, [])
  return [status, setStatus]
}

function Countdown({ until }: { until: number }): React.JSX.Element {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const left = Math.max(0, Math.round((until - now) / 1000))
  return (
    <span className="tabular-nums">
      {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}
    </span>
  )
}

function PairPanel({ info, status, paired, onClose, onRestart }: { info: PairingInfo; status: RemoteStatus; paired: RemoteDevice | null; onClose: () => void; onRestart: () => void }): React.JSX.Element {
  const expired = info.expiresAt < Date.now()
  const lan = status.hosts.find((h) => h.label === 'LAN') ?? status.hosts[0]
  return (
    <motion.div variants={pop} initial="initial" animate="animate" exit="exit" className="relative overflow-hidden rounded-2xl border border-line bg-white/[0.025] p-6 max-md:px-4 max-md:pt-10 max-md:pb-5">
      <div className="pointer-events-none absolute -top-24 -right-24 size-72 rounded-full bg-grad opacity-[0.12] blur-3xl" />
      <IconButton className="absolute top-3 right-3" size="sm" onClick={onClose} label="Close">
        <X />
      </IconButton>
      <AnimatePresence mode="wait" initial={false}>
        {paired ? (
          <motion.div key="done" initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.35, ease }} className="flex flex-col items-center gap-3 py-8 text-center">
            <motion.div initial={{ scale: 0.4, rotate: -20 }} animate={{ scale: 1, rotate: 0 }} transition={{ ...spring, delay: 0.05 }} className="grid size-16 place-items-center rounded-full bg-grad text-white shadow-[0_12px_40px_-10px_var(--accent)]">
              <Check className="size-8" strokeWidth={2.5} />
            </motion.div>
            <div className="text-[17px] font-semibold">{paired.name} is paired</div>
            <p className="max-w-sm text-[12.5px] text-fg-2">It can now use everything here — chats, stories, characters and generation — while your PC does the heavy lifting.</p>
            <Button className="mt-2" onClick={onClose}>
              Done
            </Button>
          </motion.div>
        ) : (
          <motion.div key="pair" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="relative flex flex-col items-center gap-6 sm:flex-row sm:items-stretch">
            <div className="relative shrink-0">
              <motion.div
                className="absolute -inset-3 rounded-[26px] bg-grad opacity-40 blur-xl"
                animate={{ opacity: [0.25, 0.5, 0.25] }}
                transition={{ duration: 3.2, repeat: Infinity, ease: 'easeInOut' }}
              />
              <div className={cn('relative grid size-[216px] place-items-center rounded-[22px] border border-line-strong bg-[#0b0a12] p-5 transition-opacity', expired && 'opacity-25')}>
                <div className="size-full [&>svg]:size-full" dangerouslySetInnerHTML={{ __html: info.qrSvg }} />
              </div>
            </div>
            <div className="flex min-w-0 flex-1 flex-col justify-center gap-4 max-md:w-full max-md:items-center max-md:text-center">
              <div>
                <div className="label-caps">Scan with the Stitch app</div>
                <p className="mt-1.5 text-[12.5px] leading-relaxed text-fg-2">
                  Open Stitch on your phone and tap <b className="text-fg">Scan QR code</b> — or point the camera app at the code. No camera? Enter this code instead:
                </p>
              </div>
              <div className="flex gap-1.5 max-md:max-w-full">
                {info.code.split('').map((d, i) => (
                  <motion.span
                    key={i}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.05 * i, duration: 0.4, ease }}
                    className="grid h-12 w-10 place-items-center rounded-xl border border-line-strong bg-white/[0.04] font-mono text-[24px] font-semibold max-md:h-11 max-md:min-w-0"
                  >
                    {d}
                  </motion.span>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-fg-3 max-md:justify-center">
                {lan && (
                  <span>
                    PC address <span className="font-mono text-fg-2">{lan.address}:{status.port}</span>
                  </span>
                )}
                {status.anywhere.state === 'ready' && status.anywhere.url && (
                  <span className="min-w-0 truncate">
                    Away from home <span className="font-mono text-fg-2">{status.anywhere.url.replace(/^https:\/\//, '')}</span>
                  </span>
                )}
                <span className="flex items-center gap-1.5">
                  {expired ? (
                    <>
                      Expired ·{' '}
                      <button className="font-medium text-accent hover:underline" onClick={onRestart}>
                        new code
                      </button>
                    </>
                  ) : (
                    <>
                      <StatusDot state="busy" /> Waiting for your phone · <Countdown until={info.expiresAt} />
                    </>
                  )}
                </span>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

function DeviceRow({ d, onRevoke }: { d: RemoteDevice; onRevoke?: () => void }): React.JSX.Element {
  return (
    <motion.div layout initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: -12 }} transition={{ duration: 0.3, ease }} className="group flex items-center gap-3 rounded-xl border border-line bg-white/[0.025] px-3.5 py-3">
      <div className={cn('grid size-9 place-items-center rounded-xl border border-line', d.online ? 'bg-grad text-white' : 'bg-white/[0.04] text-fg-2')}>
        <Smartphone className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-[13px] font-medium">
          <span className="truncate">{d.name}</span>
          {d.online && <Badge tone="success">Connected</Badge>}
        </div>
        <div className="truncate text-[11.5px] text-fg-3">
          {d.platform === 'web' ? 'Browser' : 'Android'}
          {d.appVersion && ` · v${d.appVersion}`}
          {d.lastAddress && ` · ${d.lastAddress}`}
          {!d.online && d.lastSeenAt && ` · seen ${timeAgo(d.lastSeenAt)}`}
        </div>
      </div>
      {onRevoke && (
        <Button size="sm" variant="ghost" className="max-md:h-9" icon={<Trash2 className="size-3.5" />} onClick={onRevoke}>
          Unpair
        </Button>
      )}
    </motion.div>
  )
}

/** Phones need Stitch running: keep it in the tray when the window closes. */
function BackgroundRow(): React.JSX.Element {
  const settings = useAppSettings()
  const update = useSettings((s) => s.update)
  return (
    <SwitchRow
      label="Keep running when the window is closed"
      help="Stitch stays in the system tray so your phone can still reach it. Quit from the tray icon."
      checked={settings.remote?.background !== false}
      onChange={(background) => void update({ remote: { background } })}
    />
  )
}

export function PhoneSettings(): React.JSX.Element {
  const [status, setStatus] = useRemote()
  const [pairing, setPairing] = useState<PairingInfo | null>(null)
  const [paired, setPaired] = useState<RemoteDevice | null>(null)
  const [busy, setBusy] = useState(false)
  const [port, setPort] = useState('')

  useEffect(() => on('remote:paired', (d) => setPaired(d)), [])
  useEffect(() => {
    if (status) setPort(String(status.port))
  }, [status?.port])

  const startPairing = async (): Promise<void> => {
    setBusy(true)
    setPaired(null)
    try {
      setPairing(await invoke('remote:pairStart'))
    } catch (err) {
      toast.error('Could not start pairing', errorText(err))
    } finally {
      setBusy(false)
    }
  }
  const closePairing = (): void => {
    if (!paired) void invoke('remote:pairCancel')
    setPairing(null)
    setPaired(null)
  }

  const setEnabled = async (enabled: boolean): Promise<void> => {
    try {
      setStatus(await invoke('remote:setEnabled', enabled))
      if (!enabled) setPairing(null)
    } catch (err) {
      toast.error('Phone remote', errorText(err))
    }
  }

  const hosts = useMemo(() => status?.hosts ?? [], [status])
  if (!status) return <div />

  // On the phone itself: what it's connected to, and the settings a phone may change.
  // (Turning the server off, the port and unpairing other phones stay on the PC.)
  if (isPhone) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3.5 rounded-2xl border border-line bg-white/[0.02] p-4">
          <div className="grid size-11 shrink-0 place-items-center rounded-2xl bg-grad text-white shadow-[0_10px_30px_-10px_var(--accent)]">
            <Smartphone className="size-5" />
          </div>
          <div className="min-w-0">
            <div className="truncate text-[15px] font-semibold">Connected to {status.pcName}</div>
            <div className="mt-0.5 flex items-center gap-1.5 text-[12px] text-fg-3">
              <StatusDot state="online" /> Everything runs on your PC and stays in its library.
            </div>
          </div>
        </div>
        <RemoteAccess status={status} onStatus={setStatus} />
        <BackgroundRow />
        <div className="space-y-3">
          <SectionTitle icon={<Radio />}>Paired phones</SectionTitle>
          <div className="space-y-2">
            {status.devices.map((d) => (
              <DeviceRow key={d.id} d={d} />
            ))}
          </div>
          <div className="flex items-center gap-3 rounded-xl border border-line bg-white/[0.02] p-3.5 text-[12px] leading-relaxed text-fg-2">
            <QrCode className="size-4 shrink-0 text-accent" />
            Pair or unpair phones from Settings → Phone on the PC.
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="relative overflow-hidden rounded-2xl border border-line bg-white/[0.02] p-5">
        <div className="pointer-events-none absolute -bottom-20 -left-10 size-64 rounded-full bg-[radial-gradient(circle,var(--accent-2),transparent_65%)] opacity-20 blur-2xl" />
        <div className="relative flex items-start gap-4 max-md:gap-3.5">
          <div className="grid size-11 shrink-0 place-items-center rounded-2xl bg-grad text-white shadow-[0_10px_30px_-10px_var(--accent)]">
            <Smartphone className="size-5" />
          </div>
          <div className="min-w-0">
            <div className="text-[15px] font-semibold">Stitch on your phone</div>
            <p className="mt-1 text-[12.5px] leading-relaxed text-fg-2">
              Keep going from the couch. The phone app is a remote for this PC — every chat, story, character and generation stays here and runs on your GPUs. It can also make text, images and voice on the phone itself when you want.
            </p>
          </div>
        </div>
      </div>

      <SwitchRow label="Allow phones to connect" help="Opens a private server on this PC. Only paired phones can use it." checked={status.enabled} onChange={(v) => void setEnabled(v)} />

      <AnimatePresence initial={false}>
        {status.enabled && (
          <motion.div key="on" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.35, ease }} className="space-y-6 overflow-hidden">
            <div className="flex flex-wrap items-center gap-2 text-[12px] text-fg-2">
              <StatusDot state={status.running ? 'online' : 'warn'} />
              {status.running ? (
                <span>
                  Listening as <b className="font-semibold text-fg">{status.pcName}</b> on port {status.port}
                </span>
              ) : (
                <span className="text-warning">{status.error ?? 'Not running'}</span>
              )}
              {hosts.map((h) => (
                <Badge key={h.address} tone={h.label === 'Tailscale' ? 'accent' : 'default'}>
                  {h.label === 'Tailscale' ? <Globe className="size-3" /> : <Wifi className="size-3" />}
                  {h.address}
                </Badge>
              ))}
            </div>

            <AnimatePresence mode="wait" initial={false}>
              {pairing ? (
                <PairPanel key="pair" info={pairing} status={status} paired={paired} onClose={closePairing} onRestart={() => void startPairing()} />
              ) : (
                <motion.div key="btn" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                  {isPhone ? (
                    // Pairing needs the code on the PC's screen, so it starts there.
                    <div className="flex items-center gap-3 rounded-xl border border-line bg-white/[0.02] p-3.5 text-[12.5px] text-fg-2">
                      <QrCode className="size-4 shrink-0 text-accent" />
                      To add another phone, open Settings → Phone on the PC and press “Pair a phone”.
                    </div>
                  ) : (
                    <Button variant="primary" size="lg" className="max-md:w-full" icon={<QrCode className="size-4" />} loading={busy} onClick={() => void startPairing()}>
                      Pair a phone
                    </Button>
                  )}
                </motion.div>
              )}
            </AnimatePresence>

            <div className="space-y-3">
              <SectionTitle icon={<Radio />}>Paired phones</SectionTitle>
              {status.devices.length === 0 ? (
                <div className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-[12.5px] text-fg-3">No phones yet — press “Pair a phone” and scan the code.</div>
              ) : (
                <div className="space-y-2">
                  <AnimatePresence initial={false}>
                    {status.devices.map((d) => (
                      <DeviceRow key={d.id} d={d} onRevoke={() => void invoke('remote:revoke', d.id)} />
                    ))}
                  </AnimatePresence>
                </div>
              )}
            </div>

            <RemoteAccess status={status} onStatus={setStatus} />

            <BackgroundRow />

            <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
              <Field label="Port" help="Change only if something else uses it. Phones find the new port when you pair again.">
                <div className="flex gap-2">
                  <Input value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, '').slice(0, 5))} className="w-32 font-mono max-md:w-auto max-md:min-w-0 max-md:flex-1" />
                  <Button disabled={Number(port) === status.port || Number(port) < 1024} onClick={() => void invoke('remote:setEnabled', true, Number(port)).then(setStatus).catch((e) => toast.error('Port', errorText(e)))}>
                    Apply
                  </Button>
                </div>
              </Field>
            </div>

            <div className="flex items-start gap-3 rounded-xl border border-line bg-white/[0.02] p-3.5 text-[12px] leading-relaxed text-fg-2">
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" />
              <div>
                At home the phone talks to this PC directly over Wi-Fi; away from home it uses the address from Access from anywhere. If Windows asks, allow Stitch on <b className="text-fg">private networks</b>. Unpairing a phone cuts it off instantly.
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
