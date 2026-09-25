import type { StitchBridge } from './index'

declare global {
  interface Window {
    stitch: StitchBridge
  }
}

export {}
