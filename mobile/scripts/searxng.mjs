// Stages SearXNG (web search for text models) for the Android app. The phone runs it in-process on CPython 3.13
// embedded by Chaquopy (android/app/build.gradle); Chaquopy's pip installs SearXNG's requirements at build time and
// this script prepares what pip can't get on its own. Everything lands in android/.searxng (gitignored):
//   python/            extra Chaquopy source dir: searx/ at the commit in ../searxng/pin.json (trimmed to what the
//                      JSON API needs) + stitch_searx.py (shared with the desktop app)
//   wheels/            msgspec — no Android wheel exists: compiled here with the NDK against Chaquopy's own Python
//                      headers/libpython — and curl_cffi (PyPI's official Android wheel, with its cffi>=2 pin relaxed
//                      to the cffi 1.17 Chaquopy builds; the compiled module's cffi ABI is the same)
//   requirements.txt   what Chaquopy's pip installs
//   build.json         what was built + the build-machine Python 3.13 Chaquopy needs (Gradle reads both)
//   host-python/       python-build-standalone 3.13, only when no Python 3.13 is installed
//   cache/             downloads
// `npm run apk` / `apk:release` run it before Gradle. Incremental: when nothing changed it only refreshes
// stitch_searx.py. `--force` rebuilds everything. Env: STITCH_BUILD_PYTHON (a Python 3.13 to use),
// ANDROID_NDK_HOME (else the newest NDK under the SDK from android/local.properties / ANDROID_HOME).
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const MOBILE = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = resolve(MOBILE, '..')
const ANDROID = join(MOBILE, 'android')
const OUT = join(ANDROID, '.searxng')
const CACHE = join(OUT, 'cache')
const WRAPPER = join(REPO, 'searxng', 'stitch_searx.py')
const pin = JSON.parse(readFileSync(join(REPO, 'searxng', 'pin.json'), 'utf8'))

// The phone's Python: Chaquopy's runtime for 3.13 (com.chaquo.python:target on Maven Central) supplies the headers
// and libpython msgspec is compiled against. Keep PYTHON in step with `chaquopy { version }` in app/build.gradle and
// bump CHAQUOPY_TARGET with the Chaquopy plugin.
const PYTHON = '3.13'
const CHAQUOPY_TARGET = '3.13.9-0'
const ABI = { android: 'arm64-v8a', triple: 'aarch64-linux-android', api: 24, tag: 'android_24_arm64_v8a' }
// Build-machine Python for Chaquopy (pip + bytecode) when none is installed (astral-sh/python-build-standalone).
const HOST_PY = { release: '20260924', version: '3.13.15' }
// SearXNG pins lxml 6; Chaquopy's repository has lxml 5.3.0 for Android, and SearXNG only uses long-stable lxml APIs.
// cffi likewise comes from Chaquopy's repository (it needs Chaquopy's libffi). tzdata: Android has no zoneinfo
// directory Python can read, and SearXNG's time-zone answers, weather and some engines use zoneinfo.
const OVERRIDES = { lxml: '5.3.0' }
const EXTRA = ['cffi==1.17.1', 'tzdata==2026.4']
/** Bump when the staged layout, trimming or requirements change, so existing builds get redone. */
const FORMAT = 2

const log = (msg) => console.log(`[searxng] ${msg}`)
const force = process.argv.includes('--force')
const win = process.platform === 'win32'

// ─── Helpers ────────────────────────────────────────────────────────────────

function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

