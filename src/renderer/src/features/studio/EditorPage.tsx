// The Studio video editor: assets + timelines on the left, Clip Viewer (or Gen
// Space) and Timeline Viewer in the middle, inspector on the right and the
// multi-track timeline along the bottom. Panels resize by dragging the gutters.
// On a phone it becomes a CapCut-style editor: preview on top, then a tab row
// switching the lower half between the timeline, media, Gen Space and inspector.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { useNavigate, useParams } from 'react-router'
import { AnimatePresence, motion } from 'motion/react'
import { AlertCircle, Check, ChevronLeft, Clapperboard, CloudOff, Download, GalleryHorizontalEnd, Images, PanelRight, Redo2, SlidersHorizontal, Sparkles, Undo2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ease, rise, spring, stagger } from '@/lib/motion'
import { useCompact } from '@/lib/platform'
import { useCollectionLoaded, useDoc } from '@/stores/db'
import { Page } from '@/components/shell/page'
import { Button, IconButton } from '@/components/ui/button'
import { Segmented } from '@/components/ui/controls'
import { EmptyState, Spinner } from '@/components/ui/misc'
import { Tooltip } from '@/components/ui/overlay'
import { AssetsPanel, TimelinesList } from './AssetsPanel'
import { ClipViewer, MobileMonitor, TimelineViewer } from './Monitors'
import { programControls, sourceControls, timelineControls } from './controls'
import { GenSpace } from './GenSpace'
import { Inspector } from './Inspector'
import { TimelinePanel } from './TimelinePanel'
import { ExportDialog } from './ExportDialog'
import { clock } from './clock'
import { editor, flushSave, useEditor } from './store'
import { addTitle, deleteSelection, duplicateSelection, jumpToEdit, selectAll, splitAtPlayhead } from './actions'
import { isEditableTarget } from './model'

// ─── Layout persistence ──────────────────────────────────────────────────────

interface LayoutPrefs {
  left: number
  top: number
  split: number
  insp: number
}

const LAYOUT_KEY = 'stitch.studio.layout'
const DEFAULT_LAYOUT: LayoutPrefs = { left: 256, top: 0.52, split: 0.5, insp: 264 }

function loadLayout(): LayoutPrefs {
  try {
    return { ...DEFAULT_LAYOUT, ...(JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? '{}') as Partial<LayoutPrefs>) }
  } catch {
    return DEFAULT_LAYOUT
  }
}

function layoutVars(l: LayoutPrefs): CSSProperties {
  return { '--left': `${l.left}px`, '--top': `${l.top * 100}%`, '--split': `${l.split * 100}%`, '--insp': `${l.insp}px` } as CSSProperties
}

/** Invisible gutter with a hairline that lights up while hovered/dragged. */
function Splitter({ dir, onStart, onDrag, onEnd, className }: { dir: 'x' | 'y'; onStart: () => void; onDrag: (delta: number) => void; onEnd: () => void; className?: string }): React.JSX.Element {
  const [active, setActive] = useState(false)
  return (
    <div
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        const p0 = dir === 'x' ? e.clientX : e.clientY
        onStart()
        setActive(true)
        document.body.style.cursor = dir === 'x' ? 'col-resize' : 'row-resize'
        const move = (ev: PointerEvent): void => onDrag((dir === 'x' ? ev.clientX : ev.clientY) - p0)
        const up = (): void => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
          document.body.style.cursor = ''
          setActive(false)
          onEnd()
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
      }}
      className={cn('group/split relative z-10 shrink-0', dir === 'x' ? 'w-2 cursor-col-resize' : 'h-2 cursor-row-resize', className)}
    >
      <div
        className={cn(
          'absolute rounded-full transition-[opacity,transform] duration-200',
          dir === 'x' ? 'inset-y-6 left-1/2 w-[2px] -translate-x-1/2' : 'inset-x-10 top-1/2 h-[2px] -translate-y-1/2',
          active ? 'bg-accent opacity-100' : 'bg-white/30 opacity-0 group-hover/split:opacity-70'
        )}
      />
    </div>
  )
}

// ─── Page ────────────────────────────────────────────────────────────────────

