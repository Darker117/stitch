import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { useNavigate, useParams } from 'react-router'
import { AnimatePresence, motion } from 'motion/react'
import { FastForward } from 'lucide-react'
import type { Adventure, Scenario } from '@shared/types'
import { onColor } from '@shared/theme'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/misc'
import { AssetLightbox } from '@/components/media'
import { errorText, fileUrl } from '@/lib/api'
import { accentsForBackground } from '@/lib/theme'
import { ease } from '@/lib/motion'
import type { LlmChoice } from '@/lib/llm'
import { db, useCollection, useCollectionLoaded, useDoc } from '@/stores/db'
import { toast } from '@/stores/toast'
import { StoryStyles } from './components/StoryStyles'
import { LogoMark } from '@/components/shell/logo'
import { finalizeAdventure, needsSetup } from './engine/adventure'
import { storyModel } from './engine/llm'
import { buildTimeline } from './engine/media'
import { useAutosave } from './hooks'
import { storyFont, themeDef } from './themes'
import { ThemeCtx } from './play/bits'
import { CommandBar } from './play/CommandBar'
import { InspectDialog } from './play/InspectDialog'
import { LoadingScreen } from './play/LoadingScreen'
import { SidePanel } from './play/SidePanel'
import { StartFlow } from './play/StartFlow'
import { StoryView } from './play/StoryView'
import { TopBar } from './play/TopBar'
import { usePlay } from './play/usePlay'

/** Accent colours sampled from the cover, for the Dynamic theme. */
function useCoverAccents(assetId: string | undefined): CSSProperties {
  const asset = useDoc('assets', assetId)
  const path = asset?.kind === 'video' ? asset.thumbPath : asset?.path
  const [acc, setAcc] = useState<{ accent: string; accent2: string } | null>(null)
  useEffect(() => {
    if (!path) {
      setAcc(null)
      return
    }
    let alive = true
    void accentsForBackground({ type: 'image', path, dim: 0, blur: 0 }).then((r) => alive && setAcc(r ? { accent: r.accent, accent2: r.accent2 } : null))
    return () => {
      alive = false
    }
  }, [path])
  // Fall back to the app's live accents so previews inside other themes stay correct.
  const root = getComputedStyle(document.documentElement)
  const accent = acc?.accent ?? (root.getPropertyValue('--accent').trim() || '#f08a6c')
  const accent2 = acc?.accent2 ?? (root.getPropertyValue('--accent-2').trim() || '#8c84e6')
  return { '--accent': accent, '--accent-2': accent2, '--accent-fg': onColor(accent) } as CSSProperties
}

function useWidth(): number {
  const [w, setW] = useState(() => window.innerWidth)
  useEffect(() => {
    const on = (): void => setW(window.innerWidth)
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])
  return w
}

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'BUTTON' || t.tagName === 'SELECT' || t.isContentEditable || !!t.closest('[role="dialog"],[role="menu"]'))
}

/** Keyed by id so switching adventures never carries state across. */
export function PlayScreen(): React.JSX.Element {
  const { id } = useParams()
  return <Play key={id} id={id} />
}