const hash = (algo, file) => createHash(algo).update(readFileSync(file)).digest('hex')
const rm = (p) => rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`
const slash = (p) => p.replace(/\\/g, '/')

/** Rename, retrying while Windows (Defender, the indexer) still holds freshly written files; copy as a last resort. */
function move(from, to) {
  for (let i = 0; i < 20; i++) {
    try {
      renameSync(from, to)
      return
    } catch (err) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) throw err
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250)
    }
  }
  cpSync(from, to, { recursive: true })
  rm(from)
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true, ...opts })
  if (r.error) throw r.error
  if (r.status !== 0) throw new Error(`${cmd} ${args.slice(0, 3).join(' ')}… exited with ${r.status}`)
  return r
}

async function download(url, dest, check) {
  const ok = () => existsSync(dest) && (!check || hash(check.algo, dest) === check.hex)
  if (ok()) return dest
  log(`downloading ${url}`)
  mkdirSync(dirname(dest), { recursive: true })
  let lastErr
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'stitch-build' } })
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
      writeFileSync(dest + '.part', Buffer.from(await res.arrayBuffer()))
      if (check && hash(check.algo, dest + '.part') !== check.hex) throw new Error(`${check.algo} mismatch for ${url}`)
      renameSync(dest + '.part', dest)
      return dest
    } catch (err) {
      lastErr = err
      log(`  attempt ${attempt} failed: ${err.message}`)
    }
  }
  throw lastErr
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'stitch-build' } })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return res.text()
}

/** A file from PyPI, checked against PyPI's SHA-256. `pick(filename)` selects it among the release's files. */
async function pypi(name, version, pick) {
  const meta = JSON.parse(await fetchText(`https://pypi.org/pypi/${name}/${version}/json`))
  const f = meta.urls.find((u) => pick(u.filename))
  if (!f) throw new Error(`${name} ${version}: no matching file on PyPI`)
  return download(f.url, join(CACHE, f.filename), { algo: 'sha256', hex: f.digests.sha256 })
}

function dirSize(p) {
  let total = 0
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const f = join(d, e.name)
      if (e.isDirectory()) walk(f)
      else total += statSync(f).size
    }
  }
  if (existsSync(p)) walk(p)
  return total
}

/** Remove every entry under `dir` (recursively) that `match(name, isDir)` selects. */
function prune(dir, match) {
  if (!existsSync(dir)) return
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name)
    if (match(e.name, e.isDirectory())) rm(full)
    else if (e.isDirectory()) prune(full, match)
  }
}

/** Copy only when the content differs, so Gradle's incremental build isn't disturbed. */
function syncFile(src, dest) {
  if (existsSync(dest) && readFileSync(dest).equals(readFileSync(src))) return false
  mkdirSync(dirname(dest), { recursive: true })
  copyFileSync(src, dest)
  return true
}

