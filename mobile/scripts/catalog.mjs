// Generates src/device/catalog.gen.ts — the bulk of the on-device model catalog — from the curated specs in
// scripts/catalog/{text,images,voices}.mjs. For every Hugging Face repo a spec names, it reads the repo's current commit
// and gated flag (/api/models/<repo>) and the exact byte size of every file at that commit (/api/models/<repo>/tree/<sha>),
// so each entry downloads from a URL pinned to a commit with a size the download is checked against (same rigour as the
// hand-written entries in catalog.ts). GGUF files named in a spec but missing in the repo are matched by quant (e.g. the
// same Q4_K_M under the repo's real naming) and reported.
//
//   node scripts/catalog.mjs            generate (API answers are cached in node_modules/.cache/stitch-catalog)
//   node scripts/catalog.mjs --refresh  re-read every repo's current commit (trees at a commit never change)
//   node scripts/catalog.mjs --check    verify the generated file's pinned sizes against the API, without writing
// HF_TOKEN (optional) raises Hugging Face's anonymous rate limit; it's only sent to huggingface.co.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TEXT } from './catalog/text.mjs'
import { IMAGES } from './catalog/images.mjs'
import { VOICES } from './catalog/voices.mjs'

const MOBILE = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(MOBILE, 'src', 'device', 'catalog.gen.ts')
const CACHE = join(MOBILE, 'node_modules', '.cache', 'stitch-catalog')
const refresh = process.argv.includes('--refresh')
const checkOnly = process.argv.includes('--check')
const token = process.env.HF_TOKEN

