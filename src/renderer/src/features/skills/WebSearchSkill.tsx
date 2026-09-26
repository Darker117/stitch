// Skills → Web search: the SearXNG that ships with Stitch, which every text model can use through
// the web_search / open_page tools. Shows its state, its settings and a live test search.
import { useCallback, useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ArrowUpRight, Globe, Laptop, Search, ShieldCheck, Smartphone } from 'lucide-react'
import type { WebRoute, WebSearchResult, WebStatus } from '@shared/ipc'
import { errorText, invoke, on } from '@/lib/api'
import { isPhone } from '@/lib/platform'
import { cn } from '@/lib/utils'
import { ease, rise, stagger } from '@/lib/motion'
import { Button } from '@/components/ui/button'
import { Segmented, Slider, Switch } from '@/components/ui/controls'
import { Input } from '@/components/ui/input'
import { Spinner, StatusDot } from '@/components/ui/misc'
import { useSettings } from '@/stores/settings'

const STATE_LABEL: Record<WebStatus['state'], string> = {
  running: 'Ready',
  starting: 'Starting…',
  stopped: 'Starts on the first search',
  missing: 'Not bundled with this build',
  error: 'Stopped with an error'
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

export function WebSearchSkill(): React.JSX.Element {
  const settings = useSettings((s) => s.settings)
  const update = useSettings((s) => s.update)
  const web = settings?.web ?? { enabled: true, safeSearch: 1 as const, maxResults: 6 }
  const [status, setStatus] = useState<WebStatus | null>(null)
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const [res, setRes] = useState<WebSearchResult | null>(null)
  const [err, setErr] = useState<string | null>(null)

  // Always re-ask: on the phone the answer depends on where searches are routed.
  const refresh = useCallback(() => {
    invoke('web:status').then(setStatus, () => setStatus(null))
  }, [])
  useEffect(() => {
    refresh()
    return on('web:status', refresh)
  }, [refresh])

  const search = async (): Promise<void> => {
    if (!q.trim()) return
    setBusy(true)
    setErr(null)
    try {
      setRes(await invoke('web:search', { query: q.trim(), limit: 5 }))
    } catch (e) {
      setErr(errorText(e))
    } finally {
      setBusy(false)
      refresh()
    }
  }

  const state = status?.state
  const dot = state === 'running' ? 'online' : state === 'starting' ? 'busy' : state === 'error' || state === 'missing' ? 'warn' : 'offline'

  return (
    <div className="glass hairline overflow-hidden rounded-[22px]">
      <div className="grid grid-cols-[1.1fr_1fr] max-lg:grid-cols-1">
        {/* About + settings */}
        <div className="p-6 max-md:p-4">
          <div className="flex items-start gap-3.5">
            <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-grad text-white shadow-[0_10px_30px_-10px_color-mix(in_oklab,var(--accent)_80%,transparent)]">
              <Globe className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <div className="text-[16px] font-semibold tracking-tight">Web search</div>
                <span className="rounded-md border border-line px-1.5 py-px font-mono text-[10px] tracking-wide text-fg-3">SearXNG</span>
              </div>
              <p className="mt-1 text-[12.5px] leading-relaxed text-fg-2">
                Lets every text model — cloud, local or on your phone — search the web and read pages, then answer with sources. Private metasearch that ships with Stitch: no account, no API key, no tracking.
              </p>
            </div>
            <Switch checked={web.enabled} onChange={(enabled) => void update({ web: { enabled } })} />
          </div>

          <div className="mt-4 flex items-center gap-2 text-[12px] text-fg-2">
            <StatusDot state={dot} />
            <span>{state ? STATE_LABEL[state] : 'Checking…'}</span>
            {status && (
              <span className="flex items-center gap-1 text-fg-3">
                · {status.where === 'phone' ? <Smartphone className="size-3" /> : <Laptop className="size-3" />} {status.where === 'phone' ? 'on this phone' : 'on your PC'}
              </span>
            )}
          </div>
          {status?.error && <div className="mt-2 rounded-lg border border-danger/25 bg-danger/10 px-2.5 py-2 text-[11.5px] leading-snug text-danger">{status.error}</div>}

          <div className={cn('mt-5 space-y-4 transition-opacity duration-300', !web.enabled && 'pointer-events-none opacity-45')}>
            <div className="flex items-center justify-between gap-3 max-md:flex-wrap">
              <span className="flex items-center gap-2 text-[12.5px] font-medium">
                <ShieldCheck className="size-3.5 text-fg-3" /> Safe search
              </span>
              <Segmented
                size="sm"
                className="max-md:[&>button]:h-8"
                value={String(web.safeSearch)}
                onChange={(v) => void update({ web: { safeSearch: Number(v) as 0 | 1 | 2 } })}
                items={[
                  { value: '0', label: 'Off' },
                  { value: '1', label: 'Moderate' },
                  { value: '2', label: 'Strict' }
                ]}
              />
            </div>
            <div>
              <div className="mb-2 flex items-center justify-between text-[12.5px] font-medium">
                Results per search
                <span className="font-mono text-[11.5px] text-fg-2 tabular-nums">{web.maxResults}</span>
              </div>
              <Slider value={web.maxResults} min={3} max={12} step={1} onChange={(maxResults) => void update({ web: { maxResults } })} className="max-md:h-8" />
            </div>
            {isPhone && status?.route && (
              <div className="flex items-center justify-between gap-3 max-md:flex-wrap">
                <span className="text-[12.5px] font-medium">Search from</span>
                <Segmented
                  size="sm"
                  className="max-md:[&>button]:h-8"
                  value={status.route}
                  onChange={(route: WebRoute) => void invoke('web:setRoute', route).then(setStatus, () => {})}
                  items={[
                    { value: 'auto', label: 'Auto' },
                    { value: 'phone', label: 'This phone' },
                    { value: 'pc', label: 'PC' }
                  ]}
                />
              </div>
            )}
          </div>
        </div>

        {/* Live test */}
        <div className="border-l border-line bg-white/[0.02] p-6 max-lg:border-t max-lg:border-l-0 max-md:p-4">
          <div className="label-caps mb-2">Try it</div>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              void search()
            }}
          >
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Who painted the Garden of Earthly Delights?" className="min-w-0 flex-1" />
            <Button type="submit" variant="primary" icon={busy ? <Spinner className="size-3.5" /> : <Search className="size-3.5" />} disabled={busy || !q.trim() || !web.enabled} className="max-md:h-10">
              Search
            </Button>
          </form>
          <AnimatePresence mode="wait" initial={false}>
            {err ? (
              <motion.div key="err" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="mt-3 text-[12px] text-danger">
                {err}
              </motion.div>
            ) : res ? (
              <motion.div key={res.query} variants={stagger(0.04)} initial="initial" animate="animate" exit={{ opacity: 0 }} className="mt-3 space-y-1">
                {res.answers[0] && (
                  <motion.div variants={rise} className="mb-2 rounded-xl border border-line bg-white/[0.04] px-3 py-2 text-[12.5px] text-fg">
                    {res.answers[0]}
                  </motion.div>
                )}
                {res.results.map((r) => (
                  <motion.button
                    key={r.url}
                    variants={rise}
                    onClick={() => void invoke('sys:openExternal', r.url)}
                    className="group block w-full rounded-xl px-2.5 py-2 text-left transition hover:bg-white/[0.05]"
                  >
                    <div className="flex items-center gap-1.5 text-[11px] text-fg-3">
                      {hostOf(r.url)}
                      <ArrowUpRight className="size-3 opacity-0 transition group-hover:opacity-100" />
                    </div>
                    <div className="truncate text-[13px] font-medium text-fg">{r.title}</div>
                    {r.snippet && <div className="line-clamp-2 text-[11.5px] leading-snug text-fg-3">{r.snippet}</div>}
                  </motion.button>
                ))}
                <motion.div variants={rise} className="px-2.5 pt-1 text-[11px] text-fg-3">
                  {res.results.length} results in {(res.tookMs / 1000).toFixed(1)} s · {res.where === 'phone' ? 'this phone' : 'your PC'}
                </motion.div>
              </motion.div>
            ) : (
              <motion.p key="hint" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.3, ease }} className="mt-3 text-[12px] leading-relaxed text-fg-3">
                In a chat, just ask for something current — “what changed in the latest Blender release?” — and the model searches, reads and cites its sources.
              </motion.p>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  )
}