// Archive work runs on the build Python (zipfile/tarfile), so nothing beyond Node and Python is needed.
const PY_HELPER = String.raw`
import base64, hashlib, io, json, os, re, sys, tarfile, zipfile
cmd = sys.argv[1]
a = json.load(sys.stdin)

def extract_tar(path, dest, prefix):
    with tarfile.open(path) as t:
        members = [m for m in t.getmembers() if m.name.startswith(prefix)]
        t.extractall(dest, members=members, filter='data')

def extract_zip(path, dest, prefixes):
    with zipfile.ZipFile(path) as z:
        for n in z.namelist():
            if any(n.startswith(p) for p in prefixes):
                z.extract(n, dest)

def record_line(name, data):
    digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b'=').decode()
    return f'{name},sha256={digest},{len(data)}'

def write_wheel(out, files, dist_info):
    # files: [(arcname, bytes)]; RECORD is added last.
    tmp = out + '.part'
    with zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED) as z:
        lines = []
        for name, data in files:
            z.writestr(zipfile.ZipInfo(name, date_time=(2020, 1, 1, 0, 0, 0)), data, zipfile.ZIP_DEFLATED)
            lines.append(record_line(name, data))
        lines.append(f'{dist_info}/RECORD,,')
        z.writestr(zipfile.ZipInfo(f'{dist_info}/RECORD', date_time=(2020, 1, 1, 0, 0, 0)), '\n'.join(lines) + '\n', zipfile.ZIP_DEFLATED)
    os.replace(tmp, out)

if cmd == 'untar':
    extract_tar(a['archive'], a['dest'], a.get('prefix', ''))
elif cmd == 'unzip':
    extract_zip(a['archive'], a['dest'], a['prefixes'])
elif cmd == 'msgspec-wheel':
    src, ver, tag = a['src'], a['version'], a['tag']
    di = f'msgspec-{ver}.dist-info'
    files = []
    pkg = os.path.join(src, 'src', 'msgspec')
    for n in sorted(os.listdir(pkg)):
        if n.endswith(('.c', '.h')) or n == '__pycache__':
            continue
        with open(os.path.join(pkg, n), 'rb') as f:
            files.append((f'msgspec/{n}', f.read()))
    with open(a['so'], 'rb') as f:
        files.append((f'msgspec/{os.path.basename(a["so"])}', f.read()))
    with open(os.path.join(src, 'PKG-INFO'), 'rb') as f:
        files.append((f'{di}/METADATA', f.read()))
    with open(os.path.join(src, 'LICENSE'), 'rb') as f:
        files.append((f'{di}/licenses/LICENSE', f.read()))
    files.append((f'{di}/WHEEL', f'Wheel-Version: 1.0\nGenerator: stitch (mobile/scripts/searxng.mjs)\nRoot-Is-Purelib: false\nTag: {tag}\n'.encode()))
    files.append((f'{di}/top_level.txt', b'msgspec\n'))
    write_wheel(a['out'], files, di)
elif cmd == 'relax-requires':
    # Rewrite Requires-Dist lines of a wheel's METADATA (e.g. cffi>=2.0.0 -> cffi>=1.12) and redo RECORD.
    with zipfile.ZipFile(a['wheel']) as z:
        names = [n for n in z.namelist() if not n.endswith('/RECORD')]
        di = next(n.split('/')[0] for n in names if n.endswith('.dist-info/METADATA'))
        files = []
        for n in names:
            data = z.read(n)
            if n == f'{di}/METADATA':
                text = data.decode('utf-8')
                for old, new in a['replace'].items():
                    if f'Requires-Dist: {old}' not in text:
                        sys.exit(f'{old} not found in {n}')
                    text = text.replace(f'Requires-Dist: {old}', f'Requires-Dist: {new}')
                data = text.encode('utf-8')
            files.append((n, data))
    write_wheel(a['out'], files, di)
else:
    sys.exit(f'unknown command {cmd}')
`

function py(python, cmd, args) {
  run(python, ['-I', '-c', PY_HELPER, cmd], { input: JSON.stringify(args) })
}

// ─── Build-machine Python 3.13 ───────────────────────────────────────────────

function probePython(cmd, args = []) {
  const r = spawnSync(cmd, [...args, '-c', 'import sys; print(sys.executable); print("%d.%d" % sys.version_info[:2])'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20_000
  })
  if (r.status !== 0 || !r.stdout) return null
  const [exe, ver] = r.stdout.trim().split(/\r?\n/)
  return ver?.trim() === PYTHON && exe && existsSync(exe.trim()) ? exe.trim() : null
}

function standaloneTriple() {
  const arch = process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : null
  const os = win ? 'pc-windows-msvc' : process.platform === 'darwin' ? 'apple-darwin' : process.platform === 'linux' ? 'unknown-linux-gnu' : null
  if (!arch || !os) throw new Error(`No Python ${PYTHON} found and no python-build-standalone build for ${process.platform}/${process.arch}; set STITCH_BUILD_PYTHON`)
  return `${arch}-${os}`
}

