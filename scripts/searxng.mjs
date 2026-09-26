// Builds the self-contained SearXNG bundle that ships inside the installer:
//   resources/searxng/
//     python/            portable CPython (python-build-standalone) + the pinned requirements
//     searx/             SearXNG at the commit in searxng/pin.json
//     stitch_searx.py    Stitch's wrapper (search / page / serve) — shared with the phone app
//     VERSION.json       what was built (the incremental check reads it)
//     LICENSE-searxng.txt, LICENSE-python.txt
// Run with `npm run searxng` (dist and dist:publish do it first). Needs network on the first run;
// downloads are cached in node_modules/.cache/stitch-searxng. The runtime never needs uv or pip.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'resources', 'searxng')
const STAGE = join(ROOT, 'resources', 'searxng.build')
const CACHE = join(ROOT, 'node_modules', '.cache', 'stitch-searxng')
const WRAPPER = join(ROOT, 'searxng', 'stitch_searx.py')
const pin = JSON.parse(readFileSync(join(ROOT, 'searxng', 'pin.json'), 'utf8'))

// Portable CPython for Windows x64 (astral-sh/python-build-standalone). Bump all three together.
const PY = {
  release: '20260924',
  version: '3.13.15',
  sha256: 'e42fa944748a50e9ff481cbb817ef8a6e3da6fbcf0cf6f29b554e1acb8c7384d'
}
PY.file = `cpython-${PY.version}+${PY.release}-x86_64-pc-windows-msvc-install_only_stripped.tar.gz`
PY.url = `https://github.com/astral-sh/python-build-standalone/releases/download/${PY.release}/${encodeURIComponent(PY.file)}`

/** Extra wheel on top of SearXNG's requirements.txt (see the pip step). */
const TZDATA = '2026.4'

/** Bump when the bundle layout or trimming changes, so existing bundles get rebuilt. */
const FORMAT = 1

const want = {
  commit: pin.commit,
  date: pin.date,
  repo: pin.repo ?? 'searxng/searxng',
  python: `${PY.version}+${PY.release}`,
  tzdata: TZDATA,
  format: FORMAT
}

const log = (msg) => console.log(`[searxng] ${msg}`)
const force = process.argv.includes('--force')

if (process.platform !== 'win32') {
  log('the bundle is Windows-only (x86_64-pc-windows-msvc); skipping on this platform')
  process.exit(0)
}

// ─── Up to date? ────────────────────────────────────────────────────────────

function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

const have = readJson(join(OUT, 'VERSION.json'))
const current =
  !force &&
  have &&
  Object.entries(want).every(([k, v]) => have[k] === v) &&
  existsSync(join(OUT, 'python', 'python.exe')) &&
  existsSync(join(OUT, 'searx', 'webapp.py'))

if (current) {
  copyWrapper(OUT)
  log(`up to date (SearXNG ${want.date} ${want.commit.slice(0, 9)}, Python ${PY.version}) — refreshed stitch_searx.py`)
  process.exit(0)
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Windows' own bsdtar: handles .tar.gz and drive-letter paths (Git's GNU tar doesn't). */
const TAR = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

async function download(url, dest, expectSha) {
  if (existsSync(dest) && (!expectSha || sha256(dest) === expectSha)) {
    log(`cached ${dest.slice(CACHE.length + 1)}`)
    return dest
  }
  log(`downloading ${url}`)
  mkdirSync(dirname(dest), { recursive: true })
  let lastErr
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'stitch-build' } })
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
      const buf = Buffer.from(await res.arrayBuffer())
      writeFileSync(dest + '.part', buf)
      if (expectSha) {
        const got = sha256(dest + '.part')
        if (got !== expectSha) throw new Error(`SHA-256 mismatch for ${url}: ${got}`)
      }
      renameSync(dest + '.part', dest)
      return dest
    } catch (err) {
      lastErr = err
      log(`  attempt ${attempt} failed: ${err.message}`)
    }
  }
  throw lastErr
}

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: 'inherit', windowsHide: true, ...opts })
}

