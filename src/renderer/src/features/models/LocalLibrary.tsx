// "My models": every model file on disk with Stability Matrix / Civitai
// metadata, coloured kind tags, base-model tags and activation keywords.
import { useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Copy, Download, ExternalLink, FolderOpen, HardDrive, RefreshCw, ScanSearch, Square, ThumbsUp, Trash2, User } from 'lucide-react'
import type { LocalModel, ModelKind } from '@shared/types'
import { folderLabel } from '@shared/civitai'
import { errorText, invoke } from '@/lib/api'
import { cn, formatBytes, timeAgo } from '@/lib/utils'
import { ease, spring } from '@/lib/motion'
import { Button, IconButton } from '@/components/ui/button'
import { SearchField } from '@/components/ui/input'
import { EmptyState, Skeleton, Spinner } from '@/components/ui/misc'
import { Dialog, Select, Tooltip } from '@/components/ui/overlay'
import { BaseTag, copyText, formatCount, KIND_META, KindTag, kindColor, kindTone, localPreviewIsNsfw, ModelThumb, modelTitle, WordChip } from '@/components/model-tags'
import { useLocalModels } from '@/components/model-library'
import { toast } from '@/stores/toast'
import { Description, Drawer, Section } from './parts'

const KIND_ORDER: ModelKind[] = ['checkpoint', 'unet', 'lora', 'controlnet', 'vae', 'textencoder', 'embedding', 'upscaler', 'clipvision', 'other']
type Sort = 'name' | 'size' | 'base' | 'recent'

const identified = (m: LocalModel): boolean => m.meta?.source === 'civitai'

// ─── Card ────────────────────────────────────────────────────────────────────

function LocalCard({
  m,
  index,
  busy,
  onOpen,
  onIdentify,
  onDelete
}: {
  m: LocalModel
  index: number
  busy: boolean
  onOpen: () => void
  onIdentify: () => void
  onDelete: () => void
}): React.JSX.Element {
  const words = m.meta?.trainedWords ?? []
  return (
    <motion.div
      layout="position"
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0, transition: { duration: 0.45, ease, delay: Math.min(index, 18) * 0.022 } }}
      exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.15 } }}
      whileHover={{ y: -3 }}
      onClick={onOpen}
      className="group glass hairline relative flex flex-col overflow-hidden rounded-2xl transition-[border-color,box-shadow] duration-300 hover:border-line-strong hover:shadow-[0_18px_40px_-18px_rgb(0_0_0/0.8)]"
    >
      <div className="relative aspect-[4/5] overflow-hidden">
        <ModelThumb model={m} allowReveal className="size-full transition-transform duration-700 ease-out group-hover:scale-[1.035]" />
        <div className="pointer-events-none absolute inset-x-0 top-0 h-16 bg-gradient-to-b from-black/45 to-transparent" />
        <div className="absolute top-2 left-2 rounded-md bg-black/35 backdrop-blur-md">
          <KindTag kind={m.kind} icon />
        </div>
        <div className="absolute top-2 right-2 flex gap-1 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
          <IconButton label="Show in folder" size="sm" variant="glass" className="bg-black/40" onClick={(e) => { e.stopPropagation(); void invoke('sys:showInFolder', m.path) }}>
            <FolderOpen className="size-3.5" />
          </IconButton>
          <IconButton label="Delete" size="sm" variant="glass" className="bg-black/40 hover:text-danger" onClick={(e) => { e.stopPropagation(); onDelete() }}>
            <Trash2 className="size-3.5" />
          </IconButton>
        </div>
        <AnimatePresence>
          {busy && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 grid place-items-center bg-black/55 backdrop-blur-sm">
              <div className="flex flex-col items-center gap-2 text-[11.5px] text-white/85">
                <Spinner className="size-5" />
                Hashing & looking up…
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <div className="flex flex-1 flex-col gap-2 p-3">
        <div>
          <div className="line-clamp-2 text-[12.5px] leading-snug font-semibold" title={modelTitle(m)}>
            {modelTitle(m)}
          </div>
          {m.meta?.versionName && <div className="mt-0.5 truncate text-[11px] text-fg-3">{m.meta.versionName}</div>}
        </div>
        <div className="flex min-w-0 items-center gap-1.5">
          <BaseTag base={m.meta?.baseModel} className="min-w-0" />
          <span className="ml-auto shrink-0 text-[10.5px] text-fg-3 tabular-nums">{formatBytes(m.size)}</span>
        </div>
        {words.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {words.slice(0, 3).map((w) => (
              <WordChip key={w} word={w} className="max-w-full" />
            ))}
            {words.length > 3 && <span className="h-6 px-1 text-[10.5px] leading-6 text-fg-3">+{words.length - 3}</span>}
          </div>
        )}
        {!identified(m) && (
          <Button
            size="xs"
            variant="secondary"
            className="mt-auto w-full"
            icon={<ScanSearch className="size-3" />}
            disabled={busy}
            onClick={(e) => {
              e.stopPropagation()
              onIdentify()
            }}
          >
            Identify on Civitai
          </Button>
        )}
      </div>
    </motion.div>
  )
}

