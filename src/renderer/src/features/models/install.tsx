// Installing missing recipe models from the curated Hugging Face catalog:
// the plan hook, the "Download model" card on Generate, a compact button for
// other recipe cards, the install dialog (variant, destination, licence) and
// the optional Hugging Face token dialog for gated repos.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { AlertTriangle, Check, CircleAlert, Copy, Download, ExternalLink, FolderOpen, FolderPlus, HardDriveDownload, KeyRound, Link2, RotateCcw, Unplug, X } from 'lucide-react'
import type { CatalogEntry, DownloadState, InstallPlan, InstallPlanFile, RecipeInfo } from '@shared/types'
import { folderLabel } from '@shared/civitai'
import { errorText, invoke, on } from '@/lib/api'
import { cn, formatBytes, formatEta, pluralize } from '@/lib/utils'
import { ease, spring, springSoft } from '@/lib/motion'
import { Button, IconButton } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge, Field, ProgressBar, Skeleton, Spinner } from '@/components/ui/misc'
import { Dialog, Tooltip } from '@/components/ui/overlay'
import { useGen } from '@/stores/gen'
import { toast } from '@/stores/toast'
import { useCivitai } from './store'

// ─── Plans & progress ────────────────────────────────────────────────────────

const pendingStatus = (d: DownloadState): boolean => d.status === 'queued' || d.status === 'downloading'

/** Refresh recipe availability after files land (ComfyUI re-lists a moment later). */
export function refreshAfterInstall(): void {
  const gen = useGen.getState()
  for (const ms of [400, 2500]) {
    setTimeout(() => {
      void gen.refreshRecipes()
      void gen.loadModels()
    }, ms)
  }
}

/** What a recipe (or catalog entry) still needs; follows downloads and model changes. */
export function useInstallPlan(recipeId: string | undefined, opts: { entryId?: string; enabled?: boolean } = {}): { plan: InstallPlan | null; error?: string; reload: () => void } {
  const enabled = opts.enabled !== false && (!!recipeId || !!opts.entryId)
  const [plan, setPlan] = useState<InstallPlan | null>(null)
  const [error, setError] = useState<string>()
  const downloads = useCivitai((s) => s.downloads)
  const group = recipeId ? `recipe:${recipeId}` : `entry:${opts.entryId}`
  // Re-plan when a download of this group changes state (not on every progress tick).
  const sig = useMemo(
    () =>
      Object.values(downloads)
        .filter((d) => d.group === group)
        .map((d) => `${d.id}:${d.status}`)
        .join(','),
    [downloads, group]
  )
  useEffect(() => {
    useCivitai.getState().initDownloads()
  }, [])
  const reload = useCallback(() => {
    if (!enabled) return
    invoke('models:installPlan', recipeId ?? '', opts.entryId)
      .then((p) => {
        setPlan(p)
        setError(undefined)
      })
      .catch((err) => setError(errorText(err)))
  }, [enabled, recipeId, opts.entryId])
  useEffect(() => {
    if (!enabled) {
      setPlan(null)
      return
    }
    reload()
  }, [enabled, reload, sig])
  useEffect(() => {
    if (!enabled) return
    let t: ReturnType<typeof setTimeout> | undefined
    const off = on('models:changed', () => {
      clearTimeout(t)
      t = setTimeout(reload, 300)
    })
    return () => {
      clearTimeout(t)
      off()
    }
  }, [enabled, reload])
  return { plan: enabled ? plan : null, error, reload }
}

/** Download size of each recipe's missing files (recipes the catalog can't supply are left out). */
export function useInstallSizes(recipeIds: string[]): Record<string, number> {
  const [sizes, setSizes] = useState<Record<string, number>>({})
  const key = recipeIds.join(',')
  useEffect(() => {
    if (!key) return
    let alive = true
    void Promise.all(key.split(',').map((id) => invoke('models:installPlan', id).then((p) => [id, p.files.some((f) => f.status === 'missing') ? p.bytes : 0] as const).catch(() => [id, 0] as const))).then(
      (pairs) => alive && setSizes(Object.fromEntries(pairs.filter(([, b]) => b > 0)))
    )
    return () => {
      alive = false
    }
  }, [key])
  return sizes
}

export interface GroupProgress {
  pending: DownloadState[]
  failed: DownloadState[]
  received: number
  total: number
  speed: number
  eta?: number
}

