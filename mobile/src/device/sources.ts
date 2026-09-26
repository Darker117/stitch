// Models from anywhere: paste a Hugging Face repo, a Civitai page or a direct file link, or import files
// already on the phone. Each becomes a custom catalog entry the normal download/run paths understand.
import { CapacitorHttp } from '@capacitor/core'
import { nanoid } from 'nanoid'
import type { CatalogModel } from './catalog'
import { StitchDevice, type DeviceBackend, type DeviceFile, type DeviceFormat, type DeviceTask } from './plugin'
import { addCustomModel, refreshStatus, useDevice } from './store'

/** One way to add what a link points at (e.g. a quantization of a GGUF repo, or a Civitai version). */
export interface LinkOption {
  key: string
  label: string
  /** Quant / base model / precision, shown as chips. */
  tags: string[]
  sizeBytes?: number
  model: CatalogModel
}

export interface LinkResult {
  title: string
  source: CatalogModel['source']
  options: LinkOption[]
  /** Why nothing usable was found. */
  note?: string
}

const TEXT_EXT = /\.(gguf|litertlm)$/i
const IMAGE_EXT = /\.(safetensors|ckpt|gguf)$/i

async function getJson<T>(url: string, headers?: Record<string, string>): Promise<T> {
  const res = await CapacitorHttp.get({ url, headers: { Accept: 'application/json', ...headers } })
  if (res.status === 401 || res.status === 403) throw new Error("Couldn't open that — check the name. If it's private or gated, accept its license on the site and add a Hugging Face token in This phone.")
  if (res.status === 404) throw new Error("That page doesn't exist.")
  if (res.status >= 400) throw new Error(`The site answered ${res.status}.`)
  return (typeof res.data === 'string' ? JSON.parse(res.data) : res.data) as T
}

function variantOf(name: string): CatalogModel['variant'] | undefined {
  if (/abliterat/i.test(name)) return 'abliterated'
  if (/uncensor|unfilter|nsfw|unaligned|heretic/i.test(name)) return 'uncensored'
  return undefined
}

function quantOf(name: string): string | undefined {
  return /(?:^|[-_.])((?:IQ|Q)\d(?:_[A-Z0-9]+)*|BF16|F16|F32|FP16|FP8|INT4|INT8)(?=[-_.]|$)/i.exec(name)?.[1]?.toUpperCase()
}

function prettyName(s: string): string {
  return s
    .replace(/\.(gguf|litertlm|safetensors|ckpt)$/i, '')
    .replace(/-(\d{5})-of-(\d{5})$/i, '')
    .replace(/[-_]+/g, ' ')
    .trim()
}

/** Backends a runtime can use (llama.cpp / stable-diffusion.cpp report their own). */
function backendsFor(format: DeviceFormat, task: DeviceTask): DeviceBackend[] {
  const rt = useDevice.getState().info?.runtimes?.[format]
  if (rt?.length) return rt.map((b) => b.id)
  return format === 'litertlm' ? ['gpu', 'cpu'] : task === 'image' ? ['gpu', 'cpu'] : ['cpu']
}

/** Sensible sampler defaults for an unknown checkpoint, guessed from its name / base model. */
function imageDefaults(name: string, base = ''): Pick<CatalogModel, 'resolution' | 'steps' | 'guidance' | 'scheduler'> {
  const s = `${name} ${base}`
  const xl = /\bxl\b|sdxl|pony|illustrious|noob/i.test(s)
  const fast = /turbo|lcm|lightning|hyper|schnell|dmd/i.test(s)
  return { resolution: xl ? 1024 : 512, steps: fast ? 6 : 24, guidance: fast ? 1.5 : 6.5, scheduler: fast ? 'lcm' : 'euler-a' }
}

function customModel(task: DeviceTask, format: DeviceFormat, name: string, files: DeviceFile[], extra: Partial<CatalogModel> = {}): CatalogModel {
  const entry = files[0]?.path
  const size = files.reduce((n, f) => n + (f.size ?? 0), 0)
  return {
    id: `custom-${nanoid(10)}`,
    task,
    format,
    name,
    family: format === 'gguf' ? 'GGUF' : format === 'litertlm' ? 'LiteRT-LM' : format === 'sd-cpp' ? 'Checkpoint' : 'Custom',
    description: 'Added by you.',
    sizeBytes: size,
    backends: backendsFor(format, task),
    files,
    entry,
    license: 'unknown',
    homepage: '',
    custom: true,
    variant: variantOf(name),
    tags: [quantOf(entry ?? name)?.toLowerCase()].filter((x): x is string => !!x),
    ...(task === 'image' ? imageDefaults(name) : { contextLength: 4096 }),
    ...extra
  }
}

