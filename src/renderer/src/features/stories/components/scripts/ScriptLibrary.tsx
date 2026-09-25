// "Add Script": the script library (built-in, imported, yours) with search,
// + New script, import from file / paste / link, and per-script actions.
import { useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Check, ClipboardPaste, Copy, Download, ExternalLink, FileUp, Link2, MoreHorizontal, Pencil, Plus, Trash2, Upload } from 'lucide-react'
import type { StoryScript } from '@shared/types'
import { Button, IconButton } from '@/components/ui/button'
import { SearchField } from '@/components/ui/input'
import { Badge, EmptyState } from '@/components/ui/misc'
import { Dialog, Menu, MenuItem, MenuSeparator } from '@/components/ui/overlay'
import { invoke } from '@/lib/api'
import { ease, springSoft } from '@/lib/motion'
import { db } from '@/stores/db'
import { toast } from '@/stores/toast'
import { saveFile } from '../../engine/io'
import { createScript } from '../../engine/scripts/api'
import { scriptToJson } from '../../engine/scripts/importer'
import { loadScript, useScripts } from '../../engine/scripts/library'
import { HookChips, KindBadge, ScriptGlyph } from './bits'
import { ImportScripts, type ImportMode } from './ImportScripts'
import { newScriptDraft } from '../../engine/scripts/templates'
import { ScriptEditor } from './ScriptEditor'

function ScriptCard({ s, added, onAdd, onEdit, onDelete }: { s: StoryScript; added: boolean; onAdd: () => void; onEdit: () => void; onDelete: () => void }): React.JSX.Element {
  const duplicate = async (): Promise<void> => {
    const full = await loadScript(s.id)
    if (!full) return
    await createScript({ ...full, id: undefined, name: `${full.name} (copy)`, source: 'user', createdAt: undefined })
    toast.success('Duplicated', 'The copy is under Your scripts.')
  }
  const exportIt = async (): Promise<void> => {
    const full = await loadScript(s.id)
    if (full) await saveFile(`${full.name || 'script'} (script)`, scriptToJson(full), 'json')
  }
  return (
    <motion.div layout initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.98 }} transition={springSoft} className="group flex gap-3 rounded-2xl border border-line bg-white/[0.03] p-3.5 transition-colors hover:border-line-strong">
      <ScriptGlyph name={s.name} className="size-10" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13.5px] font-semibold">{s.name}</span>
          <KindBadge script={s} />
          {s.license && <Badge tone="outline">{s.license}</Badge>}
        </div>
        <div className="text-[11.5px] text-fg-3">{s.author ? `by ${s.author}` : 'No author'}</div>
        {s.description && <p className="mt-1.5 line-clamp-2 text-[12px] leading-relaxed text-fg-2">{s.description}</p>}
        <HookChips script={s} className="mt-2.5" />
      </div>
      <div className="flex shrink-0 flex-col items-end gap-2">
        <Button size="sm" variant={added ? 'ghost' : 'primary'} disabled={added} icon={added ? <Check className="size-3.5" /> : <Plus className="size-3.5" />} onClick={onAdd}>
          {added ? 'Added' : 'Add'}
        </Button>
        <Menu
          align="end"
          trigger={
            <IconButton label="More" size="sm">
              <MoreHorizontal className="size-4" />
            </IconButton>
          }
        >
          <MenuItem icon={<Pencil />} onSelect={onEdit}>
            {s.source === 'builtin' ? 'View code' : 'Edit'}
          </MenuItem>
          <MenuItem icon={<Copy />} onSelect={() => void duplicate()}>
            Duplicate
          </MenuItem>
          <MenuItem icon={<Download />} onSelect={() => void exportIt()}>
            Export (.json)
          </MenuItem>
          {s.sourceUrl && (
            <MenuItem icon={<ExternalLink />} onSelect={() => void invoke('sys:openExternal', s.sourceUrl!)}>
              Open source page
            </MenuItem>
          )}
          {s.source !== 'builtin' && (
            <>
              <MenuSeparator />
              <MenuItem icon={<Trash2 />} danger onSelect={onDelete}>
                Delete…
              </MenuItem>
            </>
          )}
        </Menu>
      </div>
    </motion.div>
  )
}

/**
 * Pick a script to add to a run order. Also where scripts are created,
 * imported, edited, duplicated, exported and deleted.
 */