/** Combined progress of an install batch (all files queued together). */
export function useGroupProgress(group: string): GroupProgress {
  const downloads = useCivitai((s) => s.downloads)
  const [, tick] = useState(0)
  const list = useMemo(() => Object.values(downloads).filter((d) => d.group === group), [downloads, group])
  const pending = list.filter(pendingStatus)
  useEffect(() => {
    if (!pending.length) return
    const t = setInterval(() => tick((x) => x + 1), 1000)
    return () => clearInterval(t)
  }, [pending.length])
  const since = pending.length ? Math.min(...pending.map((d) => d.startedAt)) : Infinity
  const batch = list.filter((d) => pendingStatus(d) || (d.status === 'done' && d.startedAt >= since))
  const received = batch.reduce((n, d) => n + (d.status === 'done' ? d.total : d.received), 0)
  const total = batch.reduce((n, d) => n + d.total, 0)
  const now = Date.now()
  const speed = pending.filter((d) => d.status === 'downloading').reduce((n, d) => n + (now - d.startedAt > 1500 ? d.received / ((now - d.startedAt) / 1000) : 0), 0)
  // Failures of each file's latest attempt only (a successful retry supersedes them).
  const latest = new Map<string, DownloadState>()
  for (const d of list) {
    const k = (d.path ?? d.id).toLowerCase()
    const prev = latest.get(k)
    if (!prev || d.startedAt >= prev.startedAt) latest.set(k, d)
  }
  const failed = pending.length ? [] : [...latest.values()].filter((d) => d.status === 'error')
  return { pending, failed, received, total, speed, eta: speed > 0 && total ? (total - received) / speed : undefined }
}

// ─── Small pieces ────────────────────────────────────────────────────────────

const STATUS: Record<InstallPlanFile['status'], { label: string; tone: 'success' | 'warning' | 'default' | 'accent' }> = {
  installed: { label: 'Installed', tone: 'success' },
  hidden: { label: 'On disk', tone: 'warning' },
  missing: { label: 'Needed', tone: 'default' },
  queued: { label: 'Queued', tone: 'accent' },
  downloading: { label: 'Downloading', tone: 'accent' }
}