const log = (msg) => console.log(`[catalog] ${msg}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ─── Hugging Face API (cached, throttled, retried) ───────────────────────────

let lastCall = 0
async function api(path, { immutable = false } = {}) {
  const url = `https://huggingface.co/api/${path}`
  const file = join(CACHE, createHash('sha1').update(url).digest('hex') + '.json')
  if (existsSync(file) && (immutable || !refresh)) return JSON.parse(readFileSync(file, 'utf8'))
  for (let attempt = 1; ; attempt++) {
    const wait = lastCall + 350 - Date.now()
    if (wait > 0) await sleep(wait)
    lastCall = Date.now()
    const res = await fetch(url, { headers: { 'user-agent': 'stitch-catalog', ...(token ? { authorization: `Bearer ${token}` } : {}) } })
    if (res.status === 429 && attempt < 8) {
      const retry = Number(res.headers.get('retry-after')) || 30 * attempt
      log(`rate limited; waiting ${retry} s`)
      await sleep(retry * 1000)
      continue
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
    let body = await res.json()
    // The tree API pages with a Link header.
    let next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') ?? '')?.[1]
    while (next && Array.isArray(body)) {
      const more = await fetch(next, { headers: { 'user-agent': 'stitch-catalog', ...(token ? { authorization: `Bearer ${token}` } : {}) } })
      if (!more.ok) throw new Error(`HTTP ${more.status} for ${next}`)
      body = body.concat(await more.json())
      next = /<([^>]+)>;\s*rel="next"/.exec(more.headers.get('link') ?? '')?.[1]
    }
    mkdirSync(CACHE, { recursive: true })
    writeFileSync(file, JSON.stringify(body))
    return body
  }
}

const repos = new Map()
/** Current commit, gated flag and { path → size } of every file in a repo. */
async function repo(name) {
  if (repos.has(name)) return repos.get(name)
  const info = await api(`models/${name}`)
  const sha = info.sha
  if (!sha) throw new Error(`${name}: no commit sha`)
  const tree = await api(`models/${name}/tree/${sha}?recursive=true`, { immutable: true })
  const sizes = new Map(tree.filter((e) => e.type === 'file').map((e) => [e.path, e.lfs?.size ?? e.size]))
  const r = { name, sha, gated: !!info.gated && info.gated !== 'false', license: info.cardData?.license, sizes }
  repos.set(name, r)
  return r
}

const QUANT = /(?:^|[._-])((?:I?Q\d_[A-Z0-9_]+|Q\d_\d|F16|BF16|F32))(?=\.gguf$)/i

/** Exact path, or for GGUF the one file with the same quant under the repo's own naming. */
function resolvePath(r, path) {
  if (r.sizes.has(path)) return path
  const q = QUANT.exec(path)?.[1]
  if (path.endsWith('.gguf') && q) {
    const hits = [...r.sizes.keys()].filter((p) => p.toLowerCase().endsWith('.gguf') && !/mmproj/i.test(p) && QUANT.exec(p)?.[1]?.toUpperCase() === q.toUpperCase())
    if (hits.length === 1) {
      log(`  ${r.name}: ${path} → ${hits[0]}`)
      return hits[0]
    }
  }
  const ggufs = [...r.sizes.keys()].filter((p) => p.endsWith('.gguf')).slice(0, 12)
  throw new Error(`${r.name}@${r.sha.slice(0, 8)} has no ${path}${ggufs.length ? ` (GGUF files: ${ggufs.join(', ')})` : ''}`)
}

// ─── Espeak-ng data (must be the standard set catalog.ts lists) ─────────────

const ESPEAK = { count: 355, bytes: 17_991_651 }
function checkEspeak(r) {
  const files = [...r.sizes.entries()].filter(([p]) => p.startsWith('espeak-ng-data/'))
  const bytes = files.reduce((n, [, s]) => n + s, 0)
  if (files.length !== ESPEAK.count || bytes !== ESPEAK.bytes) {
    throw new Error(`${r.name}: espeak-ng-data is ${files.length} files / ${bytes} bytes, not the standard ${ESPEAK.count} / ${ESPEAK.bytes}`)
  }
}

// ─── Entries ─────────────────────────────────────────────────────────────────

/** Rough RAM tier (GB, as phones are sold) for a text model file of `bytes`. */
function textRam(bytes) {
  const gb = bytes / 1e9
  return gb <= 0.6 ? 3 : gb <= 1.4 ? 4 : gb <= 2.4 ? 6 : gb <= 3.6 ? 8 : gb <= 6 ? 12 : 16
}

async function build(spec) {
  const { repo: repoName, file, files: specFiles, params, espeak, espeakRepo, ...m } = spec
  const list = specFiles ?? [{ repo: repoName, path: file }]
  const files = []
  let gated = false
  const shas = new Set()
  for (const f of list) {
    const r = await repo(f.repo)
    const path = resolvePath(r, f.path)
    files.push(f.as && f.as !== path ? [r.name, r.sha, path, r.sizes.get(path), f.as] : [r.name, r.sha, path, r.sizes.get(path)])
    gated ||= r.gated
    shas.add(r.sha)
  }
  let espeakRef
  if (espeak) {
    const r = await repo(espeakRepo ?? list[0].repo)
    checkEspeak(r)
    espeakRef = [r.name, r.sha]
  }
  const saved = (f) => f[4] ?? f[2]
  let entry
  if (spec.entry) {
    const hit = files.find((f) => f[2] === spec.entry || saved(f) === spec.entry)
    if (!hit) throw new Error(`${spec.id}: entry ${spec.entry} isn't one of its files`)
    entry = saved(hit)
  } else if (spec.task === 'text') {
    entry = saved(files[0])
  }
  const size = files.reduce((n, f) => n + f[3], 0)
  if (spec.gated && !gated) log(`  note: ${spec.id} is marked gated but ${list[0].repo} isn't`)
  const out = {
    id: m.id,
    task: m.task,
    format: m.format,
    name: m.name,
    family: m.family,
    description: m.description,
    backends: m.backends,
    ...(m.socs ? { socs: m.socs } : {}),
    ...(entry ? { entry } : {}),
    license: m.license,
    homepage: m.homepage ?? `https://huggingface.co/${list[0].repo}`,
    ...(gated || m.gated ? { gated: true } : {}),
    ...(m.recommended ? { recommended: true } : {}),
    minRamGb: m.minRamGb ?? (m.task === 'text' ? textRam(size) : 4),
    ...(m.task === 'text' ? { contextLength: m.contextLength ?? ((params ?? 99) <= 2 ? 8192 : 4096) } : {}),
    ...(m.resolution ? { resolution: m.resolution } : {}),
    ...(m.steps ? { steps: m.steps } : {}),
    ...(m.guidance !== undefined ? { guidance: m.guidance } : {}),
    ...(m.scheduler ? { scheduler: m.scheduler } : {}),
    ...(m.voices ? { voices: m.voices } : {}),
    variant: m.variant ?? 'standard',
    tags: [...new Set(m.tags ?? [])],
    ...(m.config && Object.keys(m.config).length ? { config: m.config } : {}),
    source: 'catalog',
    files,
    ...(espeakRef ? { espeak: espeakRef } : {})
  }
  return out
}

// ─── Output (TypeScript literal) ─────────────────────────────────────────────

const ident = /^[A-Za-z_$][A-Za-z0-9_$]*$/
function ts(v, indent = '') {
  if (v === null) return 'null'
  if (typeof v === 'string') return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) {
    const flat = v.every((x) => x === null || typeof x !== 'object')
    if (flat) return `[${v.map((x) => ts(x)).join(', ')}]`
    const inner = indent + '  '
    return `[\n${v.map((x) => inner + ts(x, inner)).join(',\n')}\n${indent}]`
  }
  const keys = Object.keys(v).filter((k) => v[k] !== undefined)
  const oneLine = `{ ${keys.map((k) => `${ident.test(k) ? k : ts(k)}: ${ts(v[k], indent)}`).join(', ')} }`
  if (oneLine.length <= 110 && !oneLine.includes('\n')) return oneLine
  const inner = indent + '  '
  return `{\n${keys.map((k) => `${inner}${ident.test(k) ? k : ts(k)}: ${ts(v[k], inner)}`).join(',\n')}\n${indent}}`
}

