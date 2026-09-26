// Dev only (STITCH_REMOTE=1): pair a fixed token so the mobile web build connects straight away.
import { addDevice, deviceForToken } from './devices'

export function ensureDevDevice(token: string | undefined): void {
  if (!token || token.length < 20 || deviceForToken(token)) return
  addDevice({ name: 'Dev browser', platform: 'web' }, token)
}
