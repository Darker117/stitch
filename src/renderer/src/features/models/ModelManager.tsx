// "Manage": every model Stitch uses, across every folder in use — ComfyUI
// model folders (chosen folder, Stability Matrix, ComfyUI's own and extra
// paths), Stitch's default download folder, folders installed into — plus
// the local voice engines and the curated download catalog. Deletes go to
// the Recycle Bin, after a confirmation.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { AnimatePresence, motion } from 'motion/react'
import { Boxes, Check, Download, FolderOpen, HardDrive, Mic2, MoreHorizontal, Music2, RefreshCw, Settings2, Trash2, Unlink } from 'lucide-react'
import type { VoiceEngineInfo } from '@shared/ipc'
import type { LocalModel, ManagedModel, ModelInventory, ModelLocation, ModelLocationKind } from '@shared/types'
import { folderLabel } from '@shared/civitai'
import { errorText, invoke, on } from '@/lib/api'
import { cn, formatBytes, pluralize, timeAgo } from '@/lib/utils'
import { ease, rise, spring, stagger } from '@/lib/motion'
import { isPhone, useCompact } from '@/lib/platform'
import { Button, Chip, IconButton } from '@/components/ui/button'
import { SearchField } from '@/components/ui/input'
import { Badge, EmptyState, ProgressBar, Skeleton, Spinner } from '@/components/ui/misc'
import { Dialog, Menu, MenuItem, Select, Tooltip } from '@/components/ui/overlay'
import { KindTag, ModelThumb } from '@/components/model-tags'
import { refreshLocalModels } from '@/components/model-library'
import { useGen } from '@/stores/gen'
import { toast } from '@/stores/toast'
import { HfMark, HfTokenDialog, homeLabel, InstallDialog, useCatalog, useGroupProgress, useHfStatus, useInstallPlan } from './install'
import { useCivitai } from './store'

const LOC_ICON: Record<ModelLocationKind, React.ReactNode> = {
  settings: <HardDrive />,
  'stability-matrix': <Boxes />,
  comfyui: <Boxes />,
  'comfy-extra': <Boxes />,
  app: <HardDrive />,
  extra: <FolderOpen />,
  voice: <Mic2 />
}

function useInventory(): { inv: ModelInventory | null; loading: boolean; error?: string; refresh: (hard?: boolean) => void } {
  const [inv, setInv] = useState<ModelInventory | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const refresh = useCallback((hard = false) => {
    setLoading(true)
    invoke('models:inventory', hard)
      .then((i) => {
        setInv(i)
        setError(undefined)
      })
      .catch((err) => setError(errorText(err)))
      .finally(() => setLoading(false))
  }, [])
  useEffect(() => {
    refresh()
    let t: ReturnType<typeof setTimeout> | undefined
    const off = on('models:changed', () => {
      clearTimeout(t)
      t = setTimeout(() => refresh(), 400)
    })
    return () => {
      clearTimeout(t)
      off()
    }
  }, [refresh])
  return { inv, loading, error, refresh }
}

const asLocal = (m: ManagedModel): LocalModel => ({ folder: m.folder, name: m.name, path: m.path, size: m.size, kind: m.kind, meta: m.meta })
const openFolder = (p: string): void => void invoke('sys:openPath', p).catch((err) => toast.error('Could not open the folder', errorText(err)))

// ─── Locations ───────────────────────────────────────────────────────────────

