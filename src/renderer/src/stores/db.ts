// Renderer cache of the main-process document store, kept live via db:changed.
import { useEffect, useMemo } from 'react'
import { create } from 'zustand'
import type { CollectionMap, CollectionName, ID } from '@shared/types'
import { invoke, on } from '@/lib/api'

type Records = Partial<Record<CollectionName, Record<ID, unknown>>>

interface DbState {
  data: Records
  loading: Partial<Record<CollectionName, boolean>>
}

const useDbStore = create<DbState>(() => ({ data: {}, loading: {} }))

let subscribed = false
function subscribe(): void {
  if (subscribed) return
  subscribed = true
  on('db:changed', (ch) => {
    useDbStore.setState((s) => {
      const cur = s.data[ch.collection]
      if (!cur) return s
      const next = { ...cur }
      if (ch.op === 'delete') delete next[ch.id]
      else next[ch.id] = ch.doc
      return { data: { ...s.data, [ch.collection]: next } }
    })
  })
}

export async function loadCollection(name: CollectionName, force = false): Promise<void> {
  subscribe()
  const s = useDbStore.getState()
  if (!force && (s.data[name] || s.loading[name])) return
  useDbStore.setState((st) => ({ loading: { ...st.loading, [name]: true } }))
  const docs = (await invoke('db:list', name)) as { id: ID }[]
  const rec: Record<ID, unknown> = {}
  for (const d of docs) rec[d.id] = d
  useDbStore.setState((st) => ({ data: { ...st.data, [name]: rec }, loading: { ...st.loading, [name]: false } }))
}

/** Re-read every collection already in the cache (the phone app calls this after reconnecting). */
export async function reloadLoaded(): Promise<void> {
  const names = Object.keys(useDbStore.getState().data) as CollectionName[]
  await Promise.all(names.map((n) => loadCollection(n, true).catch(() => {})))
}

const EMPTY: Record<ID, unknown> = {}

function sortKey(d: unknown): number {
  const o = d as { updatedAt?: number; createdAt?: number }
  return o.updatedAt ?? o.createdAt ?? 0
}

/** All docs in a collection, newest first. */
export function useCollection<N extends CollectionName>(name: N): CollectionMap[N][] {
  useEffect(() => {
    void loadCollection(name)
  }, [name])
  const rec = useDbStore((s) => s.data[name] ?? EMPTY)
  return useMemo(() => (Object.values(rec) as CollectionMap[N][]).sort((a, b) => sortKey(b) - sortKey(a)), [rec])
}

export function useCollectionLoaded(name: CollectionName): boolean {
  useEffect(() => {
    void loadCollection(name)
  }, [name])
  return useDbStore((s) => !!s.data[name])
}

export function useDoc<N extends CollectionName>(name: N, id: ID | undefined | null): CollectionMap[N] | undefined {
  useEffect(() => {
    void loadCollection(name)
  }, [name])
  return useDbStore((s) => (id ? (s.data[name]?.[id] as CollectionMap[N] | undefined) : undefined))
}

function setLocal(name: CollectionName, id: ID, doc: unknown | null): void {
  useDbStore.setState((s) => {
    const cur = { ...(s.data[name] ?? {}) }
    if (doc === null) delete cur[id]
    else cur[id] = doc
    return { data: { ...s.data, [name]: cur } }
  })
}

export const db = {
  get<N extends CollectionName>(name: N, id: ID): CollectionMap[N] | undefined {
    return useDbStore.getState().data[name]?.[id] as CollectionMap[N] | undefined
  },
  all<N extends CollectionName>(name: N): CollectionMap[N][] {
    return Object.values(useDbStore.getState().data[name] ?? {}) as CollectionMap[N][]
  },
  /** Optimistic write. */
  async put<N extends CollectionName>(name: N, doc: CollectionMap[N]): Promise<CollectionMap[N]> {
    setLocal(name, doc.id, doc)
    await invoke('db:put', name, doc)
    return doc
  },
  async patch<N extends CollectionName>(name: N, id: ID, patch: Partial<CollectionMap[N]>): Promise<void> {
    const cur = db.get(name, id)
    if (cur) setLocal(name, id, { ...cur, ...patch })
    await invoke('db:patch', name, id, patch as Record<string, unknown>)
  },
  /** Functional update against the latest doc. */
  async update<N extends CollectionName>(name: N, id: ID, fn: (cur: CollectionMap[N]) => CollectionMap[N]): Promise<CollectionMap[N] | undefined> {
    const cur = db.get(name, id) ?? ((await invoke('db:get', name, id)) as CollectionMap[N] | null)
    if (!cur) return undefined
    const next = fn(cur)
    setLocal(name, id, next)
    await invoke('db:put', name, next)
    return next
  },
  async remove(name: CollectionName, id: ID): Promise<void> {
    setLocal(name, id, null)
    await invoke('db:delete', name, id)
  }
}
