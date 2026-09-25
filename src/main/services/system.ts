import { BrowserWindow, dialog, shell } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { DetectResult } from '@shared/ipc'
import { handle } from '../ipc'
import { getSettings } from '../settings'

const run = promisify(execFile)

export interface StabilityMatrixInfo {
  dataDir: string
  comfyDir?: string
  modelsDir: string
  launchArgs: string[]
}

/** Find Stability Matrix's data folder and its ComfyUI package. */
export function detectStabilityMatrix(): StabilityMatrixInfo | undefined {
  const candidates: string[] = []
  const appData = process.env.APPDATA
  if (appData) {
    const lib = join(appData, 'StabilityMatrix', 'library.json')
    if (existsSync(lib)) {
      try {
        const p = JSON.parse(readFileSync(lib, 'utf8')).LibraryPath as string | undefined
        if (p) candidates.push(p)
      } catch {
        /* ignore */
      }
    }
    candidates.push(join(appData, 'StabilityMatrix'))
  }
  for (const dir of candidates) {
    const settingsPath = join(dir, 'settings.json')
    if (!existsSync(settingsPath)) continue
    const info: StabilityMatrixInfo = { dataDir: dir, modelsDir: join(dir, 'Models'), launchArgs: [] }
    try {
      const s = JSON.parse(readFileSync(settingsPath, 'utf8'))
      const pkg = (s.InstalledPackages ?? []).find((p: { PackageName?: string }) => p.PackageName === 'ComfyUI')
      if (pkg?.LibraryPath) {
        const comfyDir = join(dir, pkg.LibraryPath)
        if (existsSync(join(comfyDir, 'main.py'))) info.comfyDir = comfyDir
        for (const arg of pkg.LaunchArgs ?? []) {
          const name = String(arg.Name ?? '').trim()
          if (!name || name === '--port' || name === '--listen') continue
          if (arg.Type === 'Bool' && arg.OptionValue === true) info.launchArgs.push(...name.split(/\s+/))
          if (arg.Type === 'String' && arg.OptionValue) info.launchArgs.push(name, String(arg.OptionValue))
        }
      }
      if (s.ModelDirectoryOverride) info.modelsDir = s.ModelDirectoryOverride
    } catch {
      /* ignore */
    }
    return info
  }
  return undefined
}

export function detectWallpaperEngine(): { workshopDir: string; count: number } | undefined {
  const steamRoots = new Set<string>()
  for (const base of ['C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam']) {
    if (!existsSync(base)) continue
    steamRoots.add(base)
    const vdf = join(base, 'steamapps', 'libraryfolders.vdf')
    if (existsSync(vdf)) {
      for (const m of readFileSync(vdf, 'utf8').matchAll(/"path"\s+"([^"]+)"/g)) steamRoots.add(m[1].replace(/\\\\/g, '\\'))
    }
  }
  for (const root of steamRoots) {
    const dir = join(root, 'steamapps', 'workshop', 'content', '431960')
    if (existsSync(dir)) {
      let count = 0
      try {
        count = readdirSync(dir).length
      } catch {
        /* ignore */
      }
      return { workshopDir: dir, count }
    }
  }
  return undefined
}

export async function detectFfmpeg(): Promise<string | undefined> {
  const configured = getSettings().ffmpegPath
  if (configured && existsSync(configured)) return configured
  try {
    const { stdout } = await run(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg'])
    const first = stdout.split(/\r?\n/).find((l) => l.trim())
    if (first) return first.trim()
  } catch {
    /* not on PATH */
  }
  const sm = detectStabilityMatrix()
  if (sm) {
    const guess = join(sm.dataDir, 'Assets', 'ffmpeg', 'ffmpeg.exe')
    if (existsSync(guess)) return guess
  }
  return undefined
}

export async function detectGpus(): Promise<DetectResult['gpus']> {
  try {
    const { stdout } = await run('nvidia-smi', ['--query-gpu=index,name,memory.total', '--format=csv,noheader,nounits'])
    return stdout
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .map((l) => {
        const [index, name, mem] = l.split(',').map((s) => s.trim())
        return { index: Number(index), name, memoryMB: Number(mem) }
      })
  } catch {
    return []
  }
}

export function registerSystem(): void {
  handle('sys:pickFiles', async (opts) => {
    const win = BrowserWindow.getFocusedWindow()
    const props: ('openFile' | 'multiSelections')[] = ['openFile']
    if (opts.multi) props.push('multiSelections')
    const res = await dialog.showOpenDialog(win!, { title: opts.title, filters: opts.filters, properties: props })
    return res.canceled ? [] : res.filePaths
  })
  handle('sys:pickFolder', async (opts) => {
    const win = BrowserWindow.getFocusedWindow()
    const res = await dialog.showOpenDialog(win!, {
      title: opts?.title,
      defaultPath: opts?.defaultPath,
      properties: ['openDirectory', 'createDirectory']
    })
    return res.canceled ? null : res.filePaths[0]
  })
  handle('sys:saveDialog', async (opts) => {
    const win = BrowserWindow.getFocusedWindow()
    const res = await dialog.showSaveDialog(win!, { defaultPath: opts.defaultPath, filters: opts.filters })
    return res.canceled ? null : (res.filePath ?? null)
  })
  handle('sys:openPath', async (p) => {
    await shell.openPath(p)
  })
  handle('sys:showInFolder', (p) => shell.showItemInFolder(p))
  handle('sys:openExternal', async (url) => {
    if (/^https?:\/\//.test(url)) await shell.openExternal(url)
  })
  handle('sys:readText', (p) => readFileSync(p, 'utf8'))
  handle('sys:writeText', (p, content) => writeFileSync(p, content, 'utf8'))
  handle('sys:detect', async () => {
    const sm = detectStabilityMatrix()
    return {
      stabilityMatrix: sm ? { dataDir: sm.dataDir, comfyDir: sm.comfyDir, modelsDir: sm.modelsDir } : undefined,
      wallpaperEngine: detectWallpaperEngine(),
      ffmpeg: await detectFfmpeg(),
      gpus: await detectGpus()
    }
  })
}
