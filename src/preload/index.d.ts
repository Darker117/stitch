import type { StitchBridge } from './index'

/**
 * The phone app (`mobile/`) provides the same bridge over its connection to the PC,
 * plus a few extras the desktop never sets.
 */
export interface StitchRemoteExtras {
  /** Turn a stitch:// URL into one this page can load (the PC's media server). */
  mediaUrl?: (url: string, opts?: { thumb?: number }) => string
  /** Set by the phone app. */
  phone?: {
    /** Open a file that lives on the PC with the phone's viewer/share sheet. */
    openFile: (path: string) => Promise<void>
  }
}

declare global {
  interface Window {
    stitch: StitchBridge & StitchRemoteExtras
  }
}

export {}
