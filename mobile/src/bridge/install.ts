// Installs `window.stitch` — the same bridge the desktop preload provides — backed by the PC link.
// Must run before any desktop renderer module is evaluated.
import { link } from './connection'
import { openPcFile } from './files'
import { mediaUrl } from './media'
import { route } from './router'

window.stitch = {
  invoke: (channel: string, ...args: unknown[]) => route(channel, args),
  on: (channel: string, listener: (payload: unknown) => void) => link.on(channel, listener),
  // Dropped files have no PC path; the phone uses its own picker (uploads) instead.
  pathForFile: () => '',
  platform: 'android',
  mediaUrl,
  phone: { openFile: openPcFile }
}