function dirSize(p) {
  let total = 0
  let files = 0
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const f = join(d, e.name)
      if (e.isDirectory()) walk(f)
      else {
        total += statSync(f).size
        files++
      }
    }
  }
  walk(p)
  return { total, files }
}

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`

function rm(p) {
  rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
}

/** Remove every entry under `dir` (recursively) that `match(name, isDir, fullPath)` selects. */
function prune(dir, match) {
  if (!existsSync(dir)) return
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name)
    if (match(e.name, e.isDirectory(), full)) rm(full)
    else if (e.isDirectory()) prune(full, match)
  }
}

function copyWrapper(dest) {
  copyFileSync(WRAPPER, join(dest, 'stitch_searx.py'))
}

// Clean env for the bundled Python: nothing from the developer's own Python setup leaks in.
function pyEnv() {
  const env = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PIP_DISABLE_PIP_VERSION_CHECK: '1', PIP_NO_INPUT: '1' }
  for (const k of ['PYTHONHOME', 'PYTHONPATH', 'PYTHONSTARTUP', 'PYTHONUSERBASE', 'VIRTUAL_ENV', 'CONDA_PREFIX', 'PIP_REQUIRE_VIRTUALENV', 'PIP_USER', 'PIP_TARGET', 'PIP_PREFIX']) delete env[k]
  return env
}

// ─── Build ──────────────────────────────────────────────────────────────────

const t0 = Date.now()
log(`building SearXNG ${want.date} (${want.commit.slice(0, 9)}) with Python ${PY.version}`)
rm(STAGE)
mkdirSync(STAGE, { recursive: true })

// 1. Portable Python
const pyTar = await download(PY.url, join(CACHE, PY.file), PY.sha256)
run(TAR, ['-xzf', pyTar, '-C', STAGE])
const python = join(STAGE, 'python', 'python.exe')
if (!existsSync(python)) throw new Error(`python.exe missing after extracting ${PY.file}`)

// 2. SearXNG source at the pinned commit
const sxTar = await download(`https://codeload.github.com/${want.repo}/tar.gz/${want.commit}`, join(CACHE, `searxng-${want.commit}.tar.gz`))
const sxTmp = join(tmpdir(), `stitch-searxng-${process.pid}`)
rm(sxTmp)
mkdirSync(sxTmp, { recursive: true })
const top = `searxng-${want.commit}`
run(TAR, ['-xzf', sxTar, '-C', sxTmp, `${top}/searx`, `${top}/LICENSE`, `${top}/requirements.txt`])
renameSync(join(sxTmp, top, 'searx'), join(STAGE, 'searx'))
copyFileSync(join(sxTmp, top, 'LICENSE'), join(STAGE, 'LICENSE-searxng.txt'))
const requirements = join(STAGE, 'requirements.txt')
copyFileSync(join(sxTmp, top, 'requirements.txt'), requirements)
rm(sxTmp)
for (const lic of ['LICENSE.txt', 'LICENSE']) {
  const p = join(STAGE, 'python', lic)
  if (existsSync(p)) {
    renameSync(p, join(STAGE, 'LICENSE-python.txt'))
    break
  }
}

// searx/version.py shells out to git unless this file exists (and there's no git on users' PCs).
const [y, m, d] = want.date.split('-').map(Number)
const short = want.commit.slice(0, 9)
writeFileSync(
  join(STAGE, 'searx', 'version_frozen.py'),
  [
    '# SPDX-License-Identifier: AGPL-3.0-or-later',
    '# Written by Stitch (scripts/searxng.mjs) for the bundled copy.',
    `VERSION_STRING = "${y}.${m}.${d}+${short}"`,
    `VERSION_TAG = "${y}.${m}.${d}+${short}"`,
    `DOCKER_TAG = "${y}.${m}.${d}-${short}"`,
    `GIT_URL = "https://github.com/${want.repo}"`,
    'GIT_BRANCH = "master"',
    ''
  ].join('\n')
)

