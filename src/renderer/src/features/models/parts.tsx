// Building blocks for the Models page: side drawer, Civitai key dialog,
// downloads popover and the sanitized description block.
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Dialog as D } from 'radix-ui'
import { Check, CircleAlert, Download, ExternalLink, FolderOpen, Globe, KeyRound, Link2, Plus, Unplug, X } from 'lucide-react'
import type { DownloadState } from '@shared/types'
import { folderLabel } from '@shared/civitai'
import { errorText, invoke } from '@/lib/api'
import { sanitizeHtml } from '@/lib/sanitize-html'
import { cn, formatBytes, formatEta } from '@/lib/utils'
import { ease, spring, springSoft } from '@/lib/motion'
import { Button, IconButton } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge, Field, ProgressBar, ProgressRing } from '@/components/ui/misc'
import { Dialog, Popover } from '@/components/ui/overlay'
import { useHideNsfw } from '@/components/model-tags'
import { toast } from '@/stores/toast'
import { activeDownloads, useCivitai } from './store'

// ─── Drawer ──────────────────────────────────────────────────────────────────

export function Drawer({ open, onOpenChange, title, width = 560, children }: { open: boolean; onOpenChange: (o: boolean) => void; title: string; width?: number; children: ReactNode }): React.JSX.Element {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open && (
          <D.Portal forceMount>
            <D.Overlay asChild forceMount>
              <motion.div className="fixed inset-0 z-50 bg-black/45 backdrop-blur-[3px]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.25, ease }} />
            </D.Overlay>
            <D.Content
              asChild
              forceMount
              aria-describedby={undefined}
              onOpenAutoFocus={(e) => {
                e.preventDefault()
                ;(e.currentTarget as HTMLElement | null)?.focus()
              }}
            >
              <motion.div
                className="glass-strong fixed top-[calc(var(--titlebar)+2px)] right-2 bottom-2 z-50 flex max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-[20px] shadow-[var(--shadow-pop)] outline-none"
                style={{ width }}
                initial={{ x: 64, opacity: 0 }}
                animate={{ x: 0, opacity: 1 }}
                exit={{ x: 48, opacity: 0, transition: { duration: 0.2, ease } }}
                transition={springSoft}
              >
                <D.Title className="sr-only">{title}</D.Title>
                <D.Close className="absolute top-3 right-3 z-20 grid size-8 place-items-center rounded-full border border-white/10 bg-black/40 text-white/80 backdrop-blur-md transition hover:bg-black/60 hover:text-white">
                  <X className="size-4" />
                </D.Close>
                {children}
              </motion.div>
            </D.Content>
          </D.Portal>
        )}
      </AnimatePresence>
    </D.Root>
  )
}

/** Labelled section inside a drawer. */
export function Section({ label, action, children, className }: { label: ReactNode; action?: ReactNode; children: ReactNode; className?: string }): React.JSX.Element {
  return (
    <section className={cn('space-y-2', className)}>
      <div className="flex items-center justify-between gap-2">
        <span className="label-caps">{label}</span>
        {action}
      </div>
      {children}
    </section>
  )
}

/** Sanitized Civitai HTML. Inline images are blurred when NSFW thumbnails are hidden. */
export function Description({ html, guard }: { html?: string; guard: boolean }): React.JSX.Element | null {
  const hide = useHideNsfw()
  const [reveal, setReveal] = useState(false)
  const clean = useMemo(() => sanitizeHtml(html), [html])
  if (!clean) return null
  const blur = hide && guard && !reveal
  return (
    <div className="relative">
      <div
        className={cn(
          'selectable text-[12.5px] leading-relaxed text-fg-2 [overflow-wrap:anywhere]',
          '[&_a]:text-accent [&_a]:underline-offset-2 hover:[&_a]:underline [&_b]:text-fg [&_strong]:text-fg',
          '[&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-line-strong [&_blockquote]:pl-3 [&_blockquote]:text-fg-3',
          '[&_code]:rounded [&_code]:bg-white/[0.07] [&_code]:px-1 [&_code]:font-mono [&_code]:text-[11.5px] [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-black/30 [&_pre]:p-2.5',
          '[&_h1]:mt-3 [&_h1]:mb-1.5 [&_h1]:text-[15px] [&_h1]:font-semibold [&_h1]:text-fg [&_h2]:mt-3 [&_h2]:mb-1.5 [&_h2]:text-[14px] [&_h2]:font-semibold [&_h2]:text-fg [&_h3]:mt-2.5 [&_h3]:mb-1 [&_h3]:text-[13px] [&_h3]:font-semibold [&_h3]:text-fg [&_h4]:mt-2 [&_h4]:mb-1 [&_h4]:font-semibold [&_h4]:text-fg',
          '[&_hr]:my-3 [&_hr]:border-line [&_li]:my-0.5 [&_ol]:my-1.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-1.5 [&_ul]:my-1.5 [&_ul]:list-disc [&_ul]:pl-5',
          '[&_img]:my-2 [&_img]:max-h-[320px] [&_img]:rounded-lg [&_img]:transition-[filter] [&_img]:duration-500',
          blur && '[&_img]:blur-2xl'
        )}
        dangerouslySetInnerHTML={{ __html: clean }}
      />
      {blur && /<img/i.test(clean) && (
        <button onClick={() => setReveal(true)} className="mt-1 text-[11px] font-medium text-fg-3 hover:text-fg">
          Show images in description
        </button>
      )}
    </div>
  )
}

