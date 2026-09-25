// Civitai connection, downloads and browse state. Browse results live here so
// switching tabs (or pages) keeps the grid and scroll position warm.
import { create } from 'zustand'
import type { CivitaiModel, CivitaiQuery, DownloadState } from '@shared/types'
import { folderLabel } from '@shared/civitai'
import { errorText, invoke, on } from '@/lib/api'
import { toast } from '@/stores/toast'

export interface BrowseFilters {
  query: string
  /** CIVITAI_TYPE_FILTERS labels. */
  types: string[]
  baseModels: string[]
  sort: string
  period: string
  nsfw: boolean
}

export const DEFAULT_FILTERS: BrowseFilters = { query: '', types: [], baseModels: [], sort: 'Highest Rated', period: 'Month', nsfw: false }

interface CivitaiStore {
  status: { hasKey: boolean; username?: string } | null
  keyDialog: boolean
  setKeyDialog: (open: boolean) => void
  loadStatus: () => Promise<void>

  downloads: Record<string, DownloadState>
  initDownloads: () => void

  baseModels: string[]
  loadBaseModels: () => Promise<void>

  filters: BrowseFilters
  setFilters: (patch: Partial<BrowseFilters>) => void
  items: CivitaiModel[]
  cursor?: string
  done: boolean
  loading: boolean
  error?: string
  /** Signature of the filters the current items belong to. */
  sig: string
  fetchMore: (queryFor: (f: BrowseFilters) => CivitaiQuery, reset?: boolean) => Promise<void>
}

let downloadsInit = false
let requestSeq = 0

export const useCivitai = create<CivitaiStore>((set, get) => ({
  status: null,
  keyDialog: false,
  setKeyDialog: (open) => set({ keyDialog: open }),
  loadStatus: async () => {
    try {
      set({ status: await invoke('civitai:status') })
    } catch {
      set({ status: { hasKey: false } })
    }
  },

  downloads: {},
  initDownloads: () => {
    if (downloadsInit) return
    downloadsInit = true
    on('download:progress', (d) => {
      const prev = get().downloads[d.id]
      set((s) => ({ downloads: { ...s.downloads, [d.id]: d } }))
      if (prev?.status === 'downloading' && d.status === 'done') toast.success(`Downloaded ${d.name}`, `Saved to ${folderLabel(d.folder)}`)
      if (prev?.status === 'downloading' && d.status === 'error') toast.error('Download failed', d.error)
    })
    void invoke('civitai:downloads').then((list) => set((s) => ({ downloads: { ...Object.fromEntries(list.map((d) => [d.id, d])), ...s.downloads } })))
  },

  baseModels: [],
  loadBaseModels: async () => {
    if (get().baseModels.length) return
    try {
      set({ baseModels: await invoke('civitai:baseModels') })
    } catch {
      /* the picker falls back to an empty list */
    }
  },

  filters: DEFAULT_FILTERS,
  setFilters: (patch) => set((s) => ({ filters: { ...s.filters, ...patch } })),
  items: [],
  done: false,
  loading: false,
  sig: '',
  fetchMore: async (queryFor, reset) => {
    const f = get().filters
    const sig = JSON.stringify(f)
    if (reset || sig !== get().sig) set({ items: [], cursor: undefined, done: false, error: undefined, sig, loading: false })
    const s = get()
    if (s.done || (s.loading && !reset)) return
    const seq = ++requestSeq
    set({ loading: true, error: undefined })
    try {
      const res = await invoke('civitai:search', { ...queryFor(f), cursor: s.cursor, limit: 24 })
      if (seq !== requestSeq || get().sig !== sig) return
      set((st) => {
        const seen = new Set(st.items.map((m) => m.id))
        return { items: [...st.items, ...res.items.filter((m) => !seen.has(m.id))], cursor: res.nextCursor, done: !res.nextCursor, loading: false }
      })
    } catch (err) {
      if (seq === requestSeq) set({ error: errorText(err), loading: false })
    }
  }
}))

export function activeDownloads(d: Record<string, DownloadState>): DownloadState[] {
  return Object.values(d).filter((x) => x.status === 'downloading')
}