// ─── Detail ──────────────────────────────────────────────────────────────────

function Row({ label, children, mono }: { label: string; children: React.ReactNode; mono?: boolean }): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5 text-[12px]">
      <span className="shrink-0 text-fg-3">{label}</span>
      <span className={cn('selectable min-w-0 truncate text-right text-fg-2', mono && 'font-mono text-[11px]')}>{children}</span>
    </div>
  )
}

function LocalDetail({ m, busy, onIdentify, onDelete }: { m: LocalModel; busy: boolean; onIdentify: () => void; onDelete: () => void }): React.JSX.Element {
  const meta = m.meta
  const words = meta?.trainedWords ?? []
  const file = m.path.split(/[\\/]/).pop()!
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="relative h-[380px] shrink-0">
        <ModelThumb model={m} full allowReveal className="size-full" />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-32 bg-gradient-to-t from-[var(--panel-solid)] to-transparent" />
      </div>
      <div className="relative -mt-10 space-y-6 px-6 pb-8">
        <div className="space-y-2.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <KindTag kind={m.kind} icon />
            <BaseTag base={meta?.baseModel} />
            {meta?.civitaiType && KIND_META[m.kind].label.toLowerCase() !== meta.civitaiType.toLowerCase() && (
              <span className="inline-flex h-5 items-center rounded-md border border-line px-1.5 text-[10.5px] text-fg-3">{meta.civitaiType}</span>
            )}
          </div>
          <h2 className="display text-[22px] leading-tight">{modelTitle(m)}</h2>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-fg-3">
            {meta?.versionName && <span className="text-fg-2">{meta.versionName}</span>}
            {meta?.author && (
              <span className="flex items-center gap-1">
                <User className="size-3" /> {meta.author}
              </span>
            )}
            {meta?.stats?.downloadCount ? (
              <span className="flex items-center gap-1">
                <Download className="size-3" /> {formatCount(meta.stats.downloadCount)}
              </span>
            ) : null}
            {meta?.stats?.thumbsUpCount ? (
              <span className="flex items-center gap-1">
                <ThumbsUp className="size-3" /> {formatCount(meta.stats.thumbsUpCount)}
              </span>
            ) : null}
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {meta?.modelId && (
            <Button size="sm" variant="secondary" icon={<ExternalLink className="size-3.5" />} onClick={() => void invoke('sys:openExternal', `https://civitai.com/models/${meta.modelId}${meta.versionId ? `?modelVersionId=${meta.versionId}` : ''}`)}>
              Open on Civitai
            </Button>
          )}
          <Button size="sm" variant="secondary" icon={<FolderOpen className="size-3.5" />} onClick={() => void invoke('sys:showInFolder', m.path)}>
            Show in folder
          </Button>
          <Button size="sm" variant={identified(m) ? 'ghost' : 'primary'} loading={busy} icon={<ScanSearch className="size-3.5" />} onClick={onIdentify}>
            {identified(m) ? 'Refresh info' : 'Identify on Civitai'}
          </Button>
          <div className="flex-1" />
          <Tooltip content="Delete file">
            <IconButton label="Delete file" size="sm" variant="secondary" className="hover:border-danger/30 hover:bg-danger/12 hover:text-danger" onClick={onDelete}>
              <Trash2 className="size-3.5" />
            </IconButton>
          </Tooltip>
        </div>

        {words.length > 0 && (
          <Section
            label="Activation keywords"
            action={
              <button onClick={() => void copyText(words.join(', '), 'Keywords copied')} className="flex items-center gap-1 text-[11px] font-medium text-fg-3 hover:text-fg">
                <Copy className="size-3" /> Copy all
              </button>
            }
          >
            <div className="flex flex-wrap gap-1.5">
              {words.map((w) => (
                <WordChip key={w} word={w} className="max-w-full" />
              ))}
            </div>
          </Section>
        )}

        <Section label="File">
          <div className="divide-y divide-line rounded-xl border border-line bg-white/[0.02] px-3">
            <Row label="File" mono>
              {file}
            </Row>
            <Row label="Folder">{folderLabel(m.folder)}</Row>
            {m.name !== file && (
              <Row label="ComfyUI name" mono>
                {m.name}
              </Row>
            )}
            <Row label="Size">{formatBytes(m.size)}</Row>
            {meta?.fileMeta?.fp && <Row label="Precision">{meta.fileMeta.fp}</Row>}
            {meta?.fileMeta?.format && <Row label="Format">{meta.fileMeta.format}</Row>}
            {meta?.sha256 && (
              <Row label="SHA-256" mono>
                <button className="hover:text-fg" onClick={() => void copyText(meta.sha256!, 'Hash copied')} title="Copy">
                  {meta.sha256.slice(0, 16)}…
                </button>
              </Row>
            )}
            {meta?.importedAt && !Number.isNaN(Date.parse(meta.importedAt)) && <Row label="Added">{timeAgo(Date.parse(meta.importedAt))}</Row>}
          </div>
        </Section>

        {!!meta?.tags.length && (
          <Section label="Tags">
            <div className="flex flex-wrap gap-1.5">
              {meta.tags.map((t) => (
                <span key={t} className="rounded-md border border-line bg-white/[0.04] px-2 py-0.5 text-[11px] text-fg-2">
                  {t}
                </span>
              ))}
            </div>
          </Section>
        )}

        {meta?.versionDescription && (
          <Section label="About this version">
            <Description html={meta.versionDescription} guard={localPreviewIsNsfw({ ...meta, previewPath: meta.previewPath ?? 'x' }) || meta.nsfw} />
          </Section>
        )}
        {meta?.description && (
          <Section label="About">
            <Description html={meta.description} guard={localPreviewIsNsfw({ ...meta, previewPath: meta.previewPath ?? 'x' }) || meta.nsfw} />
          </Section>
        )}
        {!meta && (
          <div className="rounded-xl border border-dashed border-line-strong p-4 text-[12px] leading-relaxed text-fg-3">
            No metadata for this file yet. <b className="text-fg-2">Identify on Civitai</b> hashes it and fetches its name, base model, keywords and preview — saved in Stability Matrix’s format so both apps see it.
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Tab ─────────────────────────────────────────────────────────────────────

export function LocalLibrary(): React.JSX.Element {
  const { models, loading, refresh } = useLocalModels()
  const [kind, setKind] = useState<ModelKind | 'all'>('all')
  const [base, setBase] = useState('all')
  const [sort, setSort] = useState<Sort>('name')
  const [q, setQ] = useState('')
  const [openPath, setOpenPath] = useState<string | null>(null)
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [bulk, setBulk] = useState<{ done: number; total: number } | null>(null)
  const stopBulk = useRef(false)
  const [confirm, setConfirm] = useState<LocalModel | null>(null)
  const [deleting, setDeleting] = useState(false)

  const kindCounts = useMemo(() => {
    const c = new Map<ModelKind, number>()
    for (const m of models) c.set(m.kind, (c.get(m.kind) ?? 0) + 1)
    return KIND_ORDER.filter((k) => c.has(k)).map((k) => ({ kind: k, count: c.get(k)! }))
  }, [models])

  const bases = useMemo(() => {
    const pool = kind === 'all' ? models : models.filter((m) => m.kind === kind)
    const c = new Map<string, number>()
    let unknown = 0
    for (const m of pool) {
      if (m.meta?.baseModel) c.set(m.meta.baseModel, (c.get(m.meta.baseModel) ?? 0) + 1)
      else unknown++
    }
    return { list: [...c.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])), unknown }
  }, [models, kind])

  const list = useMemo(() => {
    const t = q.trim().toLowerCase()
    const out = models.filter((m) => {
      if (kind !== 'all' && m.kind !== kind) return false
      if (base === '__unknown' ? !!m.meta?.baseModel : base !== 'all' && m.meta?.baseModel !== base) return false
      if (!t) return true
      const hay = `${modelTitle(m)} ${m.name} ${m.meta?.versionName ?? ''} ${m.meta?.baseModel ?? ''} ${m.meta?.trainedWords.join(' ') ?? ''} ${m.meta?.tags.join(' ') ?? ''} ${m.meta?.author ?? ''}`.toLowerCase()
      return t.split(/\s+/).every((w) => hay.includes(w))
    })
    const by: Record<Sort, (a: LocalModel, b: LocalModel) => number> = {
      name: (a, b) => modelTitle(a).localeCompare(modelTitle(b)),
      size: (a, b) => b.size - a.size,
      base: (a, b) => (a.meta?.baseModel ?? '~').localeCompare(b.meta?.baseModel ?? '~') || modelTitle(a).localeCompare(modelTitle(b)),
      recent: (a, b) => (Date.parse(b.meta?.importedAt ?? '') || 0) - (Date.parse(a.meta?.importedAt ?? '') || 0)
    }
    return out.sort(by[sort])
  }, [models, kind, base, q, sort])

  const unknown = useMemo(() => list.filter((m) => !identified(m)), [list])
  const totalSize = useMemo(() => models.reduce((n, m) => n + m.size, 0), [models])
  const open = openPath ? models.find((m) => m.path === openPath) : undefined

  const identify = async (m: LocalModel, quiet = false): Promise<boolean> => {
    setBusy((b) => ({ ...b, [m.path]: true }))
    try {
      const meta = await invoke('models:identify', m.path)
      if (!quiet) {
        if (meta) toast.success(`Identified ${meta.name}`, meta.baseModel ? `${meta.baseModel}${meta.versionName ? ` · ${meta.versionName}` : ''}` : undefined)
        else toast.info('Not on Civitai', `${modelTitle(m)} doesn't match any file Civitai knows.`)
      }
      return !!meta
    } catch (err) {
      if (quiet) throw err
      toast.error("Couldn't identify it", errorText(err))
      return false
    } finally {
      setBusy((b) => {
        const next = { ...b }
        delete next[m.path]
        return next
      })
    }
  }

  const identifyAll = async (): Promise<void> => {
    const todo = [...unknown].sort((a, b) => a.size - b.size) // small files first: quick wins
    stopBulk.current = false
    setBulk({ done: 0, total: todo.length })
    let found = 0
    for (const [i, m] of todo.entries()) {
      if (stopBulk.current) break
      try {
        if (await identify(m, true)) found++
      } catch (err) {
        toast.error("Couldn't reach Civitai", errorText(err))
        break
      }
      setBulk({ done: i + 1, total: todo.length })
    }
    setBulk(null)
    toast.success('Identification finished', `${found} of ${todo.length} files matched Civitai.`)
  }

  const doDelete = async (): Promise<void> => {
    if (!confirm) return
    setDeleting(true)
    try {
      await invoke('models:delete', confirm.path)
      toast.info(`Deleted ${modelTitle(confirm)}`, 'Moved to the Recycle Bin with its preview and metadata.')
      if (openPath === confirm.path) setOpenPath(null)
      setConfirm(null)
    } catch (err) {
      toast.error("Couldn't delete it", errorText(err))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <motion.div key="local" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.3, ease }}>
      <div className="sticky top-0 z-10 space-y-2.5 border-y border-line bg-[color-mix(in_oklab,var(--panel-solid)_82%,transparent)] px-8 py-3 backdrop-blur-xl">
        <div className="flex items-center gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto [scrollbar-width:none]">
            <KindChip label="All" count={models.length} active={kind === 'all'} onClick={() => setKind('all')} />
            {kindCounts.map(({ kind: k, count }) => (
              <KindChip key={k} kind={k} label={KIND_META[k].label} count={count} active={kind === k} onClick={() => setKind(kind === k ? 'all' : k)} />
            ))}
          </div>
          <Tooltip content="Rescan folders">
            <IconButton label="Rescan folders" size="sm" onClick={refresh}>
              <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
            </IconButton>
          </Tooltip>
        </div>
        <div className="flex items-center gap-2">
          <Select
            size="sm"
            className="w-[190px]"
            value={base}
            onChange={setBase}
            options={[
              { value: 'all', label: 'Any base model' },
              ...bases.list.map(([b, n]) => ({ value: b, label: b, hint: `${n} file${n === 1 ? '' : 's'}` })),
              ...(bases.unknown ? [{ value: '__unknown', label: 'Unknown base', hint: `${bases.unknown} unidentified` }] : [])
            ]}
          />
          <Select
            size="sm"
            className="w-[140px]"
            value={sort}
            onChange={(v) => setSort(v as Sort)}
            options={[
              { value: 'name', label: 'Name' },
              { value: 'recent', label: 'Recently added' },
              { value: 'size', label: 'Largest first' },
              { value: 'base', label: 'Base model' }
            ]}
          />
          <SearchField value={q} onChange={setQ} placeholder="Search names, keywords, tags" className="w-[260px]" />
          <div className="flex-1" />
          <span className="hidden items-center gap-1.5 text-[11.5px] text-fg-3 xl:flex">
            <HardDrive className="size-3.5" /> {models.length} files · {formatBytes(totalSize)}
          </span>
          {bulk ? (
            <Button size="sm" variant="secondary" icon={<Square className="size-3 fill-current" />} onClick={() => (stopBulk.current = true)}>
              Identifying {bulk.done}/{bulk.total} · Stop
            </Button>
          ) : (
            unknown.length > 0 && (
              <Tooltip content="Hash each unidentified file and look it up on Civitai. Big checkpoints take a while.">
                <Button size="sm" variant="secondary" icon={<ScanSearch className="size-3.5" />} onClick={() => void identifyAll()}>
                  Identify {unknown.length} unknown
                </Button>
              </Tooltip>
            )
          )}
        </div>
      </div>

      <div className="px-8 py-6">
        {loading && !models.length ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(196px,1fr))] gap-3.5">
            {Array.from({ length: 10 }, (_, i) => (
              <div key={i} className="glass overflow-hidden rounded-2xl">
                <Skeleton className="aspect-[4/5] rounded-none" />
                <div className="space-y-2 p-3">
                  <Skeleton className="h-3.5 w-3/4" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
              </div>
            ))}
          </div>
        ) : list.length ? (
          <motion.div layout className="grid grid-cols-[repeat(auto-fill,minmax(196px,1fr))] gap-3.5">
            <AnimatePresence initial={false} mode="popLayout">
              {list.map((m, i) => (
                <LocalCard key={m.path} m={m} index={i} busy={!!busy[m.path]} onOpen={() => setOpenPath(m.path)} onIdentify={() => void identify(m)} onDelete={() => setConfirm(m)} />
              ))}
            </AnimatePresence>
          </motion.div>
        ) : (
          <EmptyState
            icon={<HardDrive />}
            title={models.length ? 'Nothing matches' : 'No models found'}
            body={models.length ? 'Try another kind, base model or search.' : 'Stitch looks in your models folder (Settings), Stability Matrix’s shared Models folder and ComfyUI’s models folder. Browse Civitai to download some.'}
          />
        )}
      </div>

      <Drawer open={!!open} onOpenChange={(o) => !o && setOpenPath(null)} title={open ? modelTitle(open) : 'Model'} width={520}>
        {open && <LocalDetail key={open.path} m={open} busy={!!busy[open.path]} onIdentify={() => void identify(open)} onDelete={() => setConfirm(open)} />}
      </Drawer>

      <Dialog
        open={!!confirm}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Delete this model?"
        width={440}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button variant="danger" loading={deleting} icon={<Trash2 className="size-3.5" />} onClick={() => void doDelete()}>
              Delete
            </Button>
          </>
        }
      >
        {confirm && (
          <div className="flex gap-3.5 p-5">
            <ModelThumb model={confirm} compact className="size-16 shrink-0 rounded-xl ring-1 ring-line" />
            <div className="min-w-0 space-y-1 text-[12.5px] text-fg-2">
              <div className="truncate font-semibold text-fg">{modelTitle(confirm)}</div>
              <div className="truncate font-mono text-[11px] text-fg-3">{confirm.path}</div>
              <p className="pt-1 leading-relaxed">
                The file ({formatBytes(confirm.size)}) and its preview and metadata go to the Recycle Bin. Stability Matrix and ComfyUI will stop seeing it.
              </p>
            </div>
          </div>
        )}
      </Dialog>
    </motion.div>
  )
}

function KindChip({ kind, label, count, active, onClick }: { kind?: ModelKind; label: string; count: number; active: boolean; onClick: () => void }): React.JSX.Element {
  return (
    <motion.button
      whileTap={{ scale: 0.96 }}
      onClick={onClick}
      className={cn(
        'inline-flex h-7.5 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-[12px] font-medium transition-[background,border-color,color] duration-200',
        !active && 'border-line bg-white/[0.035] text-fg-2 hover:border-line-strong hover:bg-white/[0.07] hover:text-fg',
        active && !kind && 'border-[color-mix(in_oklab,var(--accent)_45%,transparent)] bg-[color-mix(in_oklab,var(--accent)_14%,transparent)] text-fg'
      )}
      style={active && kind ? kindTone(kind) : undefined}
    >
      {kind && <span className="size-1.5 rounded-full" style={{ background: kindColor(kind, 0.8) }} />}
      {label}
      <span className={cn('text-[10.5px] tabular-nums', active ? 'opacity-80' : 'text-fg-3')}>{count}</span>
    </motion.button>
  )
}