function LocationCard({ loc, onForget }: { loc: ModelLocation; onForget: () => void }): React.JSX.Element {
  const used = loc.total && loc.free !== undefined ? (loc.total - loc.free) / loc.total : undefined
  return (
    <motion.div
      variants={rise}
      className={cn('glass hairline group relative flex flex-col gap-3 overflow-hidden rounded-2xl p-4', loc.isDefault && 'border-[color-mix(in_oklab,var(--accent)_35%,transparent)]')}
    >
      {loc.isDefault && <div className="pointer-events-none absolute -top-12 -right-12 size-36 rounded-full bg-grad opacity-[0.14] blur-2xl" />}
      <div className="relative flex items-start gap-3">
        <span className={cn('grid size-9 shrink-0 place-items-center rounded-xl [&>svg]:size-4', loc.isDefault ? 'bg-grad text-white' : 'border border-line bg-white/[0.04] text-fg-2')}>{LOC_ICON[loc.kind]}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[13px] font-semibold">
            <span className="truncate">{loc.label}</span>
            {loc.isDefault && <Badge tone="accent">Default</Badge>}
            {!loc.exists && <Badge tone="outline">Not created yet</Badge>}
          </div>
          <div className="mt-0.5 truncate font-mono text-[10.5px] text-fg-3" title={loc.path}>
            {loc.path}
          </div>
        </div>
        <div className="flex shrink-0 gap-0.5 opacity-70 transition-opacity group-hover:opacity-100 max-md:-mt-1 max-md:-mr-1 max-md:opacity-100">
          {loc.exists && (
            <IconButton label="Open folder" size="sm" className="max-md:size-9" onClick={() => openFolder(loc.path)}>
              <FolderOpen className="size-3.5" />
            </IconButton>
          )}
          {loc.removable && (
            <IconButton label="Forget this folder (files stay)" size="sm" className="max-md:size-9" onClick={onForget}>
              <Unlink className="size-3.5" />
            </IconButton>
          )}
        </div>
      </div>
      <div className="relative flex items-end justify-between gap-3">
        <div>
          <div className="display text-[20px] leading-none tabular-nums">{formatBytes(loc.bytes)}</div>
          <div className="mt-1 text-[11px] text-fg-3">{loc.kind === 'voice' ? 'voice weights' : pluralize(loc.files, 'model file')}</div>
        </div>
        {loc.free !== undefined && <div className="text-right text-[11px] text-fg-3 tabular-nums">{formatBytes(loc.free)} free</div>}
      </div>
      {used !== undefined && (
        <Tooltip content={`Drive: ${formatBytes((loc.total ?? 0) - (loc.free ?? 0))} used of ${formatBytes(loc.total)}`}>
          <div className="relative">
            <ProgressBar value={used} className={cn('h-1.5', used > 0.92 && '[&>div]:bg-danger')} />
          </div>
        </Tooltip>
      )}
    </motion.div>
  )
}

// ─── Voice engines ───────────────────────────────────────────────────────────