async function generate() {
  const specs = [...TEXT, ...IMAGES, ...VOICES]
  const ids = new Set()
  for (const s of specs) {
    if (ids.has(s.id)) throw new Error(`duplicate id ${s.id}`)
    ids.add(s.id)
  }
  const models = []
  for (const s of specs) {
    process.stdout.write(`\r[catalog] ${models.length + 1}/${specs.length} ${s.id}`.padEnd(90))
    models.push(await build(s))
  }
  process.stdout.write('\n')
  return models
}

if (checkOnly) {
  const src = readFileSync(OUT, 'utf8')
  const rows = [...src.matchAll(/\['([^']+)', '([0-9a-f]{40})', '((?:[^'\\]|\\.)*)', (\d+)/g)]
  let bad = 0
  for (const [, name, sha, path, size] of rows) {
    const tree = await api(`models/${name}/tree/${sha}?recursive=true`, { immutable: true })
    const hit = tree.find((e) => e.path === path.replace(/\\'/g, "'"))
    const actual = hit && (hit.lfs?.size ?? hit.size)
    if (actual !== Number(size)) {
      bad++
      log(`MISMATCH ${name}@${sha.slice(0, 8)} ${path}: catalog ${size}, API ${actual ?? 'missing'}`)
    }
  }
  log(`${rows.length} pinned files checked, ${bad} mismatches`)
  process.exit(bad ? 1 : 0)
}

const models = await generate()
const count = (pred) => models.filter(pred).length
const today = new Date().toISOString().slice(0, 10)
const header = `// Generated by scripts/catalog.mjs from scripts/catalog/*.mjs on ${today} — edit the specs and run \`npm run catalog\`.
// Every file is [repo, commit, path, bytes, saved-as?]: the size is the Hugging Face API size at that exact commit.
// ${models.length} models: ${count((m) => m.task === 'text')} text (${count((m) => m.format === 'gguf')} GGUF, ${count((m) => m.format === 'litertlm')} LiteRT-LM), ${count((m) => m.task === 'image')} image, ${count((m) => m.task === 'voice')} voice.
import type { GenModel } from './catalog'

export const GENERATED_MODELS: GenModel[] = `
writeFileSync(OUT, header + ts(models) + '\n')
log(`wrote ${OUT} (${models.length} models from ${repos.size} repos)`)
