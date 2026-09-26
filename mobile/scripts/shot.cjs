// Phone-sized screenshots of the web build, rendered offscreen with the desktop repo's Electron.
//
//   node scripts/shot.mjs --routes "/,/stories" --out shots        (page: env SHOT_URL, default http://127.0.0.1:5174/)
//
// Options (flags or env): --routes (comma list; "." keeps the current page),
// --out dir, --size 412x915, --scale 1, --delay ms per route, --js "<expr run before each shot>",
// --setup "<expr run once after load>", --after ms (wait after --js, e.g. for a sheet to open), --prefix name.
const { app, BrowserWindow } = require('electron')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  if (i >= 0 && process.argv[i + 1] !== undefined) return process.argv[i + 1]
  const env = process.env[`SHOT_${name.toUpperCase()}`]
  return env !== undefined ? env : fallback
}

// A URL on Electron's command line makes it exit (127), so the page comes from the environment.
const url = process.env.SHOT_URL ?? 'http://127.0.0.1:5174/'
const routes = arg('routes', '/').split(',')
const out = resolve(arg('out', 'shots'))
const [w, h] = arg('size', '412x915').split('x').map(Number)
const scale = Number(arg('scale', '1'))
const delay = Number(arg('delay', '2200'))
const js = arg('js', '')
const setup = arg('setup', '')
const prefix = arg('prefix', 'shot')
const after = Number(arg('after', '0'))

// Own profile per run, so several screenshot runs can go at once.
app.setPath('userData', process.env.SHOT_PROFILE ?? join(require('node:os').tmpdir(), `stitch-shot-${process.pid}`))
app.commandLine.appendSwitch('force-device-scale-factor', String(scale))
app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: w,
    height: h,
    show: false,
    useContentSize: true,
    // At --scale 2 a phone-height window is taller than most screens; don't let Windows clamp it.
    enableLargerThanScreen: true,
    backgroundColor: '#07060b',
    webPreferences: { offscreen: scale === 1 ? true : { deviceScaleFactor: scale }, backgroundThrottling: false, contextIsolation: true }
  })
  win.setContentSize(w, h)
  win.webContents.setFrameRate(30)
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.log(`[page:${level}] ${message}`)
  })
  // Pretend to be a touch phone so (hover: none) and touch layouts apply.
  win.webContents.setUserAgent('Mozilla/5.0 (Linux; Android 16; Pixel 8a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36')
  await win.loadURL(url)
  await new Promise((r) => setTimeout(r, 2500))
  if (setup) console.log('[setup]', JSON.stringify(await win.webContents.executeJavaScript(setup).catch((e) => String(e))))
  mkdirSync(out, { recursive: true })
  for (const [i, route] of routes.entries()) {
    if (route !== '.') await win.webContents.executeJavaScript(`location.hash = ${JSON.stringify('#' + route)}`)
    await new Promise((r) => setTimeout(r, delay))
    if (js) console.log(`[js ${route}]`, JSON.stringify(await win.webContents.executeJavaScript(js).catch((e) => String(e))))
    if (after) await new Promise((r) => setTimeout(r, after))
    const img = await win.webContents.capturePage()
    const file = join(out, `${prefix}-${i}.png`)
    writeFileSync(file, img.toPNG())
    console.log(`saved ${file} (${route})`)
  }
  app.quit()
})
