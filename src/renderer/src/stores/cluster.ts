// Computers (linked PCs) and the llama.cpp text engine, kept live from main-process events.
import { useEffect } from 'react'
import { create } from 'zustand'
import type { ClusterStatus, LlamaStatus } from '@shared/ipc'
import { invoke, on } from '@/lib/api'

interface ClusterState {
  status: ClusterStatus | null
  llama: LlamaStatus | null
  set: (s: ClusterStatus) => void
  refresh: () => Promise<void>
}

let subscribed = false

export const useCluster = create<ClusterState>((set) => ({
  status: null,
  llama: null,
  set: (status) => set({ status }),
  refresh: async () => {
    if (!subscribed) {
      subscribed = true
      on('cluster:changed', (status) => set({ status }))
      on('llama:status', (llama) => set({ llama }))
      void invoke('llama:status').then((llama) => set({ llama }))
    }
    set({ status: await invoke('cluster:status') })
  }
}))

/**
 * Live cluster status for a mounted page. Asking for the status also keeps this PC's hardware
 * sampling on (the main process stops sampling a minute after the last ask).
 */
export function useClusterLive(): ClusterStatus | null {
  const status = useCluster((s) => s.status)
  const refresh = useCluster((s) => s.refresh)
  useEffect(() => {
    void refresh()
    const t = setInterval(() => void refresh(), 25_000)
    return () => clearInterval(t)
  }, [refresh])
  return status
}

export function useLlama(): LlamaStatus | null {
  return useCluster((s) => s.llama)
}
