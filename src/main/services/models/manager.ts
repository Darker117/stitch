// Model manager: every model file (and Stitch-run model folder) across every
// location in use, with disk usage per location, which recipes use each
// model, and Recycle-Bin-only deletes.
import { app, shell } from 'electron'
import { existsSync, statSync } from 'node:fs'
import { readdir, stat, statfs } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { LocalModel, ManagedModel, ModelInventory, ModelLocation, ModelLocationKind, ModelUse } from '@shared/types'
import { kindForFolder } from '@shared/civitai'
import { getSettings, updateSettings } from '../../settings'
import { RECIPES, type Requirement } from '../comfy/recipes'
import { catalogIdFor } from './catalog'
import { isDownloading } from './downloads'
import { comfySearches, comfyYamlFor, comfyYamlRoots, inside, insideRoots, MODEL_EXT, modelBases, modelRoots, modelsHome } from './home'
import { cachedLibrary, listLocal, stemOf } from './library'

const SIDECARS = ['.cm-info.json', '.civitai.info', '.preview.jpeg', '.preview.jpg', '.preview.png', '.preview.webp', '.preview.gif', '.preview.mp4', '.preview.webm', '.sha256']

const voiceModelsDir = (): string => join(app.getPath('userData'), 'voice-engine', 'hf')

// ─── Usage ───────────────────────────────────────────────────────────────────

const generic = (r: Requirement): boolean => !!r.anyFile
const satisfies = (r: Requirement, name: string): boolean => (r.name ? name === r.name || name.endsWith('/' + r.name) : !!r.match?.test(name))

/** Recipes (and features) that load a model. Catch-all requirements only count when nothing specific does. */
export function usesOf(folder: string, name: string): ModelUse[] {
  const specific: ModelUse[] = []
  const catchAll: ModelUse[] = []
  for (const r of RECIPES) {
    for (const q of r.requires) {
      if (q.folder !== folder || !satisfies(q, name)) continue
      ;(generic(q) ? catchAll : specific).push({ id: r.id, name: r.name })
      break
    }
  }
  const out = specific.length ? specific : catchAll
  if (folder === 'loras' && !out.length) out.push({ id: 'loras', name: 'LoRA stacks' })
  return [...new Map(out.map((u) => [u.id, u])).values()]
}

// ─── Scan ────────────────────────────────────────────────────────────────────

interface Loc {
  id: string
  kind: ModelLocationKind
  label: string
  path: string
  removable: boolean
}

function locations(): Loc[] {
  const labels: Record<string, string> = {
    settings: 'Your models folder',
    'stability-matrix': 'Stability Matrix shared models',
    comfyui: 'ComfyUI models folder',
    app: 'Stitch models folder',
    extra: 'Added folder'
  }
  const out: Loc[] = modelBases().map((b, i) => ({ id: `${b.kind}-${i}`, kind: b.kind, label: labels[b.kind], path: b.dir, removable: b.kind === 'extra' }))
  // ComfyUI extra paths that live outside every base.
  for (const r of comfyYamlRoots()) {
    if (out.some((l) => inside(l.path, r.dir) || l.path.toLowerCase() === r.dir.toLowerCase())) continue
    const parent = dirname(r.dir)
    if (out.some((l) => l.path.toLowerCase() === parent.toLowerCase())) continue
    out.push({ id: `comfy-extra-${out.length}`, kind: 'comfy-extra', label: 'ComfyUI extra path', path: parent, removable: false })
  }
  out.push({ id: 'voice', kind: 'voice', label: 'Voice engine models', path: voiceModelsDir(), removable: false })
  return out
}

function locationOf(locs: Loc[], p: string): Loc | undefined {
  let best: Loc | undefined
  for (const l of locs) if (inside(l.path, p) && (!best || l.path.length > best.path.length)) best = l
  return best
}

async function dirSize(dir: string, depth = 0): Promise<number> {
  let total = 0
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (depth < 12) total += await dirSize(p, depth + 1)
    } else if (e.isFile()) {
      try {
        total += (await stat(p)).size
      } catch {
        /* vanished */
      }
    }
  }
  return total
}

const PART = /\.part$/i
const isPartial = (name: string): boolean => PART.test(name) && MODEL_EXT.test(name.replace(PART, ''))

async function walkFiles(dir: string, prefix: string, depth: number, out: { path: string; name: string }[]): Promise<void> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (depth < 4 && !e.name.startsWith('.')) await walkFiles(join(dir, e.name), `${prefix}${e.name}/`, depth + 1, out)
    } else if (MODEL_EXT.test(e.name) || isPartial(e.name)) out.push({ path: join(dir, e.name), name: prefix + e.name })
  }
}

async function driveSpace(p: string): Promise<{ free?: number; total?: number }> {
  let cur = resolve(p)
  for (let i = 0; i < 12 && !existsSync(cur); i++) cur = dirname(cur)
  try {
    const s = await statfs(cur)
    return { free: Number(s.bavail) * Number(s.bsize), total: Number(s.blocks) * Number(s.bsize) }
  } catch {
    return {}
  }
}

let last: ModelInventory | null = null
let running: Promise<ModelInventory> | null = null

