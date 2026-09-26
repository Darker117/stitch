// First run and "can't reach the PC": pair by QR code or 6-digit code, retry, tips.
import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ArrowLeft, Cpu, KeyRound, Laptop, QrCode, RefreshCw, ScanLine, Wifi } from 'lucide-react'
import { Capacitor } from '@capacitor/core'
import { Background } from '@/components/shell/background'
import { LogoMark, Wordmark } from '@/components/shell/logo'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { StatusDot } from '@/components/ui/misc'
import { ease, rise, spring, stagger } from '@/lib/motion'
import { cn } from '@/lib/utils'
import { link, useLink } from '@mobile/bridge/connection'
import { clearPairing, pair, parseAddress, parseQr, probe, type Pairing } from '@mobile/bridge/pairing'
import { StitchDevice } from '@mobile/device/plugin'
import { success, tap, thud } from '@mobile/shell/haptics'

async function deviceName(): Promise<string> {
  try {
    const i = await StitchDevice.info()
    return i.model.toLowerCase().startsWith(i.manufacturer.toLowerCase()) ? i.model : `${i.manufacturer} ${i.model}`
  } catch {
    return /Android/.test(navigator.userAgent) ? 'Android phone' : 'Browser'
  }
}

async function scanQr(): Promise<string | null> {
  if (!Capacitor.isNativePlatform()) throw new Error('Scanning needs the Android app — enter the code instead.')
  const { BarcodeScanner, BarcodeFormat } = await import('@capacitor-mlkit/barcode-scanning')
  const { available } = await BarcodeScanner.isGoogleBarcodeScannerModuleAvailable().catch(() => ({ available: true }))
  if (!available) {
    await BarcodeScanner.installGoogleBarcodeScannerModule()
    throw new Error('Getting the scanner ready — try again in a moment.')
  }
  const { barcodes } = await BarcodeScanner.scan({ formats: [BarcodeFormat.QrCode] })
  return barcodes[0]?.rawValue ?? null
}

/** Pair from a QR payload (scanner or deep link). */
export async function pairFromQr(text: string): Promise<Pairing> {
  const qr = parseQr(text)
  if (!qr) throw new Error("That QR code isn't from Stitch.")
  const found = await probe(qr.e, qr.id)
  if (!found) throw new Error(`Can't reach ${qr.n}. Join the same Wi-Fi as the PC, or turn on “Access from anywhere” in Stitch on the PC (Settings → Phone).`)
  return pair(found.endpoint, { secret: qr.s }, await deviceName(), qr.r ? { topic: qr.r[0], key: qr.r[1] } : undefined)
}