// ─── Civitai key ─────────────────────────────────────────────────────────────

/** Civitai logo-ish monogram in the theme gradient. */
export function CivitaiMark({ size = 18 }: { size?: number }): React.JSX.Element {
  return (
    <span
      className="grid shrink-0 place-items-center bg-grad font-bold text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.25)]"
      style={{ width: size, height: size, fontSize: size * 0.48, borderRadius: Math.max(5, size * 0.3) }}
    >
      C
    </span>
  )
}

/** "Model sources" block for the Connectors page: Civitai status + key dialog. */
export function CivitaiConnectorSection(): React.JSX.Element {
  const status = useCivitai((s) => s.status)
  const loadStatus = useCivitai((s) => s.loadStatus)
  const setKeyDialog = useCivitai((s) => s.setKeyDialog)
  useEffect(() => {
    void loadStatus()
  }, [loadStatus])
  return (
    <div>
      <div className="mb-3 flex items-center gap-2 text-[14px] font-semibold tracking-tight uppercase">
        <span className="grid size-5 place-items-center rounded-full bg-grad text-white">
          <Check className="size-3" strokeWidth={3} />
        </span>
        Model sources
      </div>
      <div className="grid grid-cols-3 gap-3">
        <motion.button whileHover={{ y: -3 }} transition={spring} onClick={() => setKeyDialog(true)} className="glass hairline group flex flex-col gap-3 rounded-2xl p-4 text-left">
          <div className="flex items-center gap-3">
            <CivitaiMark size={38} />
            <div className="min-w-0 flex-1">
              <div className="text-[13.5px] font-semibold">Civitai</div>
              <div className="flex items-center gap-1.5 text-[11px] text-fg-3">
                <Globe className="size-3" /> {status?.username ? status.username : 'Model hub'}
              </div>
            </div>
            {status?.hasKey ? (
              <Badge tone="success">
                <Check className="size-2.5" /> Connected
              </Badge>
            ) : (
              <span className="flex items-center gap-1 text-[11.5px] font-medium text-fg-3 transition group-hover:text-accent">
                <Plus className="size-3" /> Connect
              </span>
            )}
          </div>
          <p className="text-[12px] leading-relaxed text-fg-3">Browse and download checkpoints, LoRAs and more into your models folder, with previews, activation keywords and base-model tags.</p>
        </motion.button>
      </div>
      <CivitaiKeyDialog />
    </div>
  )
}