async function scan(refresh: boolean): Promise<ModelInventory> {
  const locs = locations()
  const home = modelsHome()
  const library = await listLocal(refresh)
  const metaByPath = new Map<string, LocalModel>(library.map((m) => [m.path.toLowerCase(), m]))
  const models: ManagedModel[] = []
  const seen = new Set<string>()

  // Model files, every copy (the library shows one per ComfyUI name; the manager shows disk).
  for (const root of modelRoots()) {
    if (!existsSync(root.dir)) continue
    const found: { path: string; name: string }[] = []
    await walkFiles(root.dir, '', 0, found)
    for (const f of found) {
      const key = f.path.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      let size = 0
      try {
        size = (await stat(f.path)).size
      } catch {
        continue
      }
      const loc = locationOf(locs, f.path)
      const lib = metaByPath.get(key)
      const partial = isPartial(f.name)
      if (partial && isDownloading(f.path.replace(PART, ''))) continue
      models.push({
        path: f.path,
        locationId: loc?.id ?? 'other',
        folder: root.folder,
        name: f.name,
        kind: kindForFolder(root.folder),
        size,
        usedBy: partial ? [] : usesOf(root.folder, f.name),
        catalogId: catalogIdFor(root.folder, f.name.replace(PART, '')),
        meta: lib?.meta,
        ...(partial ? { partial: true } : {})
      })
    }
  }

  // Voice engine weights live in the voice engine's Hugging Face cache; the
  // Voice section manages them per engine (voice:engines / voice:removeEngine).
  const voiceBytes = existsSync(voiceModelsDir()) ? await dirSize(voiceModelsDir()) : 0

  const out: ModelLocation[] = []
  for (const l of locs) {
    const inLoc = models.filter((m) => m.locationId === l.id)
    const exists = existsSync(l.path)
    if (l.kind === 'voice' && !exists) continue
    // Keep empty bases only when they matter (the default target, or the user's own).
    if (!inLoc.length && !exists && l.kind !== 'app' && l.kind !== 'settings') continue
    if (!inLoc.length && l.kind === 'app' && home.path.toLowerCase() !== l.path.toLowerCase() && !exists) continue
    const space = await driveSpace(l.path)
    out.push({
      id: l.id,
      kind: l.kind,
      label: l.label,
      path: l.path,
      exists,
      isDefault: home.path.toLowerCase() === l.path.toLowerCase(),
      bytes: l.kind === 'voice' ? voiceBytes : inLoc.reduce((n, m) => n + m.size, 0),
      files: inLoc.length,
      free: space.free,
      total: space.total,
      removable: l.removable
    })
  }
  models.sort((a, b) => b.size - a.size)
  return { locations: out, models, scannedAt: Date.now() }
}

export function modelInventory(refresh = false): Promise<ModelInventory> {
  // Anything that changes files invalidates the library cache; follow it.
  if (!refresh && last && cachedLibrary() && Date.now() - last.scannedAt < 60_000) return Promise.resolve(last)
  if (!running) {
    running = scan(refresh)
      .then((inv) => {
        last = inv
        return inv
      })
      .finally(() => {
        running = null
      })
  }
  return running
}

export function invalidateInventory(): void {
  last = null
}

// ─── Delete (Recycle Bin only) ───────────────────────────────────────────────

async function toTrash(p: string): Promise<void> {
  try {
    await shell.trashItem(p)
  } catch (err) {
    // Never fall back to a permanent delete.
    throw new Error(`Couldn't move ${p} to the Recycle Bin (${err instanceof Error ? err.message : String(err)}). Nothing was deleted.`)
  }
}

/** Move a model file (plus its Stability Matrix / Civitai sidecars and previews) to the Recycle Bin. */
export async function trashModel(path: string): Promise<void> {
  const full = resolve(path)
  if (!existsSync(full)) throw new Error('That model is already gone.')
  if (statSync(full).isDirectory()) throw new Error('Stitch only deletes single model files here.')
  if (!(MODEL_EXT.test(full) || isPartial(full)) || !insideRoots(full)) throw new Error('Stitch only deletes model files inside your models folders.')
  if (isDownloading(full.replace(PART, ''))) throw new Error('That model is still downloading — cancel the download instead.')
  await toTrash(full)
  if (isPartial(full)) {
    invalidateInventory()
    return
  }
  const stem = stemOf(full)
  for (const p of SIDECARS.map((s) => stem + s)) if (existsSync(p)) await toTrash(p).catch((err) => console.warn('[models] sidecar', err))
  invalidateInventory()
}

/** Forget a folder added through "Choose folder". Files stay where they are. */
export function forgetDir(path: string): void {
  const p = resolve(path).toLowerCase()
  const extras = getSettings().extraModelDirs ?? []
  updateSettings({ extraModelDirs: extras.filter((d) => resolve(d).toLowerCase() !== p) })
  invalidateInventory()
}

/** extra_model_paths.yaml snippet for a ComfyUI the user runs themselves. */
export function comfyYamlSnippet(): string {
  const home = modelsHome().path.toLowerCase()
  const bases = modelBases()
    .filter((b) => b.kind !== 'comfyui' && (existsSync(b.dir) || b.dir.toLowerCase() === home) && !comfySearches(b.dir))
    .map((b) => b.dir)
  const head = [
    '# Stitch model folders — add to ComfyUI/extra_model_paths.yaml, then restart ComfyUI.',
    '# (Stability Matrix: Packages → ComfyUI → ⋮ → Open in Explorer.)'
  ]
  if (!bases.length) return `${head[0]}\n# Your ComfyUI already sees every folder Stitch uses — nothing to add.\n`
  return `${head.join('\n')}\n${comfyYamlFor(bases)}`
}

