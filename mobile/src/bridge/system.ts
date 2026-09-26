// sys:* channels on the phone: pickers open on the phone (files are uploaded to the PC), folders are
// browsed on the PC, and "open"/"show in folder" hand PC files to the phone's share sheet.
import { create } from 'zustand'
import { toast, useToasts } from '@/stores/toast'
import { invoke } from '@/lib/api'
import { openExternal, openPcFile, pickPhoneFiles, uploadToPc } from './files'
import { merge, override } from './router'

interface FolderRequest {
  title?: string
  defaultPath?: string
  resolve: (path: string | null) => void
}

/** The PC folder browser sheet (rendered by the mobile shell). */
export const useFolderPicker = create<{ req: FolderRequest | null }>(() => ({ req: null }))

function pickPcFolder(opts: { title?: string; defaultPath?: string }): Promise<string | null> {
  return new Promise((resolve) => useFolderPicker.setState({ req: { ...opts, resolve } }))
}

/** Upload progress shown as a toast-like pill by the shell. */
export const useUploads = create<{ active: { name: string; progress: number }[] }>(() => ({ active: [] }))

async function uploadAll(files: File[]): Promise<string[]> {
  const out: string[] = []
  for (const f of files) {
    useUploads.setState((s) => ({ active: [...s.active, { name: f.name, progress: 0 }] }))
    try {
      out.push(
        await uploadToPc(f, f.name, (p) =>
          useUploads.setState((s) => ({ active: s.active.map((a) => (a.name === f.name ? { ...a, progress: p } : a)) }))
        )
      )
    } catch (err) {
      toast.error(`Couldn't send ${f.name} to your PC`, err instanceof Error ? err.message : String(err))
    } finally {
      useUploads.setState((s) => ({ active: s.active.filter((a) => a.name !== f.name) }))
    }
  }
  return out
}

const FILE_LIKE = /\.[a-z0-9]{2,5}$/i
/** Paths the phone asked the PC to save into (exports) — offered to the share sheet once written. */
const savedOnPc = new Set<string>()

export function installSystem(): void {
  override('sys:pickFiles', async ([opts]) => {
    const files = await pickPhoneFiles((opts ?? {}) as Parameters<typeof pickPhoneFiles>[0])
    if (!files.length) return []
    return uploadAll(files)
  })

  override('sys:pickFolder', ([opts]) => pickPcFolder((opts ?? {}) as { title?: string; defaultPath?: string }))

  override('sys:saveDialog', async ([opts]) => {
    const o = (opts ?? {}) as { defaultPath?: string; filters?: { extensions: string[] }[] }
    let name = o.defaultPath?.split(/[\\/]/).pop() || 'export'
    const ext = o.filters?.[0]?.extensions?.[0]
    if (ext && !name.toLowerCase().endsWith(`.${ext.toLowerCase()}`)) name += `.${ext}`
    const path = await invoke('remote:savePath', name)
    savedOnPc.add(path)
    return path
  })

  merge('sys:writeText', (result, [path]) => {
    offerSaved(String(path))
    return result
  })

  override('sys:openPath', async ([path]) => {
    const p = String(path ?? '')
    if (FILE_LIKE.test(p)) await openPcFile(p).catch((err) => toast.error("Couldn't open that file", String(err?.message ?? err)))
    else toast.info('That folder is on your PC', p)
    return undefined
  })

  override('sys:showInFolder', async ([path]) => {
    const p = String(path ?? '')
    await openPcFile(p).catch((err) => toast.error("Couldn't open that file", String(err?.message ?? err)))
    return undefined
  })

  override('sys:openExternal', async ([url]) => {
    await openExternal(String(url))
    return undefined
  })
}

/** After the PC writes an export the phone asked for, offer it on the phone. */
function offerSaved(path: string): void {
  if (!savedOnPc.delete(path)) return
  const name = path.split(/[\\/]/).pop()
  useToasts.getState().push({
    title: 'Saved on your PC',
    body: `${name} is in Stitch/exports.`,
    tone: 'success',
    ms: 7000,
    action: { label: 'Share', run: () => void openPcFile(path).catch((err) => toast.error("Couldn't open that file", String(err?.message ?? err))) }
  })
}