async function hostPython() {
  const fromEnv = process.env.STITCH_BUILD_PYTHON
  if (fromEnv) {
    const p = probePython(fromEnv)
    if (!p) throw new Error(`STITCH_BUILD_PYTHON (${fromEnv}) is not a working Python ${PYTHON}`)
    return p
  }
  const found = win ? probePython('py', [`-${PYTHON}`]) : (probePython(`python${PYTHON}`) ?? probePython('python3'))
  if (found) return found

  const dir = join(OUT, 'host-python')
  const exe = join(dir, 'python', win ? 'python.exe' : 'bin/python3')
  if (existsSync(exe) && probePython(exe)) return exe
  const file = `cpython-${HOST_PY.version}+${HOST_PY.release}-${standaloneTriple()}-install_only_stripped.tar.gz`
  const base = `https://github.com/astral-sh/python-build-standalone/releases/download/${HOST_PY.release}`
  const sums = await fetchText(`${base}/SHA256SUMS`)
  const sha = sums.split('\n').find((l) => l.trim().endsWith(file))?.split(/\s+/)[0]
  if (!sha) throw new Error(`${file} is not in python-build-standalone ${HOST_PY.release}`)
  const tgz = await download(`${base}/${encodeURIComponent(file)}`, join(CACHE, file), { algo: 'sha256', hex: sha })
  rm(dir)
  mkdirSync(dir, { recursive: true })
  // Windows' own bsdtar handles drive-letter paths (Git's GNU tar doesn't).
  run(win ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar', ['-xzf', tgz, '-C', dir])
  if (!probePython(exe)) throw new Error(`python-build-standalone ${HOST_PY.version} doesn't run on this machine`)
  log(`using python-build-standalone ${HOST_PY.version} as the build Python`)
  return exe
}

// ─── Android NDK ─────────────────────────────────────────────────────────────

function sdkDir() {
  const props = join(ANDROID, 'local.properties')
  if (existsSync(props)) {
    const m = /^sdk\.dir=(.*)$/m.exec(readFileSync(props, 'utf8'))
    if (m) return m[1].trim().replace(/\\:/g, ':').replace(/\\\\/g, '\\')
  }
  return process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? null
}

function ndkClang() {
  const candidates = []
  for (const k of ['ANDROID_NDK_HOME', 'ANDROID_NDK_ROOT', 'ANDROID_NDK']) if (process.env[k]) candidates.push(process.env[k])
  const sdk = sdkDir()
  if (sdk && existsSync(join(sdk, 'ndk'))) {
    const versions = readdirSync(join(sdk, 'ndk')).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    candidates.push(...versions.map((v) => join(sdk, 'ndk', v)))
  }
  if (sdk) candidates.push(join(sdk, 'ndk-bundle'))
  for (const ndk of candidates) {
    const prebuilt = join(ndk, 'toolchains', 'llvm', 'prebuilt')
    if (!existsSync(prebuilt)) continue
    for (const host of readdirSync(prebuilt)) {
      const clang = join(prebuilt, host, 'bin', win ? 'clang.exe' : 'clang')
      if (existsSync(clang)) return clang
    }
  }
  throw new Error('No Android NDK found (needed to build msgspec): install one with the SDK manager (sdkmanager "ndk;29.0.14206865") or set ANDROID_NDK_HOME')
}

// ─── Up to date? ─────────────────────────────────────────────────────────────

if (!existsSync(WRAPPER)) throw new Error(`${WRAPPER} is missing`)

const want = { commit: pin.commit, date: pin.date, repo: pin.repo ?? 'searxng/searxng', python: PYTHON, target: CHAQUOPY_TARGET, format: FORMAT }
const stamp = join(OUT, 'build.json')
const have = readJson(stamp)
const current =
  !force &&
  have &&
  Object.entries(want).every(([k, v]) => have[k] === v) &&
  existsSync(join(OUT, 'python', 'searx', 'webapp.py')) &&
  typeof have.version === 'string' &&
  existsSync(have.requirements) &&
  (have.wheels ?? []).every((w) => existsSync(w)) &&
  probePython(have.buildPython)

if (current) {
  const changed = syncFile(WRAPPER, join(OUT, 'python', 'stitch_searx.py'))
  log(`up to date (SearXNG ${want.date} ${want.commit.slice(0, 9)}, Python ${PYTHON})${changed ? ' — refreshed stitch_searx.py' : ''}`)
  process.exit(0)
}

// ─── Build ───────────────────────────────────────────────────────────────────

const t0 = Date.now()
log(`staging SearXNG ${want.date} (${want.commit.slice(0, 9)}) for Python ${PYTHON} on Android`)
mkdirSync(CACHE, { recursive: true })
const python = await hostPython()
log(`build Python: ${python}`)

const work = join(OUT, 'work')
rm(work)
mkdirSync(work, { recursive: true })

// 1. SearXNG source at the pinned commit → python/searx (trimmed)
const top = `searxng-${want.commit}`
const sxTar = await download(`https://codeload.github.com/${want.repo}/tar.gz/${want.commit}`, join(CACHE, `${top}.tar.gz`))
py(python, 'untar', { archive: sxTar, dest: work, prefix: `${top}/` })
const sx = join(work, top)
const stage = join(work, 'python')
mkdirSync(stage, { recursive: true })
move(join(sx, 'searx'), join(stage, 'searx'))
copyFileSync(join(sx, 'LICENSE'), join(stage, 'searx', 'LICENSE'))
const before = dirSize(join(stage, 'searx'))
// The web UI's CSS/JS/images (stitch_searx points ui.static_path at an empty folder), translation sources (the
// compiled .mo files stay), type stubs, and the fastText language model nothing loads any more.
rm(join(stage, 'searx', 'static'))
rm(join(stage, 'searx', 'data', 'lid.176.ftz'))
prune(join(stage, 'searx'), (name, isDir) => (isDir && name === '__pycache__') || (!isDir && /\.(po|pot|pyi)$/i.test(name)))
log(`searx/ trimmed ${mb(before)} → ${mb(dirSize(join(stage, 'searx')))}`)
// searx/version.py shells out to git unless this exists.
const [y, m, d] = want.date.split('-').map(Number)
const short = want.commit.slice(0, 9)
writeFileSync(
  join(stage, 'searx', 'version_frozen.py'),
  [
    '# SPDX-License-Identifier: AGPL-3.0-or-later',
    '# Written by Stitch (mobile/scripts/searxng.mjs) for the copy inside the Android app.',
    `VERSION_STRING = "${y}.${m}.${d}+${short}"`,
    `VERSION_TAG = "${y}.${m}.${d}+${short}"`,
    `DOCKER_TAG = "${y}.${m}.${d}-${short}"`,
    `GIT_URL = "https://github.com/${want.repo}"`,
    'GIT_BRANCH = "master"',
    ''
  ].join('\n')
)
copyFileSync(WRAPPER, join(stage, 'stitch_searx.py'))

const pins = Object.fromEntries(
  readFileSync(join(sx, 'requirements.txt'), 'utf8')
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*/, '').trim())
    .filter(Boolean)
    .map((l) => {
      const [name, ver] = l.split('==')
      return [name.trim().toLowerCase().replace(/_/g, '-'), ver?.trim() ?? '']
    })
)
for (const need of ['msgspec', 'curl-cffi']) if (!pins[need]) throw new Error(`${need} is not pinned in SearXNG's requirements.txt`)