function FileRow({ f, download }: { f: InstallPlanFile; download?: DownloadState }): React.JSX.Element {
  const s = STATUS[f.status]
  const pct = download && download.total ? download.received / download.total : undefined
  return (
    <div className="flex items-start gap-3 py-2">
      <span
        className={cn(
          'mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg border [&>svg]:size-3.5',
          f.status === 'installed' ? 'border-success/25 bg-success/10 text-success' : f.status === 'hidden' ? 'border-warning/25 bg-warning/10 text-warning' : 'border-line bg-white/[0.04] text-fg-2'
        )}
      >
        {f.status === 'installed' ? <Check /> : f.status === 'hidden' ? <CircleAlert /> : <Download />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="min-w-0 truncate text-[12.5px] font-medium" title={f.name}>
            {f.name}
          </span>
          <Badge tone={s.tone} className="shrink-0">
            {s.label}
          </Badge>
        </div>
        <div className="mt-0.5 truncate text-[11px] text-fg-3">
          {[f.label, folderLabel(f.folder)].filter(Boolean).join(' · ')}
          {f.size ? ` · ${formatBytes(f.size)}` : ''}
          {f.status === 'missing' && f.repo ? ` · ${f.repo}` : ''}
        </div>
        {download && pendingStatus(download) && <ProgressBar value={pct} className="mt-1.5" />}
      </div>
    </div>
  )
}

/** Where downloads go by default, in words. */
export function homeLabel(source: InstallPlan['home']['source']): string {
  return source === 'settings' ? 'Your models folder' : source === 'stability-matrix' ? 'Stability Matrix shared models' : 'Stitch models folder'
}

// ─── Install dialog ──────────────────────────────────────────────────────────

export function InstallDialog({
  open,
  onOpenChange,
  recipeId,
  entryId: initialEntry,
  title
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  recipeId?: string
  entryId?: string
  title?: string
}): React.JSX.Element {
  const [entryId, setEntryId] = useState<string | undefined>(initialEntry)
  const [where, setWhere] = useState<'default' | 'custom'>('default')
  const [custom, setCustom] = useState<string>('')
  const [busy, setBusy] = useState(false)
  const [tokenOpen, setTokenOpen] = useState(false)
  const comfy = useGen((s) => s.comfy)
  const downloads = useCivitai((s) => s.downloads)
  const catalog = useCatalog()
  const { plan, error, reload } = useInstallPlan(recipeId, { entryId, enabled: open })
  useEffect(() => {
    if (open) {
      setEntryId(initialEntry)
      setWhere('default')
      setBusy(false)
    }
  }, [open, initialEntry])

  const entry = catalog.find((e) => e.id === (plan?.entryId ?? entryId))
  const missing = plan?.files.filter((f) => f.status === 'missing') ?? []
  const external = comfy.some((c) => !c.managed)
  const managed = comfy.some((c) => c.managed)
  const byPath = useMemo(() => new Map(Object.values(downloads).filter(pendingStatus).map((d) => [d.path?.toLowerCase(), d])), [downloads])

  const pick = async (): Promise<void> => {
    const p = await invoke('sys:pickFolder', { title: 'Choose where the models go (subfolders like VAE or checkpoints are created inside)', defaultPath: custom || plan?.home.path })
    if (p) {
      setCustom(p)
      setWhere('custom')
    }
  }

  const start = async (): Promise<void> => {
    if (!plan) return
    if (where === 'custom' && !custom) return void pick()
    setBusy(true)
    try {
      const started = await invoke('models:install', { recipeId: recipeId || undefined, entryId: plan.entryId ?? entryId, dest: where === 'custom' ? custom : undefined })
      if (started.length) toast.info(`Downloading ${pluralize(started.length, 'file')}`, `${formatBytes(started.reduce((n, d) => n + d.total, 0))} from Hugging Face`)
      else toast.info('Nothing to download', 'Everything is already on disk.')
      onOpenChange(false)
    } catch (err) {
      toast.error('Could not start the download', errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const visibility =
    where === 'custom'
      ? `Stitch remembers this folder, lists its models and hands it to the ComfyUI it runs${managed ? ' (restart those instances to pick it up)' : ''}.${external ? ' A ComfyUI you run yourself needs it in its extra_model_paths.yaml — Settings → Models & storage → Copy ComfyUI paths.' : ''}`
      : plan?.home.externalComfySees
        ? 'ComfyUI already reads this folder — new files show up without a restart.'
        : external
          ? 'Your own ComfyUI doesn’t read this folder yet: Settings → Models & storage → Copy ComfyUI paths, add them to its extra_model_paths.yaml and restart it. Stitch-run ComfyUI sees it automatically.'
          : 'Stitch’s ComfyUI instances read this folder automatically.'

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={onOpenChange}
        width={580}
        title={
          <span className="flex items-center gap-2.5">
            <span className="grid size-7 place-items-center rounded-lg bg-grad text-white">
              <HardDriveDownload className="size-3.5" />
            </span>
            {title ? `Install ${title}` : 'Install models'}
          </span>
        }
        description="Downloads from Hugging Face, checks each file’s size and checksum, and resumes if interrupted."
        footer={
          <>
            {entry?.url && (
              <Button variant="ghost" size="sm" icon={<ExternalLink className="size-3.5" />} onClick={() => void invoke('sys:openExternal', entry.url!)}>
                Model page
              </Button>
            )}
            <div className="flex-1" />
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button variant="primary" loading={busy} disabled={!plan || !missing.length} icon={<Download className="size-3.5" />} onClick={() => void start()}>
              {missing.length ? `Download · ${formatBytes(plan?.bytes)}` : 'Nothing to download'}
            </Button>
          </>
        }
      >
        <div className="min-w-0 space-y-5 p-5">
          {error && <div className="rounded-xl border border-danger/25 bg-danger/10 p-3 text-[12px] text-danger">{error}</div>}
          {!plan && !error && (
            <div className="space-y-2">
              <Skeleton className="h-12" />
              <Skeleton className="h-12" />
            </div>
          )}

          {plan && plan.alternatives.length > 1 && (
            <section className="space-y-2">
              <span className="label-caps">Version</span>
              <div className="grid grid-cols-[minmax(0,1fr)] gap-1.5">
                {plan.alternatives.map((a) => {
                  const active = (plan.entryId ?? entryId) === a.id
                  return (
                    <button
                      key={a.id}
                      onClick={() => setEntryId(a.id)}
                      className={cn('relative flex items-start gap-3 rounded-xl border p-3 text-left transition-colors', active ? 'border-transparent' : 'border-line bg-white/[0.02] hover:bg-white/[0.05]')}
                    >
                      {active && (
                        <motion.span
                          layoutId="install-variant"
                          className="absolute inset-0 rounded-xl border border-[color-mix(in_oklab,var(--accent)_45%,transparent)] bg-[color-mix(in_oklab,var(--accent)_9%,transparent)]"
                          transition={springSoft}
                        />
                      )}
                      <div className="relative min-w-0 flex-1">
                        <div className="text-[12.5px] font-semibold">{a.name}</div>
                        <div className="mt-0.5 text-[11.5px] leading-snug text-fg-3">{a.description}</div>
                      </div>
                      <span className="relative shrink-0 text-[11.5px] font-medium text-fg-2 tabular-nums">{formatBytes(a.bytes)}</span>
                    </button>
                  )
                })}
              </div>
            </section>
          )}

          {plan && (
            <section className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="label-caps">Files</span>
                <span className="text-[11px] text-fg-3">{missing.length ? `${pluralize(missing.length, 'file')} to download · ${formatBytes(plan.bytes)}` : 'All present'}</span>
              </div>
              <div className="divide-y divide-line rounded-xl border border-line px-3">
                {plan.files.map((f) => (
                  <FileRow key={`${f.folder}/${f.name}`} f={f} download={f.dest ? byPath.get(f.dest.toLowerCase()) : undefined} />
                ))}
              </div>
              {plan.unknown.length > 0 && (
                <p className="pt-1 text-[11.5px] text-warning">No download source for: {plan.unknown.join(', ')} — get it from Civitai or the model’s page.</p>
              )}
              {plan.files.some((f) => f.status === 'hidden') && (
                <p className="pt-1 text-[11.5px] text-fg-3">“On disk” files are downloaded but ComfyUI doesn’t list them yet — see the note below.</p>
              )}
            </section>
          )}

          {plan && missing.length > 0 && (
            <section className="space-y-2">
              <span className="label-caps">Save to</span>
              <div className="grid grid-cols-[minmax(0,1fr)] gap-1.5">
                {(
                  [
                    { value: 'default', icon: <HardDriveDownload />, title: `Default · ${homeLabel(plan.home.source)}`, path: plan.home.path },
                    { value: 'custom', icon: <FolderPlus />, title: 'Another folder…', path: custom || 'Pick a folder — model subfolders are created inside it' }
                  ] as const
                ).map((o) => {
                  const active = where === o.value
                  return (
                    <button
                      key={o.value}
                      onClick={() => (o.value === 'custom' && !custom ? void pick() : setWhere(o.value))}
                      className={cn('relative flex items-center gap-3 rounded-xl border p-3 text-left transition-colors', active ? 'border-transparent' : 'border-line bg-white/[0.02] hover:bg-white/[0.05]')}
                    >
                      {active && (
                        <motion.span
                          layoutId="install-dest"
                          className="absolute inset-0 rounded-xl border border-[color-mix(in_oklab,var(--accent)_45%,transparent)] bg-[color-mix(in_oklab,var(--accent)_9%,transparent)]"
                          transition={springSoft}
                        />
                      )}
                      <span className="relative text-fg-2 [&>svg]:size-4">{o.icon}</span>
                      <div className="relative min-w-0 flex-1">
                        <div className="text-[12.5px] font-semibold">{o.title}</div>
                        <div className="mt-0.5 truncate font-mono text-[11px] text-fg-3" title={o.path}>
                          {o.path}
                        </div>
                      </div>
                      {o.value === 'custom' && custom && (
                        <span
                          role="button"
                          onClick={(e) => {
                            e.stopPropagation()
                            void pick()
                          }}
                          className="relative text-[11.5px] font-medium text-accent hover:brightness-125"
                        >
                          Change
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
              <p className="text-[11.5px] leading-relaxed text-fg-3">{visibility}</p>
            </section>
          )}

          {plan?.gated && !plan.hasHfToken && (
            <div className="flex items-center gap-3 rounded-xl border border-warning/25 bg-warning/[0.07] p-3 text-[12px] text-fg-2">
              <KeyRound className="size-4 shrink-0 text-warning" />
              <span className="flex-1">This model is gated on Hugging Face: accept its licence on the model page, then add a read token.</span>
              <Button size="sm" onClick={() => setTokenOpen(true)}>
                Add token
              </Button>
            </div>
          )}

          {entry?.license && (
            <p className="text-[11.5px] leading-relaxed text-fg-3">
              <b className="font-semibold text-fg-2">Licence:</b> {entry.license}. By downloading you accept the model’s licence.
            </p>
          )}
        </div>
      </Dialog>
      <HfTokenDialog
        open={tokenOpen}
        onOpenChange={(o) => {
          setTokenOpen(o)
          if (!o) reload()
        }}
      />
    </>
  )
}

// ─── Catalog ─────────────────────────────────────────────────────────────────

let catalogCache: CatalogEntry[] | null = null

/** The curated download catalog (static for a session). */
export function useCatalog(): CatalogEntry[] {
  const [list, setList] = useState<CatalogEntry[]>(catalogCache ?? [])
  useEffect(() => {
    if (catalogCache) return
    void invoke('models:catalog').then((c) => {
      catalogCache = c
      setList(c)
    })
  }, [])
  return list
}

// ─── Generate page card ──────────────────────────────────────────────────────

/**
 * Replaces the "missing files" dead end on Generate: a Download button with
 * the size, live progress, errors with retry, and what to do when files are
 * on disk but ComfyUI can't see them.
 */
export function InstallModelsCard({ recipe }: { recipe: RecipeInfo }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const { plan } = useInstallPlan(recipe.id, { enabled: recipe.builtin && !recipe.available })
  const group = useGroupProgress(`recipe:${recipe.id}`)
  const wasPending = useRef(false)
  useEffect(() => {
    if (group.pending.length) wasPending.current = true
    else if (wasPending.current) {
      wasPending.current = false
      refreshAfterInstall()
    }
  }, [group.pending.length, wasPending])

  const missing = plan?.files.filter((f) => f.status === 'missing') ?? []
  const hidden = plan?.files.filter((f) => f.status === 'hidden') ?? []
  const downloading = group.pending.length > 0
  const canDownload = missing.length > 0

  const retry = async (): Promise<void> => {
    try {
      // Resume into the folder the failed attempt used (its .part is there).
      const failedAt = group.failed[0]?.path?.replace(/[\\/][^\\/]+$/, '')
      await invoke('models:install', { recipeId: recipe.id, entryId: plan?.entryId, dest: failedAt })
    } catch (err) {
      toast.error('Could not resume', errorText(err))
    }
  }

  return (
    <motion.div layout initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={springSoft} className="glass hairline relative overflow-hidden rounded-2xl p-3.5">
      <div className="pointer-events-none absolute -top-10 -right-10 size-32 rounded-full bg-grad opacity-[0.12] blur-2xl" />
      <div className="relative flex items-start gap-3">
        <span className={cn('grid size-9 shrink-0 place-items-center rounded-xl [&>svg]:size-4', downloading ? 'bg-white/[0.06] text-accent' : 'bg-grad text-white')}>
          {downloading ? <Spinner /> : <HardDriveDownload />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold">{downloading ? `Downloading ${recipe.name}` : hidden.length && !canDownload ? 'Almost ready' : `${recipe.name} needs its model`}</div>
          <div className="mt-0.5 text-[11.5px] leading-snug text-fg-3">
            {!plan
              ? 'Checking what’s needed…'
              : downloading
                ? `${formatBytes(group.received)} of ${formatBytes(group.total)}${group.speed ? ` · ${formatBytes(group.speed)}/s` : ''}${group.eta ? ` · ${formatEta(group.eta)} left` : ''}`
                : canDownload
                  ? `${pluralize(missing.length, 'file')} · ${formatBytes(plan.bytes)} from Hugging Face`
                  : hidden.length
                    ? 'The files are downloaded, but ComfyUI doesn’t list them yet.'
                    : `Missing: ${recipe.missing?.join(', ')}`}
          </div>
        </div>
      </div>

      <AnimatePresence initial={false} mode="wait">
        {downloading ? (
          <motion.div key="progress" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.25, ease }} className="relative mt-3 space-y-2">
            <ProgressBar value={group.total ? group.received / group.total : undefined} />
            <div className="flex items-center justify-between gap-2 text-[11px] text-fg-3">
              <span className="truncate">
                {group.pending.find((d) => d.status === 'downloading')?.note ?? group.pending.find((d) => d.status === 'downloading')?.name ?? 'Queued'}
                {group.pending.length > 1 ? ` · ${group.pending.length - 1} more` : ''}
              </span>
              <button
                onClick={() => {
                  for (const d of group.pending) void invoke('civitai:cancelDownload', d.id)
                }}
                className="flex shrink-0 items-center gap-1 font-medium text-fg-3 transition hover:text-danger"
              >
                <X className="size-3" /> Cancel
              </button>
            </div>
          </motion.div>
        ) : (
          <motion.div key="actions" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.25, ease }} className="relative mt-3 space-y-2.5">
            {group.failed.length > 0 && (
              <div className="flex items-start gap-2 rounded-lg border border-danger/20 bg-danger/[0.07] px-2.5 py-2 text-[11.5px] text-danger">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                <span className="line-clamp-3 flex-1">{group.failed[0].error}</span>
              </div>
            )}
            {canDownload ? (
              <div className="flex gap-2">
                {group.failed.length > 0 ? (
                  <Button variant="primary" className="flex-1" icon={<RotateCcw className="size-3.5" />} onClick={() => void retry()}>
                    Resume download
                  </Button>
                ) : (
                  <Button variant="primary" className="flex-1" icon={<Download className="size-3.5" />} onClick={() => setOpen(true)}>
                    Download model · {formatBytes(plan?.bytes)}
                  </Button>
                )}
                {group.failed.length > 0 && (
                  <Tooltip content="Options">
                    <IconButton label="Install options" variant="secondary" onClick={() => setOpen(true)}>
                      <FolderOpen className="size-3.5" />
                    </IconButton>
                  </Tooltip>
                )}
              </div>
            ) : hidden.length ? (
              <HiddenHelp />
            ) : plan ? (
              <p className="text-[11.5px] leading-relaxed text-fg-3">Stitch has no download source for these files. Put them in your models folder (Settings → Models & storage) or grab them from Civitai.</p>
            ) : null}
            {canDownload && plan?.unknown.length ? <p className="text-[11px] text-warning">Also needs {plan.unknown.join(', ')} (no download source).</p> : null}
          </motion.div>
        )}
      </AnimatePresence>
      <InstallDialog open={open} onOpenChange={setOpen} recipeId={recipe.id} entryId={plan?.entryId} title={recipe.name} />
    </motion.div>
  )
}

/** What to do when files are on disk but ComfyUI doesn't list them. */
export function HiddenHelp(): React.JSX.Element {
  const comfy = useGen((s) => s.comfy)
  const external = comfy.some((c) => !c.managed && c.online)
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(await invoke('models:comfyYaml'))
      toast.success('ComfyUI paths copied', 'Paste them into ComfyUI/extra_model_paths.yaml and restart ComfyUI.')
    } catch (err) {
      toast.error('Could not copy', errorText(err))
    }
  }
  return (
    <div className="space-y-2">
      <p className="text-[11.5px] leading-relaxed text-fg-3">
        {external
          ? 'Your ComfyUI doesn’t read the folder they’re in. Add Stitch’s model folders to its extra_model_paths.yaml and restart it.'
          : 'Restart ComfyUI so it re-reads its model folders, then check again.'}
      </p>
      <div className="flex gap-2">
        <Button size="sm" icon={<Copy className="size-3.5" />} onClick={() => void copy()}>
          Copy ComfyUI paths
        </Button>
        <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" />} onClick={() => refreshAfterInstall()}>
          Check again
        </Button>
      </div>
    </div>
  )
}

/** Compact "Install missing models" for recipe cards elsewhere (Studio, story side panel…). */
export function InstallMissingButton({ recipe, className, size = 'xs' }: { recipe: RecipeInfo; className?: string; size?: 'xs' | 'sm' }): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const { plan } = useInstallPlan(recipe.id, { enabled: recipe.builtin && !recipe.available })
  const group = useGroupProgress(`recipe:${recipe.id}`)
  if (!recipe.builtin || recipe.available || !plan) return null
  const missing = plan.files.filter((f) => f.status === 'missing')
  if (group.pending.length) {
    return (
      <span className={cn('inline-flex items-center gap-1.5 text-[11px] font-medium text-accent', className)}>
        <Spinner className="size-3" /> {group.total ? `${Math.round((group.received / group.total) * 100)}%` : 'Starting…'}
      </span>
    )
  }
  if (!missing.length) return null
  return (
    <>
      <Button size={size} variant="secondary" className={className} icon={<Download className="size-3" />} onClick={() => setOpen(true)}>
        Install missing models · {formatBytes(plan.bytes)}
      </Button>
      <InstallDialog open={open} onOpenChange={setOpen} recipeId={recipe.id} entryId={plan.entryId} title={recipe.name} />
    </>
  )
}

// ─── Hugging Face token ──────────────────────────────────────────────────────

export function useHfStatus(): { status: { hasToken: boolean; username?: string } | null; reload: () => void } {
  const [status, setStatus] = useState<{ hasToken: boolean; username?: string } | null>(null)
  const reload = useCallback(() => {
    void invoke('hf:status')
      .then(setStatus)
      .catch(() => setStatus({ hasToken: false }))
  }, [])
  useEffect(reload, [reload])
  return { status, reload }
}

/** Hugging Face monogram in the theme gradient. */
export function HfMark({ size = 18 }: { size?: number }): React.JSX.Element {
  return (
    <span
      className="grid shrink-0 place-items-center bg-grad font-bold tracking-tight text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.25)]"
      style={{ width: size, height: size, fontSize: size * 0.4, borderRadius: Math.max(5, size * 0.3) }}
    >
      HF
    </span>
  )
}

export function HfTokenDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }): React.JSX.Element {
  const { status, reload } = useHfStatus()
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)
  useEffect(() => {
    if (open) {
      setToken('')
      setResult(null)
      reload()
    }
  }, [open, reload])
  const save = async (value: string | null): Promise<void> => {
    setBusy(true)
    setResult(null)
    try {
      const r = await invoke('hf:setToken', value)
      setResult(r)
      reload()
      if (r.ok) {
        toast.success(value ? 'Hugging Face token saved' : 'Hugging Face token removed', r.message)
        setTimeout(() => onOpenChange(false), 650)
      }
    } catch (err) {
      setResult({ ok: false, message: errorText(err) })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      width={480}
      title={
        <span className="flex items-center gap-2.5">
          <HfMark size={26} /> Hugging Face token
        </span>
      }
      footer={
        <>
          <Button variant="ghost" size="sm" icon={<ExternalLink className="size-3.5" />} onClick={() => void invoke('sys:openExternal', 'https://huggingface.co/settings/tokens')}>
            Get a token
          </Button>
          {status?.hasToken && (
            <Button variant="ghost" size="sm" icon={<Unplug className="size-3.5" />} disabled={busy} onClick={() => void save(null)}>
              Remove
            </Button>
          )}
          <div className="flex-1" />
          <Button variant="primary" loading={busy} disabled={!token.trim()} icon={<Link2 className="size-3.5" />} onClick={() => void save(token)}>
            Save & test
          </Button>
        </>
      }
    >
      <div className="space-y-4 p-5">
        <p className="text-[12.5px] leading-relaxed text-fg-2">
          Only needed for gated models (and higher download rate limits). Accept the model’s licence on its Hugging Face page, then paste a <b className="text-fg">read</b> token.
        </p>
        {status?.hasToken && (
          <div className="flex items-center gap-2 rounded-xl border border-success/25 bg-success/10 px-3 py-2 text-[12px] text-success">
            <Check className="size-3.5" /> {status.username ? `Connected as ${status.username}` : 'A token is saved'}
          </div>
        )}
        <Field label="Token" help="Stored encrypted with your Windows account; only ever sent to huggingface.co.">
          <Input
            type="password"
            autoFocus
            icon={<KeyRound />}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && token.trim() && void save(token)}
            placeholder={status?.hasToken ? 'Paste a new token to replace it' : 'hf_…'}
          />
        </Field>
        <AnimatePresence>
          {result && (
            <motion.div
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={spring}
              className={cn('rounded-xl border p-3 text-[12px]', result.ok ? 'border-success/25 bg-success/10 text-success' : 'border-danger/25 bg-danger/10 text-danger')}
            >
              {result.message}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </Dialog>
  )
}
