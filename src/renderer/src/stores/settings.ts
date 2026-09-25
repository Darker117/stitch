import { create } from 'zustand'
import type { DeepPartial } from '@shared/ipc'
import type { AppSettings } from '@shared/types'
import { invoke, on } from '@/lib/api'

interface SettingsState {
  settings: AppSettings | null
  load: () => Promise<void>
  update: (patch: DeepPartial<AppSettings>) => Promise<AppSettings>
}

export const useSettings = create<SettingsState>((set) => ({
  settings: null,
  load: async () => {
    const s = await invoke('settings:get')
    set({ settings: s })
    on('settings:changed', (next) => set({ settings: next }))
  },
  update: async (patch) => {
    const s = await invoke('settings:update', patch)
    set({ settings: s })
    return s
  }
}))

/** Non-null settings for components rendered after boot. */
export function useAppSettings(): AppSettings {
  return useSettings((s) => s.settings!)
}
