// Full-size script editor: Library / Input / Context / Output tabs with a
// code editor, name/author/description, Save, and a Test console that runs
// the unsaved code in the sandbox.
import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { BookOpen, Braces, CircleAlert, Copy, Download, ExternalLink, FlaskConical, Lock, WandSparkles } from 'lucide-react'
import type { StoryScript } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Input, Textarea } from '@/components/ui/input'
import { Badge, Spinner } from '@/components/ui/misc'
import { Dialog, Select } from '@/components/ui/overlay'
import { invoke } from '@/lib/api'
import { cn } from '@/lib/utils'
import { ease, spring } from '@/lib/motion'
import { db } from '@/stores/db'
import { toast } from '@/stores/toast'
import { saveFile } from '../../engine/io'
import { createScript } from '../../engine/scripts/api'
import { builtin } from '../../engine/scripts/builtin'
import { scriptToJson } from '../../engine/scripts/importer'
import { loadScript, scriptMeta } from '../../engine/scripts/library'
import { HOOK_LABEL } from '../../engine/scripts/runtime'
import { runSandboxed } from '../../engine/scripts/sandbox'
import { sampleAdventure } from '../../engine/scripts/test'
import { HOOK_TEMPLATE, newScriptDraft } from '../../engine/scripts/templates'
import { envFor } from '../../engine/scripts/runtime'
import type { HookName } from '../../engine/scripts/types'
import { KindBadge } from './bits'
import { CodeEditor } from './CodeEditor'
import { TestConsole } from './TestConsole'

type Tab = 'library' | HookName
const TABS: Tab[] = ['library', 'input', 'context', 'output']

const TAB_HELP: Record<Tab, string> = {
  library: 'Shared code. It is prepended to the Input, Context and Output code every time one of them runs.',
  input: "Runs on the player's action before it is added. Return { text }, or { text, stop: true } to cancel the turn.",
  context: 'Runs on the full context right before the model is called. Whatever text you return is what the model sees.',
  output: "Runs on the model's reply before it is shown and saved. Return the text to keep."
}

type Fields = Pick<StoryScript, 'name' | 'author' | 'description' | 'library' | 'input' | 'context' | 'output'>

function fieldsOf(s: Partial<StoryScript>): Fields {
  return { name: s.name ?? '', author: s.author ?? '', description: s.description ?? '', library: s.library ?? '', input: s.input ?? '', context: s.context ?? '', output: s.output ?? '' }
}

const same = (a: Fields, b: Fields): boolean => (Object.keys(a) as (keyof Fields)[]).every((k) => (a[k] ?? '') === (b[k] ?? ''))

/** Syntax check of each tab (compile only). */
async function syntaxProblems(f: Fields): Promise<string[]> {
  const adv = sampleAdventure()
  const env = envFor(adv, adv.actions, '')
  const out: string[] = []
  if (f.library.trim()) {
    const r = await runSandboxed(f.library, env, { compileOnly: true })
    if (!r.ok) return [`Library: ${r.error}`]
  }
  for (const h of ['input', 'context', 'output'] as HookName[]) {
    if (!f[h].trim()) continue
    const r = await runSandboxed(`${f.library}\n${f[h]}`, env, { compileOnly: true })
    if (!r.ok) out.push(`${HOOK_LABEL[h]}: ${r.error}`)
  }
  return out
}