// 2. msgspec for Android: compile _core.c with the NDK against Chaquopy's Python, then package a wheel.
const wheels = join(OUT, 'wheels')
mkdirSync(wheels, { recursive: true })
const tag = `cp${PYTHON.replace('.', '')}-cp${PYTHON.replace('.', '')}-${ABI.tag}`
const msgspecWheel = join(wheels, `msgspec-${pins.msgspec}-${tag}.whl`)
{
  const clang = ndkClang()
  const base = `https://repo1.maven.org/maven2/com/chaquo/python/target/${CHAQUOPY_TARGET}/target-${CHAQUOPY_TARGET}-${ABI.android}.zip`
  const sha1 = (await fetchText(`${base}.sha1`)).trim().split(/\s+/)[0]
  const targetZip = await download(base, join(CACHE, `chaquopy-target-${CHAQUOPY_TARGET}-${ABI.android}.zip`), { algo: 'sha1', hex: sha1 })
  const target = join(work, 'target')
  py(python, 'unzip', { archive: targetZip, dest: target, prefixes: [`include/python${PYTHON}/`, `jniLibs/${ABI.android}/libpython${PYTHON}.so`] })

  const sdist = await pypi('msgspec', pins.msgspec, (f) => f.endsWith('.tar.gz'))
  py(python, 'untar', { archive: sdist, dest: work, prefix: `msgspec-${pins.msgspec}/` })
  const src = join(work, `msgspec-${pins.msgspec}`)
  const so = join(work, `_core.cpython-${PYTHON.replace('.', '')}-${ABI.triple}.so`)
  log(`compiling msgspec ${pins.msgspec} for ${ABI.android} (${clang})`)
  // Flags as CPython's own build uses for extensions (sysconfig CFLAGS), 16 KB pages, linked to libpython like
  // every extension module in Chaquopy's runtime.
  run(clang, [
    `--target=${ABI.triple}${ABI.api}`,
    '-shared',
    '-fPIC',
    '-O3',
    '-g0',
    '-DNDEBUG',
    '-fwrapv',
    '-fno-strict-aliasing',
    '-Wno-shift-negative-value',
    '-Wno-unused-function',
    `-I${join(target, 'include', `python${PYTHON}`)}`,
    join(src, 'src', 'msgspec', '_core.c'),
    '-o',
    so,
    `-L${join(target, 'jniLibs', ABI.android)}`,
    `-lpython${PYTHON}`,
    '-lm',
    '-Wl,-z,max-page-size=16384',
    '-Wl,--build-id=sha1',
    '-Wl,-s'
  ])
  py(python, 'msgspec-wheel', { src, so, version: pins.msgspec, tag, out: msgspecWheel })
  log(`built ${msgspecWheel.slice(OUT.length + 1)} (${mb(statSync(msgspecWheel).size)})`)
}

