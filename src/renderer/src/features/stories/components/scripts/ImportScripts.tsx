// Import AI Dungeon scripts: from files (.js tabs or .json exports), pasted
// code, or a link (GitHub repository / raw file). Shows what was found first.
import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ClipboardPaste, FileUp, FolderGit2, Link2, PackageOpen } from 'lucide-react'
import { Button, Chip } from '@/components/ui/button'
import { Segmented } from '@/components/ui/controls'
import { Input, Textarea } from '@/components/ui/input'
import { Badge } from '@/components/ui/misc'
import { Dialog } from '@/components/ui/overlay'
import { errorText } from '@/lib/api'
import { ease } from '@/lib/motion'
import { toast } from '@/stores/toast'
import { createScript } from '../../engine/scripts/api'
import { pickScriptFiles, scriptFromPaste, scriptFromUrl, type ScriptDraft } from '../../engine/scripts/importer'
import { HOOK_LABEL } from '../../engine/scripts/runtime'
import { HOOKS } from '../../engine/scripts/types'

export type ImportMode = 'file' | 'paste' | 'url'
type Tab = 'library' | 'input' | 'context' | 'output'

const EXAMPLES = ['https://github.com/LewdLeah/Auto-Cards', 'https://github.com/LewdLeah/Inner-Self']

function DraftRow({ d, onName }: { d: ScriptDraft; onName: (n: string) => void }): React.JSX.Element {
  const tabs = (['library', ...HOOKS] as Tab[]).filter((t) => (d[t] ?? '').trim())
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-line bg-white/[0.03] p-3">
      <Input value={d.name} onChange={(e) => onName(e.target.value)} className="h-8 text-[13px] font-semibold" />
      <div className="flex flex-wrap items-center gap-1.5 text-[11.5px] text-fg-3">
        {d.author && <span>by {d.author}</span>}
        {d.license && <Badge tone="outline">{d.license}</Badge>}
        {tabs.map((t) => (
          <Badge key={t}>
            {HOOK_LABEL[t]} · {(d[t] ?? '').split('\n').length.toLocaleString()} lines
          </Badge>
        ))}
      </div>
      {d.description && <p className="line-clamp-2 text-[12px] text-fg-2">{d.description}</p>}
      {!HOOKS.some((h) => (d[h] ?? '').trim()) && <p className="text-[11.5px] text-warning">No Input, Context or Output code — add hook code after importing, or the library never runs.</p>}
    </div>
  )
}

export function ImportScripts({ open, mode: initialMode, onClose, onImported }: { open: boolean; mode: ImportMode; onClose: () => void; onImported: (ids: string[]) => void }): React.JSX.Element {
  const [mode, setMode] = useState<ImportMode>(initialMode)
  const [drafts, setDrafts] = useState<ScriptDraft[]>([])
  const [paste, setPaste] = useState('')
  const [pasteTab, setPasteTab] = useState<Tab>('library')
  const [pasteName, setPasteName] = useState('Pasted script')
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setMode(initialMode)
    setDrafts([])
    setPaste('')
    setUrl('')
  }, [open, initialMode])

  const fromFiles = async (): Promise<void> => {
    try {
      const found = await pickScriptFiles()
      if (found.length) setDrafts(found)
    } catch (err) {
      toast.error('Could not read those files', errorText(err))
    }
  }

  const fromUrl = async (): Promise<void> => {
    if (!url.trim()) return
    setBusy(true)
    try {
      setDrafts(await scriptFromUrl(url))
    } catch (err) {
      toast.error('Could not download that script', errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const commit = async (list: ScriptDraft[]): Promise<void> => {
    setBusy(true)
    try {
      const ids: string[] = []
      for (const d of list) ids.push((await createScript({ ...d, source: 'import' })).id)
      toast.success(`Imported ${ids.length} script${ids.length === 1 ? '' : 's'}`)
      onImported(ids)
      onClose()
    } catch (err) {
      toast.error('Import failed', errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const pasted = mode === 'paste' && paste.trim() ? scriptFromPaste(paste, pasteTab, pasteName.trim() || 'Pasted script') : []
  const ready = mode === 'paste' ? pasted : drafts

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Import scripts"
      description="Any AI Dungeon script works: its Library, Input, Context and Output code."
      width={620}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy && ready.length > 0}
            disabled={!ready.length}
            onClick={() => void commit(ready)}
          >
            Import{ready.length > 1 ? ` ${ready.length}` : ''}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 p-5">
        <Segmented
          caps
          className="self-start"
          value={mode}
          onChange={(m) => {
            setMode(m)
            setDrafts([])
          }}
          items={[
            { value: 'file', label: 'File', icon: <FileUp /> },
            { value: 'paste', label: 'Paste', icon: <ClipboardPaste /> },
            { value: 'url', label: 'Link', icon: <Link2 /> }
          ]}
        />
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={mode} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.22, ease }} className="flex flex-col gap-3">
            {mode === 'file' && (
              <>
                <p className="text-[12.5px] leading-relaxed text-fg-2">
                  Pick <span className="font-mono text-fg">library.js</span>, <span className="font-mono text-fg">input.js</span>, <span className="font-mono text-fg">context.js</span> and <span className="font-mono text-fg">output.js</span> together, or a <span className="font-mono text-fg">.json</span> script or scenario export.
                </p>
                <Button icon={<PackageOpen className="size-4" />} className="self-start" onClick={() => void fromFiles()}>
                  Choose files…
                </Button>
              </>
            )}
            {mode === 'paste' && (
              <>
                <div className="flex gap-2">
                  <Input value={pasteName} onChange={(e) => setPasteName(e.target.value)} placeholder="Script name" className="flex-1" />
                  <Segmented
                    size="sm"
                    value={pasteTab}
                    onChange={setPasteTab}
                    items={(['library', 'input', 'context', 'output'] as Tab[]).map((t) => ({ value: t, label: HOOK_LABEL[t] }))}
                  />
                </div>
                <Textarea value={paste} onChange={(e) => setPaste(e.target.value)} minRows={10} maxRows={18} spellCheck={false} placeholder={'Paste code for the tab picked above — or a whole JSON export, which is detected automatically.'} className="font-mono text-[11.5px]" />
              </>
            )}
            {mode === 'url' && (
              <>
                <div className="flex gap-2">
                  <Input value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void fromUrl()} placeholder="https://github.com/owner/repo or a raw .js / .json link" icon={<Link2 />} className="flex-1" />
                  <Button variant="secondary" loading={busy && !drafts.length} onClick={() => void fromUrl()} disabled={!url.trim()}>
                    Fetch
                  </Button>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {EXAMPLES.map((u) => (
                    <Chip key={u} icon={<FolderGit2 />} onClick={() => setUrl(u)}>
                      {u.replace('https://github.com/', '')}
                    </Chip>
                  ))}
                </div>
                <p className="text-[11.5px] leading-relaxed text-fg-3">GitHub repositories are read from library.js / input.js / context.js / output.js (in the root or src/). The code is downloaded once, now; it never updates on its own.</p>
              </>
            )}
          </motion.div>
        </AnimatePresence>
        <AnimatePresence initial={false}>
          {mode !== 'paste' && drafts.length > 0 && (
            <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.25, ease }} className="flex flex-col gap-2">
              <span className="label-caps">Found</span>
              {drafts.map((d, i) => (
                <DraftRow key={i} d={d} onName={(n) => setDrafts((all) => all.map((x, j) => (j === i ? { ...x, name: n } : x)))} />
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </Dialog>
  )
}