function VoiceEngines({ bytes }: { bytes?: number }): React.JSX.Element | null {
  const [engines, setEngines] = useState<VoiceEngineInfo[] | null>(null)
  const [fallback, setFallback] = useState<{ label: string; downloaded: boolean }[] | null>(null)
  const [confirm, setConfirm] = useState<VoiceEngineInfo | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    invoke('voice:engines')
      .then((list) => alive && setEngines(list))
      .catch(() => {
        // Older build without the engines API: show the Qwen3-TTS models instead.
        invoke('voice:engineStatus')
          .then((st) => alive && setFallback(st.models))
          .catch(() => alive && setFallback([]))
      })
    const off = on('voice:engine', (st) => {
      if (st.engines) setEngines(st.engines)
    })
    return () => {
      alive = false
      off()
    }
  }, [])

  const local = (engines ?? []).filter((e) => e.kind === 'local')
  if (!engines && !fallback) return <Skeleton className="h-24 rounded-2xl" />

  const act = async (e: VoiceEngineInfo, action: 'install' | 'remove'): Promise<void> => {
    setBusy(e.id)
    try {
      if (action === 'install') await invoke('voice:installEngine', e.id)
      else await invoke('voice:removeEngine', e.id)
      setEngines(await invoke('voice:engines'))
    } catch (err) {
      toast.error(action === 'install' ? `Couldn't install ${e.name}` : `Couldn't remove ${e.name}`, errorText(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between max-md:flex-wrap max-md:gap-x-3 max-md:gap-y-1">
        <h3 className="flex items-center gap-2 text-[14px] font-semibold tracking-tight">
          <Mic2 className="size-4 text-accent" /> Voice engines
        </h3>
        {bytes ? <span className="text-[11.5px] text-fg-3">{formatBytes(bytes)} of voice weights on disk</span> : null}
      </div>
      {engines ? (
        <div className="grid grid-cols-3 gap-3 max-md:grid-cols-1 max-md:gap-2.5">
          {local.map((e) => (
            <div key={e.id} className="glass hairline flex flex-col gap-2.5 rounded-2xl p-4">
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-semibold">{e.name}</span>
                {e.installing ? (
                  <Badge tone="accent">
                    <Spinner className="size-2.5" /> Working
                  </Badge>
                ) : e.installed ? (
                  <Badge tone="success">
                    <Check className="size-2.5" /> Installed
                  </Badge>
                ) : (
                  <Badge tone="outline">Not installed</Badge>
                )}
                {e.supportsCloning && <Badge>Cloning</Badge>}
              </div>
              {e.description && <p className="line-clamp-2 text-[11.5px] leading-snug text-fg-3">{e.description}</p>}
              <div className="mt-auto flex items-center justify-between gap-2 text-[11px] text-fg-3">
                <span className="tabular-nums">
                  {e.installed ? formatBytes(e.sizeBytes) : e.downloadBytes ? `~${formatBytes(e.downloadBytes)} download` : ''}
                  {e.weights?.length ? ` · ${e.weights.filter((w) => w.downloaded).length}/${e.weights.length} weights` : ''}
                </span>
                <div className="flex gap-1">
                  {e.installed && e.path && (
                    <IconButton label="Open folder" size="xs" className="max-md:size-8" onClick={() => openFolder(e.path!)}>
                      <FolderOpen className="size-3.5" />
                    </IconButton>
                  )}
                  {e.installed ? (
                    <Button size="xs" variant="ghost" className="hover:text-danger max-md:h-8 max-md:px-2.5" loading={busy === e.id} disabled={!!e.installing} icon={<Trash2 className="size-3" />} onClick={() => setConfirm(e)}>
                      Remove
                    </Button>
                  ) : (
                    <Button size="xs" className="max-md:h-8 max-md:px-2.5" loading={busy === e.id} disabled={!!e.installing} icon={<Download className="size-3" />} onClick={() => void act(e, 'install')}>
                      Install
                    </Button>
                  )}
                </div>
              </div>
            </div>
          ))}
          {!local.length && <p className="col-span-3 text-[12px] text-fg-3">No local voice engines available.</p>}
        </div>
      ) : (
        <div className="glass hairline rounded-2xl p-4 text-[12px] text-fg-2">
          <div className="mb-2 font-semibold">Qwen3-TTS (local voice engine)</div>
          <div className="flex flex-wrap gap-1.5">
            {(fallback ?? []).map((m) => (
              <Badge key={m.label} tone={m.downloaded ? 'success' : 'outline'}>
                {m.downloaded && <Check className="size-2.5" />} {m.label}
              </Badge>
            ))}
            {!fallback?.length && <span className="text-fg-3">Voice engine status unavailable.</span>}
          </div>
          <p className="mt-2 text-[11px] text-fg-3">Manage voice models in Generate → Voice.</p>
        </div>
      )}
      <Dialog
        open={!!confirm}
        onOpenChange={(o) => !o && setConfirm(null)}
        width={440}
        title={`Remove ${confirm?.name ?? ''}?`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Keep it
            </Button>
            <Button
              variant="danger"
              icon={<Trash2 className="size-3.5" />}
              onClick={() => {
                const e = confirm!
                setConfirm(null)
                void act(e, 'remove')
              }}
            >
              Remove engine
            </Button>
          </>
        }
      >
        <p className="p-5 text-[12.5px] leading-relaxed text-fg-2">
          Deletes this engine’s packages and downloaded weights{confirm?.sizeBytes ? ` (${formatBytes(confirm.sizeBytes)})` : ''}. Voices that use it stop working until you install it again.
        </p>
      </Dialog>
    </section>
  )
}

// ─── Catalog ─────────────────────────────────────────────────────────────────

function CatalogCard({ id, onInstall }: { id: string; onInstall: () => void }): React.JSX.Element | null {
  const catalog = useCatalog()
  const recipes = useGen((s) => s.recipes)
  const entry = catalog.find((e) => e.id === id)
  const { plan } = useInstallPlan(undefined, { entryId: id })
  const group = useGroupProgress(`entry:${id}`)
  const recipeGroup = useGroupProgress(`recipe:${entry?.recipes[0] ?? ''}`)
  if (!entry) return null
  const size = entry.files.reduce((n, f) => n + f.size, 0)
  const missing = plan?.files.filter((f) => f.status === 'missing').length ?? 0
  const installed = plan && !missing && plan.files.every((f) => f.status === 'installed')
  const pending = group.pending.length ? group : recipeGroup.pending.length ? recipeGroup : null
  const music = entry.recipes.some((r) => recipes.find((x) => x.id === r)?.kind === 'audio')
  return (
    <motion.div variants={rise} className="glass hairline flex flex-col gap-2.5 rounded-2xl p-4">
      <div className="flex items-start gap-2">
        {music && <Music2 className="mt-0.5 size-3.5 shrink-0 text-accent" />}
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold">{entry.name}</div>
          <div className="mt-0.5 line-clamp-2 text-[11.5px] leading-snug text-fg-3">{entry.description}</div>
        </div>
      </div>
      <div className="flex flex-wrap gap-1">
        {entry.recipes.map((r) => (
          <Badge key={r} tone="outline">
            {recipes.find((x) => x.id === r)?.name ?? r}
          </Badge>
        ))}
      </div>
      <div className="mt-auto flex items-center justify-between gap-2 pt-1">
        <span className="text-[11px] text-fg-3 tabular-nums">
          {formatBytes(size)} · {pluralize(entry.files.length, 'file')}
        </span>
        {pending ? (
          <span className="flex items-center gap-1.5 text-[11.5px] font-medium text-accent">
            <Spinner className="size-3" /> {pending.total ? `${Math.round((pending.received / pending.total) * 100)}%` : 'Queued'}
          </span>
        ) : installed ? (
          <Badge tone="success">
            <Check className="size-2.5" /> Installed
          </Badge>
        ) : (
          <Button size="xs" className="max-md:h-8 max-md:px-2.5" variant={missing < entry.files.length ? 'secondary' : 'primary'} icon={<Download className="size-3" />} disabled={!plan} onClick={onInstall}>
            {plan && missing < entry.files.length && missing > 0 ? `Add missing · ${formatBytes(plan.bytes)}` : 'Install'}
          </Button>
        )}
      </div>
    </motion.div>
  )
}

// ─── Main ────────────────────────────────────────────────────────────────────

type Sort = 'size' | 'name' | 'unused'

export function ModelManager(): React.JSX.Element {
  const navigate = useNavigate()
  const { inv, loading, error, refresh } = useInventory()
  const { status: hf, reload: reloadHf } = useHfStatus()
  const catalog = useCatalog()
  const initDownloads = useCivitai((s) => s.initDownloads)
  const [q, setQ] = useState('')
  const [loc, setLoc] = useState('all')
  const [sort, setSort] = useState<Sort>('size')
  const [confirm, setConfirm] = useState<ManagedModel | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [installEntry, setInstallEntry] = useState<string | null>(null)
  const [tokenOpen, setTokenOpen] = useState(false)
  const [rescanning, setRescanning] = useState(false)
  const compact = useCompact()
  useEffect(() => initDownloads(), [initDownloads])

  const locName = useMemo(() => new Map((inv?.locations ?? []).map((l) => [l.id, l.label])), [inv])
  const home = inv?.locations.find((l) => l.isDefault)
  const models = useMemo(() => {
    const t = q.trim().toLowerCase()
    let list = (inv?.models ?? []).filter((m) => loc === 'all' || m.locationId === loc)
    if (t) list = list.filter((m) => `${m.name} ${m.meta?.name ?? ''} ${m.folder} ${m.usedBy.map((u) => u.name).join(' ')}`.toLowerCase().includes(t))
    if (sort === 'name') list = [...list].sort((a, b) => a.name.localeCompare(b.name))
    if (sort === 'unused') list = [...list].sort((a, b) => a.usedBy.length - b.usedBy.length || b.size - a.size)
    return list
  }, [inv, q, loc, sort])

  const rescan = async (): Promise<void> => {
    setRescanning(true)
    try {
      await refreshLocalModels()
      refresh(true)
      void useGen.getState().refreshRecipes()
    } finally {
      setTimeout(() => setRescanning(false), 500)
    }
  }

  const trash = async (): Promise<void> => {
    if (!confirm) return
    setDeleting(true)
    try {
      await invoke('models:trash', confirm.path)
      toast.success('Moved to the Recycle Bin', confirm.name)
      setConfirm(null)
      refresh(true)
      void useGen.getState().refreshRecipes()
    } catch (err) {
      toast.error('Could not delete', errorText(err))
    } finally {
      setDeleting(false)
    }
  }

  const forget = async (l: ModelLocation): Promise<void> => {
    try {
      await invoke('models:forgetDir', l.path)
      toast.info('Folder forgotten', 'Its files stay on disk; Stitch just stops listing them.')
      refresh(true)
    } catch (err) {
      toast.error('Could not forget the folder', errorText(err))
    }
  }

  const voiceLoc = inv?.locations.find((l) => l.kind === 'voice')

  return (
    <motion.div key="manage" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.3, ease }} className="space-y-8 px-8 pt-5 pb-12 max-md:space-y-7 max-md:px-4 max-md:pt-4">
      {/* Default path + actions */}
      <div className="flex flex-wrap items-center gap-3 max-md:gap-2">
        <div className="min-w-0 flex-1 max-md:basis-full">
          <div className="label-caps">Default models path</div>
          <div className="mt-1 flex min-w-0 items-center gap-2 text-[12.5px]">
            {home ? (
              <>
                <span className="truncate font-mono text-[12px] text-fg" title={home.path}>
                  {home.path}
                </span>
                <span className="shrink-0 text-fg-3">· {home.label}</span>
              </>
            ) : (
              <Skeleton className="h-4 w-80 max-md:w-full" />
            )}
          </div>
        </div>
        <Tooltip content="Change the default in Settings → Models & storage">
          <Button size="sm" variant="ghost" className="max-md:h-9 max-md:-ml-2.5" icon={<Settings2 className="size-3.5" />} onClick={() => navigate('/settings?tab=storage')}>
            Change
          </Button>
        </Tooltip>
        <Button size="sm" variant="secondary" className="max-md:h-9 max-md:min-w-0 max-md:flex-1" icon={<HfMark size={15} />} onClick={() => setTokenOpen(true)}>
          {hf?.hasToken ? (hf.username ?? 'Hugging Face') : 'Hugging Face token'}
        </Button>
        <Button size="sm" variant="secondary" className="max-md:h-9" loading={rescanning} icon={<RefreshCw className="size-3.5" />} onClick={() => void rescan()}>
          Rescan
        </Button>
      </div>

      {error && <div className="rounded-xl border border-danger/25 bg-danger/10 p-3 text-[12px] text-danger">{error}</div>}

      {/* Locations */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-[14px] font-semibold tracking-tight">
            <HardDrive className="size-4 text-accent" /> Locations
          </h3>
          {inv && <span className="text-[11.5px] text-fg-3">Scanned {timeAgo(inv.scannedAt)}</span>}
        </div>
        {inv ? (
          <motion.div variants={stagger(0.04, 0.02)} initial="initial" animate="animate" className="grid grid-cols-3 gap-3 max-md:grid-cols-1 max-md:gap-2.5">
            {inv.locations
              .filter((l) => l.kind !== 'voice')
              .map((l) => (
                <LocationCard key={l.id} loc={l} onForget={() => void forget(l)} />
              ))}
          </motion.div>
        ) : (
          <div className="grid grid-cols-3 gap-3 max-md:grid-cols-1 max-md:gap-2.5">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-36 rounded-2xl" />
            ))}
          </div>
        )}
      </section>

      <VoiceEngines bytes={voiceLoc?.bytes} />

      {/* Models */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="mr-2 flex items-center gap-2 text-[14px] font-semibold tracking-tight max-md:mr-0 max-md:basis-full">
            <Boxes className="size-4 text-accent" /> Models
            {inv && <span className="text-[12px] font-medium text-fg-3 tabular-nums">{models.length}</span>}
          </h3>
          <SearchField value={q} onChange={setQ} placeholder="Search models or recipes…" className="w-[260px] max-md:w-full" />
          <Select
            size="sm"
            className="w-[230px] max-md:h-9 max-md:w-full"
            value={loc}
            onChange={setLoc}
            options={[{ value: 'all', label: 'All locations' }, ...(inv?.locations ?? []).filter((l) => l.files > 0).map((l) => ({ value: l.id, label: `${l.label} (${l.files})` }))]}
          />
          <div className="flex-1 max-md:hidden" />
          {(['size', 'name', 'unused'] as Sort[]).map((s) => (
            <Chip key={s} active={sort === s} onClick={() => setSort(s)} className="max-md:h-9 max-md:rounded-full max-md:px-3">
              {s === 'size' ? 'Largest' : s === 'name' ? 'Name' : 'Unused first'}
            </Chip>
          ))}
        </div>
        <div className="glass hairline overflow-hidden rounded-2xl">
          <div className="grid grid-cols-[minmax(0,1fr)_120px_minmax(0,220px)_150px_84px_68px] items-center gap-3 border-b border-line px-4 py-2 text-[10.5px] font-semibold tracking-wide text-fg-3 uppercase max-md:hidden">
            <span>Model</span>
            <span>Type</span>
            <span>Used by</span>
            <span>Location</span>
            <span className="text-right">Size</span>
            <span />
          </div>
          {loading && !inv ? (
            <div className="space-y-2 p-4">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-10" />
              ))}
            </div>
          ) : !models.length ? (
            <EmptyState className="py-12" icon={<Boxes />} title={q ? 'No matches' : 'No model files yet'} body={q ? 'Try another search.' : 'Install a recipe’s models below, or download from Civitai.'} />
          ) : (
            <div className="max-h-[560px] overflow-y-auto max-md:max-h-[64vh]">
              <AnimatePresence initial={false}>
                {models.map((m) => (
                  <motion.div
                    key={m.path}
                    layout="position"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0, x: 24, transition: { duration: 0.2 } }}
                    transition={spring}
                    className={cn(
                      'group items-center border-b border-line/60 last:border-b-0',
                      compact ? 'flex gap-3 py-2.5 pr-1.5 pl-3.5' : 'grid grid-cols-[minmax(0,1fr)_120px_minmax(0,220px)_150px_84px_68px] gap-3 px-4 py-2 hover:bg-white/[0.03]'
                    )}
                  >
                    {compact ? (
                      <>
                        <ModelThumb model={asLocal(m)} compact className="size-11 shrink-0 rounded-xl" />
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 items-center gap-2">
                            <span className="min-w-0 truncate text-[12.5px] font-medium" title={m.name}>
                              {m.meta?.source === 'civitai' ? m.meta.name : m.name.split('/').pop()}
                            </span>
                            <span className="ml-auto shrink-0 text-[11px] text-fg-2 tabular-nums">{formatBytes(m.size)}</span>
                          </div>
                          <div className="mt-0.5 truncate text-[10.5px] text-fg-3" title={m.path}>
                            {folderLabel(m.folder)} · {locName.get(m.locationId) ?? '—'}
                          </div>
                          <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1">
                            <KindTag kind={m.kind} />
                            {m.partial && <Badge tone="warning">Partial download</Badge>}
                            {m.usedBy.slice(0, 2).map((u) => (
                              <span key={u.id} className="max-w-full truncate rounded-md border border-line bg-white/[0.04] px-1.5 py-0.5 text-[10.5px] text-fg-2">
                                {u.name}
                              </span>
                            ))}
                            {m.usedBy.length > 2 && <span className="px-1 text-[10.5px] text-fg-3">+{m.usedBy.length - 2}</span>}
                            {!m.usedBy.length && <span className="text-[10.5px] text-fg-3/70">Not used by a recipe</span>}
                          </div>
                        </div>
                        <Menu
                          align="end"
                          trigger={
                            <IconButton label="Model actions" className="size-10 shrink-0 rounded-full">
                              <MoreHorizontal className="size-4" />
                            </IconButton>
                          }
                        >
                          {!isPhone && (
                            <MenuItem icon={<FolderOpen />} onSelect={() => void invoke('sys:showInFolder', m.path)}>
                              Show in folder
                            </MenuItem>
                          )}
                          <MenuItem icon={<Trash2 />} danger onSelect={() => setConfirm(m)}>
                            Move to Recycle Bin…
                          </MenuItem>
                        </Menu>
                      </>
                    ) : (
                      <>
                        <div className="flex min-w-0 items-center gap-3">
                          <ModelThumb model={asLocal(m)} compact className="size-9 shrink-0 rounded-lg" />
                          <div className="min-w-0">
                            <div className="flex min-w-0 items-center gap-1.5">
                              <span className="truncate text-[12.5px] font-medium" title={m.name}>
                                {m.meta?.source === 'civitai' ? m.meta.name : m.name.split('/').pop()}
                              </span>
                              {m.partial && <Badge tone="warning">Partial download</Badge>}
                            </div>
                            <div className="truncate text-[10.5px] text-fg-3" title={m.path}>
                              {folderLabel(m.folder)} · {m.name}
                            </div>
                          </div>
                        </div>
                        <KindTag kind={m.kind} className="justify-self-start" />
                        <div className="flex min-w-0 flex-wrap gap-1">
                          {m.usedBy.length ? (
                            <>
                              {m.usedBy.slice(0, 2).map((u) => (
                                <span key={u.id} className="max-w-full truncate rounded-md border border-line bg-white/[0.04] px-1.5 py-0.5 text-[10.5px] text-fg-2">
                                  {u.name}
                                </span>
                              ))}
                              {m.usedBy.length > 2 && (
                                <Tooltip content={m.usedBy.map((u) => u.name).join(', ')}>
                                  <span className="px-1 text-[10.5px] text-fg-3">+{m.usedBy.length - 2}</span>
                                </Tooltip>
                              )}
                            </>
                          ) : (
                            <span className="text-[10.5px] text-fg-3/70">Not used by a recipe</span>
                          )}
                        </div>
                        <span className="truncate text-[11px] text-fg-3" title={locName.get(m.locationId)}>
                          {locName.get(m.locationId) ?? '—'}
                        </span>
                        <span className="text-right text-[11.5px] text-fg-2 tabular-nums">{formatBytes(m.size)}</span>
                        <div className="flex justify-end gap-0.5 opacity-60 transition-opacity group-hover:opacity-100">
                          <IconButton label="Show in folder" size="xs" onClick={() => void invoke('sys:showInFolder', m.path)}>
                            <FolderOpen className="size-3.5" />
                          </IconButton>
                          <IconButton label="Delete" size="xs" className="hover:text-danger" onClick={() => setConfirm(m)}>
                            <Trash2 className="size-3.5" />
                          </IconButton>
                        </div>
                      </>
                    )}
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          )}
        </div>
      </section>

      {/* Catalog */}
      <section className="space-y-3">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h3 className="flex items-center gap-2 text-[14px] font-semibold tracking-tight">
              <Download className="size-4 text-accent" /> Recipe models
            </h3>
            <p className="mt-1 text-[12px] text-fg-3">Exact files each built-in recipe needs, from Hugging Face — sizes and checksums verified.</p>
          </div>
        </div>
        <motion.div variants={stagger(0.03, 0.02)} initial="initial" animate="animate" className="grid grid-cols-3 gap-3 max-md:grid-cols-1 max-md:gap-2.5">
          {catalog.map((e) => (
            <CatalogCard key={e.id} id={e.id} onInstall={() => setInstallEntry(e.id)} />
          ))}
        </motion.div>
      </section>

      <Dialog
        open={!!confirm}
        onOpenChange={(o) => !o && setConfirm(null)}
        width={480}
        title="Move to the Recycle Bin?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button variant="danger" loading={deleting} icon={<Trash2 className="size-3.5" />} onClick={() => void trash()}>
              Move to Recycle Bin
            </Button>
          </>
        }
      >
        {confirm && (
          <div className="space-y-3 p-5 text-[12.5px] leading-relaxed text-fg-2">
            <div>
              <div className="font-semibold text-fg">{confirm.name.split('/').pop()}</div>
              <div className="mt-0.5 font-mono text-[11px] break-all text-fg-3">{confirm.path}</div>
            </div>
            <p>
              {formatBytes(confirm.size)} plus its preview and metadata files go to the Recycle Bin — restore them from there if you change your mind.
            </p>
            {confirm.usedBy.some((u) => u.id !== 'loras') && (
              <p className="rounded-xl border border-warning/25 bg-warning/[0.07] p-3 text-[12px] text-fg-2">
                <b className="text-warning">In use:</b> {confirm.usedBy.filter((u) => u.id !== 'loras').map((u) => u.name).join(', ')} may stop working without it.
              </p>
            )}
          </div>
        )}
      </Dialog>
      <InstallDialog
        open={!!installEntry}
        onOpenChange={(o) => !o && setInstallEntry(null)}
        entryId={installEntry ?? undefined}
        title={catalog.find((e) => e.id === installEntry)?.name}
      />
      <HfTokenDialog
        open={tokenOpen}
        onOpenChange={(o) => {
          setTokenOpen(o)
          if (!o) reloadHf()
        }}
      />
      {home && home.kind === 'app' && !home.exists && (
        <p className="text-[11.5px] text-fg-3">{homeLabel('app')} is created on the first download.</p>
      )}
    </motion.div>
  )
}