export function ScriptEditor({
  open,
  onClose,
  scriptId,
  draft,
  switchable,
  onCreated,
  onDuplicated,
  adventureId
}: {
  open: boolean
  onClose: () => void
  /** Script to open. Leave empty and pass `draft` to write a new one. */
  scriptId?: string
  draft?: Partial<StoryScript> & { name: string }
  /** Other script ids to switch between (e.g. the scenario's run order). */
  switchable?: string[]
  /** A new script was saved for the first time. */
  onCreated?: (id: string) => void
  /** A built-in was copied so it can be edited. */
  onDuplicated?: (fromId: string, toId: string) => void
  /** Adventure the Test console starts with. */
  adventureId?: string
}): React.JSX.Element {
  const [currentId, setCurrentId] = useState<string | undefined>(scriptId)
  const [base, setBase] = useState<StoryScript | null>(null)
  const [fields, setFields] = useState<Fields>(fieldsOf(draft ?? {}))
  const [loading, setLoading] = useState(false)
  const [nonce, setNonce] = useState(0)
  const [tab, setTab] = useState<Tab>('input')
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [problems, setProblems] = useState<string[]>([])
  const [confirmClose, setConfirmClose] = useState(false)

  useEffect(() => {
    if (open) setCurrentId(scriptId)
  }, [open, scriptId])

  // (Re)load whenever the dialog opens or another script is picked.
  useEffect(() => {
    if (!open) return
    setConfirmClose(false)
    setProblems([])
    if (!currentId) {
      setBase(null)
      setFields(fieldsOf(draft ?? newScriptDraft()))
      setTab('input')
      setNonce((n) => n + 1)
      return
    }
    let alive = true
    setLoading(true)
    void loadScript(currentId).then((s) => {
      if (!alive) return
      setLoading(false)
      setBase(s ?? null)
      const f = fieldsOf(s ?? {})
      setFields(f)
      setTab(f.input.trim() ? 'input' : f.library.trim() ? 'library' : 'input')
      setNonce((n) => n + 1)
    })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, currentId])

  const readOnly = base?.source === 'builtin'
  const dirty = !readOnly && (base ? !same(fields, fieldsOf(base)) : true)
  const meta = builtin(currentId ?? '')
  const testScript: StoryScript = useMemo(() => ({ id: currentId ?? 'draft', source: base?.source ?? 'user', createdAt: 0, updatedAt: 0, ...fields, name: fields.name || 'Untitled script' }), [fields, currentId, base?.source])

  const set = <K extends keyof Fields>(k: K, v: Fields[K]): void => setFields((f) => ({ ...f, [k]: v }))

  const save = async (): Promise<void> => {
    if (readOnly) return
    setSaving(true)
    try {
      const name = fields.name.trim() || 'Untitled script'
      const clean = { ...fields, name, author: fields.author?.trim() || undefined, description: fields.description?.trim() || undefined }
      if (base) {
        const next: StoryScript = { ...base, ...clean, updatedAt: Date.now() }
        await db.put('scripts', next)
        setBase(next)
      } else {
        const created = await createScript(clean)
        setBase(created)
        setCurrentId(created.id)
        onCreated?.(created.id)
      }
      setFields((f) => ({ ...f, name }))
      const found = await syntaxProblems(clean)
      setProblems(found)
      if (found.length) toast.error('Saved, but the code has a syntax error', found[0])
      else toast.success('Script saved')
    } finally {
      setSaving(false)
    }
  }

  const duplicate = async (): Promise<void> => {
    if (!base) return
    const copy = await createScript({ ...base, id: undefined, name: `${base.name} (copy)`, source: 'user', createdAt: undefined })
    onDuplicated?.(base.id, copy.id)
    setCurrentId(copy.id)
    toast.success('Copied to your scripts', 'Edit the copy freely.')
  }

  const requestClose = (): void => {
    if (dirty && !confirmClose) setConfirmClose(true)
    else onClose()
  }

  const title = base ? (readOnly ? 'View script' : 'Edit script') : 'New script'
  const others = (switchable ?? []).filter((id) => id !== currentId)

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && requestClose()}
      title={
        <span className="flex items-center gap-2">
          <Braces className="size-4 text-accent" />
          {title}
          {base && <KindBadge script={base} />}
        </span>
      }
      description={base?.source === 'builtin' ? `${base.name} ships with Stitch — duplicate it to make changes.` : 'AI Dungeon-compatible: Library code runs before each hook.'}
      width={1240}
      className="h-[86vh]"
      headerAction={
        <div className="flex items-center gap-2">
          {others.length > 0 && (
            <div className="w-[210px]">
              <Select
                size="sm"
                value={currentId ?? ''}
                onChange={(id) => {
                  if (dirty) {
                    toast.info('Save or discard your changes first')
                    return
                  }
                  setCurrentId(id)
                }}
                options={(switchable ?? []).map((id) => ({ value: id, label: scriptMeta(id)?.name ?? 'Missing script' }))}
              />
            </div>
          )}
          <Button size="sm" variant={testing ? 'secondary' : 'glass'} icon={<FlaskConical className="size-3.5" />} onClick={() => setTesting((t) => !t)}>
            {testing ? 'Hide test' : 'Test'}
          </Button>
        </div>
      }
      footer={
        <div className="flex w-full items-center gap-2">
          <AnimatePresence mode="wait" initial={false}>
            {confirmClose ? (
              <motion.div key="confirm" initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} className="flex items-center gap-2 text-[12.5px] text-warning">
                <CircleAlert className="size-4" /> You have unsaved changes.
                <Button size="sm" variant="ghost" onClick={onClose}>
                  Discard
                </Button>
              </motion.div>
            ) : problems.length ? (
              <motion.div key="problems" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex min-w-0 items-center gap-2 text-[12px] text-danger">
                <CircleAlert className="size-4 shrink-0" /> <span className="truncate">{problems[0]}</span>
              </motion.div>
            ) : (
              <motion.span key="status" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="text-[12px] text-fg-3">
                {readOnly ? 'Read-only' : dirty ? 'Unsaved changes' : base ? 'Saved · changes apply everywhere this script is used' : ''}
              </motion.span>
            )}
          </AnimatePresence>
          <div className="flex-1" />
          {base && (
            <Button variant="ghost" icon={<Download className="size-3.5" />} onClick={() => void saveFile(`${base.name || 'script'} (script)`, scriptToJson({ ...base, ...fields }), 'json')}>
              Export
            </Button>
          )}
          {readOnly ? (
            <Button variant="primary" icon={<Copy className="size-3.5" />} onClick={() => void duplicate()}>
              Duplicate to edit
            </Button>
          ) : (
            <>
              <Button variant="secondary" onClick={requestClose}>
                Close
              </Button>
              <Button variant="primary" className="min-w-[90px]" loading={saving} disabled={!dirty && !!base} onClick={() => void save()}>
                Save
              </Button>
            </>
          )}
        </div>
      }
    >
      <div className="flex h-full min-h-0">
        {/* Sidebar: details + tabs */}
        <div className="flex w-[260px] shrink-0 flex-col gap-4 overflow-y-auto border-r border-line p-4">
          <label className="flex flex-col gap-1.5">
            <span className="label-caps">Name</span>
            <Input value={fields.name} onChange={(e) => set('name', e.target.value)} placeholder="Script name" disabled={readOnly} />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="label-caps">Author</span>
            <Input value={fields.author ?? ''} onChange={(e) => set('author', e.target.value)} placeholder="Who wrote it" disabled={readOnly} />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="label-caps">Description</span>
            <Textarea value={fields.description ?? ''} onChange={(e) => set('description', e.target.value)} minRows={3} maxRows={8} placeholder="What does it do? How do players use it?" disabled={readOnly} className="text-[12px]" />
          </label>
          <div className="flex flex-col gap-1">
            <span className="label-caps mb-1">Code</span>
            {TABS.map((t) => {
              const has = fields[t].trim().length > 0
              const lines = has ? fields[t].split('\n').length : 0
              return (
                <button key={t} onClick={() => setTab(t)} className={cn('relative flex h-9 items-center gap-2.5 rounded-[10px] px-3 text-left text-[13px] font-medium transition-colors', tab === t ? 'text-fg' : 'text-fg-2 hover:bg-white/[0.04] hover:text-fg')}>
                  {tab === t && <motion.span layoutId="script-tab" className="absolute inset-0 rounded-[10px] border border-line-strong bg-white/[0.08]" transition={spring} />}
                  <span className={cn('relative size-1.5 rounded-full', has ? 'bg-accent' : 'bg-white/15')} />
                  <span className="relative flex-1">{HOOK_LABEL[t]}</span>
                  <span className="relative font-mono text-[10.5px] text-fg-3 tabular-nums">{has ? lines.toLocaleString() : '—'}</span>
                </button>
              )
            })}
          </div>
          {(base?.license || base?.sourceUrl) && (
            <div className="mt-auto flex flex-col gap-2 rounded-xl border border-line bg-white/[0.02] p-3 text-[11.5px] text-fg-2">
              {base.license && (
                <div className="flex items-center gap-2">
                  <span className="label-caps">License</span>
                  <Badge tone="outline">{base.license}</Badge>
                </div>
              )}
              {meta?.licenseText && <pre className="max-h-[120px] overflow-auto font-mono text-[10px] leading-snug whitespace-pre-wrap text-fg-3">{meta.licenseText}</pre>}
              {base.sourceUrl && (
                <button className="flex items-center gap-1.5 text-left text-fg-2 hover:text-fg" onClick={() => void invoke('sys:openExternal', base.sourceUrl!)}>
                  <ExternalLink className="size-3.5 shrink-0" /> <span className="truncate">{base.sourceUrl.replace(/^https?:\/\//, '')}</span>
                </button>
              )}
            </div>
          )}
        </div>

        {/* Editor */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-3 border-b border-line px-4 py-2.5">
            <BookOpen className="size-4 shrink-0 text-fg-3" />
            <p className="min-w-0 flex-1 text-[12px] leading-snug text-fg-2">{TAB_HELP[tab]}</p>
            {readOnly && (
              <Badge>
                <Lock className="size-3" /> Read-only
              </Badge>
            )}
            {!readOnly && tab !== 'library' && !fields[tab].trim() && (
              <Button size="sm" icon={<WandSparkles className="size-3.5" />} onClick={() => {
                set(tab, HOOK_TEMPLATE[tab])
                setNonce((n) => n + 1)
              }}>
                Insert template
              </Button>
            )}
          </div>
          <div className="relative min-h-0 flex-1 bg-black/20">
            {loading && (
              <div className="absolute inset-0 z-10 grid place-items-center">
                <Spinner className="size-5 text-fg-3" />
              </div>
            )}
            {TABS.map((t) => (
              <div key={t} className={cn('absolute inset-0', tab === t ? 'visible' : 'invisible')}>
                <CodeEditor
                  value={fields[t]}
                  resetKey={`${currentId ?? 'new'}:${nonce}`}
                  onChange={(v) => set(t, v)}
                  readOnly={readOnly}
                  className="h-full"
                  placeholder={t === 'library' ? '// Functions and constants shared by every hook' : `// ${HOOK_LABEL[t]} hook — end with modifier(text)`}
                />
              </div>
            ))}
          </div>
        </div>

        {/* Test console */}
        <AnimatePresence initial={false}>
          {testing && (
            <motion.div initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 24 }} transition={{ duration: 0.28, ease }} className="w-[380px] shrink-0 overflow-hidden border-l border-line">
              <div className="h-full">
                <TestConsole key={currentId ?? 'new'} script={testScript} adventureId={adventureId} />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </Dialog>
  )
}