// 3. curl_cffi: PyPI's official Android wheel, cffi requirement relaxed (see the header).
const curlFile = `curl_cffi-${pins['curl-cffi']}-${tag}.whl`
const curlWheel = join(wheels, curlFile)
{
  const orig = await pypi('curl_cffi', pins['curl-cffi'], (f) => f === curlFile)
  py(python, 'relax-requires', { wheel: orig, out: curlWheel, replace: { 'cffi>=2.0.0': 'cffi>=1.12' } })
  log(`prepared ${curlWheel.slice(OUT.length + 1)} (${mb(statSync(curlWheel).size)})`)
}

// 4. Requirements for Chaquopy's pip: SearXNG's pins, with the local wheels and Chaquopy's builds swapped in.
const reqLines = [
  '# Written by mobile/scripts/searxng.mjs from SearXNG\'s requirements.txt — do not edit.',
  ...Object.entries(pins).map(([name, ver]) => {
    if (name === 'msgspec') return slash(msgspecWheel)
    if (name === 'curl-cffi') return slash(curlWheel)
    if (OVERRIDES[name]) return `${name}==${OVERRIDES[name]}`
    return ver ? `${name}==${ver}` : name
  }),
  ...EXTRA
]
const requirements = join(OUT, 'requirements.txt')
writeFileSync(requirements, reqLines.join('\n') + '\n')

// 5. Swap the source dir into place, then stamp.
const dest = join(OUT, 'python')
rm(dest)
move(stage, dest)
rm(work)
writeFileSync(
  stamp,
  JSON.stringify({ ...want, version: `${y}.${m}.${d}+${short}`, buildPython: slash(python), requirements: slash(requirements), wheels: [slash(msgspecWheel), slash(curlWheel)], builtAt: new Date().toISOString() }, null, 2) + '\n'
)
log(`done in ${Math.round((Date.now() - t0) / 1000)} s → ${OUT}`)
