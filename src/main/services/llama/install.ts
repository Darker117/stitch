// Stitch-managed llama.cpp: the official Windows build from ggml-org/llama.cpp GitHub releases,
// downloaded on demand (llama zip + matching cudart zip), checked against the SHA-256 digests
// GitHub publishes for each asset, and unpacked to <userData>/bin/llama.cpp/<tag>-<flavor>/.
//
// Flavor: CUDA 12.4 by default; CUDA 13 when a GPU is Blackwell or newer (compute 12.x, which the
// 12.4 build has no kernels for) and the driver supports CUDA 13; CPU when there's no NVIDIA GPU.
// A node installs exactly the tag its main runs so the RPC protocol matches.
import { app } from 'electron'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'

const run = promisify(execFile)
const API = 'https://api.github.com/repos/ggml-org/llama.cpp'
const UA = 'Stitch (+desktop)'

export type LlamaFlavor = 'cuda12' | 'cuda13' | 'cpu'

export interface LlamaInstall {
  tag: string
  flavor: LlamaFlavor
  dir: string
}

interface Asset {
  name: string
  size: number
  digest?: string
  browser_download_url: string
}

interface Release {
  tag_name: string
  draft: boolean
  prerelease: boolean
  assets: Asset[]
}

export const llamaRoot = (): string => join(app.getPath('userData'), 'bin', 'llama.cpp')
const marker = (): string => join(llamaRoot(), 'current.json')

/** The newest complete install on disk (llama-server + rpc-server present). */
export function installedLlama(tag?: string): LlamaInstall | undefined {
  try {
    const cur = JSON.parse(readFileSync(marker(), 'utf8')) as LlamaInstall
    if ((!tag || cur.tag === tag) && complete(cur.dir)) return cur
  } catch {
    /* none yet */
  }
  if (!tag) return undefined
  // A node may hold several tags (one per main version); look for the wanted one.
  try {
    for (const name of readdirSync(llamaRoot())) {
      const m = /^(b\d+)-(cuda12|cuda13|cpu)$/.exec(name)
      if (m && m[1] === tag && complete(join(llamaRoot(), name))) return { tag, flavor: m[2] as LlamaFlavor, dir: join(llamaRoot(), name) }
    }
  } catch {
    /* no root */
  }
  return undefined
}

function complete(dir: string): boolean {
  return existsSync(join(dir, exe('llama-server'))) && !!rpcServer(dir)
}

export const exe = (name: string): string => (process.platform === 'win32' ? `${name}.exe` : name)

/** The RPC server binary (`ggml-rpc-server` in current builds, `rpc-server` in older ones). */
export function rpcServer(dir: string): string | undefined {
  return ['ggml-rpc-server', 'rpc-server'].map((n) => join(dir, exe(n))).find((p) => existsSync(p))
}

/** Which build fits this PC's GPUs and driver. */
export async function pickFlavor(): Promise<LlamaFlavor> {
  try {
    const { stdout } = await run('nvidia-smi', ['--query-gpu=compute_cap,driver_version', '--format=csv,noheader'], { windowsHide: true, timeout: 8000 })
    const rows = stdout.split(/\r?\n/).filter((l) => l.trim()).map((l) => l.split(',').map((s) => s.trim()))
    if (!rows.length) return 'cpu'
    const newest = Math.max(...rows.map((r) => Number(r[0]) || 0))
    const driver = Number((rows[0][1] ?? '0').split('.')[0])
    // CUDA 13 needs driver 580+.
    return newest >= 12 && driver >= 580 ? 'cuda13' : 'cuda12'
  } catch {
    return 'cpu'
  }
}

function assetsFor(r: Release, flavor: LlamaFlavor): Asset[] | null {
  const tag = r.tag_name
  if (flavor === 'cpu') {
    const a = r.assets.find((x) => x.name === `llama-${tag}-bin-win-cpu-x64.zip`)
    return a ? [a] : null
  }
  const major = flavor === 'cuda13' ? '13' : '12'
  const re = new RegExp(`^llama-${tag}-bin-win-cuda-(${major}\\.\\d+)-x64\\.zip$`)
  const main = r.assets.map((a) => ({ a, m: re.exec(a.name) })).filter((x) => x.m).sort((x, y) => Number(y.m![1].split('.')[1]) - Number(x.m![1].split('.')[1]))[0]
  if (!main) return null
  const rt = r.assets.find((a) => a.name === `cudart-llama-bin-win-cuda-${main.m![1]}-x64.zip`)
  return rt ? [main.a, rt] : null
}