export function EditorPage(): React.JSX.Element {
  const { id } = useParams()
  const navigate = useNavigate()
  const doc = useDoc('timelines', id)
  const loaded = useCollectionLoaded('timelines')
  const tl = useEditor((s) => s.tl)
  const tab = useEditor((s) => s.tab)
  const inspector = useEditor((s) => s.inspector)
  const compact = useCompact()
  const [exporting, setExporting] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const midRef = useRef<HTMLDivElement>(null)
  const topRef = useRef<HTMLDivElement>(null)
  const layout = useRef<LayoutPrefs>(loadLayout())
  const dragBase = useRef<LayoutPrefs>(layout.current)
  const [resizing, setResizing] = useState(false)

  // Load the timeline into the editor session
  useEffect(() => {
    if (!doc) return
    const cur = useEditor.getState().tl
    if (cur?.id === doc.id) return
    void flushSave()
    editor.load(doc)
  }, [doc])

  // Leaving the editor: save and release — unless another editor instance
  // (route change between timelines) has already taken over the session.
  useEffect(
    () => () => {
      if (useEditor.getState().tl?.id === id) editor.unload()
    },
    [id]
  )

  // Keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (isEditableTarget(e.target) || e.defaultPrevented) return
      if (document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]')) return
      if (!useEditor.getState().tl) return
      const mod = e.ctrlKey || e.metaKey
      const k = e.key
      const lower = k.toLowerCase()
      const src = useEditor.getState().focus === 'source' && sourceControls.active
      const fps = useEditor.getState().tl!.fps
      if (mod) {
        if (lower === 'z') {
          e.preventDefault()
          if (e.shiftKey) editor.redo()
          else editor.undo()
        } else if (lower === 'y') {
          e.preventDefault()
          editor.redo()
        } else if (lower === 'd') {
          e.preventDefault()
          duplicateSelection()
        } else if (lower === 'a') {
          e.preventDefault()
          selectAll()
        } else if (k === '=' || k === '+') {
          e.preventDefault()
          timelineControls.zoomBy(1.4)
        } else if (k === '-') {
          e.preventDefault()
          timelineControls.zoomBy(1 / 1.4)
        }
        return
      }
      let handled = true
      switch (k) {
        case ' ':
          ;(document.activeElement as HTMLElement | null)?.blur?.()
          if (src) sourceControls.toggle()
          else clock.toggle()
          break
        case 'j':
        case 'J':
          if (src) sourceControls.step(-1)
          else clock.shuttle(-1)
          break
        case 'k':
        case 'K':
          clock.pause()
          break
        case 'l':
        case 'L':
          if (src) sourceControls.toggle()
          else clock.shuttle(1)
          break
        case 'ArrowLeft':
          if (src) sourceControls.step(e.shiftKey ? -fps : -1)
          else clock.step(e.shiftKey ? -fps : -1)
          break
        case 'ArrowRight':
          if (src) sourceControls.step(e.shiftKey ? fps : 1)
          else clock.step(e.shiftKey ? fps : 1)
          break
        case 'ArrowUp':
          jumpToEdit(-1)
          break
        case 'ArrowDown':
          jumpToEdit(1)
          break
        case 'Home':
          clock.pause()
          clock.seek(0)
          break
        case 'End':
          clock.pause()
          clock.seek(clock.end)
          break
        case 's':
        case 'S':
          splitAtPlayhead()
          break
        case 'Delete':
        case 'Backspace':
          deleteSelection(e.shiftKey)
          break
        case 'i':
        case 'I':
          sourceControls.markIn()
          break
        case 'o':
        case 'O':
          sourceControls.markOut()
          break
        case ',':
          if (sourceControls.active) sourceControls.insert(false)
          break
        case '.':
          if (sourceControls.active) sourceControls.insert(true)
          break
        case 't':
        case 'T':
          addTitle()
          break
        case 'n':
        case 'N':
          useEditor.setState((s) => ({ snapping: !s.snapping }))
          break
        case 'z':
        case 'Z':
          if (e.shiftKey) timelineControls.fit()
          else handled = false
          break
        case 'f':
        case 'F':
          programControls.fullscreen()
          break
        case 'Escape':
          editor.select([])
          break
        default:
          handled = false
      }
      if (handled) e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Resizing: write CSS variables directly, persist on release
  const apply = useCallback((next: LayoutPrefs) => {
    layout.current = next
    const el = rootRef.current
    if (!el) return
    const vars = layoutVars(next) as Record<string, string>
    for (const [k, v] of Object.entries(vars)) el.style.setProperty(k, v)
  }, [])
  const begin = (): void => {
    dragBase.current = layout.current
    setResizing(true)
  }
  const persist = (): void => {
    setResizing(false)
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout.current))
    } catch {
      /* ignore */
    }
  }

  if (!doc || !tl || tl.id !== doc.id) {
    return (
      <Page scroll={false} className="grid place-items-center">
        {loaded && !doc ? (
          <EmptyState
            icon={<Clapperboard />}
            title="Timeline not found"
            body="It may have been deleted."
            action={
              <Button variant="secondary" icon={<ChevronLeft className="size-4" />} onClick={() => navigate('/studio')}>
                All timelines
              </Button>
            }
          />
        ) : (
          <Spinner className="size-5 text-fg-3" />
        )}
      </Page>
    )
  }

  if (compact) {
    return (
      <Page scroll={false} className="flex flex-col">
        <MobileEditor onExport={() => setExporting(true)} />
        <ExportDialog open={exporting} onClose={() => setExporting(false)} tl={tl} />
      </Page>
    )
  }

  return (
    <Page scroll={false} className="flex flex-col">
      <TopBar onExport={() => setExporting(true)} />
      <motion.div
        ref={rootRef}
        variants={stagger(0.05, 0.02)}
        initial="initial"
        animate="animate"
        className={cn('group/ed flex min-h-0 flex-1 px-2 pb-2', resizing && 'select-none')}
        data-resizing={resizing || undefined}
        style={layoutVars(layout.current)}
      >
        <motion.aside variants={rise} className="flex min-h-0 shrink-0 flex-col overflow-hidden rounded-[14px] border border-line bg-white/[0.02]" style={{ width: 'var(--left)' }}>
          <AssetsPanel />
          <TimelinesList />
        </motion.aside>
        <Splitter
          dir="x"
          onStart={begin}
          onDrag={(d) => {
            apply({ ...layout.current, left: Math.min(460, Math.max(210, dragBase.current.left + d)) })
          }}
          onEnd={persist}
        />

        <div ref={midRef} className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex min-h-[180px] shrink-0" style={{ height: 'var(--top)' }}>
            <div ref={topRef} className="flex min-w-0 flex-1">
            <motion.div variants={rise} className="flex min-w-0 shrink-0" style={{ width: `calc(var(--split) - 4px)` }}>
              <AnimatePresence mode="wait" initial={false}>
                {tab === 'gen' ? (
                  <motion.div key="gen" className="flex min-w-0 flex-1" initial={{ opacity: 0, x: -12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -12 }} transition={{ duration: 0.22, ease }}>
                    <section className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[14px] border border-[color-mix(in_oklab,var(--accent)_28%,var(--line))] bg-black/25">
                      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
                        <Sparkles className="size-3.5 text-accent" />
                        <span className="label-caps text-fg-2">Gen Space</span>
                        <span className="truncate text-[11.5px] text-fg-3">Generate straight into this cut</span>
                      </header>
                      <GenSpace />
                    </section>
                  </motion.div>
                ) : (
                  <motion.div key="clip" className="flex min-w-0 flex-1" initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 12 }} transition={{ duration: 0.22, ease }}>
                    <ClipViewer />
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
            <Splitter
              dir="x"
              onStart={begin}
              onDrag={(d) => {
                const row = topRef.current!.getBoundingClientRect().width
                apply({ ...layout.current, split: Math.min(0.7, Math.max(0.28, dragBase.current.split + d / Math.max(1, row))) })
              }}
              onEnd={persist}
            />
            <motion.div variants={rise} className="flex min-w-0 flex-1">
              <TimelineViewer />
            </motion.div>
            </div>
            <div
              className={cn('flex shrink-0 overflow-hidden', !resizing && 'transition-[width] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)]')}
              style={{ width: inspector ? 'calc(var(--insp) + 8px)' : 0 }}
            >
              <Splitter
                dir="x"
                onStart={begin}
                onDrag={(d) => {
                  apply({ ...layout.current, insp: Math.min(420, Math.max(236, dragBase.current.insp - d)) })
                }}
                onEnd={persist}
              />
              <motion.aside
                variants={rise}
                className="flex min-h-0 shrink-0 flex-col overflow-hidden rounded-[14px] border border-line bg-white/[0.02]"
                style={{ width: 'var(--insp)' }}
              >
                <Inspector />
              </motion.aside>
            </div>
          </div>
          <Splitter
            dir="y"
            onStart={begin}
            onDrag={(d) => {
              const h = midRef.current!.getBoundingClientRect().height
              apply({ ...layout.current, top: Math.min(0.72, Math.max(0.26, dragBase.current.top + d / Math.max(1, h))) })
            }}
            onEnd={persist}
          />
          <motion.div variants={rise} className="flex min-h-0 flex-1 overflow-hidden rounded-[14px] border border-line bg-white/[0.02]" onPointerDownCapture={() => useEditor.setState({ focus: 'program' })}>
            <TimelinePanel />
          </motion.div>
        </div>
      </motion.div>
      <ExportDialog open={exporting} onClose={() => setExporting(false)} tl={tl} />
    </Page>
  )
}

