// stitch:// URLs (used throughout the desktop renderer) → the PC's media server, or phone files.
import { Capacitor } from '@capacitor/core'
import { link, useLink } from './connection'

/** Phone-local files are written as `phone-file://<absolute path>` by on-device engines. */
export const PHONE_FILE = 'phone-file://'

export function mediaUrl(url: string, opts?: { thumb?: number }): string {
  if (url.startsWith(PHONE_FILE)) return Capacitor.convertFileSrc(url.slice(PHONE_FILE.length))
  if (!url.startsWith('stitch://')) return url
  const local = url.startsWith('stitch://local/') ? url.slice('stitch://local/'.length).replace(/^\/+/, '') : null
  // Files made on the phone that haven't reached the PC yet (Android absolute paths).
  if (local !== null && /^(data|storage|sdcard)\//.test(local)) return Capacitor.convertFileSrc('/' + decodeURI(local))
  const base = link.baseUrl()
  const key = useLink.getState().pairing?.mediaKey ?? ''
  if (!base) return ''
  if (local !== null) {
    return opts?.thumb ? `${base}/api/t/${key}/${Math.round(opts.thumb * Math.min(2, window.devicePixelRatio || 1))}/${local}` : `${base}/api/f/${key}/${local}`
  }
  const m = /^stitch:\/\/wp-([^/]+)\/(.*)$/.exec(url)
  if (m) return `${base}/api/wp/${key}/${encodeURIComponent(m[1])}/${m[2]}`
  return url
}
