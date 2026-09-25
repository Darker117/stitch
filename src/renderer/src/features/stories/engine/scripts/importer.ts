// Getting AI Dungeon scripts in and out: .js/.json files, pasted code, URLs
// (raw files and GitHub repositories laid out like LewdLeah's), AID's
// gameCode JSON, and Stitch's own script export.
import type { StoryScript } from '@shared/types'
import { invoke } from '@/lib/api'
import { HOOKS, type HookName } from './types'

export type ScriptDraft = Partial<StoryScript> & { name: string }
type Tab = 'library' | HookName

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** Which tab a file belongs to, from its name. */
export function tabForName(fileName: string): Tab | undefined {
  const n = fileName.toLowerCase().replace(/\.(js|txt|mjs|cjs)$/, '')
  if (/(^|[^a-z])(library|shared|sharedlibrary|lib)$/.test(n) || n.endsWith('library')) return 'library'
  if (/(on)?input$/.test(n)) return 'input'
  if (/(on)?(model)?context$/.test(n)) return 'context'
  if (/(on)?output$/.test(n)) return 'output'
  return undefined
}

function titleCase(s: string): string {
  return s.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/\b\w/g, (c) => c.toUpperCase())
}

/**
 * Script(s) described by parsed JSON: Stitch exports, AID gameCode objects
 * ({ sharedLibrary, onInput, onModelContext, onOutput }), AID scenario data
 * (gameCodeSharedLibrary…), or plain { library, input, context, output }.
 */
export function scriptsFromJson(data: unknown, fallbackName = 'Imported script'): ScriptDraft[] {
  if (Array.isArray(data)) return data.flatMap((d) => scriptsFromJson(d, fallbackName))
  if (!data || typeof data !== 'object') return []
  const o = data as Record<string, unknown>
  if (Array.isArray(o.scripts)) return (o.scripts as unknown[]).flatMap((d) => scriptsFromJson(d, fallbackName))
  if (o.script && typeof o.script === 'object') return scriptsFromJson(o.script, fallbackName)
  if (o.gameCode && typeof o.gameCode === 'object') return scriptsFromJson({ ...(o.gameCode as object), title: o.title ?? o.name }, fallbackName)
  for (const k of ['scenario', 'data']) {
    const inner = o[k]
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
      const found = scriptsFromJson(inner, fallbackName)
      if (found.length) return found
    }
  }
  const library = str(o.library) || str(o.sharedLibrary) || str(o.gameCodeSharedLibrary)
  const input = str(o.input) || str(o.onInput) || str(o.gameCodeOnInput)
  const context = str(o.context) || str(o.onModelContext) || str(o.gameCodeOnModelContext)
  const output = str(o.output) || str(o.onOutput) || str(o.gameCodeOnOutput)
  if (!library && !input && !context && !output) return []
  const name = str(o.name) || str(o.title) || fallbackName
  return [
    {
      name: name.trim() || fallbackName,
      author: str(o.author) || undefined,
      description: str(o.description) || undefined,
      license: str(o.license) || undefined,
      sourceUrl: str(o.sourceUrl) || undefined,
      library,
      input,
      context,
      output
    }
  ]
}

/** One script from several files (library.js, input.js, …) or a single JSON file. */
export function scriptFromFiles(files: { name: string; text: string }[], fallbackName: string): ScriptDraft[] {
  const drafts: ScriptDraft[] = []
  const code: Partial<Record<Tab, string>> = {}
  for (const f of files) {
    if (/\.json$/i.test(f.name)) {
      try {
        drafts.push(...scriptsFromJson(JSON.parse(f.text), fallbackName))
      } catch {
        throw new Error(`${f.name} is not valid JSON`)
      }
      continue
    }
    const tab = tabForName(f.name) ?? (code.library === undefined ? 'library' : undefined)
    if (!tab) throw new Error(`Can't tell which tab ${f.name} belongs to — name it library.js, input.js, context.js or output.js`)
    code[tab] = f.text
  }
  if (Object.keys(code).length) drafts.push({ name: fallbackName, library: code.library ?? '', input: code.input ?? '', context: code.context ?? '', output: code.output ?? '' })
  return drafts
}

