// Generation jobs, recipes and ComfyUI instance status.
import { create } from 'zustand'
import type { ComfyStatus } from '@shared/ipc'
import type { GenJob, GenRequest, RecipeInfo } from '@shared/types'
import { invoke, on } from '@/lib/api'

interface GenState {
  jobs: Record<string, GenJob>
  recipes: RecipeInfo[]
  comfy: ComfyStatus[]
  /** Model files per ComfyUI folder (diffusion_models, loras, checkpoints…). */
  models: Record<string, string[]>
  loadModels: (folders?: string[]) => Promise<void>
  init: () => Promise<void>
  refreshRecipes: () => Promise<void>
  submit: (req: GenRequest) => Promise<GenJob[]>
  cancel: (id: string) => Promise<void>
  clearFinished: () => Promise<void>
}

let inited = false

export const useGen = create<GenState>((set, get) => ({
  jobs: {},
  recipes: [],
  comfy: [],
  models: {},
  loadModels: async (folders = ['diffusion_models', 'loras', 'checkpoints', 'text_encoders', 'vae']) => {
    const entries = await Promise.all(folders.map(async (f) => [f, await invoke('comfy:models', f).catch(() => [] as string[])] as const))
    set((s) => ({ models: { ...s.models, ...Object.fromEntries(entries) } }))
  },
  init: async () => {
    if (inited) return
    inited = true
    on('gen:job', (job) => set((s) => ({ jobs: { ...s.jobs, [job.id]: job } })))
    on('models:changed', () => void get().refreshRecipes())
    on('comfy:status', (comfy) => {
      const wasOnline = get().comfy.some((c) => c.online)
      set({ comfy })
      if (comfy.some((c) => c.online) !== wasOnline) {
        void get().refreshRecipes()
        void get().loadModels()
      }
    })
    const [jobs, recipes, comfy] = await Promise.all([invoke('gen:jobs'), invoke('gen:recipes'), invoke('comfy:status')])
    set({ jobs: Object.fromEntries(jobs.map((j) => [j.id, j])), recipes, comfy })
    void get().loadModels()
  },
  refreshRecipes: async () => set({ recipes: await invoke('gen:recipes') }),
  submit: async (req) => {
    const created = await invoke('gen:submit', req)
    set((s) => ({ jobs: { ...s.jobs, ...Object.fromEntries(created.map((j) => [j.id, j])) } }))
    return created
  },
  cancel: (id) => invoke('gen:cancel', id),
  clearFinished: async () => {
    await invoke('gen:clearFinished')
    set((s) => ({ jobs: Object.fromEntries(Object.entries(s.jobs).filter(([, j]) => j.status === 'queued' || j.status === 'running')) }))
  }
}))

export function isActive(j: GenJob): boolean {
  return j.status === 'queued' || j.status === 'running'
}

/** Wait for a job to finish (resolves with the final job). */
export function waitForJob(id: string): Promise<GenJob> {
  return invoke('gen:wait', id)
}