// ─── Hugging Face ────────────────────────────────────────────────────────────

interface HfFile {
  type: 'file' | 'directory'
  path: string
  size: number
  lfs?: { size: number }
}

function parseHf(url: string): { repo: string; rev?: string; path?: string } | null {
  const bare = /^([\w.-]+)\/([\w.-]+)$/.exec(url.trim())
  if (bare) return { repo: `${bare[1]}/${bare[2]}` }
  let u: URL
  try {
    u = new URL(url.trim())
  } catch {
    return null
  }
  if (!/(^|\.)huggingface\.co$|(^|\.)hf\.co$/.test(u.hostname)) return null
  const parts = u.pathname.split('/').filter(Boolean)
  if (parts[0] === 'models') parts.shift()
  if (parts.length < 2) return null
  const repo = `${parts[0]}/${parts[1]}`
  if ((parts[2] === 'blob' || parts[2] === 'resolve' || parts[2] === 'tree') && parts[3]) return { repo, rev: parts[3], path: decodeURIComponent(parts.slice(4).join('/')) || undefined }
  return { repo }
}

async function fromHuggingFace(ref: { repo: string; rev?: string; path?: string }, task: DeviceTask): Promise<LinkResult> {
  const token = useDevice.getState().prefs.hfToken
  const auth = token ? { Authorization: `Bearer ${token}` } : undefined
  const info = await getJson<{ sha?: string; gated?: boolean | string; cardData?: { license?: string } }>(`https://huggingface.co/api/models/${ref.repo}`, auth)
  const rev = info.sha ?? ref.rev ?? 'main'
  const tree = await getJson<HfFile[]>(`https://huggingface.co/api/models/${ref.repo}/tree/${encodeURIComponent(rev)}?recursive=true`, auth)
  const files = tree.filter((f) => f.type === 'file').map((f) => ({ path: f.path, size: f.lfs?.size ?? f.size }))
  const url = (path: string): string => `https://huggingface.co/${ref.repo}/resolve/${rev}/${path.split('/').map(encodeURIComponent).join('/')}`
  const base: Partial<CatalogModel> = {
    source: 'huggingface',
    homepage: `https://huggingface.co/${ref.repo}`,
    license: info.cardData?.license ?? 'see model card',
    gated: !!info.gated,
    description: `From huggingface.co/${ref.repo}.`
  }
  const repoName = ref.repo.split('/')[1]
  const options: LinkOption[] = []

  if (task === 'text') {
    // GGUF: one option per quant; split files (…-00001-of-00003.gguf) stay together, first part first.
    const groups = new Map<string, { path: string; size: number }[]>()
    for (const f of files) {
      if (!/\.gguf$/i.test(f.path) || /mmproj|imatrix/i.test(f.path)) continue
      if (ref.path && !f.path.startsWith(ref.path.replace(/-(\d{5})-of-(\d{5})\.gguf$/i, ''))) continue
      const key = f.path.replace(/-(\d{5})-of-(\d{5})\.gguf$/i, '')
      groups.set(key, [...(groups.get(key) ?? []), f].sort((a, b) => a.path.localeCompare(b.path)))
    }
    for (const [key, parts] of groups) {
      const q = quantOf(key)
      const dfiles = parts.map((p) => ({ url: url(p.path), path: p.path.split('/').pop()!, size: p.size }))
      options.push({
        key,
        label: q ?? prettyName(key.split('/').pop()!),
        tags: [q, parts.length > 1 ? `${parts.length} parts` : ''].filter(Boolean) as string[],
        sizeBytes: dfiles.reduce((n, f) => n + f.size, 0),
        model: customModel('text', 'gguf', `${prettyName(repoName)}${q ? ` ${q}` : ''}`, dfiles, base)
      })
    }
    for (const f of files.filter((x) => /\.litertlm$/i.test(x.path))) {
      const name = f.path.split('/').pop()!
      options.push({ key: f.path, label: prettyName(name), tags: ['LiteRT-LM'], sizeBytes: f.size, model: customModel('text', 'litertlm', prettyName(name), [{ url: url(f.path), path: name, size: f.size }], base) })
    }
  } else if (task === 'image') {
    // ONNX Stable Diffusion exports in the layout our NPU/GPU pipeline reads.
    const has = (p: string): boolean => files.some((f) => f.path === p)
    if (has('unet/model.onnx') && has('text_encoder/model.onnx') && has('vae_decoder/model.onnx') && has('tokenizer/vocab.json') && has('tokenizer/merges.txt')) {
      const keep = files.filter((f) => /^(unet|text_encoder|vae_decoder)\//.test(f.path) || f.path === 'tokenizer/vocab.json' || f.path === 'tokenizer/merges.txt')
      const dfiles = keep.map((f) => ({ url: url(f.path), path: f.path, size: f.size }))
      options.push({ key: 'onnx', label: 'ONNX (NPU · GPU · CPU)', tags: ['ONNX'], sizeBytes: dfiles.reduce((n, f) => n + f.size, 0), model: customModel('image', 'sd-onnx', prettyName(repoName), dfiles, { ...base, backends: ['npu', 'gpu', 'cpu'], ...imageDefaults(repoName), entry: undefined }) })
    }
    // Single-file checkpoints for stable-diffusion.cpp (diffusers sub-folders are skipped).
    for (const f of files.filter((x) => IMAGE_EXT.test(x.path) && !x.path.includes('/') && x.size > 200 * 1024 ** 2 && !/vae|lora|text_encoder|clip|t5/i.test(x.path))) {
      if (ref.path && f.path !== ref.path) continue
      const name = f.path.split('/').pop()!
      const q = quantOf(name)
      options.push({ key: f.path, label: prettyName(name), tags: [q, name.split('.').pop()!.toUpperCase()].filter(Boolean) as string[], sizeBytes: f.size, model: customModel('image', 'sd-cpp', prettyName(name), [{ url: url(f.path), path: name, size: f.size }], { ...base, ...imageDefaults(`${repoName} ${name}`) }) })
    }
  }
  options.sort((a, b) => (a.sizeBytes ?? 0) - (b.sizeBytes ?? 0))
  return {
    title: ref.repo,
    source: 'huggingface',
    options,
    note: options.length ? undefined : task === 'text' ? 'No .gguf or .litertlm files in that repo.' : 'No single-file checkpoints (.safetensors / .ckpt / .gguf) or ONNX export in that repo.'
  }
}

// ─── Civitai ─────────────────────────────────────────────────────────────────

interface CivitaiVersion {
  id: number
  name: string
  baseModel?: string
  files: { name: string; sizeKB: number; type: string; primary?: boolean; downloadUrl: string; metadata?: { format?: string; fp?: string; size?: string } }[]
}

async function fromCivitai(url: URL): Promise<LinkResult> {
  const id = /\/models\/(\d+)/.exec(url.pathname)?.[1]
  if (!id) throw new Error('Paste a Civitai model page link (civitai.com/models/…).')
  const want = url.searchParams.get('modelVersionId')
  const m = await getJson<{ name: string; type: string; nsfw?: boolean; modelVersions: CivitaiVersion[] }>(`https://civitai.com/api/v1/models/${id}`)
  if (m.type !== 'Checkpoint') return { title: m.name, source: 'civitai', options: [], note: `That's a ${m.type}, not a checkpoint. Phone image models need a full checkpoint.` }
  const options: LinkOption[] = []
  for (const v of m.modelVersions) {
    if (want && String(v.id) !== want) continue
    // Single-file checkpoints only (zipped diffusers folders and pickles are skipped).
    const file = v.files.filter((f) => f.type === 'Model' && f.metadata?.format !== 'PickleTensor' && IMAGE_EXT.test(f.name)).sort((a, b) => a.sizeKB - b.sizeKB)[0]
    if (!file) continue
    const size = Math.round(file.sizeKB * 1024)
    const ext = file.name.split('.').pop() ?? 'safetensors'
    const path = `model.${ext}`
    options.push({
      key: String(v.id),
      label: v.name,
      tags: [v.baseModel ?? '', /inpaint/i.test(v.name) ? 'inpainting' : '', file.metadata?.fp ?? '', file.metadata?.size ?? ''].filter(Boolean),
      sizeBytes: size,
      // Civitai reports sizes in rounded KB: no exact byte count, so the download isn't held to one (the size shown is approximate).
      model: customModel('image', 'sd-cpp', `${m.name} ${v.name}`.trim(), [{ url: file.downloadUrl, path }], {
        sizeBytes: size,
        source: 'civitai',
        homepage: `https://civitai.com/models/${id}?modelVersionId=${v.id}`,
        license: 'see Civitai page',
        description: `From Civitai${v.baseModel ? ` · ${v.baseModel}` : ''}.`,
        family: v.baseModel ?? 'Checkpoint',
        variant: m.nsfw ? 'uncensored' : variantOf(m.name),
        ...imageDefaults(`${m.name} ${v.name}`, v.baseModel)
      })
    })
  }
  return { title: m.name, source: 'civitai', options, note: options.length ? undefined : 'No downloadable checkpoint files on that page.' }
}

// ─── Any link ────────────────────────────────────────────────────────────────

/** Work out what a pasted link (or `owner/repo`) offers for a task. */
export async function resolveLink(input: string, task: DeviceTask): Promise<LinkResult> {
  const text = input.trim()
  if (!text) throw new Error('Paste a link first.')
  if (task === 'voice') throw new Error('Voices come from the built-in list for now — custom voice files need extra data the phone builds itself.')
  const hf = parseHf(text)
  if (hf) return fromHuggingFace(hf, task)
  let u: URL
  try {
    u = new URL(text)
  } catch {
    throw new Error("That doesn't look like a link. Paste a https:// address or a Hugging Face owner/repo.")
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Only web links (https://…) can be downloaded.')
  if (/(^|\.)civitai\.com$/.test(u.hostname)) {
    if (task !== 'image') throw new Error('Civitai hosts image models — switch to Image.')
    return fromCivitai(u)
  }
  // A direct file link.
  const name = decodeURIComponent(u.pathname.split('/').pop() ?? '') || 'model'
  const ok = task === 'text' ? TEXT_EXT.test(name) : IMAGE_EXT.test(name)
  if (!ok) throw new Error(task === 'text' ? 'Direct links need to end in .gguf or .litertlm.' : 'Direct links need to end in .safetensors, .ckpt or .gguf.')
  let size: number | undefined
  try {
    const head = await CapacitorHttp.request({ method: 'HEAD', url: u.toString() })
    const len = Number(head.headers['Content-Length'] ?? head.headers['content-length'])
    if (Number.isFinite(len) && len > 0) size = len
  } catch {
    /* size unknown — the download still works */
  }
  const format: DeviceFormat = task === 'text' ? (/\.litertlm$/i.test(name) ? 'litertlm' : 'gguf') : 'sd-cpp'
  const model = customModel(task, format, prettyName(name), [{ url: u.toString(), path: name, size }], { source: 'url', homepage: `${u.protocol}//${u.host}`, description: `From ${u.host}.`, ...(task === 'image' ? imageDefaults(name) : {}) })
  return { title: name, source: 'url', options: [{ key: name, label: prettyName(name), tags: [quantOf(name) ?? '', u.host].filter(Boolean), sizeBytes: size, model }] }
}

// ─── Import from the phone ───────────────────────────────────────────────────

/** Pick model files on the phone and copy them into Stitch's model folder. */
export async function importFromPhone(task: DeviceTask): Promise<CatalogModel | null> {
  if (task === 'voice') throw new Error('Importing voices isn’t supported yet — pick one from the list.')
  const id = `import-${nanoid(10)}`
  let picked: { path: string; name: string; size: number }[]
  try {
    picked = (await StitchDevice.importFiles({ id, multiple: true, mimeTypes: ['*/*'] })).files
  } catch (err) {
    if ((err as { code?: string }).code === 'CANCELED' || /cancel/i.test(String(err))) return null
    throw err
  }
  const bad = async (msg: string): Promise<never> => {
    await StitchDevice.deleteModel({ id }).catch(() => {})
    await refreshStatus()
    throw new Error(msg)
  }
  let format: DeviceFormat
  let entry: { path: string; name: string; size: number } | undefined
  if (task === 'text') {
    entry = picked.filter((f) => /\.gguf$/i.test(f.name) && !/mmproj/i.test(f.name)).sort((a, b) => a.name.localeCompare(b.name))[0]
    format = 'gguf'
    if (!entry) {
      entry = picked.find((f) => /\.litertlm$/i.test(f.name))
      format = 'litertlm'
    }
    if (!entry) return bad('Pick a .gguf or .litertlm file.')
  } else {
    entry = picked.filter((f) => IMAGE_EXT.test(f.name) && !/vae|lora/i.test(f.name)).sort((a, b) => b.size - a.size)[0]
    format = 'sd-cpp'
    if (!entry) return bad('Pick a checkpoint (.safetensors, .ckpt or .gguf).')
  }
  const vae = task === 'image' ? picked.find((f) => /vae/i.test(f.name) && IMAGE_EXT.test(f.name)) : undefined
  const files = [entry, ...picked.filter((f) => f !== entry)].map((f) => ({ url: '', path: f.path, size: f.size }))
  const m = customModel(task, format, prettyName(entry.name), files, {
    id,
    source: 'import',
    description: 'Imported from this phone.',
    entry: entry.path,
    ...(vae ? { config: { vae: vae.path } } : {}),
    ...(task === 'image' ? imageDefaults(entry.name) : {})
  })
  await addCustomModel(m)
  return m
}