/** Pasted text: JSON in any supported shape, or JavaScript for one tab. */
export function scriptFromPaste(text: string, tab: Tab, name: string): ScriptDraft[] {
  const t = text.trim()
  if (/^[[{]/.test(t)) {
    try {
      const found = scriptsFromJson(JSON.parse(t), name)
      if (found.length) return found
    } catch {
      /* not JSON — treat as code */
    }
  }
  const draft: ScriptDraft = { name, library: '', input: '', context: '', output: '' }
  draft[tab] = text
  return [draft]
}

// ─── Files ───────────────────────────────────────────────────────────────────

export async function pickScriptFiles(): Promise<ScriptDraft[]> {
  const paths = await invoke('sys:pickFiles', { filters: [{ name: 'Scripts', extensions: ['js', 'json', 'txt', 'mjs'] }], multi: true, title: 'Import scripts' })
  if (!paths.length) return []
  const files = await Promise.all(paths.map(async (p) => ({ name: p.split(/[\\/]/).pop() ?? p, text: await invoke('sys:readText', p) })))
  const base = files.length === 1 ? titleCase(files[0].name.replace(/\.[^.]+$/, '')) : titleCase(paths[0].split(/[\\/]/).slice(-2, -1)[0] ?? 'Imported script')
  return scriptFromFiles(files, base || 'Imported script')
}

// ─── URLs ────────────────────────────────────────────────────────────────────

async function get(url: string): Promise<string> {
  return (await invoke('scripts:fetch', url)).text
}

async function tryGet(url: string): Promise<string | undefined> {
  try {
    return await get(url)
  } catch {
    return undefined
  }
}

const RAW = 'https://raw.githubusercontent.com'

/** A GitHub repository laid out as library.js / input.js / context.js / output.js (in the root, src/ or scripts/). */
async function fromGithubRepo(owner: string, repo: string, branch?: string, dir?: string): Promise<ScriptDraft> {
  let info: { default_branch?: string; description?: string; license?: { spdx_id?: string } | null; html_url?: string } = {}
  try {
    info = JSON.parse(await get(`https://api.github.com/repos/${owner}/${repo}`))
  } catch {
    /* rate limited or private: fall back to guesses */
  }
  const branches = branch ? [branch] : [info.default_branch, 'main', 'master'].filter((b, i, a): b is string => !!b && a.indexOf(b) === i)
  const dirs = dir !== undefined ? [dir] : ['src', '', 'scripts', 'script']
  for (const b of branches) {
    for (const d of dirs) {
      const base = `${RAW}/${owner}/${repo}/${b}/${d ? `${d.replace(/\/$/, '')}/` : ''}`
      const library = await tryGet(`${base}library.js`)
      const hooks = await Promise.all(HOOKS.map((h) => tryGet(`${base}${h}.js`)))
      if (library === undefined && hooks.every((h) => h === undefined)) continue
      const spdx = info.license?.spdx_id
      return {
        name: repo.replace(/_+/g, ' '),
        author: owner,
        description: info.description ?? undefined,
        license: spdx && spdx !== 'NOASSERTION' ? spdx : undefined,
        sourceUrl: info.html_url ?? `https://github.com/${owner}/${repo}`,
        library: library ?? '',
        input: hooks[0] ?? '',
        context: hooks[1] ?? '',
        output: hooks[2] ?? ''
      }
    }
  }
  throw new Error('No library.js / input.js / context.js / output.js found in that repository')
}

/** Import from a link: a GitHub repository or file, or any raw .js/.json URL. */
export async function scriptFromUrl(raw: string): Promise<ScriptDraft[]> {
  const url = raw.trim()
  const gh = /^https?:\/\/github\.com\/([^/]+)\/([^/#?]+)(?:\/(tree|blob)\/([^/]+)(?:\/(.*))?)?\/?(?:[#?].*)?$/i.exec(url)
  if (gh) {
    const [, owner, repoRaw, kind, branch, path] = gh
    const repo = repoRaw.replace(/\.git$/, '')
    if (kind === 'blob' && path) return scriptFromUrl(`${RAW}/${owner}/${repo}/${branch}/${path}`)
    return [await fromGithubRepo(owner, repo, branch, kind === 'tree' ? (path ?? '') : undefined)]
  }
  const res = await invoke('scripts:fetch', url)
  const file = decodeURIComponent(new URL(res.url).pathname.split('/').pop() || 'script.js')
  const name = titleCase(file.replace(/\.[^.]+$/, '')) || 'Imported script'
  const json = /\.json$/i.test(file) || /json/.test(res.contentType ?? '') || /^\s*[[{]/.test(res.text)
  const drafts = json ? scriptFromFiles([{ name: file.endsWith('.json') ? file : `${file}.json`, text: res.text }], name) : scriptFromFiles([{ name: file, text: res.text }], name)
  return drafts.map((d) => ({ ...d, sourceUrl: d.sourceUrl ?? url }))
}

// ─── Export ──────────────────────────────────────────────────────────────────

/** Stitch's script file; also carries AID's gameCode names so other tools can read it. */
export function scriptToJson(s: StoryScript): string {
  const { id, name, author, description, license, sourceUrl, library, input, context, output } = s
  return JSON.stringify(
    { kind: 'stitch-script', version: 1, script: { id, name, author, description, license, sourceUrl, library, input, context, output }, gameCode: { sharedLibrary: library, onInput: input, onModelContext: context, onOutput: output } },
    null,
    2
  )
}
