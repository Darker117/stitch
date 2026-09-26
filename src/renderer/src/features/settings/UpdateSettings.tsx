// Settings → Updates: current version, check / download / restart, release notes.
import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ArrowUpRight, Check, Download, RefreshCw, RotateCw, TriangleAlert } from 'lucide-react'
import type { UpdateState } from '@shared/types'
import { RELEASES_URL } from '@shared/release'
import { invoke } from '@/lib/api'
import { ease, spring } from '@/lib/motion'
import { sanitizeHtml } from '@/lib/sanitize-html'
import { cn, timeAgo } from '@/lib/utils'
import { LogoMark } from '@/components/shell/logo'
import { Button } from '@/components/ui/button'
import { SwitchRow } from '@/components/ui/controls'
import { ProgressBar, SectionTitle, Spinner, Surface } from '@/components/ui/misc'
import { useAppSettings, useSettings } from '@/stores/settings'
import { formatBytes, useUpdate } from '@/stores/update'

function statusLine(s: UpdateState): { text: string; tone: 'muted' | 'good' | 'accent' | 'bad'; icon?: React.ReactNode } {
  switch (s.status) {
    case 'unsupported':
      return { text: 'This is a development build — updates install in the packaged app.', tone: 'muted' }
    case 'checking':
      return { text: 'Checking GitHub for updates…', tone: 'muted', icon: <Spinner className="size-3.5" /> }
    case 'not-available':
      return { text: `You’re up to date${s.checkedAt ? ` · checked ${timeAgo(s.checkedAt)}` : ''}`, tone: 'good', icon: <Check className="size-3.5" /> }
    case 'available':
      return { text: `Stitch ${s.version} is available.`, tone: 'accent' }
    case 'downloading':
      return { text: `Downloading Stitch ${s.version ?? ''}… ${Math.round(s.progress?.percent ?? 0)}%`, tone: 'accent' }
    case 'downloaded':
      return { text: `Stitch ${s.version} is ready — restart to finish updating.`, tone: 'accent', icon: <Check className="size-3.5" /> }
    case 'error':
      return { text: s.error ?? 'The update check failed.', tone: 'bad', icon: <TriangleAlert className="size-3.5" /> }
    default:
      return { text: s.checkedAt ? `Checked ${timeAgo(s.checkedAt)}` : 'Stitch checks for updates when it starts and every few hours.', tone: 'muted' }
  }
}

export function UpdateSettings(): React.JSX.Element {
  const state = useUpdate((s) => s.state)
  const init = useUpdate((s) => s.init)
  const check = useUpdate((s) => s.check)
  const download = useUpdate((s) => s.download)
  const install = useUpdate((s) => s.install)
  const settings = useAppSettings()
  const update = useSettings((s) => s.update)
  const [asked, setAsked] = useState(false)
  useEffect(() => {
    void init()
  }, [init])

  const s: UpdateState = state ?? { status: 'idle', current: '' }
  const line = statusLine(s)
  const notes = s.releaseNotes ? sanitizeHtml(s.releaseNotes) : ''
  const checking = s.status === 'checking' || (asked && s.status === 'idle')

  const action = ((): React.ReactNode => {
    if (s.status === 'downloaded')
      return (
        <Button variant="primary" icon={<RotateCw className="size-3.5" />} onClick={() => void install()}>
          Restart & update
        </Button>
      )
    if (s.status === 'available')
      return (
        <Button variant="primary" icon={<Download className="size-3.5" />} onClick={() => void download()}>
          Download
        </Button>
      )
    if (s.status === 'downloading') return null
    return (
      <Button
        variant="secondary"
        disabled={s.status === 'unsupported' || checking}
        icon={<RefreshCw className={cn('size-3.5', checking && 'animate-spin')} />}
        onClick={async () => {
          setAsked(true)
          try {
            await check()
          } finally {
            setAsked(false)
          }
        }}
      >
        Check for updates
      </Button>
    )
  })()

  return (
    <div className="space-y-6">
      <SectionTitle>Updates</SectionTitle>
      <Surface className="relative overflow-hidden p-5 max-md:p-4">
        <motion.div
          className="pointer-events-none absolute -top-20 -right-16 size-64 rounded-full bg-grad blur-3xl"
          animate={{ opacity: s.status === 'downloaded' || s.status === 'downloading' ? 0.28 : 0.12 }}
          transition={{ duration: 0.8, ease }}
        />
        <div className="relative flex items-center gap-4 max-md:flex-wrap max-md:gap-3.5">
          <div className="grid size-14 shrink-0 place-items-center rounded-2xl border border-line bg-white/[0.04] max-md:size-12">
            <LogoMark size={36} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-semibold">Stitch {s.current}</div>
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={`${s.status}-${line.text}`}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.2 }}
                className={cn('mt-0.5 flex items-center gap-1.5 text-[12.5px]', line.tone === 'good' && 'text-success', line.tone === 'accent' && 'text-accent', line.tone === 'bad' && 'text-danger', line.tone === 'muted' && 'text-fg-3')}
              >
                {line.icon}
                <span>{line.text}</span>
              </motion.div>
            </AnimatePresence>
          </div>
          <motion.div layout transition={spring} className="max-md:basis-full max-md:empty:hidden max-md:[&>button]:h-10 max-md:[&>button]:w-full">
            {action}
          </motion.div>
        </div>
        <AnimatePresence initial={false}>
          {s.status === 'downloading' && (
            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.3, ease }} className="relative overflow-hidden">
              <ProgressBar value={(s.progress?.percent ?? 0) / 100} className="mt-4 h-1.5" />
              <div className="mt-2 flex justify-between text-[11.5px] text-fg-3 tabular-nums">
                <span>
                  {formatBytes(s.progress?.transferred ?? 0)} of {formatBytes(s.progress?.total ?? 0)}
                </span>
                <span>{formatBytes(s.progress?.bytesPerSecond ?? 0)}/s</span>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </Surface>

      <AnimatePresence initial={false}>
        {notes && (
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.3, ease }}>
            <div className="label-caps mb-2">What’s new in {s.releaseName || s.version}</div>
            <div className="prose-stitch max-h-[320px] overflow-y-auto rounded-2xl border border-line bg-white/[0.02] px-5 py-4 text-[13px]" dangerouslySetInnerHTML={{ __html: notes }} />
          </motion.div>
        )}
      </AnimatePresence>

      <div className="space-y-4">
        <SwitchRow
          label="Download updates automatically"
          help="Stitch checks GitHub when it starts and every few hours, downloads new versions in the background and asks before restarting."
          checked={settings.updates?.autoDownload !== false}
          onChange={(v) => void update({ updates: { autoDownload: v } })}
        />
        <Button variant="ghost" className="max-md:-ml-3.5" iconRight={<ArrowUpRight className="size-3.5" />} onClick={() => void invoke('sys:openExternal', RELEASES_URL)}>
          All releases on GitHub
        </Button>
      </div>
    </div>
  )
}
