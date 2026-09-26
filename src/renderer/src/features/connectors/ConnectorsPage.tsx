import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ComponentType } from 'react'
import { useNavigate } from 'react-router'
import { AnimatePresence, motion } from 'motion/react'
import { Blocks, Check, CircleDashed, Cloud, Cpu, ExternalLink, KeyRound, LayoutGrid, Link2, Plus, RefreshCw, Rocket, Trash2 } from 'lucide-react'
import type { ComfyConnector, Connector, GenKind, LlmConnector, VoiceConnector } from '@shared/types'
import { errorText, invoke } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useCompact } from '@/lib/platform'
import { ease, rise, spring, stagger } from '@/lib/motion'
import { Page } from '@/components/shell/page'
import { LogoMark } from '@/components/shell/logo'
import { Button, IconButton } from '@/components/ui/button'
import { Switch, Tabs } from '@/components/ui/controls'
import { Input, SearchField } from '@/components/ui/input'
import { Badge, EmptyState, Field, Spinner, StatusDot } from '@/components/ui/misc'
import { Dialog, Menu, MenuCheck, Tooltip } from '@/components/ui/overlay'
import { useCollection } from '@/stores/db'
import { useGen } from '@/stores/gen'
import { toast } from '@/stores/toast'
import { CATALOG, catalogFor, Mono, type CatalogEntry } from './catalog'
import { CivitaiConnectorSection } from '@/features/models/parts'

const engineModules = import.meta.glob<{ VoiceEngineCard: ComponentType }>('./VoiceEngineCard.tsx')
const engineLoader = Object.values(engineModules)[0]
const VoiceEngineCard = engineLoader ? lazy(() => engineLoader().then((m) => ({ default: m.VoiceEngineCard }))) : null

// ─── Hero constellation ──────────────────────────────────────────────────────

const NODES: { key: string; x: number; y: number }[] = [
  { key: 'openai', x: 0.12, y: 0.2 },
  { key: 'anthropic', x: 0.25, y: 0.48 },
  { key: 'ollama', x: 0.08, y: 0.72 },
  { key: 'lmstudio', x: 0.3, y: 0.85 },
  { key: 'openrouter', x: 0.38, y: 0.14 },
  { key: 'comfy', x: 0.7, y: 0.18 },
  { key: 'elevenlabs', x: 0.9, y: 0.32 },
  { key: 'voice-local', x: 0.78, y: 0.7 },
  { key: 'azure', x: 0.95, y: 0.82 },
  { key: 'gemini', x: 0.6, y: 0.9 }
]

