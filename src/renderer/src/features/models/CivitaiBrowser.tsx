// "Browse Civitai": search with type/base-model filters and infinite scroll,
// plus a detail drawer with gallery, versions, files and one-click download.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Check, ChevronLeft, ChevronRight, CircleAlert, Copy, Download, FolderOpen, Globe, KeyRound, SlidersHorizontal, ThumbsUp, X } from 'lucide-react'
import type { CivitaiFile, CivitaiModel, CivitaiQuery, CivitaiVersion, LocalModel } from '@shared/types'
import { baseFamily, CIVITAI_TYPE_FILTERS, FAMILY_ORDER, folderForCivitai, folderLabel, kindForCivitaiType, MODEL_FOLDERS } from '@shared/civitai'
import { errorText, invoke } from '@/lib/api'
import { cn, formatBytes } from '@/lib/utils'
import { ease, spring } from '@/lib/motion'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/controls'
import { SearchField } from '@/components/ui/input'
import { Avatar, Badge, EmptyState, ProgressBar, Skeleton } from '@/components/ui/misc'
import { Popover, Select, Tooltip } from '@/components/ui/overlay'
import { BaseTag, CivitaiMedia, civitaiImageIsNsfw, copyText, formatCount, KindTag, kindColor, kindTone, WordChip } from '@/components/model-tags'
import { useLocalModels } from '@/components/model-library'
import { toast } from '@/stores/toast'
import { Description, Drawer, Section } from './parts'
import { type BrowseFilters, useCivitai } from './store'

const SORTS = ['Highest Rated', 'Most Downloaded', 'Newest']
const PERIODS: { value: string; label: string }[] = [
  { value: 'AllTime', label: 'All time' },
  { value: 'Year', label: 'This year' },
  { value: 'Month', label: 'This month' },
  { value: 'Week', label: 'This week' },
  { value: 'Day', label: 'Today' }
]

function queryFor(f: BrowseFilters): CivitaiQuery {
  return {
    query: f.query || undefined,
    types: CIVITAI_TYPE_FILTERS.filter((t) => f.types.includes(t.label)).flatMap((t) => t.types),
    baseModels: f.baseModels,
    sort: f.sort,
    period: f.period,
    nsfw: f.nsfw
  }
}

// ─── Base model picker ───────────────────────────────────────────────────────

function BaseModelPicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }): React.JSX.Element {
  const all = useCivitai((s) => s.baseModels)
  const load = useCivitai((s) => s.loadBaseModels)
  const [q, setQ] = useState('')
  useEffect(() => {
    void load()
  }, [load])
  const groups = useMemo(() => {
    const t = q.trim().toLowerCase()
    const map = new Map<string, string[]>()
    for (const b of all) {
      if (t && !b.toLowerCase().includes(t) && !baseFamily(b).toLowerCase().includes(t)) continue
      const fam = baseFamily(b)
      map.set(fam, [...(map.get(fam) ?? []), b])
    }
    const rank = (f: string): number => (FAMILY_ORDER.indexOf(f) + 1 || FAMILY_ORDER.length + 1)
    return [...map.entries()].sort((a, b) => rank(a[0]) - rank(b[0]))
  }, [all, q])
  const toggle = (b: string): void => onChange(value.includes(b) ? value.filter((x) => x !== b) : [...value, b])
  return (
    <Popover
      align="start"
      className="w-[440px] p-0"
      trigger={
        <Button size="sm" variant={value.length ? 'secondary' : 'outline'} icon={<SlidersHorizontal className="size-3.5" />} className={cn(value.length && 'border-[color-mix(in_oklab,var(--accent)_45%,transparent)]')}>
          {value.length === 0 ? 'Base models' : value.length === 1 ? value[0] : `${value.length} base models`}
        </Button>
      }
    >
      <div className="flex max-h-[min(560px,70vh)] flex-col">
        <div className="space-y-2 border-b border-line p-2.5">
          <SearchField autoFocus value={q} onChange={setQ} placeholder="Search base models (Flux, Krea, Qwen, Wan…)" />
          {value.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              {value.map((b) => (
                <button key={b} onClick={() => toggle(b)} className="inline-flex h-6 items-center gap-1 rounded-md bg-[color-mix(in_oklab,var(--accent)_16%,transparent)] px-1.5 text-[11px] font-medium text-fg">
                  {b} <X className="size-3 text-fg-3" />
                </button>
              ))}
              <button onClick={() => onChange([])} className="ml-auto text-[11px] font-medium text-fg-3 hover:text-fg">
                Clear
              </button>
            </div>
          )}
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
          {!all.length && <div className="py-8 text-center text-[12px] text-fg-3">Loading Civitai’s base models…</div>}
          {groups.map(([fam, list]) => (
            <div key={fam}>
              <div className="label-caps mb-1.5">{fam}</div>
              <div className="flex flex-wrap gap-1">
                {list.map((b) => {
                  const on = value.includes(b)
                  return (
                    <motion.button
                      key={b}
                      whileTap={{ scale: 0.95 }}
                      onClick={() => toggle(b)}
                      className={cn(
                        'inline-flex h-7 items-center gap-1 rounded-lg border px-2 text-[11.5px] font-medium transition-[background,border-color,color] duration-150',
                        on ? 'border-[color-mix(in_oklab,var(--accent)_45%,transparent)] bg-[color-mix(in_oklab,var(--accent)_14%,transparent)] text-fg' : 'border-line text-fg-2 hover:border-line-strong hover:bg-white/[0.05] hover:text-fg'
                      )}
                    >
                      {on && <Check className="size-3 text-accent" strokeWidth={3} />}
                      {b}
                    </motion.button>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </Popover>
  )
}

// ─── Card ────────────────────────────────────────────────────────────────────

function CivitaiCard({ model, index, downloaded, onOpen }: { model: CivitaiModel; index: number; downloaded: boolean; onOpen: () => void }): React.JSX.Element {
  const v = model.versions[0]
  const cover = v?.images[0] ?? model.versions.find((x) => x.images.length)?.images[0]
  const kind = kindForCivitaiType(model.type)
  return (
    <motion.div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => e.key === 'Enter' && onOpen()}
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0, transition: { duration: 0.45, ease, delay: (index % 24) * 0.018 } }}
      whileHover={{ y: -3 }}
      className="group glass hairline relative flex cursor-default flex-col overflow-hidden rounded-2xl outline-none transition-[border-color,box-shadow] duration-300 hover:border-line-strong hover:shadow-[0_18px_40px_-18px_rgb(0_0_0/0.8)] focus-visible:shadow-[var(--ring)]"
    >
      <div className="relative aspect-[4/5] overflow-hidden">
        <CivitaiMedia image={cover} kind={kind} modelNsfw={model.nsfw} allowReveal className="size-full transition-transform duration-700 ease-out group-hover:scale-[1.035]" />
        <div className="pointer-events-none absolute inset-x-0 top-0 h-16 bg-gradient-to-b from-black/45 to-transparent" />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-28 bg-gradient-to-t from-black/85 via-black/40 to-transparent" />
        <div className="absolute top-2 left-2 rounded-md bg-black/35 backdrop-blur-md">
          <KindTag kind={kind} icon />
        </div>
        {downloaded && (
          <span className="absolute top-2 right-2 inline-flex h-5 items-center gap-1 rounded-md border border-success/30 bg-black/45 px-1.5 text-[10.5px] font-semibold text-success backdrop-blur-md">
            <Check className="size-2.5" strokeWidth={3} /> In library
          </span>
        )}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 p-3">
          <div className="line-clamp-2 text-[13px] leading-snug font-semibold text-white drop-shadow">{model.name}</div>
          {model.creator && <div className="mt-0.5 truncate text-[11px] text-white/60">by {model.creator}</div>}
        </div>
      </div>
      <div className="flex min-w-0 items-center gap-2 px-2.5 py-2">
        <BaseTag base={v?.baseModel} className="min-w-0" />
        <span className="ml-auto flex shrink-0 items-center gap-2.5 text-[10.5px] text-fg-3 tabular-nums">
          <span className="flex items-center gap-0.5">
            <Download className="size-3" />
            {formatCount(model.stats?.downloadCount)}
          </span>
          <span className="flex items-center gap-0.5">
            <ThumbsUp className="size-3" />
            {formatCount(model.stats?.thumbsUpCount)}
          </span>
        </span>
      </div>
    </motion.div>
  )
}

function CardSkeleton(): React.JSX.Element {
  return (
    <div className="glass overflow-hidden rounded-2xl">
      <Skeleton className="aspect-[4/5] rounded-none" />
      <div className="flex items-center gap-2 px-2.5 py-2.5">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="ml-auto h-3 w-12" />
      </div>
    </div>
  )
}

// ─── Detail ──────────────────────────────────────────────────────────────────

function Carousel({ version, modelNsfw }: { version: CivitaiVersion; modelNsfw: boolean }): React.JSX.Element {
  const images = version.images
  const [[index, dir], setIndex] = useState<[number, number]>([0, 0])
  useEffect(() => setIndex([0, 0]), [version.id])
  const go = useCallback((d: number) => setIndex(([i]) => [(i + d + images.length) % images.length, d]), [images.length])
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.target as HTMLElement)?.closest('input,textarea')) return
      if (e.key === 'ArrowLeft') go(-1)
      if (e.key === 'ArrowRight') go(1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [go])
  const img = images[index]
  return (
    <div className="relative shrink-0">
      <div className="relative h-[440px] overflow-hidden bg-black/30">
        <AnimatePresence initial={false} custom={dir} mode="popLayout">
          <motion.div
            key={`${version.id}-${index}`}
            custom={dir}
            initial={{ opacity: 0, x: dir * 40, scale: 0.99 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: dir * -40, scale: 0.99 }}
            transition={{ duration: 0.35, ease }}
            className="absolute inset-0"
          >
            <CivitaiMedia image={img} modelNsfw={modelNsfw} width={900} play fit="contain" allowReveal className="size-full" />
          </motion.div>
        </AnimatePresence>
        {images.length > 1 && (
          <>
            <button onClick={() => go(-1)} className="absolute top-1/2 left-3 grid size-9 -translate-y-1/2 place-items-center rounded-full border border-white/10 bg-black/40 text-white/85 backdrop-blur-md transition hover:bg-black/60 hover:text-white">
              <ChevronLeft className="size-4.5" />
            </button>
            <button onClick={() => go(1)} className="absolute top-1/2 right-3 grid size-9 -translate-y-1/2 place-items-center rounded-full border border-white/10 bg-black/40 text-white/85 backdrop-blur-md transition hover:bg-black/60 hover:text-white">
              <ChevronRight className="size-4.5" />
            </button>
            <span className="absolute bottom-3 left-3 rounded-md bg-black/45 px-1.5 py-0.5 text-[10.5px] font-medium text-white/80 tabular-nums backdrop-blur">
              {index + 1} / {images.length}
            </span>
          </>
        )}
        {!images.length && <div className="grid size-full place-items-center text-[12px] text-fg-3">No preview images</div>}
      </div>
      {images.length > 1 && (
        <div className="flex gap-1.5 overflow-x-auto border-b border-line px-4 py-2.5 [scrollbar-width:thin]">
          {images.map((im, i) => (
            <button key={`${im.url}-${i}`} onClick={() => setIndex([i, i > index ? 1 : -1])} className="relative size-12 shrink-0 overflow-hidden rounded-lg">
              <CivitaiMedia image={im} modelNsfw={modelNsfw} width={120} compact className="size-full" />
              {i === index && <motion.span layoutId="civitai-thumb" className="absolute inset-0 rounded-lg ring-2 ring-accent ring-inset" transition={spring} />}
              {i !== index && <span className="absolute inset-0 rounded-lg bg-black/30 transition hover:bg-black/0" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function FileRow({ f, active, onClick }: { f: CivitaiFile; active: boolean; onClick: () => void }): React.JSX.Element {
  const meta = [f.type, f.metadata?.fp, f.metadata?.size, f.metadata?.format].filter(Boolean).join(' · ')
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-3 rounded-xl border p-2.5 text-left transition-[background,border-color] duration-200',
        active ? 'border-[color-mix(in_oklab,var(--accent)_45%,transparent)] bg-[color-mix(in_oklab,var(--accent)_8%,transparent)]' : 'border-line bg-white/[0.02] hover:bg-white/[0.05]'
      )}
    >
      <span className={cn('grid size-4 shrink-0 place-items-center rounded-full border transition', active ? 'border-transparent bg-grad' : 'border-line-strong')}>
        {active && <span className="size-1.5 rounded-full bg-white" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-[11.5px] text-fg">{f.name}</div>
        <div className="mt-0.5 truncate text-[10.5px] text-fg-3">{meta}</div>
      </div>
      {f.primary && <Badge tone="accent">Primary</Badge>}
      <span className="shrink-0 text-[11.5px] text-fg-2 tabular-nums">{formatBytes(f.sizeKB * 1024)}</span>
    </button>
  )
}

/** Without "Include NSFW results", keep galleries to what the search showed (PG/PG-13, plus unrated). */
function sfwOnly(m: CivitaiModel): CivitaiModel {
  return { ...m, versions: m.versions.map((v) => ({ ...v, images: v.images.filter((i) => i.nsfwLevel < 4) })) }
}

function CivitaiDetail({ initial, local }: { initial: CivitaiModel; local: LocalModel[] }): React.JSX.Element {
  const includeNsfw = useCivitai((s) => s.filters.nsfw)
  const [model, setModel] = useState(initial)
  const [versionId, setVersionId] = useState(initial.versions[0]?.id)
  const version = model.versions.find((v) => v.id === versionId) ?? model.versions[0]
  const [fileId, setFileId] = useState<number | undefined>()
  const [dest, setDest] = useState('auto')
  const [starting, setStarting] = useState(false)
  const status = useCivitai((s) => s.status)
  const setKeyDialog = useCivitai((s) => s.setKeyDialog)
  const downloads = useCivitai((s) => s.downloads)

  // Refresh with the full model (search results can be trimmed).
  useEffect(() => {
    let alive = true
    invoke('civitai:model', initial.id)
      .then((m) => alive && m.versions.length && setModel(includeNsfw ? m : sfwOnly(m)))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [initial.id, includeNsfw])

  const files = version?.files ?? []
  const file = files.find((f) => f.id === fileId) ?? files.find((f) => f.primary) ?? files[0]
  useEffect(() => setFileId(undefined), [versionId])
  const autoFolder = folderForCivitai(model.type, version?.baseModel, file?.type)
  const kind = kindForCivitaiType(model.type)
  const installed = local.find((m) => m.meta?.versionId === version?.id)
  const active = Object.values(downloads).find((d) => d.versionId === version?.id && d.status === 'downloading')
  const lastDone = Object.values(downloads)
    .filter((d) => d.versionId === version?.id && d.status === 'error')
    .sort((a, b) => b.startedAt - a.startedAt)[0]
  const guard = model.nsfw || !!version?.images.some((i) => civitaiImageIsNsfw(i, model.nsfw))
  const words = version?.trainedWords ?? []

  const download = async (): Promise<void> => {
    if (!version || !file) return
    if (!status?.hasKey) {
      setKeyDialog(true)
      return
    }
    setStarting(true)
    try {
      await invoke('civitai:download', { modelId: model.id, versionId: version.id, fileId: file.id, folder: dest === 'auto' ? undefined : dest })
    } catch (err) {
      const msg = errorText(err)
      toast.error('Download failed', msg)
      if (/api key/i.test(msg)) setKeyDialog(true)
    } finally {
      setStarting(false)
    }
  }

  if (!version)
    return (
      <div className="grid flex-1 place-items-center p-8">
        <EmptyState icon={<CircleAlert />} title="No versions" body="This model has no published versions." />
      </div>
    )

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <Carousel version={version} modelNsfw={model.nsfw} />
        <div className="space-y-6 px-6 pt-5 pb-8">
          <div className="space-y-2.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <KindTag kind={kind} icon />
              <BaseTag base={version.baseModel} />
              {model.type !== 'Checkpoint' && kind === 'lora' && model.type !== 'LORA' && <span className="inline-flex h-5 items-center rounded-md border border-line px-1.5 text-[10.5px] text-fg-3">{model.type}</span>}
              {installed && (
                <Badge tone="success">
                  <Check className="size-2.5" strokeWidth={3} /> Downloaded
                </Badge>
              )}
            </div>
            <h2 className="display text-[22px] leading-tight">{model.name}</h2>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px] text-fg-3">
              {model.creator && (
                <span className="flex items-center gap-1.5 text-fg-2">
                  <Avatar src={model.creatorImage} name={model.creator} size={18} />
                  {model.creator}
                </span>
              )}
              <span className="flex items-center gap-1">
                <Download className="size-3" /> {formatCount(model.stats?.downloadCount)}
              </span>
              <span className="flex items-center gap-1">
                <ThumbsUp className="size-3" /> {formatCount(model.stats?.thumbsUpCount)}
              </span>
              <button onClick={() => void invoke('sys:openExternal', `https://civitai.com/models/${model.id}?modelVersionId=${version.id}`)} className="flex items-center gap-1 transition hover:text-fg">
                <Globe className="size-3" /> civitai.com
              </button>
            </div>
          </div>

          {model.versions.length > 1 && (
            <Section label={`Versions · ${model.versions.length}`}>
              <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 [scrollbar-width:thin]">
                {model.versions.map((v) => {
                  const on = v.id === version.id
                  const have = local.some((m) => m.meta?.versionId === v.id)
                  return (
                    <button
                      key={v.id}
                      onClick={() => setVersionId(v.id)}
                      className={cn('relative flex shrink-0 flex-col items-start rounded-xl border px-3 py-1.5 text-left transition-colors', on ? 'border-transparent' : 'border-line hover:bg-white/[0.05]')}
                    >
                      {on && <motion.span layoutId="civitai-version" className="absolute inset-0 rounded-xl border border-[color-mix(in_oklab,var(--accent)_45%,transparent)] bg-[color-mix(in_oklab,var(--accent)_12%,transparent)]" transition={spring} />}
                      <span className="relative flex items-center gap-1 text-[12px] font-medium whitespace-nowrap">
                        {v.name}
                        {have && <Check className="size-3 text-success" strokeWidth={3} />}
                      </span>
                      <span className="relative text-[10.5px] whitespace-nowrap text-fg-3">{v.baseModel}</span>
                    </button>
                  )
                })}
              </div>
            </Section>
          )}

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

          <Section label={`Files · ${files.length}`}>
            <div className="space-y-1.5">
              {files.map((f) => (
                <FileRow key={f.id} f={f} active={f.id === file?.id} onClick={() => setFileId(f.id)} />
              ))}
            </div>
          </Section>

          {!!model.tags.length && (
            <Section label="Tags">
              <div className="flex flex-wrap gap-1.5">
                {model.tags.map((t) => (
                  <span key={t} className="rounded-md border border-line bg-white/[0.04] px-2 py-0.5 text-[11px] text-fg-2">
                    {t}
                  </span>
                ))}
              </div>
            </Section>
          )}

          {version.description && (
            <Section label="About this version">
              <Description html={version.description} guard={guard} />
            </Section>
          )}
          {model.description && (
            <Section label="About">
              <Description html={model.description} guard={guard} />
            </Section>
          )}
        </div>
      </div>

      {/* Download bar */}
      <div className="shrink-0 border-t border-line bg-[color-mix(in_oklab,var(--panel-solid)_70%,transparent)] px-5 py-3.5 backdrop-blur-xl">
        <AnimatePresence mode="wait" initial={false}>
          {active ? (
            <motion.div key="active" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.25, ease }} className="space-y-2">
              <div className="flex items-center justify-between gap-3 text-[12px]">
                <span className="truncate font-medium">Downloading to {folderLabel(active.folder)}…</span>
                <span className="shrink-0 text-fg-3 tabular-nums">
                  {formatBytes(active.received)} / {formatBytes(active.total)}
                </span>
                <Button size="xs" variant="ghost" icon={<X className="size-3" />} onClick={() => void invoke('civitai:cancelDownload', active.id)}>
                  Cancel
                </Button>
              </div>
              <ProgressBar value={active.total ? active.received / active.total : undefined} />
            </motion.div>
          ) : (
            <motion.div key="idle" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.25, ease }} className="flex items-center gap-2">
              <Select
                size="sm"
                className="w-[210px]"
                value={dest}
                onChange={setDest}
                options={[
                  { value: 'auto', label: autoFolder ? `Auto · ${folderLabel(autoFolder)}` : 'Auto (choose a folder)', hint: 'Picked from type and base model' },
                  ...MODEL_FOLDERS.map((f) => ({ value: f.key, label: f.label, hint: f.key }))
                ]}
              />
              <div className="min-w-0 flex-1 truncate text-right text-[11px] text-fg-3">{lastDone?.error && !installed ? <span className="text-danger">{lastDone.error}</span> : file ? formatBytes(file.sizeKB * 1024) : ''}</div>
              {installed ? (
                <Button variant="secondary" icon={<FolderOpen className="size-3.5" />} onClick={() => void invoke('sys:showInFolder', installed.path)}>
                  Show in folder
                </Button>
              ) : !status?.hasKey ? (
                <Tooltip content="Downloads need a free Civitai API key">
                  <Button variant="primary" icon={<KeyRound className="size-3.5" />} onClick={() => setKeyDialog(true)}>
                    Connect to download
                  </Button>
                </Tooltip>
              ) : (
                <Button variant="primary" loading={starting} disabled={!file || (!autoFolder && dest === 'auto')} icon={<Download className="size-3.5" />} onClick={() => void download()}>
                  Download
                </Button>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </>
  )
}

// ─── Tab ─────────────────────────────────────────────────────────────────────

export function CivitaiBrowser(): React.JSX.Element {
  const filters = useCivitai((s) => s.filters)
  const setFilters = useCivitai((s) => s.setFilters)
  const items = useCivitai((s) => s.items)
  const loading = useCivitai((s) => s.loading)
  const done = useCivitai((s) => s.done)
  const error = useCivitai((s) => s.error)
  const sig = useCivitai((s) => s.sig)
  const fetchMore = useCivitai((s) => s.fetchMore)
  const { models: local } = useLocalModels()
  const [text, setText] = useState(filters.query)
  const [open, setOpen] = useState<CivitaiModel | null>(null)
  const sentinel = useRef<HTMLDivElement>(null)

  const localVersions = useMemo(() => new Set(local.map((m) => m.meta?.versionId).filter(Boolean)), [local])

  // Debounce typing into the query filter.
  useEffect(() => {
    const t = setTimeout(() => {
      if (text.trim() !== filters.query) setFilters({ query: text.trim() })
    }, 380)
    return () => clearTimeout(t)
  }, [text, filters.query, setFilters])

  // New filters → first page (kept when coming back with the same filters).
  const currentSig = JSON.stringify(filters)
  useEffect(() => {
    if (currentSig !== sig || (!items.length && !loading && !error && !done)) void fetchMore(queryFor, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSig])

  // Infinite scroll.
  useEffect(() => {
    const el = sentinel.current
    if (!el) return
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        const s = useCivitai.getState()
        if (!s.loading && !s.done && !s.error && s.items.length) void s.fetchMore(queryFor)
      }
    }, { rootMargin: '900px 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [])

  const toggleType = (label: string): void => setFilters({ types: filters.types.includes(label) ? filters.types.filter((t) => t !== label) : [...filters.types, label] })

  return (
    <motion.div key="civitai" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.3, ease }}>
      <div className="sticky top-0 z-10 space-y-2.5 border-y border-line bg-[color-mix(in_oklab,var(--panel-solid)_82%,transparent)] px-8 py-3 backdrop-blur-xl">
        <div className="flex items-center gap-2">
          <SearchField value={text} onChange={setText} placeholder="Search Civitai — styles, characters, checkpoints…" className="w-[320px]" />
          <BaseModelPicker value={filters.baseModels} onChange={(b) => setFilters({ baseModels: b })} />
          <Select size="sm" className="w-[160px]" value={filters.sort} onChange={(v) => setFilters({ sort: v })} options={SORTS.map((s) => ({ value: s, label: s }))} />
          <Tooltip content={filters.query ? 'Civitai ignores the time window while searching' : undefined}>
            <div className={cn(filters.query && 'cursor-not-allowed')}>
              <div className={cn('transition-opacity duration-200', filters.query && 'pointer-events-none opacity-45')}>
                <Select size="sm" className="w-[130px]" value={filters.period} onChange={(v) => setFilters({ period: v })} options={PERIODS} />
              </div>
            </div>
          </Tooltip>
          <div className="flex-1" />
          <label className="flex shrink-0 items-center gap-2 text-[12px] text-fg-2">
            Include NSFW results
            <Switch size="sm" checked={filters.nsfw} onChange={(v) => setFilters({ nsfw: v })} />
          </label>
        </div>
        <div className="flex items-center gap-1.5 overflow-x-auto [scrollbar-width:none]">
          {CIVITAI_TYPE_FILTERS.map((t) => {
            const on = filters.types.includes(t.label)
            return (
              <motion.button
                key={t.label}
                whileTap={{ scale: 0.96 }}
                onClick={() => toggleType(t.label)}
                className={cn('inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-[12px] font-medium transition-[background,border-color,color] duration-200', !on && 'border-line bg-white/[0.035] text-fg-2 hover:border-line-strong hover:text-fg')}
                style={on ? kindTone(t.kind) : undefined}
              >
                <span className="size-1.5 rounded-full" style={{ background: kindColor(t.kind, 0.8) }} />
                {t.label}
              </motion.button>
            )
          })}
          {(filters.types.length > 0 || filters.baseModels.length > 0 || filters.query) && (
            <button
              onClick={() => {
                setText('')
                setFilters({ types: [], baseModels: [], query: '' })
              }}
              className="ml-1 shrink-0 text-[11.5px] font-medium text-fg-3 hover:text-fg"
            >
              Reset filters
            </button>
          )}
        </div>
      </div>

      <div className="px-8 py-6">
        {error && !items.length ? (
          <EmptyState
            icon={<CircleAlert />}
            title="Civitai didn't answer"
            body={error}
            action={
              <Button size="sm" onClick={() => void fetchMore(queryFor, true)}>
                Try again
              </Button>
            }
          />
        ) : !loading && done && !items.length ? (
          <EmptyState icon={<SlidersHorizontal />} title="No models match" body="Try fewer filters, another base model or a different search." />
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(196px,1fr))] gap-3.5">
            {items.map((m, i) => (
              <CivitaiCard key={m.id} model={m} index={i} downloaded={m.versions.some((v) => localVersions.has(v.id))} onOpen={() => setOpen(m)} />
            ))}
            {loading && Array.from({ length: items.length ? 6 : 12 }, (_, i) => <CardSkeleton key={`sk-${i}`} />)}
          </div>
        )}
        {error && items.length > 0 && (
          <div className="mt-6 flex items-center justify-center gap-3 text-[12px] text-danger">
            {error}
            <Button size="xs" onClick={() => void fetchMore(queryFor)}>
              Retry
            </Button>
          </div>
        )}
        {done && items.length > 0 && <div className="mt-8 text-center text-[11.5px] text-fg-3">That’s everything for these filters.</div>}
        <div ref={sentinel} className="h-px" />
      </div>

      <Drawer open={!!open} onOpenChange={(o) => !o && setOpen(null)} title={open?.name ?? 'Model'} width={600}>
        {open && <CivitaiDetail key={open.id} initial={open} local={local} />}
      </Drawer>
    </motion.div>
  )
}