async function gh<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, { headers: { 'User-Agent': UA, Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(20_000) })
  if (res.status === 403 || res.status === 429) throw new Error('GitHub is rate-limiting requests — try again in a few minutes.')
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for llama.cpp releases`)
  return (await res.json()) as T
}

/** The release to install: an exact tag, or the newest build that has this flavor. */
async function findRelease(flavor: LlamaFlavor, tag?: string): Promise<{ release: Release; assets: Asset[] }> {
  if (tag) {
    const r = await gh<Release>(`/releases/tags/${encodeURIComponent(tag)}`)
    const assets = assetsFor(r, flavor) ?? (flavor === 'cuda13' ? assetsFor(r, 'cuda12') : null)
    if (!assets) throw new Error(`llama.cpp ${tag} has no Windows ${flavor} build`)
    return { release: r, assets }
  }
  // "latest" is a source-only release; the binaries live on the bNNNNN build tags.
  const list = await gh<Release[]>('/releases?per_page=20')
  for (const r of list) {
    if (r.draft || !/^b\d+$/.test(r.tag_name)) continue
    const assets = assetsFor(r, flavor)
    if (assets) return { release: r, assets }
  }
  throw new Error('No llama.cpp release with a Windows build was found')
}

export interface InstallProgress {
  (label: string, progress?: number): void
}

let installing: Promise<LlamaInstall> | null = null

/**
 * Make sure llama.cpp is installed (a specific tag for nodes). Concurrent callers share one
 * download. Progress goes to `onProgress` (label, 0–1).
 */
export function ensureLlama(onProgress: InstallProgress, tag?: string): Promise<LlamaInstall> {
  const have = installedLlama(tag)
  if (have) return Promise.resolve(have)
  if (process.platform !== 'win32') return Promise.reject(new Error('Stitch installs llama.cpp on Windows only — put llama-server on this PC yourself.'))
  installing ??= install(onProgress, tag).finally(() => (installing = null))
  return installing
}

async function install(onProgress: InstallProgress, tag?: string): Promise<LlamaInstall> {
  const flavor = await pickFlavor()
  onProgress('Finding the llama.cpp build', undefined)
  const { release, assets } = await findRelease(flavor, tag)
  const realFlavor: LlamaFlavor = assets[0].name.includes('cuda-13') ? 'cuda13' : assets[0].name.includes('cuda-12') ? 'cuda12' : 'cpu'
  const root = llamaRoot()
  const dir = join(root, `${release.tag_name}-${realFlavor}`)
  const tmp = join(root, 'download')
  mkdirSync(tmp, { recursive: true })
  const total = assets.reduce((n, a) => n + a.size, 0)
  let done = 0
  const zips: string[] = []
  for (const a of assets) {
    const file = join(tmp, a.name)
    zips.push(file)
    const base = done
    await download(a, file, (got) => onProgress(`Downloading llama.cpp ${release.tag_name}`, total ? (base + got) / total : undefined))
    done += a.size
  }
  onProgress('Unpacking llama.cpp', undefined)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  for (const z of zips) await unzip(z, dir)
  // Some builds nest everything in a folder; flatten to where llama-server.exe is.
  const binDir = findBinDir(dir)
  if (!binDir) throw new Error('The llama.cpp download did not contain llama-server')
  const result: LlamaInstall = { tag: release.tag_name, flavor: realFlavor, dir: binDir }
  if (!complete(binDir)) throw new Error('The llama.cpp download did not contain rpc-server')
  writeFileSync(marker(), JSON.stringify(result, null, 2))
  for (const z of zips) rmSync(z, { force: true })
  prune(dir)
  return result
}

async function download(a: Asset, file: string, onBytes: (n: number) => void): Promise<void> {
  const want = a.digest?.startsWith('sha256:') ? a.digest.slice(7).toLowerCase() : undefined
  if (existsSync(file) && statSync(file).size === a.size && want && (await sha256(file)) === want) return
  const res = await fetch(a.browser_download_url, { headers: { 'User-Agent': UA }, redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`Couldn't download ${a.name} (${res.status})`)
  const hash = createHash('sha256')
  let got = 0
  let last = 0
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      hash.update(chunk)
      got += chunk.length
      if (Date.now() - last > 250) {
        last = Date.now()
        onBytes(got)
      }
      cb(null, chunk)
    }
  })
  const part = `${file}.part`
  try {
    await pipeline(Readable.fromWeb(res.body as never), meter, createWriteStream(part))
  } catch (err) {
    try {
      unlinkSync(part)
    } catch {
      /* ignore */
    }
    throw err
  }
  const got256 = hash.digest('hex')
  if (a.size && statSync(part).size !== a.size) {
    unlinkSync(part)
    throw new Error(`${a.name} arrived incomplete — try again`)
  }
  if (want && got256 !== want) {
    unlinkSync(part)
    throw new Error(`${a.name} failed its checksum — the download was removed`)
  }
  rmSync(file, { force: true })
  renameSync(part, file)
}

async function sha256(file: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(file), hash)
  return hash.digest('hex')
}

/** Windows 10+ ships bsdtar, which reads zip files. */
async function unzip(zip: string, dest: string): Promise<void> {
  const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
  await run(existsSync(tar) ? tar : 'tar', ['-xf', zip, '-C', dest], { windowsHide: true, timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024 })
}

function findBinDir(dir: string, depth = 0): string | null {
  if (existsSync(join(dir, exe('llama-server')))) return dir
  if (depth > 2) return null
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    const hit = findBinDir(join(dir, e.name), depth + 1)
    if (hit) {
      // Move the DLLs from the other zip (unpacked at the top) next to the binaries.
      if (hit !== dir) {
        for (const f of readdirSync(dir)) {
          const p = join(dir, f)
          if (statSync(p).isFile() && !existsSync(join(hit, f))) renameSync(p, join(hit, f))
        }
      }
      return hit
    }
  }
  return null
}

/** Keep the new install plus at most one other (a node may serve mains on two versions). */
function prune(keep: string): void {
  try {
    const dirs = readdirSync(llamaRoot(), { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^b\d+-/.test(e.name) && join(llamaRoot(), e.name) !== keep)
      .map((e) => ({ p: join(llamaRoot(), e.name), t: statSync(join(llamaRoot(), e.name)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
    for (const d of dirs.slice(1)) rmSync(d.p, { recursive: true, force: true })
  } catch {
    /* in use or gone */
  }
}
