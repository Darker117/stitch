import { BrowserWindow, ipcMain } from 'electron'
import type { EventChannel, IpcEvents, InvokeArgs, InvokeChannel, InvokeResult } from '@shared/ipc'

type Handler<C extends InvokeChannel> = (
  ...args: InvokeArgs<C>
) => InvokeResult<C> | Promise<InvokeResult<C>>

/** Register a typed invoke handler. Errors are re-thrown with a clean message. */
export function handle<C extends InvokeChannel>(channel: C, fn: Handler<C>): void {
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

/** Broadcast an event to every renderer window. */
export function emit<E extends EventChannel>(event: E, payload: IpcEvents[E]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(event, payload)
  }
}
