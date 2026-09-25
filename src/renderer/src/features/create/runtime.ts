// Live agent runs, kept outside React so they survive navigation.
import { create } from 'zustand'
import { nanoid } from 'nanoid'
import type { Chat, ChatToolCall, ID } from '@shared/types'
import { errorText } from '@/lib/api'
import { defaultLlm } from '@/lib/llm'
import { db } from '@/stores/db'
import { toast } from '@/stores/toast'
import { runAgent, titleChat } from './agent'

interface Approval {
  call: ChatToolCall
  resolve: (ok: boolean) => void
}

interface RuntimeState {
  live: Record<ID, Chat>
  running: Record<ID, boolean>
  approvals: Record<ID, Approval | undefined>
}

export const useRuntime = create<RuntimeState>(() => ({ live: {}, running: {}, approvals: {} }))

const handles = new Map<ID, { abort: () => void }>()

export function isRunning(chatId: ID): boolean {
  return !!useRuntime.getState().running[chatId]
}

function start(chatId: ID): void {
  useRuntime.setState((s) => ({ running: { ...s.running, [chatId]: true } }))
  const h = runAgent(chatId, {
    onUpdate: (chat) => useRuntime.setState((s) => ({ live: { ...s.live, [chatId]: chat } })),
    approve: (call) =>
      new Promise<boolean>((resolve) => {
        useRuntime.setState((s) => ({ approvals: { ...s.approvals, [chatId]: { call, resolve } } }))
      })
  })
  handles.set(chatId, h)
  h.done
    .catch((err) => toast.error('The assistant stopped', errorText(err)))
    .finally(() => {
      handles.delete(chatId)
      useRuntime.setState((s) => {
        const live = { ...s.live }
        delete live[chatId]
        return { running: { ...s.running, [chatId]: false }, live, approvals: { ...s.approvals, [chatId]: undefined } }
      })
    })
}

export function resolveApproval(chatId: ID, ok: boolean): void {
  const a = useRuntime.getState().approvals[chatId]
  if (!a) return
  useRuntime.setState((s) => ({ approvals: { ...s.approvals, [chatId]: undefined } }))
  a.resolve(ok)
}

export function stop(chatId: ID): void {
  handles.get(chatId)?.abort()
  resolveApproval(chatId, false)
}

/** Create a chat from the first message and start the agent. */
export async function startChat(text: string, attachments: ID[], opts: { projectId?: ID; askBeforeGenerating: boolean; llm?: Chat['llm'] }): Promise<ID> {
  const now = Date.now()
  const chat: Chat = {
    id: nanoid(10),
    title: text.replace(/\s+/g, ' ').slice(0, 48) || 'New chat',
    projectId: opts.projectId,
    createdAt: now,
    updatedAt: now,
    askBeforeGenerating: opts.askBeforeGenerating,
    llm: opts.llm ?? defaultLlm(),
    messages: [{ id: nanoid(10), role: 'user', content: text, createdAt: now, attachments }]
  }
  await db.put('chats', chat)
  start(chat.id)
  void titleChat(chat.id, text)
  return chat.id
}

export async function send(chatId: ID, text: string, attachments: ID[]): Promise<void> {
  if (isRunning(chatId)) return
  await db.update('chats', chatId, (c) => ({
    ...c,
    updatedAt: Date.now(),
    messages: [...c.messages, { id: nanoid(10), role: 'user', content: text, createdAt: Date.now(), attachments }]
  }))
  start(chatId)
}