// ─── Phone layout ────────────────────────────────────────────────────────────

type PhoneTab = 'timeline' | 'media' | 'gen' | 'inspect'
const PHONE_TABS: PhoneTab[] = ['timeline', 'media', 'gen', 'inspect']

function MobileEditor({ onExport }: { onExport: () => void }): React.JSX.Element {
  const [tab, setTab] = useState<PhoneTab>('timeline')
  // Panes mount on first visit and then stay (keeps scroll, filters, a half-written prompt).
  const [visited, setVisited] = useState<PhoneTab[]>(['timeline'])
  const selCount = useEditor((s) => s.selection.length)
  const rootRef = useRef<HTMLDivElement>(null)
  const [typing, setTyping] = useState(false)
  const [short, setShort] = useState(false)
  const idx = PHONE_TABS.indexOf(tab)

  // With the keyboard up the panel gets short: fold the preview away while typing.
  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el) return
    const measure = (): void => setShort(el.clientHeight < 500)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const go = (t: PhoneTab): void => {
    setTab(t)
    setVisited((v) => (v.includes(t) ? v : [...v, t]))
  }

  const pane = (t: PhoneTab): React.ReactNode =>
    t === 'timeline' ? (
      <div className="flex min-h-0 flex-1" onPointerDownCapture={() => useEditor.setState({ focus: 'program' })}>
        <TimelinePanel />
      </div>
    ) : t === 'media' ? (
      <>
        <AssetsPanel />
        <TimelinesList defaultOpen={false} />
      </>
    ) : t === 'gen' ? (
      <GenSpace />
    ) : (
      <Inspector />
    )

  return (
    <>
      <MobileTopBar onExport={onExport} />
      <motion.div ref={rootRef} variants={stagger(0.05, 0.02)} initial="initial" animate="animate" className="flex min-h-0 flex-1 flex-col gap-2 px-2 pb-2">
        <motion.div variants={rise} className={cn('shrink-0', typing && short && 'hidden')}>
          <MobileMonitor />
        </motion.div>
        <motion.div variants={rise} className="shrink-0">
          <Segmented
            size="sm"
            className="w-full [&>button]:h-8 [&>button]:min-w-0 [&>button]:flex-1 [&>button]:justify-center [&>button]:px-1"
            value={tab}
            onChange={go}
            items={[
              { value: 'timeline', label: 'Timeline', icon: <GalleryHorizontalEnd /> },
              { value: 'media', label: 'Media', icon: <Images /> },
              { value: 'gen', label: 'Generate', icon: <Sparkles /> },
              { value: 'inspect', label: 'Edit', icon: <SlidersHorizontal />, count: selCount || undefined }
            ]}
          />
        </motion.div>
        <motion.div
          variants={rise}
          className="relative min-h-0 flex-1 overflow-hidden rounded-[14px] border border-line bg-white/[0.02]"
          onFocusCapture={(e) => isEditableTarget(e.target) && setTyping(true)}
          onBlurCapture={(e) => !isEditableTarget(e.relatedTarget) && setTyping(false)}
        >
          {PHONE_TABS.filter((t) => visited.includes(t)).map((t) => {
            const active = t === tab
            const i = PHONE_TABS.indexOf(t)
            return (
              <motion.div
                key={t}
                inert={!active}
                className={cn('absolute inset-0 flex min-h-0 flex-col', !active && 'pointer-events-none')}
                initial={t === 'timeline' ? false : { opacity: 0, x: 28 }}
                animate={active ? { opacity: 1, x: 0, visibility: 'visible' } : { opacity: 0, x: (i < idx ? -1 : 1) * 28, transitionEnd: { visibility: 'hidden' } }}
                transition={{ duration: 0.28, ease }}
              >
                {pane(t)}
              </motion.div>
            )
          })}
        </motion.div>
      </motion.div>
    </>
  )
}

