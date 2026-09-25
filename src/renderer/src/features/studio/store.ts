// Editor session state: the working copy of the timeline, undo/redo, selection,
// zoom and the source (clip viewer) asset. Saves back to the document store.
import { create } from 'zustand'
import type { ID, Timeline } from '@shared/types'
import { db } from '@/stores/db'
import { clock } from './clock'
import { timelineDuration } from './model'

const HISTORY = 200

export type SaveState = 'saved' | 'dirty' | 'saving' | 'error'

interface EditorState {
  tl: Timeline | null
  past: Timeline[]
  future: Timeline[]
  selection: ID[]
  /** px per second */
  zoom: number
  snapping: boolean
  sourceId: ID | null
  /** In/out marks per source asset. */
  marks: Record<ID, { in?: number; out?: number }>
  saveState: SaveState
  tab: 'editor' | 'gen'
  inspector: boolean
  /** Which monitor answers Space / J K L. */
  focus: 'program' | 'source'
}

export const useEditor = create<EditorState>(() => ({
  tl: null,
  past: [],
  future: [],
  selection: [],
  zoom: 60,
  snapping: true,
  sourceId: null,
  marks: {},
  saveState: 'saved',
  tab: 'editor',
  inspector: true,
  focus: 'program'
}))

// ─── Persistence ─────────────────────────────────────────────────────────────

let saveTimer: ReturnType<typeof setTimeout> | null = null
let saving: Promise<void> = Promise.resolve()

function scheduleSave(): void {
  useEditor.setState({ saveState: 'dirty' })
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => void flushSave(), 650)
}

/** Write the working copy now (used before export and when leaving). */
export async function flushSave(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  const tl = useEditor.getState().tl
  if (!tl || useEditor.getState().saveState === 'saved') return saving
  useEditor.setState({ saveState: 'saving' })
  const snapshot = tl
  saving = saving
    .then(() => db.update('timelines', snapshot.id, () => ({ ...snapshot, updatedAt: Date.now() })))
    .then(() => {
      if (useEditor.getState().tl === snapshot) useEditor.setState({ saveState: 'saved' })
    })
    .catch(() => useEditor.setState({ saveState: 'error' }))
  return saving
}

function syncClock(tl: Timeline): void {
  clock.duration = timelineDuration(tl)
  clock.fps = tl.fps
  if (clock.time > clock.duration) clock.seek(clock.duration)
}

// ─── Actions ─────────────────────────────────────────────────────────────────

export const editor = {
  get: () => useEditor.getState(),
  tl: (): Timeline => useEditor.getState().tl!,

  load(tl: Timeline): void {
    const prev = useEditor.getState().tl
    if (prev?.id === tl.id) return
    useEditor.setState({ tl, past: [], future: [], selection: [], saveState: 'saved' })
    clock.pause()
    syncClock(tl)
    clock.seek(0)
  },

  unload(): void {
    void flushSave()
    clock.pause()
    useEditor.setState({ tl: null, past: [], future: [], selection: [] })
  },

  /** Apply an edit as one undo step. */
  commit(fn: (tl: Timeline) => Timeline, selection?: ID[]): void {
    const { tl, past } = useEditor.getState()
    if (!tl) return
    const next = fn(tl)
    if (next === tl) return
    useEditor.setState({
      tl: next,
      past: [...past, tl].slice(-HISTORY),
      future: [],
      ...(selection ? { selection } : {})
    })
    syncClock(next)
    scheduleSave()
  },

  // Gestures (drag/trim): preview freely, then land as a single undo step.
  gestureBase: null as Timeline | null,
  begin(): void {
    editor.gestureBase = useEditor.getState().tl
  },
  preview(fn: (tl: Timeline) => Timeline): void {
    const { tl } = useEditor.getState()
    if (!tl) return
    const next = fn(tl)
    useEditor.setState({ tl: next })
    syncClock(next)
  },
  end(finalize?: (tl: Timeline) => Timeline): void {
    const base = editor.gestureBase
    editor.gestureBase = null
    let { tl } = useEditor.getState()
    if (!tl || !base) return
    if (finalize) {
      tl = finalize(tl)
      useEditor.setState({ tl })
      syncClock(tl)
    }
    if (tl === base) return
    useEditor.setState((s) => ({ past: [...s.past, base].slice(-HISTORY), future: [] }))
    scheduleSave()
  },
  cancelGesture(): void {
    const base = editor.gestureBase
    editor.gestureBase = null
    if (base) {
      useEditor.setState({ tl: base })
      syncClock(base)
    }
  },

  undo(): void {
    const { tl, past, future } = useEditor.getState()
    if (!tl || !past.length) return
    const prev = past[past.length - 1]
    useEditor.setState({ tl: prev, past: past.slice(0, -1), future: [tl, ...future].slice(0, HISTORY) })
    editor.pruneSelection()
    syncClock(prev)
    scheduleSave()
  },

  redo(): void {
    const { tl, past, future } = useEditor.getState()
    if (!tl || !future.length) return
    const next = future[0]
    useEditor.setState({ tl: next, past: [...past, tl].slice(-HISTORY), future: future.slice(1) })
    editor.pruneSelection()
    syncClock(next)
    scheduleSave()
  },

  pruneSelection(): void {
    const { tl, selection } = useEditor.getState()
    if (!tl) return
    const ids = new Set(tl.clips.map((c) => c.id))
    const kept = selection.filter((id) => ids.has(id))
    if (kept.length !== selection.length) useEditor.setState({ selection: kept })
  },

  select(ids: ID[]): void {
    useEditor.setState({ selection: ids })
  },

  toggleSelect(id: ID): void {
    const { selection } = useEditor.getState()
    useEditor.setState({ selection: selection.includes(id) ? selection.filter((x) => x !== id) : [...selection, id] })
  },

  setZoom(z: number): void {
    useEditor.setState({ zoom: z })
  },

  setSource(id: ID | null): void {
    useEditor.setState({ sourceId: id, focus: id ? 'source' : 'program' })
  },

  setMark(assetId: ID, which: 'in' | 'out', t: number | undefined): void {
    const { marks } = useEditor.getState()
    const cur = { ...(marks[assetId] ?? {}) }
    cur[which] = t
    if (cur.in !== undefined && cur.out !== undefined && cur.out <= cur.in) {
      if (which === 'in') cur.out = undefined
      else cur.in = undefined
    }
    useEditor.setState({ marks: { ...marks, [assetId]: cur } })
  }
}
