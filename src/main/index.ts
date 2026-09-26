import { app, BrowserWindow, Menu, nativeTheme, session, shell, Tray } from 'electron'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { handle } from './ipc'
import { registerProtocolHandler, registerSchemePrivileges } from './protocol'
import { getSettings, updateSettings } from './settings'
import { db, flushAll } from './store'
import { registerAssets } from './services/assets'
import { autoLaunchComfy, registerComfy, shutdownComfy } from './services/comfy'
import { registerConnectors, seedConnectors } from './services/connectors'
import { registerEditor } from './services/editor'
import { registerLlm } from './services/llm'
import { registerModels } from './services/models'
import { registerSkills } from './services/skills'
import { registerScripts } from './services/scripts'
import { registerSystem } from './services/system'
import { registerUpdater } from './services/updater'
import { registerVoice, shutdownVoice } from './services/voice'
import { registerWallpaper, restoreWallpaperRoot } from './services/wallpaper'
import { registerRemote, shutdownRemote } from './remote'

registerSchemePrivileges()
app.setAppUserModelId('com.stitch.studio')
nativeTheme.themeSource = 'dark'

// Dev: isolated profile for screenshot/test runs so they never touch real data.
if (!app.isPackaged && process.env.STITCH_USERDATA) app.setPath('userData', process.env.STITCH_USERDATA)

if (!process.env.STITCH_CAPTURE && !app.requestSingleInstanceLock()) {
  app.quit()
}

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false

/** Phones need the PC app running: with the remote on, closing the window hides to the tray. */
function stayInTray(): boolean {
  const r = getSettings().remote
  return !!r.enabled && r.background !== false
}

function showWindow(): void {
  if (!mainWindow) return createWindow()
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function ensureTray(): void {
  if (tray) return
  const icon = iconPath()
  if (!icon) return
  tray = new Tray(icon)
  tray.setToolTip('Stitch — ready for your phone')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Stitch', click: showWindow },
      { type: 'separator' },
      {
        label: 'Quit Stitch',
        click: () => {
          quitting = true
          app.quit()
        }
      }
    ])
  )
  tray.on('double-click', showWindow)
  tray.on('click', showWindow)
  tray.displayBalloon?.({ title: 'Stitch is still running', content: 'Your phone can keep using it. Quit from the tray icon.', iconType: 'info' })
}

function iconPath(): string | undefined {
  const candidates = [
    join(process.resourcesPath ?? '', 'icon.ico'),
    join(__dirname, '../../resources/icon.ico'),
    join(__dirname, '../../resources/icon.png')
  ]
  return candidates.find((p) => existsSync(p))
}

function overlayColors(): { color: string; symbolColor: string; height: number } {
  return { color: '#00000000', symbolColor: '#e9e4f5', height: 40 }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1080,
    minHeight: 680,
    show: false,
    title: 'Stitch',
    icon: iconPath(),
    backgroundColor: '#0b0a12',
    titleBarStyle: 'hidden',
    titleBarOverlay: overlayColors(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      spellcheck: true,
      backgroundThrottling: false
    }
  })

  mainWindow.on('close', (e) => {
    if (!quitting && stayInTray() && !process.env.STITCH_CAPTURE) {
      e.preventDefault()
      mainWindow?.hide()
      ensureTray()
    }
  })

  mainWindow.once('ready-to-show', () => {
    // Dev: STITCH_HIDDEN=1 runs headless (e.g. as the PC for the phone app's web build).
    if (app.isPackaged || !process.env.STITCH_HIDDEN) mainWindow?.show()
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (e, url) => {
    const current = mainWindow?.webContents.getURL() ?? ''
    if (url !== current && /^https?:\/\//.test(url) && !url.startsWith(process.env.ELECTRON_RENDERER_URL ?? '\0')) {
      e.preventDefault()
      void shell.openExternal(url)
    }
  })

  // Dev-only: walk a list of routes and save screenshots (STITCH_CAPTURE=<dir>).
  const captureDir = !app.isPackaged ? process.env.STITCH_CAPTURE : undefined
  if (captureDir) {
    mainWindow.webContents.once('did-finish-load', async () => {
      const win = mainWindow!
      const routes = (process.env.STITCH_ROUTES ?? '/').split(',')
      const delay = Number(process.env.STITCH_CAPTURE_DELAY ?? 2500)
      await new Promise((r) => setTimeout(r, 1500))
      if (process.env.STITCH_DEBUG_JS) console.log('[capture] eval:', await win.webContents.executeJavaScript(process.env.STITCH_DEBUG_JS))
      for (const [i, route] of routes.entries()) {
        // '.' keeps whatever page the debug script navigated to.
        if (route !== '.') await win.webContents.executeJavaScript(`location.hash = ${JSON.stringify('#' + route)}`)
        await new Promise((r) => setTimeout(r, delay))
        if (process.env.STITCH_DEBUG_JS && !process.env.STITCH_DEBUG_ONCE) console.log('[capture] eval after:', await win.webContents.executeJavaScript(process.env.STITCH_DEBUG_JS))
        const img = await win.webContents.capturePage()
        mkdirSync(captureDir, { recursive: true })
        writeFileSync(join(captureDir, `shot-${i}.png`), img.toPNG())
      }
      if (process.env.STITCH_CAPTURE_QUIT) app.quit()
    })
  }

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL + '#/')
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'), { hash: '/' })
  }
}

app.on('second-instance', () => showWindow())

void app.whenReady().then(() => {
  registerProtocolHandler()

  // Microphone for voice samples / dictation; everything else denied.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(permission === 'media' || permission === 'clipboard-sanitized-write' || permission === 'fullscreen')
  })

  const settings = getSettings()
  seedConnectors()
  restoreWallpaperRoot(settings.theme.background)

  handle('settings:get', () => getSettings())
  handle('settings:update', (patch) => updateSettings(patch))
  handle('db:list', (col) => db(col).list())
  handle('db:get', (col, id) => db(col).get(id))
  handle('db:put', (col, doc) => db(col).put(doc as never))
  handle('db:patch', (col, id, patch) => db(col).patch(id, patch as never))
  handle('db:delete', (col, id) => db(col).delete(id))

  registerSystem()
  registerAssets()
  registerConnectors()
  registerLlm()
  registerComfy()
  registerVoice()
  registerWallpaper()
  registerSkills()
  registerScripts()
  registerEditor()
  registerModels()
  registerUpdater()
  registerRemote()

  createWindow()
  autoLaunchComfy()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  quitting = true
  tray?.destroy()
  tray = null
  flushAll()
  shutdownComfy()
  shutdownVoice()
  void shutdownRemote()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