function MobileTopBar({ onExport }: { onExport: () => void }): React.JSX.Element {
  const navigate = useNavigate()
  const tl = useEditor((s) => s.tl)!
  const canUndo = useEditor((s) => s.past.length > 0)
  const canRedo = useEditor((s) => s.future.length > 0)
  const [name, setName] = useState(tl.name)
  useEffect(() => setName(tl.name), [tl.name])
  const commitName = (): void => {
    const n = name.trim()
    if (n && n !== tl.name) editor.commit((t) => ({ ...t, name: n }))
    else setName(tl.name)
  }
  return (
    <div className="flex h-12 shrink-0 items-center gap-1 pr-2 pl-1.5">
      <IconButton label="All timelines" onClick={() => void flushSave().then(() => navigate('/studio'))}>
        <ChevronLeft className="size-4.5" />
      </IconButton>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={commitName}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        }}
        spellCheck={false}
        aria-label="Timeline name"
        className="h-8 min-w-0 flex-1 truncate rounded-lg border border-transparent bg-transparent px-1.5 text-[14px] font-semibold tracking-tight text-fg outline-none focus:border-[color-mix(in_oklab,var(--accent)_50%,transparent)] focus:bg-white/[0.04]"
      />
      <SaveIndicator compact />
      <IconButton label="Undo" disabled={!canUndo} onClick={() => editor.undo()}>
        <Undo2 className="size-4" />
      </IconButton>
      <IconButton label="Redo" disabled={!canRedo} onClick={() => editor.redo()}>
        <Redo2 className="size-4" />
      </IconButton>
      <Button variant="primary" size="sm" className="ml-0.5 h-8.5 px-3" icon={<Download className="size-3.5" />} onClick={onExport}>
        Export
      </Button>
    </div>
  )
}

