import { create } from 'zustand'
import type { UpdateState } from '@shared/types'
import { invoke, on } from '@/lib/api'

interface UpdateStore {
  state: UpdateState | null
  init: () => Promise<void>
  check: () => Promise<UpdateState>
  download: () => Promise<void>
  install: () => Promise<void>
  defer: () => Promise<void>
}

let started = false

export const useUpdate = create<UpdateStore>((set) => ({
  state: null,
  init: async () => {
    if (started) return
    started = true
    on('update:state', (state) => set({ state }))
    set({ state: await invoke('update:get') })
  },
  check: async () => {
    const state = await invoke('update:check')
    set({ state })
    return state
  },
  download: () => invoke('update:download'),
  install: () => invoke('update:install'),
  defer: () => invoke('update:defer')
}))

export function formatBytes(n: number): string {
  if (!n) return '0 MB'
  const mb = n / (1024 * 1024)
  return mb >= 100 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`
}
