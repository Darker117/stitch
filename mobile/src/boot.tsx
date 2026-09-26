// Boot: restore the pairing, connect to the PC, then mount the desktop app with phone chrome.
import { StrictMode, useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { createHashRouter } from 'react-router'
import { AnimatePresence, motion } from 'motion/react'
import { App as CapApp } from '@capacitor/app'
import { Capacitor } from '@capacitor/core'
import { Network } from '@capacitor/network'
import { App, immersiveRoutes, shellRoutes } from '@/App'
import { LogoMark } from '@/components/shell/logo'
import { Toaster } from '@/components/shell/toaster'
import { TooltipProvider } from '@/components/ui/overlay'
import { invoke } from '@/lib/api'
import { ease } from '@/lib/motion'
import { reloadLoaded } from '@/stores/db'
import { useGen } from '@/stores/gen'
import { useSettings } from '@/stores/settings'
import { toast } from '@/stores/toast'
import { link, useLink } from './bridge/connection'
import { loadPairing, type Pairing } from './bridge/pairing'
import { installSystem } from './bridge/system'
import { installDevice } from './device'
import { DevicePage } from './device/DevicePage'
import { ConnectScreen, pairFromQr } from './pair/ConnectScreen'
import { installBackButton } from './shell/back'
import { installInsets } from './shell/insets'
import { MobileImmersive, MobileShell } from './shell/MobileShell'
import { PhoneStudio } from './studio/PhoneStudio'
import { installStudioSync } from './studio/sync'

/** After a reconnect, catch up on whatever changed on the PC meanwhile. */
async function resync(): Promise<void> {
  const [settings, jobs, recipes, comfy] = await Promise.all([invoke('settings:get'), invoke('gen:jobs'), invoke('gen:recipes'), invoke('comfy:status')])
  useSettings.setState({ settings })
  useGen.setState({ jobs: Object.fromEntries(jobs.map((j) => [j.id, j])), recipes, comfy })
  await reloadLoaded()
}

function Splash(): React.JSX.Element {
  return (
    <motion.div key="splash" className="grid h-full place-items-center" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, scale: 1.04, filter: 'blur(6px)' }} transition={{ duration: 0.45, ease }}>
      <div className="relative">
        <motion.div className="absolute inset-0 rounded-full bg-grad blur-2xl" animate={{ opacity: [0.3, 0.65, 0.3], scale: [0.85, 1.1, 0.85] }} transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut' }} />
        <motion.div animate={{ scale: [1, 1.04, 1] }} transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut' }}>
          <LogoMark size={72} className="relative" />
        </motion.div>
      </div>
    </motion.div>
  )
}

function Root({ initial }: { initial: Pairing | null }): React.JSX.Element {
  const state = useLink((s) => s.state)
  const failures = useLink((s) => s.failures)
  const [paired, setPaired] = useState(!!initial)
  const [everReady, setEverReady] = useState(false)
  const [slow, setSlow] = useState(false)
  const [studio, setStudio] = useState(false)

  const repair = (): void => {
    link.stop()
    setPaired(false)
    setEverReady(false)
  }

  const router = useMemo(
    () =>
      createHashRouter([
        { element: <MobileShell onPair={repair} />, children: [...shellRoutes, { path: '/phone', element: <DevicePage /> }] },
        { element: <MobileImmersive onPair={repair} />, children: immersiveRoutes }
      ]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  useEffect(() => {
    if (state === 'ready') setEverReady(true)
  }, [state])

  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 5000)
    return () => clearTimeout(t)
  }, [paired])

  // Catch up after every reconnect (not the first connect).
  useEffect(() => {
    let first = true
    return link.onReady(() => {
      if (first) {
        first = false
        return
      }
      void resync().catch(() => {})
    })
  }, [])

  // stitch://pair?d=… links (camera app scanning the PC's QR code).
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return
    const h = CapApp.addListener('appUrlOpen', ({ url }) => {
      if (!url.startsWith('stitch://pair')) return
      void pairFromQr(url)
        .then((p) => {
          link.stop()
          link.start(p)
          setPaired(true)
          toast.success(`Paired with ${p.pcName}`)
        })
        .catch((err) => toast.error("Couldn't pair", err instanceof Error ? err.message : String(err)))
    })
    return () => void h.then((x) => x.remove())
  }, [])

  const onPaired = (p: Pairing): void => {
    link.start(p)
    setPaired(true)
  }

  let view: 'connect' | 'splash' | 'offline' | 'app' | 'studio'
  if (studio) view = 'studio'
  else if (!paired || (state === 'unpaired' && !everReady)) view = 'connect'
  else if (everReady) view = 'app'
  else if (slow || failures >= 3) view = 'offline'
  else view = 'splash'

  return (
    <AnimatePresence mode="wait">
      {view === 'app' ? (
        <motion.div key="app" className="h-full" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.5, ease }}>
          <App router={router} />
        </motion.div>
      ) : view === 'splash' ? (
        <Splash />
      ) : view === 'studio' ? (
        <motion.div key="studio" className="h-full" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.4, ease }}>
          <TooltipProvider>
            <PhoneStudio onExit={() => setStudio(false)} onOpenApp={() => setStudio(false)} />
            <Toaster />
          </TooltipProvider>
        </motion.div>
      ) : (
        <motion.div key={view} className="h-full" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.4, ease }}>
          <TooltipProvider>
            <ConnectScreen offline={view === 'offline'} onPaired={onPaired} onStudio={() => setStudio(true)} />
            <Toaster />
          </TooltipProvider>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

export async function boot(): Promise<void> {
  installSystem()
  installDevice()
  installStudioSync()
  installBackButton()
  await installInsets()

  if (Capacitor.isNativePlatform()) {
    void CapApp.addListener('appStateChange', ({ isActive }) => {
      if (isActive) link.kick()
    })
    void Network.addListener('networkStatusChange', (s) => {
      if (s.connected) link.kick()
    })
  }

  const pairing = await loadPairing()
  if (pairing) link.start(pairing)

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Root initial={pairing} />
    </StrictMode>
  )
}

// Dev helpers for the web build (never shipped in the APK's behaviour).
if (import.meta.env.DEV) {
  ;(window as unknown as { __stitchSeed: () => Promise<string> }).__stitchSeed = () => import('./dev/seed').then((m) => m.seed())
  // Lets screenshot runs render the on-device pages with a simulated phone.
  ;(window as unknown as { __device: unknown }).__device = () => import('./device/store').then((m) => m.useDevice)
}