function CodeInput({ value, onChange }: { value: string; onChange: (v: string) => void }): React.JSX.Element {
  const ref = useRef<HTMLInputElement>(null)
  return (
    <button type="button" className="relative flex w-full justify-between gap-1.5" onClick={() => ref.current?.focus()}>
      {Array.from({ length: 6 }, (_, i) => {
        const ch = value[i]
        const active = i === value.length
        return (
          <span
            key={i}
            className={cn(
              'grid h-13 flex-1 place-items-center rounded-xl border bg-white/[0.04] font-mono text-[22px] font-semibold transition-colors duration-200',
              active ? 'border-[color-mix(in_oklab,var(--accent)_60%,transparent)] shadow-[var(--ring)]' : 'border-line-strong'
            )}
          >
            <AnimatePresence mode="popLayout">
              {ch && (
                <motion.span key={ch + i} initial={{ opacity: 0, y: 8, scale: 0.8 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={spring}>
                  {ch}
                </motion.span>
              )}
            </AnimatePresence>
          </span>
        )
      })}
      <input
        ref={ref}
        value={value}
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
        className="absolute inset-0 opacity-0"
      />
    </button>
  )
}

type Mode = 'home' | 'code'

export function ConnectScreen({ offline, onPaired, onStudio }: { offline?: boolean; onPaired: (p: Pairing) => void; onStudio?: () => void }): React.JSX.Element {
  const link$ = useLink()
  const [mode, setMode] = useState<Mode>('home')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [address, setAddress] = useState(link$.pairing?.lastEndpoint?.replace(/^https?:\/\//, '') ?? '')
  const [code, setCode] = useState('')

  const run = async (fn: () => Promise<Pairing>): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      const p = await fn()
      success()
      onPaired(p)
    } catch (err) {
      thud()
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const onScan = (): Promise<void> =>
    run(async () => {
      const text = await scanQr()
      if (!text) throw new Error('No code scanned.')
      return pairFromQr(text)
    })

  const onCode = (): Promise<void> =>
    run(async () => {
      const endpoint = parseAddress(address)
      if (!endpoint) throw new Error('Enter the PC address shown next to the code.')
      const found = await probe([endpoint])
      if (!found) throw new Error(`Nothing answered at ${endpoint.replace(/^https?:\/\//, '')}. Is Stitch open on the PC with phones allowed?`)
      return pair(found.endpoint, { code }, await deviceName())
    })

  useEffect(() => {
    if (code.length === 6 && address && !busy) void onCode()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code])

  return (
    // `isolate` keeps the fixed backdrop (z -10) above the body's own background.
    <div className="relative isolate h-full overflow-y-auto pt-[var(--sat)] pb-[var(--sab)]">
      <Background bg={{ type: 'gradient', dim: 0.35, blur: 0 }} />
      <div className="flex min-h-full flex-col px-6 pt-10 pb-8">
        <motion.div variants={stagger(0.07, 0.1)} initial="initial" animate="animate" className="flex flex-col items-center text-center">
          <motion.div variants={rise} className="relative">
            <motion.div className="absolute inset-0 rounded-full bg-grad blur-2xl" animate={{ opacity: [0.35, 0.6, 0.35], scale: [0.9, 1.08, 0.9] }} transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut' }} />
            <LogoMark size={84} className="relative" />
          </motion.div>
          <motion.div variants={rise} className="mt-5">
            <Wordmark height={30} className="text-fg" />
          </motion.div>
          <motion.h1 variants={rise} className="display mt-6 text-[26px]">
            {offline ? (
              <>
                Can't reach <span className="text-grad">{link$.pcName || 'your PC'}</span>
              </>
            ) : (
              <>
                Your studio, <span className="text-grad">in your pocket</span>
              </>
            )}
          </motion.h1>
          <motion.p variants={rise} className="mt-2 max-w-[320px] text-[13.5px] leading-relaxed text-fg-2">
            {offline
              ? 'Stitch keeps trying. Check that the PC is awake, Stitch is open, and the phone is on the same Wi-Fi (or Tailscale).'
              : 'Pair with Stitch on your PC. Stories, characters and generations run on your GPUs — this phone is the remote.'}
          </motion.p>
        </motion.div>

        <div className="mt-auto pt-10">
          <AnimatePresence mode="wait" initial={false}>
            {offline && mode === 'home' ? (
              <motion.div key="offline" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.35, ease }} className="flex flex-col gap-3">
                <div className="glass hairline flex items-center gap-3 rounded-2xl p-3.5">
                  <div className="grid size-10 place-items-center rounded-xl border border-line bg-white/[0.05] text-fg-2">
                    <Laptop className="size-4.5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13.5px] font-semibold">{link$.pcName}</div>
                    <div className="flex items-center gap-1.5 truncate text-[11.5px] text-fg-3">
                      <StatusDot state="warn" /> Trying {link$.host ?? link$.pairing?.endpoints[0]?.replace(/^https?:\/\//, '')}…
                    </div>
                  </div>
                  <motion.span animate={{ rotate: 360 }} transition={{ duration: 1.4, repeat: Infinity, ease: 'linear' }}>
                    <RefreshCw className="size-4 text-accent" />
                  </motion.span>
                </div>
                <Button size="lg" variant="primary" icon={<RefreshCw className="size-4" />} onClick={() => link.kick()}>
                  Try again now
                </Button>
                <Button
                  size="lg"
                  variant="ghost"
                  icon={<ScanLine className="size-4" />}
                  onClick={async () => {
                    tap()
                    await clearPairing()
                    link.stop()
                    location.reload()
                  }}
                >
                  Pair with a different PC
                </Button>
                {onStudio && (
                  <Button size="lg" variant="ghost" icon={<Cpu className="size-4" />} onClick={onStudio}>
                    Use on-device models meanwhile
                  </Button>
                )}
              </motion.div>
            ) : mode === 'home' ? (
              <motion.div key="home" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.35, ease }} className="flex flex-col gap-3">
                <div className="glass hairline rounded-2xl p-4 text-[12.5px] leading-relaxed text-fg-2">
                  <div className="label-caps mb-2">On your PC</div>
                  Open Stitch → <b className="text-fg">Settings</b> → <b className="text-fg">Phone</b> → <b className="text-fg">Pair a phone</b>. A QR code and a 6-digit code appear.
                </div>
                <Button size="lg" variant="primary" icon={<QrCode className="size-4" />} loading={busy} onClick={() => void onScan()}>
                  Scan QR code
                </Button>
                <Button
                  size="lg"
                  icon={<KeyRound className="size-4" />}
                  onClick={() => {
                    tap()
                    setError(undefined)
                    setMode('code')
                  }}
                >
                  Enter code instead
                </Button>
                {onStudio && (
                  <Button size="lg" variant="ghost" icon={<Cpu className="size-4" />} onClick={onStudio}>
                    Try on-device models first
                  </Button>
                )}
              </motion.div>
            ) : (
              <motion.div key="code" initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -24 }} transition={{ duration: 0.35, ease }} className="flex flex-col gap-4">
                <button onClick={() => setMode('home')} className="flex items-center gap-1.5 self-start text-[12.5px] font-medium text-fg-2">
                  <ArrowLeft className="size-3.5" /> Back
                </button>
                <div>
                  <div className="label-caps mb-1.5">PC address</div>
                  <Input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="192.168.1.20 or a public address" inputMode="url" autoCapitalize="off" autoCorrect="off" icon={<Wifi className="size-3.5" />} className="h-12 font-mono text-[15px]" />
                  <div className="mt-1.5 text-[11.5px] text-fg-3">Shown under the code on the PC — the Wi-Fi address at home, or the “away from home” address anywhere else.</div>
                </div>
                <div>
                  <div className="label-caps mb-1.5">Pairing code</div>
                  <CodeInput value={code} onChange={setCode} />
                </div>
                <Button size="lg" variant="primary" loading={busy} disabled={code.length !== 6 || !address} onClick={() => void onCode()}>
                  Pair
                </Button>
              </motion.div>
            )}
          </AnimatePresence>
          <AnimatePresence>
            {error && (
              <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.3, ease }} className="overflow-hidden">
                <div className="mt-3 rounded-xl border border-danger/25 bg-danger/10 p-3 text-[12.5px] text-danger">{error}</div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  )
}
