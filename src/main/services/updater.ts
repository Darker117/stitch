// App updates from GitHub Releases (electron-updater). The installed app checks
// shortly after launch and every few hours, downloads in the background, then
// asks the user to restart. "Later" installs the update on the next quit.
import { app, BrowserWindow, Notification } from 'electron'
import { autoUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater'
import type { UpdateState } from '@shared/types'
import { emit, handle } from '../ipc'
import { getSettings } from '../settings'

const FIRST_CHECK_MS = 8_000
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000

/** Packaged builds update themselves; `STITCH_UPDATE_DEV=1` tests against dev-app-update.yml. */
const enabled = app.isPackaged || process.env.STITCH_UPDATE_DEV === '1'

let state: UpdateState = { status: enabled ? 'idle' : 'unsupported', current: app.getVersion() }
let checking: Promise<UpdateState> | null = null

function set(patch: Partial<UpdateState>): void {
  state = { ...state, ...patch }
  emit('update:state', state)
}

function notesOf(info: UpdateInfo): string | undefined {
  const n = info.releaseNotes
  if (!n) return undefined
  if (typeof n === 'string') return n
  return n.map((x) => `<h3>${x.version}</h3>${x.note ?? ''}`).join('')
}

function releaseOf(info: UpdateInfo): Partial<UpdateState> {
  return { version: info.version, releaseName: info.releaseName ?? undefined, releaseNotes: notesOf(info), releaseDate: info.releaseDate }
}

function friendly(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|net::ERR_/i.test(msg)) return 'Couldn’t reach GitHub. Check your connection and try again.'
  if (/latest\.yml|No published versions|404/i.test(msg)) return 'No release has been published yet.'
  if (/sha512 checksum mismatch/i.test(msg)) return 'The download was corrupted. Stitch will fetch it again on the next check.'
  return msg.split('\n')[0].slice(0, 240)
}

function progressOf(p: ProgressInfo): UpdateState['progress'] {
  return { percent: p.percent, transferred: p.transferred, total: p.total, bytesPerSecond: p.bytesPerSecond }
}

/** Nudge the user when the window isn't in front; the in-app prompt handles the rest. */
function notifyReady(version: string): void {
  const win = BrowserWindow.getAllWindows()[0]
  if (!win || win.isFocused() || !Notification.isSupported()) return
  const n = new Notification({ title: `Stitch ${version} is ready`, body: 'Restart Stitch to finish updating.', silent: true })
  n.on('click', () => {
    if (win.isMinimized()) win.restore()
    win.focus()
  })
  n.show()
}

function check(): Promise<UpdateState> {
  if (!enabled) return Promise.resolve(state)
  // Once an update is on its way (or waiting), there is nothing new to ask GitHub.
  if (state.status === 'downloading' || state.status === 'downloaded') return Promise.resolve(state)
  if (checking) return checking
  autoUpdater.autoDownload = getSettings().updates?.autoDownload !== false
  checking = (async () => {
    try {
      await autoUpdater.checkForUpdates()
    } catch (err) {
      set({ status: 'error', error: friendly(err) })
    }
    set({ checkedAt: Date.now() })
    return state
  })().finally(() => {
    checking = null
  })
  return checking
}

export function registerUpdater(): void {
  handle('update:get', () => state)
  handle('update:check', () => check())
  handle('update:download', async () => {
    if (!enabled || state.status !== 'available') return
    set({ status: 'downloading', progress: { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 } })
    try {
      await autoUpdater.downloadUpdate()
    } catch (err) {
      set({ status: 'error', error: friendly(err) })
    }
  })
  handle('update:install', () => {
    if (state.status !== 'downloaded' || !app.isPackaged) return
    // Silent install, then relaunch. before-quit shuts ComfyUI and the voice engine down first.
    setImmediate(() => autoUpdater.quitAndInstall(true, true))
  })
  handle('update:defer', () => set({ deferred: true }))

  if (!enabled) return
  if (!app.isPackaged) autoUpdater.forceDevUpdateConfig = true
  // "Later" means install on the next quit — but never from a dev run, which
  // would silently install the test build over the real app.
  autoUpdater.autoInstallOnAppQuit = app.isPackaged
  autoUpdater.disableWebInstaller = true
  autoUpdater.allowPrerelease = false
  autoUpdater.logger = {
    info: (m: unknown) => console.log('[update]', m),
    warn: (m: unknown) => console.warn('[update]', m),
    error: (m: unknown) => console.error('[update]', m),
    debug: () => {}
  }

  autoUpdater.on('checking-for-update', () => set({ status: 'checking', error: undefined }))
  autoUpdater.on('update-not-available', () => set({ status: 'not-available', checkedAt: Date.now() }))
  autoUpdater.on('update-available', (info) => {
    const downloading = autoUpdater.autoDownload
    set({ status: downloading ? 'downloading' : 'available', ...releaseOf(info), progress: downloading ? { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 } : undefined })
  })
  autoUpdater.on('download-progress', (p) => set({ status: 'downloading', progress: progressOf(p) }))
  autoUpdater.on('update-downloaded', (info) => {
    set({ status: 'downloaded', ...releaseOf(info), progress: undefined, deferred: false })
    notifyReady(info.version)
  })
  autoUpdater.on('error', (err) => set({ status: 'error', error: friendly(err), progress: undefined }))

  setTimeout(() => void check(), FIRST_CHECK_MS)
  setInterval(() => void check(), CHECK_EVERY_MS)
}
