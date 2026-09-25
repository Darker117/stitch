import { contextBridge, ipcRenderer, webUtils } from 'electron'

const api = {
  invoke: (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args),
  on: (channel: string, listener: (payload: unknown) => void) => {
    const wrapped = (_e: Electron.IpcRendererEvent, payload: unknown) => listener(payload)
    ipcRenderer.on(channel, wrapped)
    return () => {
      ipcRenderer.removeListener(channel, wrapped)
    }
  },
  /** Absolute path of a dropped/selected File (Electron removed File.path). */
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  platform: process.platform
}

contextBridge.exposeInMainWorld('stitch', api)

export type StitchBridge = typeof api