function Play({ id }: { id: string | undefined }): React.JSX.Element {
  const navigate = useNavigate()
  const advLoaded = useCollectionLoaded('adventures')
  const scenariosLoaded = useCollectionLoaded('scenarios')
  useCollection('characters')
  useCollection('assets')
  useCollection('connectors')
  const { value: adv, change, flush } = useAutosave('adventures', id)
  const scenario = useDoc('scenarios', adv?.scenarioId)
  const ctl = usePlay(id, flush)

  const [minDelay, setMinDelay] = useState(true)
  const [panel, setPanel] = useState(false)
  const [input, setInput] = useState(false)
  const [lightbox, setLightbox] = useState<string | null>(null)
  const [inspect, setInspect] = useState(false)
  const [studioBusy, setStudioBusy] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const width = useWidth()
  const dynamicVars = useCoverAccents(adv?.coverAssetId)
  const cover = useDoc('assets', adv?.coverAssetId)

  useEffect(() => {
    const t = setTimeout(() => setMinDelay(false), 1400)
    return () => clearTimeout(t)
  }, [])

  // Mark as played.
  useEffect(() => {
    if (adv?.id) void db.patch('adventures', adv.id, { lastPlayedAt: Date.now() })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adv?.id])

  const phase: 'loading' | 'missing' | 'setup' | 'play' =
    !advLoaded || !scenariosLoaded || minDelay ? 'loading' : !adv ? 'missing' : adv.actions.length === 0 && scenario && needsSetup(scenario) ? 'setup' : 'play'

  // Keep the newest text in view while it streams (unless the reader scrolled up).
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el || !pinned.current) return
    el.scrollTop = el.scrollHeight
  }, [ctl.streaming?.text, adv?.actions.length, phase])

  const onScroll = (): void => {
    const el = scroller.current
    if (!el) return
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 140
  }

  // Keyboard: Enter opens the turn input, Esc closes things, Ctrl+Z / Ctrl+Y undo/redo.
  useEffect(() => {
    if (phase !== 'play') return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        if (input) setInput(false)
        else if (panel) setPanel(false)
        return
      }
      if (isTyping(e)) return
      if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !input && !ctl.busy) {
        e.preventDefault()
        setInput(true)
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault()
        void ctl.undo()
      } else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
        e.preventDefault()
        void ctl.redo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [phase, input, panel, ctl])

  const setupDone = useCallback(
    async (resolved: Scenario, values: Record<string, string>, name: string) => {
      const cur = id ? db.get('adventures', id) : undefined
      if (!cur) return
      const next = finalizeAdventure(cur, resolved, values, name)
      await db.put('adventures', next)
      if (resolved.openingType === 'characterCreator' || !next.actions.length) setTimeout(() => void ctl.generateOpening(), 450)
    },
    [id, ctl]
  )

  const sendToStudio = async (): Promise<void> => {
    if (!adv) return
    setStudioBusy(true)
    try {
      await flush()
      const tl = await buildTimeline(db.get('adventures', adv.id) ?? adv)
      navigate(`/studio/${tl.id}`)
    } catch (err) {
      toast.error('Could not build the timeline', errorText(err))
      setStudioBusy(false)
    }
  }

  const theme = themeDef(adv?.settings.theme)
  const vars = (theme.id === 'dynamic' ? { ...dynamicVars, ...theme.vars } : theme.vars) as CSSProperties
  const colW = Math.min(820, width - 48)
  const left = (width - colW) / 2
  const overlap = left + colW - (width - 400 - 24)
  const shift = panel && phase === 'play' ? -Math.min(Math.max(0, overlap), Math.max(0, left - 16)) : 0
  const model: LlmChoice | undefined = adv ? storyModel(adv) : undefined
  const large = adv?.settings.largeText

  return (
    <ThemeCtx.Provider value={theme}>
      <div className="absolute inset-0 overflow-hidden" style={{ ...vars, color: 'var(--st-text)', background: 'var(--st-bg)' }}>
        <StoryStyles />
        {/* Backdrop */}
        <AnimatePresence>
          <motion.div key={theme.id} className="absolute inset-0" style={{ background: theme.backdrop }} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.8, ease }} />
        </AnimatePresence>
        {theme.id === 'dynamic' && cover?.kind === 'image' && (
          <motion.img
            src={fileUrl(cover.path)}
            initial={{ opacity: 0 }}
            animate={{ opacity: 0.16 }}
            transition={{ duration: 1.2 }}
            className="st-drift pointer-events-none absolute inset-0 size-full scale-110 object-cover blur-[60px] saturate-150"
          />
        )}
        <div className="grain pointer-events-none absolute inset-0" />

        <AnimatePresence>{phase === 'loading' && <LoadingScreen title={adv?.title} />}</AnimatePresence>

        {phase === 'missing' && (
          <EmptyState title="Adventure not found" body="It may have been deleted." action={<Button onClick={() => navigate('/stories')}>Back to stories</Button>} className="h-full" />
        )}

        {adv && (phase === 'setup' || phase === 'play') && (
          <>
            <TopBar
              adv={adv}
              model={model}
              panelOpen={panel}
              onTogglePanel={() => setPanel((p) => !p)}
              onModel={(llm) => change((cur) => ({ settings: { ...cur.settings, llm } }))}
              onPlayer={(p) => change((cur) => ({ player: { ...cur.player, ...p } }))}
              onUndo={() => void ctl.undo()}
              onRedo={() => void ctl.redo()}
              onStudio={() => void sendToStudio()}
              busy={ctl.busy}
            />

            <div
              ref={scroller}
              onScroll={onScroll}
              className="absolute inset-0 overflow-y-auto"
              style={{ maskImage: 'linear-gradient(to bottom, transparent 0, black 84px, black calc(100% - 170px), transparent calc(100% - 48px))' }}
            >
              <motion.div animate={{ x: shift }} transition={{ type: 'spring', stiffness: 320, damping: 36 }} className="mx-auto min-h-full px-6" style={{ maxWidth: 820 + 48 }}>
                {phase === 'setup' && scenario ? (
                  <StartFlow root={scenario} defaultName={adv.player.name} onDone={(r, v, n) => void setupDone(r, v, n)} />
                ) : (
                  <motion.div
                    initial={{ opacity: 0, y: 14 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.7, ease, delay: 0.05 }}
                    className="pt-[104px] pb-[210px]"
                    style={{ fontFamily: storyFont(adv.settings.textStyle), fontSize: large ? 20 : 17, lineHeight: 1.9 }}
                  >
                    <header className="mb-8 flex flex-col items-center text-center">
                      <LogoMark size={32} />
                      <h1 className="mt-3 font-serif text-[30px] leading-tight font-semibold tracking-tight" style={{ color: 'var(--st-text)' }}>
                        {adv.title || 'Untitled adventure'}
                      </h1>
                      <div className="mt-4 h-px w-24 bg-[linear-gradient(90deg,transparent,var(--accent),transparent)] opacity-70" />
                    </header>
                    <StoryView adv={adv} ctl={ctl} animateText={adv.settings.textAnimation} onOpen={setLightbox} />
                    {!adv.actions.length && !ctl.busy && (
                      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col items-center gap-3 py-10 text-center font-sans">
                        <p className="text-[14px] text-fg-2">The page is blank. Take a turn, or let the AI set the scene.</p>
                        <Button variant="primary" icon={<FastForward className="size-4" />} onClick={() => void ctl.generateOpening()}>
                          Begin the story
                        </Button>
                      </motion.div>
                    )}
                  </motion.div>
                )}
              </motion.div>
            </div>

            {phase === 'play' && (
              <motion.div
                animate={{ x: shift }}
                transition={{ type: 'spring', stiffness: 320, damping: 36 }}
                className="pointer-events-none absolute inset-x-0 bottom-6 z-30 mx-auto px-6 font-sans"
                style={{ maxWidth: 820 + 48, fontSize: large ? 15 : undefined }}
              >
                <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease, delay: 0.25 }}>
                  <CommandBar ctl={ctl} settings={adv.settings} open={input} setOpen={setInput} />
                </motion.div>
              </motion.div>
            )}

            <SidePanel
              open={panel && phase === 'play'}
              onClose={() => setPanel(false)}
              adv={adv as Adventure}
              change={change}
              scenario={scenario}
              model={model}
              onModel={(llm) => change((cur) => ({ settings: { ...cur.settings, llm } }))}
              onInspect={() => setInspect(true)}
              onStudio={() => void sendToStudio()}
              studioBusy={studioBusy}
              dynamicVars={dynamicVars}
            />
            <InspectDialog open={inspect} onClose={() => setInspect(false)} adv={adv} />
          </>
        )}
        <AssetLightbox assetId={lightbox} onClose={() => setLightbox(null)} />
      </div>
    </ThemeCtx.Provider>
  )
}
