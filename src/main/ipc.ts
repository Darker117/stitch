import { BrowserWindow, ipcMain } from 'electron'
import type { EventChannel, IpcEvents, InvokeArgs, InvokeChannel, InvokeResult } from '@shared/ipc'

type Handler<C extends InvokeChannel> = (
  ...args: InvokeArgs<C>
) => InvokeResult<C> | Promise<InvokeResult<C>>

/** Every registered handler, so remote clients (the phone app) can call the same channels. */
const handlers = new Map<string, (...args: unknown[]) => unknown>()

/** Register a typed invoke handler. Errors are re-thrown with a clean message. */
export function handle<C extends InvokeChannel>(channel: C, fn: Handler<C>): void {
  handlers.set(channel, fn as (...args: unknown[]) => unknown)
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return await fn(...(args as InvokeArgs<C>))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[ipc] ${channel} failed:`, message)
      throw new Error(message)
    }
  })
}

/** Run a registered handler directly (used by the remote server). */
export async function invokeHandler(channel: string, args: unknown[]): Promise<unknown> {
  const fn = handlers.get(channel)
  if (!fn) throw new Error(`Unknown channel: ${channel}`)
  return await fn(...args)
}

type EmitListener = (event: EventChannel, payload: unknown) => void
const emitListeners = new Set<EmitListener>()

/** Observe every broadcast event (the remote server forwards them to phones). */
export function onEmit(fn: EmitListener): () => void {
  emitListeners.add(fn)
  return () => emitListeners.delete(fn)
}

/** Broadcast an event to every renderer window and remote client. */
export function emit<E extends EventChannel>(event: E, payload: IpcEvents[E]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(event, payload)
  }
  for (const fn of emitListeners) {
    try {
      fn(event, payload)
    } catch (err) {
      console.error(`[ipc] emit listener failed for ${event}:`, err)
    }
  }
}