function Constellation(): React.JSX.Element {
  const cx = 0.52
  const cy = 0.5
  return (
    <div className="absolute inset-0">
      <svg className="absolute inset-0 size-full" viewBox="0 0 100 100" preserveAspectRatio="none">
        {NODES.map((n, i) => {
          const mx = (n.x + cx) / 2 + (n.y > cy ? 0.04 : -0.04)
          const my = (n.y + cy) / 2 + (n.x > cx ? 0.05 : -0.05)
          return (
            <motion.path
              key={n.key}
              d={`M ${cx * 100} ${cy * 100} Q ${mx * 100} ${my * 100} ${n.x * 100} ${n.y * 100}`}
              fill="none"
              stroke="rgb(255 255 255 / 0.16)"
              strokeWidth="0.25"
              strokeDasharray="0.8 1.2"
              vectorEffect="non-scaling-stroke"
              initial={{ pathLength: 0, opacity: 0 }}
              animate={{ pathLength: 1, opacity: 1, strokeDashoffset: [0, -8] }}
              transition={{ pathLength: { duration: 1.2, delay: 0.2 + i * 0.06, ease }, opacity: { duration: 0.6, delay: 0.2 + i * 0.06 }, strokeDashoffset: { duration: 6, repeat: Infinity, ease: 'linear' } }}
            />
          )
        })}
      </svg>
      {NODES.map((n, i) => {
        const entry = CATALOG.find((c) => c.key === n.key)!
        return (
          <motion.div
            key={n.key}
            className="absolute -translate-x-1/2 -translate-y-1/2"
            style={{ left: `${n.x * 100}%`, top: `${n.y * 100}%` }}
            initial={{ opacity: 0, scale: 0.6 }}
            animate={{ opacity: 1, scale: 1, y: [0, -4, 0] }}
            transition={{ opacity: { delay: 0.4 + i * 0.07 }, scale: { ...spring, delay: 0.4 + i * 0.07 }, y: { duration: 4 + (i % 3), repeat: Infinity, ease: 'easeInOut', delay: i * 0.3 } }}
          >
            <Tooltip content={entry.name}>
              <div className="rounded-full border border-line-strong bg-[#141220]/90 p-1 shadow-lg backdrop-blur">
                <Mono entry={entry} size={30} className="!rounded-full" />
              </div>
            </Tooltip>
          </motion.div>
        )
      })}
      <motion.div className="absolute -translate-x-1/2 -translate-y-1/2" style={{ left: `${cx * 100}%`, top: `${cy * 100}%` }} initial={{ scale: 0.5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ ...spring, delay: 0.15 }}>
        <div className="relative flex flex-col items-center gap-3">
          <div className="absolute -inset-8 rounded-full bg-grad opacity-25 blur-2xl" />
          <LogoMark size={64} className="relative drop-shadow-[0_10px_30px_color-mix(in_oklab,var(--accent)_35%,transparent)]" />
          <div className="display relative text-[22px] tracking-tight uppercase">Connectors</div>
        </div>
      </motion.div>
    </div>
  )
}

// ─── Configure dialog ────────────────────────────────────────────────────────

const ROLE_LABEL: Record<GenKind, string> = { image: 'Images', video: 'Video', audio: 'Music & SFX', voice: 'Voice' }

