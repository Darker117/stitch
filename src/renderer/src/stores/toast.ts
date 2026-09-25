import { create } from 'zustand'
import { nanoid } from 'nanoid'

export interface Toast {
  id: string
  title: string
  body?: string
  tone: 'default' | 'success' | 'error'
  action?: { label: string; run: () => void }
}

interface ToastState {
  toasts: Toast[]
  push: (t: Omit<Toast, 'id' | 'tone'> & { tone?: Toast['tone']; ms?: number }) => void
  dismiss: (id: string) => void
}

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  push: ({ ms = 4200, tone = 'default', ...t }) => {
    const id = nanoid(6)
    set((s) => ({ toasts: [...s.toasts.slice(-4), { id, tone, ...t }] }))
    setTimeout(() => get().dismiss(id), ms)
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
}))

export const toast = {
  info: (title: string, body?: string) => useToasts.getState().push({ title, body }),
  success: (title: string, body?: string) => useToasts.getState().push({ title, body, tone: 'success' }),
  error: (title: string, body?: string) => useToasts.getState().push({ title, body, tone: 'error', ms: 7000 })
}