// ─── Top bar ─────────────────────────────────────────────────────────────────

function TopBar({ onExport }: { onExport: () => void }): React.JSX.Element {
  const navigate = useNavigate()
  const tl = useEditor((s) => s.tl)!
  const tab = useEditor((s) => s.tab)
  const inspector = useEditor((s) => s.inspector)
  const [name, setName] = useState(tl.name)
  useEffect(() => setName(tl.name), [tl.name])
  const commitName = (): void => {
    const n = name.trim()
    if (n && n !== tl.name) editor.commit((t) => ({ ...t, name: n }))
    else setName(tl.name)
  }
  return (
    <div className="relative flex h-12 shrink-0 items-center gap-2 px-3">
      <Tooltip content="All timelines">
        <IconButton label="All timelines" size="sm" onClick={() => void flushSave().then(() => navigate('/studio'))}>
          <ChevronLeft className="size-4" />
        </IconButton>
      </Tooltip>
      <div className="flex min-w-0 items-center gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            if (e.key === 'Escape') {
              setName(tl.name)
              ;(e.target as HTMLInputElement).blur()
            }
          }}
          spellCheck={false}
          className="h-8 w-[min(260px,22vw)] min-w-0 truncate rounded-lg border border-transparent bg-transparent px-2 text-[14px] font-semibold tracking-tight text-fg transition-colors outline-none hover:border-line focus:border-[color-mix(in_oklab,var(--accent)_50%,transparent)] focus:bg-white/[0.04]"
        />
        <SaveIndicator />
      </div>

      <div className="absolute left-1/2 -translate-x-1/2">
        <Segmented
          value={tab}
          onChange={(v) => useEditor.setState({ tab: v })}
          items={[
            { value: 'gen', label: 'Gen Space', icon: <Sparkles /> },
            { value: 'editor', label: 'Video Editor', icon: <Clapperboard /> }
          ]}
        />
      </div>

      <div className="flex-1" />
      <Tooltip content={inspector ? 'Hide inspector' : 'Show inspector'}>
        <IconButton label="Inspector" size="sm" active={inspector} onClick={() => useEditor.setState({ inspector: !inspector })}>
          <PanelRight className="size-4" />
        </IconButton>
      </Tooltip>
      <Button variant="primary" size="sm" icon={<Download className="size-3.5" />} onClick={onExport}>
        Export
      </Button>
    </div>
  )
}

function SaveIndicator({ compact }: { compact?: boolean }): React.JSX.Element {
  const state = useEditor((s) => s.saveState)
  const label = state === 'saved' ? 'Saved' : state === 'error' ? 'Not saved' : 'Saving…'
  return (
    <div
      className={cn('flex h-6 items-center gap-1.5 rounded-full border border-line bg-white/[0.03] text-[11px] font-medium text-fg-3', compact ? 'w-6 shrink-0 justify-center' : 'px-2')}
      title={compact ? label : undefined}
      aria-label={compact ? label : undefined}
    >
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={state === 'dirty' ? 'saving' : state}
          initial={{ scale: 0.5, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.5, opacity: 0 }}
          transition={spring}
          className="grid size-3 place-items-center"
        >
          {state === 'saved' ? <Check className="size-3 text-success" /> : state === 'error' ? <CloudOff className="size-3 text-danger" /> : <Spinner className="size-3" />}
        </motion.span>
      </AnimatePresence>
      {!compact && <span>{label}</span>}
      {state === 'error' && !compact && <AlertCircle className="size-3 text-danger" />}
    </div>
  )
}