export function ScriptLibrary({ open, onClose, onPick, added, adventureId }: { open: boolean; onClose: () => void; onPick: (id: string) => void; added: string[]; adventureId?: string }): React.JSX.Element {
  const all = useScripts()
  const [q, setQ] = useState('')
  const [editor, setEditor] = useState<{ id?: string; draft?: Partial<StoryScript> & { name: string }; n: number } | null>(null)
  const [importing, setImporting] = useState<ImportMode | null>(null)
  const [deleting, setDeleting] = useState<StoryScript | null>(null)

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const hit = (s: StoryScript): boolean => !needle || [s.name, s.author, s.description].some((x) => x?.toLowerCase().includes(needle))
    const list = all.filter(hit)
    return [
      { title: 'Built-in', items: list.filter((s) => s.source === 'builtin') },
      { title: 'Imported', items: list.filter((s) => s.source === 'import') },
      { title: 'Your scripts', items: list.filter((s) => s.source === 'user') }
    ].filter((g) => g.items.length)
  }, [all, q])

  const pick = (id: string): void => {
    onPick(id)
    onClose()
  }

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(o) => !o && onClose()}
        title="Add a script"
        description="Scripts run in order on every turn. Anything written for AI Dungeon works here."
        width={720}
        className="h-[80vh]"
      >
        <div className="flex h-full flex-col">
          <div className="flex items-center gap-2 border-b border-line px-5 py-3">
            <SearchField value={q} onChange={setQ} placeholder="Search scripts" className="flex-1" />
            <Button variant="primary" icon={<Plus className="size-3.5" />} onClick={() => setEditor({ draft: newScriptDraft(), n: Date.now() })}>
              New script
            </Button>
            <Menu
              align="end"
              trigger={
                <Button icon={<Upload className="size-3.5" />} variant="secondary">
                  Import
                </Button>
              }
            >
              <MenuItem icon={<FileUp />} onSelect={() => setImporting('file')}>
                From file…
              </MenuItem>
              <MenuItem icon={<ClipboardPaste />} onSelect={() => setImporting('paste')}>
                Paste code…
              </MenuItem>
              <MenuItem icon={<Link2 />} onSelect={() => setImporting('url')}>
                From a link…
              </MenuItem>
            </Menu>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-4 pb-6">
            {groups.length === 0 ? (
              <EmptyState title="No scripts found" body={q ? 'Try another search.' : 'Write one, or import any AI Dungeon script.'} />
            ) : (
              <div className="flex flex-col gap-5">
                {groups.map((g) => (
                  <motion.section key={g.title} layout="position" transition={{ duration: 0.3, ease }} className="flex flex-col gap-2">
                    <div className="label-caps">
                      {g.title} <span className="text-fg-3">· {g.items.length}</span>
                    </div>
                    <AnimatePresence initial={false}>
                      {g.items.map((s) => (
                        <ScriptCard key={s.id} s={s} added={added.includes(s.id)} onAdd={() => pick(s.id)} onEdit={() => setEditor({ id: s.id, n: Date.now() })} onDelete={() => setDeleting(s)} />
                      ))}
                    </AnimatePresence>
                  </motion.section>
                ))}
              </div>
            )}
          </div>
        </div>
      </Dialog>

      <ScriptEditor
        key={editor?.n ?? 0}
        open={!!editor}
        onClose={() => setEditor(null)}
        scriptId={editor?.id}
        draft={editor?.draft}
        adventureId={adventureId}
        onCreated={(id) => {
          onPick(id)
          onClose()
        }}
      />
      <ImportScripts
        open={!!importing}
        mode={importing ?? 'file'}
        onClose={() => setImporting(null)}
        onImported={(ids) => {
          for (const id of ids) onPick(id)
          if (ids.length) onClose()
        }}
      />
      <Dialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete “${deleting?.name ?? ''}”?`}
        description="Scenarios and adventures that use it will show it as missing."
        width={420}
        footer={
          <>
            <Button variant="secondary" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              icon={<Trash2 className="size-3.5" />}
              onClick={() => {
                if (deleting) void db.remove('scripts', deleting.id)
                setDeleting(null)
              }}
            >
              Delete
            </Button>
          </>
        }
      >
        <div />
      </Dialog>
    </>
  )
}
