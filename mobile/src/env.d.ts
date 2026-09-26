/// <reference types="vite/client" />

/** The Stitch release this build belongs to (the repo's package.json version). */
declare const __STITCH_VERSION__: string

// The bridge the desktop renderer talks to (desktop: Electron preload; here: bridge/install.ts).
interface StitchBridgeShape {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  on: (channel: string, listener: (payload: unknown) => void) => () => void
  pathForFile: (file: File) => string
  platform: string
  mediaUrl?: (url: string, opts?: { thumb?: number }) => string
  phone?: { openFile: (path: string) => Promise<void> }
}

interface Window {
  stitch: StitchBridgeShape
}

interface ImportMetaEnv {
  readonly VITE_STITCH_PC?: string
  readonly VITE_STITCH_TOKEN?: string
}
