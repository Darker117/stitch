// Launch scripts/shot.cjs with the Electron binary from the Stitch desktop repo.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const desktop = resolve(process.env.STITCH_DESKTOP ?? resolve(here, '../..'))
const electron = resolve(desktop, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
if (!existsSync(electron)) {
  console.error(`Electron not found at ${electron} (run npm install in the Stitch repo)`)
  process.exit(1)
}
// A throwaway Electron profile per run (several runs can go at once), removed afterwards.
const profile = mkdtempSync(resolve(tmpdir(), 'stitch-shot-'))
const env = { ...process.env, SHOT_PROFILE: profile }
delete env.ELECTRON_RUN_AS_NODE
const r = spawnSync(electron, [resolve(here, 'shot.cjs'), ...process.argv.slice(2)], { stdio: 'inherit', env })
try {
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
} catch {
  /* still locked; the OS cleans temp */
}
process.exit(r.status ?? 1)
