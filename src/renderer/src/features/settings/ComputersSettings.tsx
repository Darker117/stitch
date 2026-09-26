// Settings → Computers: this PC's role (main or node), Stitch PCs on the network, linked PCs with
// their hardware, and the llama.cpp text engine that can span them.
import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Check, Copy, KeyRound, Link2, Monitor, Network, Plus, Radar, Server, ShieldCheck, Unlink, X } from 'lucide-react'
import type { ClusterStatus, FoundPc, LinkedNode, NodeModelGap } from '@shared/ipc'
import { errorText, invoke } from '@/lib/api'
import { cn, formatBytes, timeAgo } from '@/lib/utils'
import { ease, pop, spring, stagger } from '@/lib/motion'
import { useCompact } from '@/lib/platform'
import { Button, Chip } from '@/components/ui/button'
import { Segmented } from '@/components/ui/controls'
import { Input } from '@/components/ui/input'
import { Badge, ProgressBar, SectionTitle, Spinner, StatusDot } from '@/components/ui/misc'
import { Dialog } from '@/components/ui/overlay'
import { useCluster, useClusterLive } from '@/stores/cluster'
import { useAppSettings, useSettings } from '@/stores/settings'
import { toast } from '@/stores/toast'
import { PcCard, shortGpu } from './computers/hardware'
import { TextEngine } from './computers/TextEngine'

function Countdown({ until }: { until: number }): React.JSX.Element {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const left = Math.max(0, Math.round((until - now) / 1000))
  return (
    <span className="tabular-nums">
      {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}
    </span>
  )
}

// ─── Main: link a node ───────────────────────────────────────────────────────

