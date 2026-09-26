// Phone-studio chats live on the phone until the PC is reachable, then become normal Stitch chats.
import { Preferences } from '@capacitor/preferences'
import type { Chat, ChatMessage } from '@shared/types'
import { invoke } from '@/lib/api'
import { toast } from '@/stores/toast'
import { link } from '@mobile/bridge/connection'
import { PHONE_LLM_ID } from '@mobile/device/llm'

export interface StudioChat {
  id: string
  title: string
  model: string
  createdAt: number
  updatedAt: number
  messages: Pick<ChatMessage, 'id' | 'role' | 'content' | 'createdAt' | 'reasoning' | 'thinkingMs'>[]
}

const KEY = 'stitch.studio.chats'

export async function loadStudioChats(): Promise<StudioChat[]> {
  try {
    const { value } = await Preferences.get({ key: KEY })
    return value ? (JSON.parse(value) as StudioChat[]) : []
  } catch {
    return []
  }
}

export async function saveStudioChats(list: StudioChat[]): Promise<void> {
  await Preferences.set({ key: KEY, value: JSON.stringify(list.slice(0, 50)) })
}

async function syncChats(): Promise<void> {
  const list = await loadStudioChats()
  if (!list.length) return
  const left: StudioChat[] = []
  for (const c of list) {
    const chat: Chat = {
      id: c.id,
      title: c.title,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      askBeforeGenerating: true,
      llm: { connectorId: PHONE_LLM_ID, model: c.model },
      messages: c.messages as ChatMessage[]
    }
    try {
      await invoke('db:put', 'chats', chat)
    } catch {
      left.push(c)
    }
  }
  await saveStudioChats(left)
  const sent = list.length - left.length
  if (sent) toast.success(`Moved ${sent} phone chat${sent === 1 ? '' : 's'} to your PC`)
}

export function installStudioSync(): void {
  link.onReady(() => void syncChats())
}