export function CivitaiKeyDialog(): React.JSX.Element {
  const open = useCivitai((s) => s.keyDialog)
  const setOpen = useCivitai((s) => s.setKeyDialog)
  const status = useCivitai((s) => s.status)
  const loadStatus = useCivitai((s) => s.loadStatus)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)
  useEffect(() => {
    if (open) {
      setKey('')
      setResult(null)
    }
  }, [open])

  const save = async (value: string | null): Promise<void> => {
    setBusy(true)
    setResult(null)
    try {
      const r = await invoke('civitai:setKey', value)
      setResult(r)
      await loadStatus()
      if (r.ok) {
        toast.success(value ? 'Civitai connected' : 'Civitai disconnected', r.message)
        setTimeout(() => setOpen(false), 650)
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
      onOpenChange={setOpen}
      width={480}
      title={
        <span className="flex items-center gap-2.5">
          <CivitaiMark size={26} /> {status?.hasKey ? 'Civitai account' : 'Connect Civitai'}
        </span>
      }
      footer={
        <>
          <Button variant="ghost" size="sm" icon={<ExternalLink className="size-3.5" />} onClick={() => void invoke('sys:openExternal', 'https://civitai.com/user/account')}>
            Get a key
          </Button>
          {status?.hasKey && (
            <Button variant="ghost" size="sm" icon={<Unplug className="size-3.5" />} disabled={busy} onClick={() => void save(null)}>
              Remove key
            </Button>
          )}
          <div className="flex-1" />
          <Button variant="primary" loading={busy} disabled={!key.trim()} icon={<Link2 className="size-3.5" />} onClick={() => void save(key)}>
            Save & test
          </Button>
        </>
      }
    >
      <div className="space-y-4 p-5">
        <p className="text-[12.5px] leading-relaxed text-fg-2">
          Browsing Civitai works without an account. Downloading needs your personal API key — create one under{' '}
          <button className="font-medium text-accent hover:underline" onClick={() => void invoke('sys:openExternal', 'https://civitai.com/user/account')}>
            civitai.com/user/account
          </button>{' '}
          → API Keys.
        </p>
        {status?.hasKey && (
          <div className="flex items-center gap-2 rounded-xl border border-success/25 bg-success/10 px-3 py-2 text-[12px] text-success">
            <Check className="size-3.5" /> {status.username ? `Connected as ${status.username}` : 'A key is saved'}
          </div>
        )}
        <Field label="API key" help="Stored encrypted with your Windows account; only ever sent to civitai.com.">
          <Input
            type="password"
            autoFocus
            icon={<KeyRound />}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && key.trim() && void save(key)}
            placeholder={status?.hasKey ? 'Paste a new key to replace it' : 'Paste your key'}
          />
        </Field>
        <AnimatePresence>
          {result && (
            <motion.div
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
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

// ─── Downloads ───────────────────────────────────────────────────────────────

function DownloadRow({ d }: { d: DownloadState }): React.JSX.Element {
  const pct = d.total ? d.received / d.total : undefined
  const secs = (Date.now() - d.startedAt) / 1000
  const speed = d.status === 'downloading' && secs > 1 ? d.received / secs : 0
  const eta = speed && d.total ? (d.total - d.received) / speed : undefined
  const active = d.status === 'downloading' || d.status === 'queued'
  return (
    <motion.div layout initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: 16 }} transition={spring} className="rounded-xl p-2.5 transition-colors hover:bg-white/[0.04]">
      <div className="flex items-start gap-2.5">
        <span
          className={cn(
            'mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg border',
            d.status === 'done' && 'border-success/25 bg-success/10 text-success',
            d.status === 'error' && 'border-danger/25 bg-danger/10 text-danger',
            d.status === 'canceled' && 'border-line text-fg-3',
            active && 'border-line bg-white/[0.05] text-fg-2'
          )}
        >
          {d.status === 'done' ? <Check className="size-3.5" /> : d.status === 'error' ? <CircleAlert className="size-3.5" /> : d.status === 'canceled' ? <X className="size-3.5" /> : <Download className="size-3.5" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="min-w-0 truncate text-[12.5px] font-medium" title={d.name}>
              {d.name}
            </span>
            {d.source === 'huggingface' && <span className="shrink-0 rounded bg-white/[0.07] px-1 text-[9.5px] font-semibold tracking-wide text-fg-3">HF</span>}
          </div>
          <div className="mt-0.5 truncate text-[11px] text-fg-3" title={d.error ?? d.path}>
            {d.status === 'queued' && `Queued · ${formatBytes(d.total)}`}
            {d.status === 'downloading' && (d.note ?? `${formatBytes(d.received)} of ${formatBytes(d.total)}${speed ? ` · ${formatBytes(speed)}/s` : ''}${eta ? ` · ${formatEta(eta)} left` : ''}`)}
            {d.status === 'done' && `${formatBytes(d.total)} · ${folderLabel(d.folder)}`}
            {d.status === 'error' && d.error}
            {d.status === 'canceled' && 'Canceled'}
          </div>
          {d.status === 'downloading' && <ProgressBar value={pct} className="mt-2" />}
        </div>
        {active && (
          <IconButton label="Cancel download" size="xs" onClick={() => void invoke('civitai:cancelDownload', d.id)}>
            <X className="size-3.5" />
          </IconButton>
        )}
        {d.status === 'done' && d.path && (
          <IconButton label="Show in folder" size="xs" onClick={() => void invoke('sys:showInFolder', d.path!)}>
            <FolderOpen className="size-3.5" />
          </IconButton>
        )}
      </div>
    </motion.div>
  )
}

export function DownloadsButton(): React.JSX.Element {
  const downloads = useCivitai((s) => s.downloads)
  const list = useMemo(() => Object.values(downloads).sort((a, b) => b.startedAt - a.startedAt), [downloads])
  const active = activeDownloads(downloads)
  const received = active.reduce((n, d) => n + d.received, 0)
  // Queued files count towards the total so the ring doesn't jump back.
  const total = active.reduce((n, d) => n + d.total, 0)
  // Tick once a second so speeds/ETAs stay live between progress events.
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!active.length) return
    const t = setInterval(() => setTick((x) => x + 1), 1000)
    return () => clearInterval(t)
  }, [active.length])

  return (
    <Popover
      align="end"
      className="w-[380px] p-0"
      trigger={
        <Button variant="secondary" icon={active.length ? <ProgressRing value={total ? received / total : undefined} size={16} stroke={2} /> : <Download className="size-3.5" />}>
          Downloads
          {list.length > 0 && <span className="rounded-md bg-white/10 px-1.5 text-[10.5px] tabular-nums text-fg-2">{active.length || list.length}</span>}
        </Button>
      }
    >
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <span className="text-[13px] font-semibold">Downloads</span>
        <span className="text-[11px] text-fg-3">{active.length ? `${active.length} active` : 'This session'}</span>
      </div>
      <div className="max-h-[56vh] overflow-y-auto p-1.5">
        <AnimatePresence initial={false}>
          {list.map((d) => (
            <DownloadRow key={d.id} d={d} />
          ))}
        </AnimatePresence>
        {!list.length && (
          <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
            <Download className="size-5 text-fg-3" />
            <div className="text-[12.5px] font-medium text-fg-2">No downloads yet</div>
            <div className="text-[11.5px] text-fg-3">Pick a model on Browse Civitai, or install a recipe’s missing models from Generate or Manage.</div>
          </div>
        )}
      </div>
    </Popover>
  )
}