function ConfigureDialog({ entry, existing, onClose }: { entry: CatalogEntry | null; existing?: Connector; onClose: () => void }): React.JSX.Element {
  const [name, setName] = useState(existing?.name ?? entry?.name ?? '')
  const [baseUrl, setBaseUrl] = useState((existing as LlmConnector | undefined)?.baseUrl ?? (existing as ComfyConnector | undefined)?.url ?? entry?.baseUrl ?? '')
  const [key, setKey] = useState('')
  const [region, setRegion] = useState((existing as VoiceConnector | undefined)?.region ?? 'eastus')
  const [roles, setRoles] = useState<GenKind[]>((existing as ComfyConnector | undefined)?.roles ?? [])
  const [voiceModel, setVoiceModel] = useState((existing as VoiceConnector | undefined)?.model ?? '')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)
  const hasKey = existing && 'hasKey' in existing ? existing.hasKey : false

  const save = async (test: boolean): Promise<void> => {
    if (!entry) return
    setBusy(true)
    setResult(null)
    try {
      const base = { id: existing?.id ?? '', name: name.trim() || entry.name, enabled: existing?.enabled ?? true, createdAt: existing?.createdAt ?? 0 }
      let c: Connector
      if (entry.category === 'comfy') c = { ...base, category: 'comfy', url: baseUrl.trim(), roles, managed: (existing as ComfyConnector | undefined)?.managed }
      else if (entry.category === 'llm') c = { ...base, category: 'llm', kind: entry.kind as LlmConnector['kind'], baseUrl: baseUrl.trim(), hasKey, models: (existing as LlmConnector | undefined)?.models }
      else c = { ...base, category: 'voice', kind: entry.kind as VoiceConnector['kind'], baseUrl: baseUrl.trim() || undefined, region: entry.needsRegion ? region.trim() : undefined, model: voiceModel.trim() || undefined, hasKey }
      const saved = await invoke('connectors:save', c, key ? key.trim() : undefined)
      if (test) {
        const r = await invoke('connectors:test', saved.id)
        setResult(r)
        if (r.ok) {
          toast.success(`${saved.name} connected`, r.message)
          void useGen.getState().refreshRecipes()
          setTimeout(onClose, 700)
        }
      } else onClose()
    } catch (err) {
      setResult({ ok: false, message: errorText(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={!!entry}
      onOpenChange={(o) => !o && onClose()}
      title={
        entry && (
          <span className="flex items-center gap-3">
            <Mono entry={entry} size={30} /> {existing ? `Configure ${existing.name}` : `Connect ${entry.name}`}
          </span>
        )
      }
      width={500}
      footer={
        <>
          {entry?.docs && (
            <Button variant="ghost" size="sm" icon={<ExternalLink className="size-3.5" />} onClick={() => invoke('sys:openExternal', entry.docs!)}>
              {entry.needsKey || entry.optionalKey ? 'Get a key' : 'Learn more'}
            </Button>
          )}
          <div className="flex-1" />
          <Button variant="ghost" onClick={() => void save(false)} disabled={busy}>
            Save
          </Button>
          <Button variant="primary" loading={busy} icon={<Link2 className="size-3.5" />} onClick={() => void save(true)}>
            Save & test
          </Button>
        </>
      }
    >
      {entry && (
        <div className="space-y-4 p-5">
          <p className="text-[12.5px] text-fg-2">{entry.blurb}</p>
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          {(entry.baseUrl !== undefined || entry.category === 'comfy') && (
            <Field label={entry.category === 'comfy' ? 'Server URL' : 'Base URL'} help={entry.local ? 'Runs on this PC.' : 'Change only if you use a proxy or compatible gateway.'}>
              <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={entry.baseUrl} />
            </Field>
          )}
          {(entry.needsKey || entry.key === 'custom' || entry.optionalKey) && (
            <Field label={entry.keyLabel ?? 'API key'} help={hasKey ? 'A key is saved (encrypted with Windows). Leave blank to keep it.' : 'Stored encrypted on this PC; never shared.'}>
              <Input type="password" icon={<KeyRound />} value={key} onChange={(e) => setKey(e.target.value)} placeholder={hasKey ? '••••••••••••' : entry.needsKey ? 'Paste your key' : 'Optional'} />
            </Field>
          )}
          {entry.needsRegion && (
            <Field label="Region" help="e.g. eastus, westeurope — from your Azure Speech resource.">
              <Input value={region} onChange={(e) => setRegion(e.target.value)} />
            </Field>
          )}
          {entry.category === 'voice' && (entry.kind === 'elevenlabs' || entry.kind === 'openai-tts') && (
            <Field label="Model (optional)" help={entry.kind === 'elevenlabs' ? 'e.g. eleven_multilingual_v2, or eleven_v3 for delivery directions.' : 'e.g. gpt-4o-mini-tts.'}>
              <Input value={voiceModel} onChange={(e) => setVoiceModel(e.target.value)} placeholder={entry.kind === 'elevenlabs' ? 'eleven_multilingual_v2' : 'gpt-4o-mini-tts'} />
            </Field>
          )}
          {entry.category === 'comfy' && (
            <Field label="Handles" help="Leave all off to accept every kind of job.">
              <div className="flex flex-wrap gap-1.5">
                {(['image', 'video', 'audio'] as GenKind[]).map((r) => (
                  <button
                    key={r}
                    onClick={() => setRoles((x) => (x.includes(r) ? x.filter((y) => y !== r) : [...x, r]))}
                    className={cn('h-7.5 rounded-lg border px-2.5 text-[12px] font-medium transition max-md:h-9 max-md:rounded-full max-md:px-3.5', roles.includes(r) ? 'border-[color-mix(in_oklab,var(--accent)_45%,transparent)] bg-[color-mix(in_oklab,var(--accent)_14%,transparent)]' : 'border-line text-fg-3 hover:text-fg-2')}
                  >
                    {ROLE_LABEL[r]}
                  </button>
                ))}
              </div>
            </Field>
          )}
          <AnimatePresence>
            {result && (
              <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className={cn('rounded-xl border p-3 text-[12px]', result.ok ? 'border-success/25 bg-success/10 text-success' : 'border-danger/25 bg-danger/10 text-danger')}>
                {result.message}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}
    </Dialog>
  )
}

// ─── Page ────────────────────────────────────────────────────────────────────

function ConnectorRow({ c, onEdit }: { c: Connector; onEdit: () => void }): React.JSX.Element {
  const entry = catalogFor(c) ?? CATALOG[CATALOG.length - 1]
  const navigate = useNavigate()
  // "This phone" (phone app only): models are managed on the phone's own page, and it can't be removed.
  const onPhone = 'kind' in c && c.kind === 'device'
  const comfy = useGen((s) => s.comfy.find((x) => x.connectorId === c.id))
  const [testing, setTesting] = useState(false)
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null)
  const online = c.category === 'comfy' ? comfy?.online : status?.ok
  return (
    <motion.div layout variants={rise} className="glass hairline flex items-center gap-4 rounded-2xl p-3.5 max-md:flex-wrap max-md:gap-3">
      <Mono entry={entry} size={40} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 max-md:flex-wrap max-md:gap-y-1">
          <span className="text-[13.5px] font-semibold">{c.name}</span>
          {c.category === 'comfy' && (c as ComfyConnector).managed && <Badge tone="accent">Managed</Badge>}
          {'hasKey' in c && c.hasKey && (
            <Badge>
              <KeyRound className="size-2.5" /> Key saved
            </Badge>
          )}
        </div>
        <div className="mt-0.5 truncate text-[11.5px] text-fg-3">
          {c.category === 'comfy'
            ? comfy?.online
              ? `${comfy.gpu ?? 'GPU'} · ComfyUI ${comfy.version ?? ''} · ${comfy.queueRemaining} queued`
              : `${(c as ComfyConnector).url} · offline`
            : status?.message ?? ('baseUrl' in c && c.baseUrl ? c.baseUrl : entry.blurb)}
        </div>
      </div>
      <StatusDot state={online ? 'online' : status && !status.ok ? 'warn' : 'offline'} />
      <div className="contents max-md:flex max-md:basis-full max-md:items-center max-md:gap-2 max-md:border-t max-md:border-line max-md:pt-3">
        <Button
          size="sm"
          variant="ghost"
          className="max-md:h-9"
          icon={testing ? <Spinner className="size-3.5" /> : <RefreshCw className="size-3.5" />}
          onClick={async () => {
            setTesting(true)
            setStatus(await invoke('connectors:test', c.id))
            setTesting(false)
          }}
        >
          Test
        </Button>
        <Button size="sm" className="max-md:h-9" onClick={onPhone ? () => navigate(`/phone?task=${c.category === 'llm' ? 'text' : 'voice'}`) : onEdit}>
          {onPhone ? 'Models' : 'Configure'}
        </Button>
        <span className="hidden max-md:block max-md:flex-1" />
        <Switch checked={c.enabled} onChange={(v) => void invoke('connectors:save', { ...c, enabled: v } as Connector)} />
        <IconButton
          label="Remove"
          size="sm"
          className={cn('max-md:size-9', onPhone && 'hidden')}
          onClick={async () => {
            await invoke('connectors:delete', c.id)
            toast.info(`${c.name} removed`)
          }}
        >
          <Trash2 className="size-3.5" />
        </IconButton>
      </div>
    </motion.div>
  )
}

type Cat = 'llm' | 'comfy' | 'voice'
const CAT_LABEL: Record<Cat, string> = { llm: 'Text & story models', comfy: 'Image & video', voice: 'Voice' }

export function ConnectorsPage(): React.JSX.Element {
  const connectors = useCollection('connectors')
  const [tab, setTab] = useState<'explore' | 'mine'>('explore')
  const [q, setQ] = useState('')
  const [cats, setCats] = useState<Cat[]>(['llm', 'comfy', 'voice'])
  const [editing, setEditing] = useState<{ entry: CatalogEntry; existing?: Connector } | null>(null)
  // Phones: a plain header instead of the constellation hero, and your connectors first.
  const compact = useCompact()
  const picked = useRef(false)
  useEffect(() => {
    if (compact && connectors.length && !picked.current) setTab('mine')
  }, [compact, connectors.length])
  const addCustom = (): void => setEditing({ entry: CATALOG.find((c) => c.key === 'custom')! })

  const catalog = useMemo(() => CATALOG.filter((e) => cats.includes(e.category as Cat) && (!q || `${e.name} ${e.blurb}`.toLowerCase().includes(q.toLowerCase()))), [cats, q])
  const mine = useMemo(() => connectors.filter((c) => cats.includes(c.category as Cat) && (!q || c.name.toLowerCase().includes(q.toLowerCase()))), [connectors, cats, q])

  return (
    <Page>
      {compact ? (
        <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease }} className="flex items-center gap-2 px-4 pt-5 pb-1">
          <h1 className="display min-w-0 flex-1 truncate text-[23px]">Connectors</h1>
          <Button className="h-10 rounded-xl px-3.5" icon={<Plus className="size-4" />} onClick={addCustom}>
            Custom
          </Button>
        </motion.div>
      ) : (
      <div className="relative h-[360px] overflow-hidden border-b border-line max-md:h-auto">
        <div className="absolute inset-y-0 right-0 w-[62%] max-md:relative max-md:inset-auto max-md:h-[220px] max-md:w-full">
          <Constellation />
        </div>
        <div className="relative z-10 flex h-full max-w-[520px] flex-col justify-center gap-5 px-10 max-md:h-auto max-md:gap-4 max-md:px-5 max-md:pt-1 max-md:pb-7">
          <motion.h1 initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease }} className="display text-[34px] uppercase max-md:text-[28px]">
            Connect Stitch
            <br />
            to your models
          </motion.h1>
          <motion.ul variants={stagger(0.07, 0.15)} initial="initial" animate="animate" className="space-y-2 text-[13px] text-fg-3">
            {[
              { icon: <Link2 />, b: 'A connector', r: 'links Stitch to an AI provider or a server on this PC' },
              { icon: <Blocks />, b: 'Mix and match', r: 'story text from one, images from another, voices from a third' },
              { icon: <KeyRound />, b: 'Keys stay local', r: 'encrypted with your Windows account' }
            ].map((b) => (
              <motion.li key={b.b} variants={rise} className="flex items-center gap-2.5">
                <span className="shrink-0 text-fg-2 [&>svg]:size-3.5">{b.icon}</span>
                <span>
                  <b className="font-semibold text-fg">{b.b}</b> {b.r}
                </span>
              </motion.li>
            ))}
          </motion.ul>
          <div>
            <Button variant="glass" className="max-md:h-10" icon={<Plus className="size-4" />} onClick={addCustom}>
              Add custom endpoint
            </Button>
          </div>
        </div>
      </div>
      )}

      <div className="px-10 pt-6 pb-16 max-md:px-4 max-md:pt-4 max-md:pb-10">
        <Tabs
          value={tab}
          onChange={(t) => {
            picked.current = true
            setTab(t)
          }}
          className="max-md:[&>button]:h-10"
          items={[
            { value: 'explore', label: 'Explore', icon: <LayoutGrid /> },
            { value: 'mine', label: 'My connectors', icon: <Check />, count: connectors.length }
          ]}
        />
        <div className="mt-5 flex items-center justify-between gap-3 max-md:mt-4 max-md:gap-2">
          <SearchField value={q} onChange={setQ} className="w-[280px] max-md:w-auto max-md:min-w-0 max-md:flex-1" />
          <Menu
            align="end"
            trigger={
              <Button variant="outline" size="sm" className="max-md:h-9" icon={<LayoutGrid className="size-3.5" />}>
                Category
              </Button>
            }
          >
            {(Object.keys(CAT_LABEL) as Cat[]).map((c) => (
              <MenuCheck key={c} checked={cats.includes(c)} onChange={(v) => setCats((x) => (v ? [...x, c] : x.filter((y) => y !== c)))}>
                {CAT_LABEL[c]}
              </MenuCheck>
            ))}
          </Menu>
        </div>

        <AnimatePresence mode="wait">
          {tab === 'explore' ? (
            <motion.div key="explore" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.3, ease }} className="mt-6 space-y-9 max-md:mt-5 max-md:space-y-7">
              {(Object.keys(CAT_LABEL) as Cat[])
                .filter((cat) => cats.includes(cat))
                .map((cat) => {
                  const list = catalog.filter((e) => e.category === cat)
                  if (!list.length) return null
                  return (
                    <div key={cat}>
                      <div className="mb-3 flex items-center gap-2 text-[14px] font-semibold tracking-tight uppercase">
                        <span className="grid size-5 place-items-center rounded-full bg-grad text-white">
                          <Check className="size-3" strokeWidth={3} />
                        </span>
                        {CAT_LABEL[cat]}
                      </div>
                      <motion.div variants={stagger(0.04)} initial="initial" animate="animate" className="grid grid-cols-3 gap-3 max-md:grid-cols-1 max-md:gap-2.5">
                        {list.map((e) => {
                          const existing = connectors.filter((c) => catalogFor(c)?.key === e.key)
                          return (
                            <motion.button
                              key={e.key}
                              variants={rise}
                              whileHover={{ y: -3 }}
                              transition={spring}
                              onClick={() => setEditing({ entry: e, existing: existing[0] })}
                              className="glass hairline group flex flex-col gap-3 rounded-2xl p-4 text-left max-md:gap-2 max-md:p-3.5"
                            >
                              <div className="flex items-center gap-3">
                                <Mono entry={e} size={38} />
                                <div className="min-w-0 flex-1">
                                  <div className="text-[13.5px] font-semibold">{e.name}</div>
                                  <div className="flex items-center gap-1.5 text-[11px] text-fg-3">
                                    {e.local ? <Cpu className="size-3" /> : <Cloud className="size-3" />}
                                    {e.local ? 'Runs locally' : 'Cloud API'}
                                  </div>
                                </div>
                                {existing.length ? (
                                  <Badge tone="success">
                                    <Check className="size-2.5" /> Connected
                                  </Badge>
                                ) : (
                                  <span className="flex items-center gap-1 text-[11.5px] font-medium text-fg-3 transition group-hover:text-accent">
                                    <Plus className="size-3" /> Connect
                                  </span>
                                )}
                              </div>
                              <p className="text-[12px] leading-relaxed text-fg-3">{e.blurb}</p>
                            </motion.button>
                          )
                        })}
                      </motion.div>
                    </div>
                  )
                })}
              {cats.includes('comfy') && <CivitaiConnectorSection />}
              {cats.includes('voice') && VoiceEngineCard && (
                <Suspense fallback={null}>
                  <VoiceEngineCard />
                </Suspense>
              )}
            </motion.div>
          ) : (
            <motion.div key="mine" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.3, ease }} className="mt-6">
              {mine.length ? (
                <motion.div variants={stagger(0.04)} initial="initial" animate="animate" className="space-y-2.5">
                  {mine.map((c) => (
                    <ConnectorRow key={c.id} c={c} onEdit={() => setEditing({ entry: catalogFor(c) ?? CATALOG.find((x) => x.key === 'custom')!, existing: c })} />
                  ))}
                </motion.div>
              ) : (
                <EmptyState icon={<CircleDashed />} title="No connectors match" action={<Button icon={<Rocket className="size-3.5" />} onClick={() => setTab('explore')}>Explore connectors</Button>} />
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <ConfigureDialog key={editing?.existing?.id ?? editing?.entry.key ?? 'none'} entry={editing?.entry ?? null} existing={editing?.existing} onClose={() => setEditing(null)} />
    </Page>
  )
}