function LinkDialog({ pc, onClose }: { pc: FoundPc | null; onClose: () => void }): React.JSX.Element {
  const [code, setCode] = useState('')
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<LinkedNode | null>(null)
  const [error, setError] = useState<string>()

  useEffect(() => {
    if (!pc) return
    setCode('')
    setDone(null)
    setError(undefined)
    setAsking(true)
    // The node shows a fresh code (and a notification) as soon as we ask.
    invoke('cluster:requestLink', pc.id)
      .catch((err) => setError(errorText(err)))
      .finally(() => setAsking(false))
  }, [pc?.id])

  const link = async (): Promise<void> => {
    if (!pc) return
    setBusy(true)
    setError(undefined)
    try {
      setDone(await invoke('cluster:link', pc.id, code))
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={!!pc} onOpenChange={(o) => !o && onClose()} title={done ? undefined : `Link ${pc?.name ?? ''}`} width={460}>
      <div className="p-5 max-md:px-4">
        <AnimatePresence mode="wait" initial={false}>
          {done ? (
            <motion.div key="done" initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.35, ease }} className="flex flex-col items-center gap-3 py-4 text-center">
              <motion.div initial={{ scale: 0.4, rotate: -20 }} animate={{ scale: 1, rotate: 0 }} transition={{ ...spring, delay: 0.05 }} className="grid size-14 place-items-center rounded-full bg-grad text-white shadow-[0_12px_40px_-10px_var(--accent)]">
                <Check className="size-7" strokeWidth={2.5} />
              </motion.div>
              <div className="text-[16px] font-semibold">{done.name} is linked</div>
              <p className="max-w-xs text-[12.5px] text-fg-2">Its GPUs are ready. Add them to your layout under GPUs, or give them layers in the text engine below.</p>
              <Button className="mt-1" onClick={onClose}>
                Done
              </Button>
            </motion.div>
          ) : (
            <motion.div key="code" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="space-y-4">
              <div className="flex items-start gap-3 rounded-xl border border-line bg-white/[0.02] p-3.5 text-[12.5px] leading-relaxed text-fg-2">
                <KeyRound className="mt-0.5 size-4 shrink-0 text-accent" />
                {asking ? (
                  <span className="flex items-center gap-2">
                    <Spinner className="size-3.5" /> Asking {pc?.name} for a code…
                  </span>
                ) : (
                  <span>
                    <b className="text-fg">{pc?.name}</b> now shows a 6-digit code (in a notification and in Settings → Computers). Type it here.
                  </span>
                )}
              </div>
              <Input
                autoFocus
                inputMode="numeric"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                onKeyDown={(e) => e.key === 'Enter' && code.length === 6 && void link()}
                placeholder="000000"
                className="h-14 text-center font-mono text-[26px] tracking-[0.5em]"
              />
              {error && <div className="rounded-xl border border-danger/25 bg-danger/[0.07] px-3 py-2.5 text-[12px] text-danger">{error}</div>}
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={onClose}>
                  Cancel
                </Button>
                <Button variant="primary" loading={busy} disabled={code.length !== 6} icon={<Link2 className="size-3.5" />} onClick={() => void link()} className="max-md:flex-1">
                  Link
                </Button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </Dialog>
  )
}

function AddByAddress({ open, onOpenChange, onFound }: { open: boolean; onOpenChange: (o: boolean) => void; onFound: (pc: FoundPc) => void }): React.JSX.Element {
  const [address, setAddress] = useState('')
  const [busy, setBusy] = useState(false)
  const find = async (): Promise<void> => {
    setBusy(true)
    try {
      const pc = await invoke('cluster:probe', address)
      onOpenChange(false)
      onFound(pc)
    } catch (err) {
      toast.error('Not found', errorText(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Add a PC by address" description="For a PC on another subnet or over Tailscale. Use the address and port shown on that PC." width={460}>
      <div className="space-y-4 p-5 max-md:px-4">
        <Input autoFocus value={address} onChange={(e) => setAddress(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && address && void find()} placeholder="192.168.1.20 or 100.64.0.5:47847" className="font-mono text-[12.5px]" />
        <div className="flex justify-end">
          <Button variant="primary" loading={busy} disabled={!address.trim()} onClick={() => void find()} className="max-md:flex-1">
            Find
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

function ModelGaps({ node, onClose }: { node: LinkedNode | null; onClose: () => void }): React.JSX.Element {
  const [gaps, setGaps] = useState<NodeModelGap[] | null>(null)
  const live = useCluster((s) => s.status?.nodes.find((n) => n.id === node?.id))
  useEffect(() => {
    if (!node) return
    setGaps(null)
    invoke('cluster:modelGaps', node.id)
      .then(setGaps)
      .catch((err) => {
        toast.error('Models', errorText(err))
        onClose()
      })
  }, [node?.id, live?.copies.filter((c) => c.state === 'done').length])
  const copies = live?.copies ?? []
  return (
    <Dialog open={!!node} onOpenChange={(o) => !o && onClose()} title={`Models on ${node?.name ?? ''}`} description="Recipes this PC can't run yet. Copy a file from this PC over your network, or install it there." width={620}>
      <div className="max-h-[62vh] space-y-3 overflow-y-auto p-5 max-md:px-4">
        {copies.length > 0 && (
          <div className="space-y-2">
            {copies.map((c) => (
              <div key={c.id} className="rounded-xl border border-line bg-white/[0.02] px-3 py-2.5">
                <div className="flex items-center gap-2 text-[12px]">
                  <Copy className="size-3.5 text-fg-3" />
                  <span className="min-w-0 flex-1 truncate">{c.name}</span>
                  <span className="text-fg-3 tabular-nums">{c.state === 'copying' ? `${formatBytes(c.sent)} / ${formatBytes(c.total)}` : c.state === 'done' ? 'Copied' : c.state === 'canceled' ? 'Canceled' : c.error}</span>
                  {c.state === 'copying' && (
                    <button className="grid size-6 place-items-center rounded-md text-fg-3 hover:bg-white/[0.07] hover:text-fg" onClick={() => void invoke('cluster:cancelCopy', c.id)} aria-label="Cancel">
                      <X className="size-3.5" />
                    </button>
                  )}
                </div>
                {c.state === 'copying' && <ProgressBar className="mt-2" value={c.total ? c.sent / c.total : undefined} />}
              </div>
            ))}
          </div>
        )}
        {!gaps && (
          <div className="flex items-center justify-center gap-2 py-8 text-[12.5px] text-fg-3">
            <Spinner className="size-3.5" /> Comparing models…
          </div>
        )}
        {gaps?.length === 0 && <div className="py-8 text-center text-[12.5px] text-fg-3">{node?.name} has everything the built-in recipes need.</div>}
        {gaps?.map((g) => (
          <div key={g.recipeId} className="rounded-xl border border-line bg-white/[0.02] p-3">
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-medium">{g.recipeName}</span>
              <Badge>{g.kind}</Badge>
            </div>
            <div className="mt-2 space-y-1.5">
              {g.missing.map((m) => (
                <div key={m.folder + m.label} className="flex items-center gap-2 text-[12px] max-md:flex-wrap">
                  <span className="min-w-0 flex-1 truncate text-fg-2">{m.label}</span>
                  {m.source ? (
                    <Button size="xs" icon={<Copy className="size-3" />} className="max-md:h-8" disabled={copies.some((c) => c.state === 'copying' && c.name === m.source!.name.split('/').pop())} onClick={() => invoke('cluster:copyModel', node!.id, m.folder, m.source!.name).catch((e) => toast.error('Copy', errorText(e)))}>
                      Copy from this PC · {formatBytes(m.source.size)}
                    </Button>
                  ) : (
                    <span className="text-[11px] text-fg-3">Not on this PC either</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Dialog>
  )
}

function MainView({ status }: { status: ClusterStatus }): React.JSX.Element {
  const [linking, setLinking] = useState<FoundPc | null>(null)
  const [adding, setAdding] = useState(false)
  const [gapsFor, setGapsFor] = useState<LinkedNode | null>(null)
  const unlinked = status.found.filter((f) => !f.linked)

  const unlink = async (n: LinkedNode): Promise<void> => {
    try {
      await invoke('cluster:unlink', n.id)
      toast.success(`${n.name} unlinked`, 'Its GPUs were removed from your layout.')
    } catch (err) {
      toast.error('Unlink', errorText(err))
    }
  }

  return (
    <>
      <div className="space-y-3">
        <SectionTitle
          icon={<Radar />}
          action={
            <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => setAdding(true)} className="max-md:h-9">
              Add by address
            </Button>
          }
        >
          Stitch PCs on your network
        </SectionTitle>
        <AnimatePresence initial={false} mode="popLayout">
          {unlinked.length === 0 ? (
            <motion.div key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex items-center gap-3 rounded-xl border border-dashed border-line px-4 py-4 text-[12.5px] text-fg-3">
              <span className="relative grid size-8 shrink-0 place-items-center">
                <motion.span className="absolute inset-0 rounded-full border border-[color-mix(in_oklab,var(--accent)_60%,transparent)]" animate={{ scale: [0.6, 1.3], opacity: [0.8, 0] }} transition={{ duration: 2.2, repeat: Infinity, ease: 'easeOut' }} />
                <Radar className="size-4 text-accent" />
              </span>
              <span>Looking for other PCs… On the other PC open Stitch → Settings → Computers and choose <b className="text-fg-2">Node</b>.</span>
            </motion.div>
          ) : (
            unlinked.map((pc) => (
              <motion.div key={pc.id} layout initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: -12 }} transition={{ duration: 0.3, ease }} className="flex items-center gap-3 rounded-xl border border-line bg-white/[0.025] px-3.5 py-3 max-md:flex-wrap">
                <div className="grid size-9 shrink-0 place-items-center rounded-xl border border-line bg-white/[0.04] text-fg-2">
                  <Server className="size-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium">{pc.name}</div>
                  <div className="truncate text-[11.5px] text-fg-3">
                    {pc.address}:{pc.port}
                    {pc.version && ` · Stitch ${pc.version}`}
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5 max-md:order-last max-md:basis-full">
                  {pc.gpus.map((g, i) => (
                    <Badge key={i} tone="outline">
                      {shortGpu(g.name)} · {formatBytes(g.memTotal)}
                    </Badge>
                  ))}
                </div>
                <Button size="sm" variant="primary" icon={<Link2 className="size-3.5" />} onClick={() => setLinking(pc)} className="max-md:h-9">
                  Link
                </Button>
              </motion.div>
            ))
          )}
        </AnimatePresence>
      </div>

      <div className="space-y-3">
        <SectionTitle icon={<Network />}>Linked computers</SectionTitle>
        {status.nodes.length === 0 ? (
          <div className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-[12.5px] text-fg-3">No linked PCs yet — link one above and its GPUs join this PC’s.</div>
        ) : (
          <motion.div variants={stagger(0.05)} initial="initial" animate="animate" className="space-y-3">
            {status.nodes.map((n) => (
              <PcCard
                key={n.id}
                kind="node"
                name={n.name}
                hardware={n.hardware}
                services={n.services}
                state={n.state === 'online' ? 'online' : n.state === 'connecting' ? 'busy' : n.state === 'revoked' ? 'warn' : 'offline'}
                subtitle={
                  n.state === 'online'
                    ? `${n.hardware?.os ?? ''} · ${n.address}:${n.port}`
                    : n.error ?? (n.state === 'connecting' ? 'Connecting…' : `Offline${n.lastSeenAt ? ` · seen ${timeAgo(n.lastSeenAt)}` : ''}`)
                }
                actions={
                  <>
                    {n.state === 'revoked' && (
                      <Button size="sm" variant="primary" className="max-md:h-9" icon={<Link2 className="size-3.5" />} onClick={() => setLinking({ id: n.id, name: n.name, address: n.address ?? '', port: n.port, gpus: [], linked: true })}>
                        Link again
                      </Button>
                    )}
                    {n.state === 'online' && (
                      <Button size="sm" variant="ghost" className="max-md:h-9" onClick={() => setGapsFor(n)}>
                        Models
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" className="max-md:h-9" icon={<Unlink className="size-3.5" />} onClick={() => void unlink(n)}>
                      Unlink
                    </Button>
                  </>
                }
              />
            ))}
          </motion.div>
        )}
      </div>

      <LinkDialog pc={linking} onClose={() => setLinking(null)} />
      <AddByAddress open={adding} onOpenChange={setAdding} onFound={setLinking} />
      <ModelGaps node={gapsFor} onClose={() => setGapsFor(null)} />
    </>
  )
}

// ─── Node: lend this PC ──────────────────────────────────────────────────────

function NodeView({ status }: { status: ClusterStatus }): React.JSX.Element {
  const settings = useAppSettings()
  const update = useSettings((s) => s.update)
  const w = status.node.linkWindow
  const gpus = status.hardware?.gpus ?? []
  const share = settings.cluster?.share
  const toggleShare = (i: number): void => {
    const cur = share ?? gpus.map((g) => g.index)
    const next = cur.includes(i) ? cur.filter((x) => x !== i) : [...cur, i].sort((a, b) => a - b)
    void update({ cluster: { share: next } })
  }
  const setWindow = (open: boolean): void => void invoke('cluster:linkWindow', open).then((s) => useCluster.getState().set(s)).catch((e) => toast.error('Linking', errorText(e)))

  return (
    <>
      <div className="flex items-start gap-2 text-[12px] text-fg-2">
        <span className="mt-[5px] flex shrink-0">
          <StatusDot state={status.node.listening ? 'online' : 'warn'} />
        </span>
        {status.node.listening ? (
          <span>
            Offering this PC on port <b className="font-semibold text-fg">{status.node.port}</b> — mains on your network can find it.
          </span>
        ) : (
          <span className="text-warning">{status.node.error ?? 'Not listening yet'}</span>
        )}
      </div>

      <AnimatePresence mode="wait" initial={false}>
        {w ? (
          <motion.div key="code" variants={pop} initial="initial" animate="animate" exit="exit" className="relative overflow-hidden rounded-2xl border border-line bg-white/[0.025] p-5 max-md:p-4">
            <div className="pointer-events-none absolute -top-24 -right-24 size-72 rounded-full bg-grad opacity-[0.12] blur-3xl" />
            <div className="relative flex flex-col items-center gap-4 text-center">
              <div className="label-caps">{w.requestedBy ? `${w.requestedBy} wants to link` : 'Link code'}</div>
              <div className="flex gap-1.5">
                {w.code.split('').map((d, i) => (
                  <motion.span key={`${w.code}-${i}`} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 * i, duration: 0.4, ease }} className="grid h-14 w-11 place-items-center rounded-xl border border-line-strong bg-white/[0.04] font-mono text-[28px] font-semibold max-md:h-12 max-md:w-10 max-md:text-[24px]">
                    {d}
                  </motion.span>
                ))}
              </div>
              <p className="max-w-sm text-[12.5px] text-fg-2">Type this on the main PC. It works for <Countdown until={w.expiresAt} /> and only on your local network.</p>
              <Button size="sm" variant="ghost" onClick={() => setWindow(false)}>
                Close
              </Button>
            </div>
          </motion.div>
        ) : (
          <motion.div key="btn" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex flex-wrap items-center gap-3">
            <Button variant="primary" size="lg" icon={<KeyRound className="size-4" />} onClick={() => setWindow(true)} className="max-md:w-full">
              Show link code
            </Button>
            <span className="text-[12px] text-fg-3 max-md:text-center">Or press “Link” on the main PC — the code pops up here.</span>
          </motion.div>
        )}
      </AnimatePresence>

      {gpus.length > 0 && (
        <div className="space-y-2">
          <div className="label-caps">GPUs a main may use</div>
          <div className="flex flex-wrap gap-2">
            {gpus.map((g) => {
              const on = !share || share.includes(g.index)
              return (
                <Chip key={g.index} active={on} icon={on ? <Check /> : undefined} onClick={() => toggleShare(g.index)} className="max-md:h-9">
                  GPU {g.index} · {shortGpu(g.name)}
                </Chip>
              )
            })}
          </div>
        </div>
      )}

      <div className="space-y-3">
        <SectionTitle icon={<Monitor />}>Mains that can use this PC</SectionTitle>
        {status.node.mains.length === 0 ? (
          <div className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-[12.5px] text-fg-3">None yet.</div>
        ) : (
          <div className="space-y-2">
            <AnimatePresence initial={false}>
              {status.node.mains.map((m) => (
                <motion.div key={m.id} layout initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: -12 }} transition={{ duration: 0.3, ease }} className="flex items-center gap-3 rounded-xl border border-line bg-white/[0.025] px-3.5 py-3">
                  <div className={cn('grid size-9 shrink-0 place-items-center rounded-xl border border-line', m.online ? 'bg-grad text-white' : 'bg-white/[0.04] text-fg-2')}>
                    <Monitor className="size-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-[13px] font-medium">
                      <span className="truncate">{m.name}</span>
                      {m.online && <Badge tone="success">Connected</Badge>}
                    </div>
                    <div className="truncate text-[11.5px] text-fg-3">
                      Linked {timeAgo(m.createdAt)}
                      {m.lastAddress && ` · ${m.lastAddress}`}
                      {!m.online && m.lastSeenAt && ` · seen ${timeAgo(m.lastSeenAt)}`}
                    </div>
                  </div>
                  <Button size="sm" variant="ghost" className="max-md:h-9" icon={<Unlink className="size-3.5" />} onClick={() => void invoke('cluster:revokeMain', m.id)}>
                    Revoke
                  </Button>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>

      <div className="flex items-start gap-3 rounded-xl border border-line bg-white/[0.02] p-3.5 text-[12px] leading-relaxed text-fg-2">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" />
        <div>
          A linked main can run ComfyUI workflows and llama.cpp layers on the GPUs you share, and copy model files into your models folder — nothing else on this PC. ComfyUI and llama.cpp only listen on this PC itself; the main reaches them through Stitch’s authenticated link. Revoke a main to cut it off instantly. If Windows asks, allow Stitch on <b className="text-fg">private networks</b>.
        </div>
      </div>
    </>
  )
}

// ─── Page ────────────────────────────────────────────────────────────────────

/** The name other PCs see for this one. */
function PcName({ current }: { current: string }): React.JSX.Element {
  const update = useSettings((s) => s.update)
  const [value, setValue] = useState(current)
  useEffect(() => setValue(current), [current])
  const save = (): void => {
    const name = value.trim().slice(0, 60)
    if (name && name !== current) void update({ cluster: { name } }).then(() => useCluster.getState().refresh())
    else setValue(current)
  }
  return (
    <label className="ml-auto flex items-center gap-2 max-md:ml-0 max-md:w-full">
      <span className="label-caps shrink-0">Name</span>
      <Input value={value} onChange={(e) => setValue(e.target.value)} onBlur={save} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} className="h-8 w-52 text-[12.5px] max-md:h-9 max-md:w-auto max-md:min-w-0 max-md:flex-1" />
    </label>
  )
}

export function ComputersSettings(): React.JSX.Element {
  const status = useClusterLive()
  const compact = useCompact()
  const [switching, setSwitching] = useState(false)
  if (!status) return <div />
  const role = status.role

  const setRole = async (r: 'main' | 'node'): Promise<void> => {
    if (r === role) return
    setSwitching(true)
    try {
      useCluster.getState().set(await invoke('cluster:setRole', r))
    } catch (err) {
      toast.error('Computers', errorText(err))
    } finally {
      setSwitching(false)
    }
  }

  return (
    <div className="space-y-7">
      <div className="relative overflow-hidden rounded-2xl border border-line bg-white/[0.02] p-5 max-md:p-4">
        <div className="pointer-events-none absolute -bottom-20 -left-10 size-64 rounded-full bg-[radial-gradient(circle,var(--accent-2),transparent_65%)] opacity-20 blur-2xl" />
        <div className="relative flex items-start gap-4 max-md:gap-3.5">
          <div className="grid size-11 shrink-0 place-items-center rounded-2xl bg-grad text-white shadow-[0_10px_30px_-10px_var(--accent)]">
            <Network className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-semibold">Use your other computers</div>
            <p className="mt-1 text-[12.5px] leading-relaxed text-fg-2">
              The PC you work on is the <b className="text-fg">main</b>. Other PCs running Stitch on the same network can be <b className="text-fg">nodes</b>: link them once, then send image, video and music jobs to their GPUs and spread a text model across all of them.
            </p>
          </div>
        </div>
        <div className="relative mt-4 flex flex-wrap items-center gap-3">
          <Segmented
            value={role}
            onChange={(r) => void setRole(r)}
            items={[
              { value: 'main', label: compact ? 'Main' : 'Main — use other PCs', icon: <Monitor /> },
              { value: 'node', label: compact ? 'Node' : 'Node — lend this PC', icon: <Server /> }
            ]}
            className="max-md:flex max-md:w-full [&>button]:max-md:h-9 [&>button]:max-md:flex-1 [&>button]:max-md:justify-center"
          />
          {switching && <Spinner className="size-3.5 text-fg-3" />}
          <PcName current={status.name} />
        </div>
      </div>

      <motion.div variants={stagger(0.05)} initial="initial" animate="animate">
        <PcCard kind="this" name={`${status.name} · this PC`} hardware={status.hardware} services={role === 'node' ? status.node.services : undefined} />
      </motion.div>

      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={role} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.28, ease }} className="space-y-7">
          {role === 'main' ? (
            <>
              <MainView status={status} />
              <TextEngine />
            </>
          ) : (
            <NodeView status={status} />
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  )
}