// 3. Requirements into the portable Python's own site-packages (wheels only)
const env = pyEnv()
try {
  execFileSync(python, ['-m', 'pip', '--version'], { env, stdio: 'ignore', windowsHide: true })
} catch {
  run(python, ['-m', 'ensurepip', '--default-pip'], { env })
}
// tzdata: Windows has no system zoneinfo database, and some engines build ZoneInfo(...) at import.
run(python, ['-m', 'pip', 'install', '--no-compile', '--only-binary=:all:', '--no-warn-script-location', '--disable-pip-version-check', '-r', requirements, `tzdata==${TZDATA}`], { env })
rm(requirements)

// 4. Trim
const before = dirSize(STAGE)
const py = join(STAGE, 'python')
const lib = join(py, 'Lib')
const site = join(lib, 'site-packages')
for (const p of ['include', 'libs', 'Scripts', 'tcl', 'share']) rm(join(py, p))
for (const p of ['test', 'idlelib', 'tkinter', 'turtledemo', 'turtle.py', 'ensurepip', 'venv', 'pydoc_data', 'lib2to3']) rm(join(lib, p))
for (const f of readdirSync(join(py, 'DLLs'))) {
  if (/^(_tkinter|tcl\d|tk\d|_test|_ctypes_test|xxlimited|xxsubtype)/i.test(f)) rm(join(py, 'DLLs', f))
}
for (const f of readdirSync(site)) {
  if (/^(pip|setuptools|_distutils_hack|distutils-precedence\.pth|wheel)([-_.]|$)/i.test(f)) rm(join(site, f))
}
// Bytecode is cached under the user's profile at runtime (-X pycache_prefix), so none ships.
prune(STAGE, (name, isDir) => isDir && name === '__pycache__')
prune(site, (name, isDir) => (isDir && (name === 'tests' || name === 'includes')) || (!isDir && /\.(pyi|pyx|pxd|pxi|h|c|cpp|lib|pdb)$/i.test(name)))
prune(lib, (name, isDir) => !isDir && /\.(pyi|pdb)$/i.test(name))
prune(join(STAGE, 'searx'), (name, isDir) => !isDir && /\.(po|pot|pyi)$/i.test(name))
// The web UI's CSS/JS/images: Stitch only uses the JSON API (stitch_searx points ui.static_path elsewhere).
rm(join(STAGE, 'searx', 'static'))
const after = dirSize(STAGE)
log(`trimmed ${mb(before.total)} → ${mb(after.total)} (${after.files} files)`)

// 5. Wrapper + version, then a smoke test that searx imports cleanly in the bundle
copyWrapper(STAGE)
writeFileSync(join(STAGE, 'VERSION.json'), JSON.stringify({ ...want, builtAt: new Date().toISOString() }, null, 2) + '\n')

if (!process.env.STITCH_SEARXNG_NO_CHECK) {
  const checkDir = join(tmpdir(), `stitch-searxng-check-${process.pid}`)
  rm(checkDir)
  try {
    run(python, ['-I', '-X', 'utf8', '-X', `pycache_prefix=${join(checkDir, 'pycache')}`, join(STAGE, 'stitch_searx.py'), 'check', '--data', checkDir], { env, timeout: 180_000 })
  } finally {
    rm(checkDir)
  }
}

// 6. Swap into place. Antivirus scanners briefly hold freshly written files, so renames can
// fail with EPERM for a moment; retry before giving up.
rm(OUT)
for (let attempt = 1; ; attempt++) {
  try {
    renameSync(STAGE, OUT)
    break
  } catch (err) {
    if (attempt >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err
    await new Promise((r) => setTimeout(r, 500))
  }
}
log(`done in ${Math.round((Date.now() - t0) / 1000)} s → ${OUT} (${mb(after.total)})`)
