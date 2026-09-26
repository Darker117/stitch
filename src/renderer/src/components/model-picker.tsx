// Text-model picker: connectors → models, with search and "set as default".
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { motion } from 'motion/react'
import { Check, ChevronDown, Cpu, Globe, RefreshCw, Search, Settings2, Smartphone, Star } from 'lucide-react'
import type { LlmConnector } from '@shared/types'
import { cn } from '@/lib/utils'
import { springSoft } from '@/lib/motion'
import { useCompact } from '@/lib/platform'
import { isLocalKind, LLM_KIND_LABEL, modelLabel, useLlmConnectors, useModels, type LlmChoice } from '@/lib/llm'
import { useSettings } from '@/stores/settings'
import { Button } from './ui/button'
import { Dialog, Popover } from './ui/overlay'
import { Spinner } from './ui/misc'

function ConnectorModels({ connector, value, onPick, query, touch }: { connector: LlmConnector; value?: LlmChoice; onPick: (c: LlmChoice) => void; query: string; touch?: boolean }): React.JSX.Element | null {
  const { models, loading, error, refresh } = useModels(connector.id)
  const settings = useSettings((s) => s.settings)
  const update = useSettings((s) => s.update)
  const list = models.filter((m) => !query || m.id.toLowerCase().includes(query) || m.name?.toLowerCase().includes(query)).slice(0, 80)
  if (query && !list.length) return null
  return (
    <div className="py-1">
      <div className="flex items-center gap-2 px-2.5 pt-1.5 pb-1">
        <span className="text-fg-3">{connector.kind === 'device' ? <Smartphone className="size-3" /> : isLocalKind(connector.kind) ? <Cpu className="size-3" /> : <Globe className="size-3" />}</span>
        <span className="label-caps">{connector.name}</span>
        {connector.kind === 'device' ? <span className="text-[10.5px] text-fg-3">on-device</span> : <span className="text-[10.5px] text-fg-3">{LLM_KIND_LABEL[connector.kind]}</span>}
        <button onClick={refresh} className={cn('ml-auto grid size-5 place-items-center rounded text-fg-3 hover:text-fg', touch && 'size-8 rounded-lg')} title="Refresh models">
          {loading ? <Spinner className="size-3" /> : <RefreshCw className="size-3" />}
        </button>
      </div>
      {error && <div className="px-2.5 pb-1.5 text-[11px] text-danger">{error}</div>}
      {!error && !loading && !models.length && (
        <div className="px-2.5 pb-1.5 text-[11px] text-fg-3">{connector.kind === 'device' ? 'No models on this phone yet — get one in More → This phone.' : 'No models found — is it running?'}</div>
      )}
      {list.map((m) => {
        const active = value?.connectorId === connector.id && value.model === m.id
        const isDefault = settings?.defaultLlm?.connectorId === connector.id && settings.defaultLlm.model === m.id
        return (
          <button
            key={m.id}
            onClick={() => onPick({ connectorId: connector.id, model: m.id })}
            className={cn(
              'group relative flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[12.5px] transition-colors',
              active ? 'text-fg' : 'text-fg-2 hover:bg-white/[0.06] hover:text-fg',
              touch && 'h-11 rounded-xl pr-1 text-[13px] active:bg-white/[0.06]'
            )}
          >
            {active && <motion.span layoutId="model-active" className={cn('absolute inset-0 rounded-lg bg-white/[0.08]', touch && 'rounded-xl')} transition={springSoft} />}
            <span className="relative min-w-0 flex-1 truncate">{m.name ?? m.id}</span>
            {m.contextLength && <span className="relative text-[10.5px] text-fg-3 tabular-nums">{Math.round(m.contextLength / 1000)}k</span>}
            <span
              role="button"
              title={isDefault ? 'Default model' : 'Set as default'}
              onClick={(e) => {
                e.stopPropagation()
                void update({ defaultLlm: { connectorId: connector.id, model: m.id } })
              }}
              className={cn(
                'relative grid size-5 place-items-center rounded transition',
                isDefault ? 'text-accent' : 'text-fg-3 opacity-0 group-hover:opacity-100 hover:text-fg',
                touch && 'size-9 rounded-lg opacity-100 active:bg-white/[0.08]',
                touch && !isDefault && 'text-fg-3/60'
              )}
            >
              <Star className={cn('size-3', isDefault && 'fill-current', touch && 'size-3.5')} />
            </span>
            {active && <Check className={cn('relative size-3.5 text-accent', touch && 'mr-1.5 size-4')} />}
          </button>
        )
      })}
    </div>
  )
}

export function ModelPicker({ value, onChange, className, align = 'start' }: { value?: LlmChoice; onChange: (c: LlmChoice) => void; className?: string; align?: 'start' | 'end' }): React.JSX.Element {
  const connectors = useLlmConnectors()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const label = useMemo(() => modelLabel(value), [value])
  const compact = useCompact()

  // Phone: the list opens as a bottom sheet with thumb-sized rows (no keyboard until you tap search).
  if (compact) {
    return (
      <>
        <button
          onClick={() => setOpen(true)}
          className={cn('no-drag inline-flex h-7.5 max-w-[260px] min-w-0 items-center gap-1.5 rounded-lg border border-line bg-white/[0.04] px-2.5 text-[12px] font-medium text-fg-2 transition active:scale-[0.97] active:bg-white/[0.08]', className)}
        >
          <span className="size-1.5 shrink-0 rounded-full bg-grad" />
          <span className="truncate">{label}</span>
          <ChevronDown className="size-3 shrink-0 text-fg-3" />
        </button>
        <Dialog
          open={open}
          onOpenChange={(o) => {
            setOpen(o)
            if (!o) setQ('')
          }}
          title="Text model"
          description="Tap the star to make a model your default."
          footer={
            <Button
              variant="secondary"
              className="h-11 w-full rounded-xl"
              icon={<Settings2 className="size-4" />}
              onClick={() => {
                setOpen(false)
                navigate('/connectors')
              }}
            >
              Manage connectors
            </Button>
          }
        >
          <div className="sticky top-0 z-10 border-b border-line bg-[var(--panel-strong)] px-3 py-2.5 backdrop-blur-xl">
            <div className="flex h-10 items-center gap-2 rounded-xl border border-line bg-white/[0.04] px-3 focus-within:border-[color-mix(in_oklab,var(--accent)_55%,transparent)]">
              <Search className="size-4 shrink-0 text-fg-3" />
              <input value={q} onChange={(e) => setQ(e.target.value)} enterKeyHint="search" placeholder="Search models" className="h-full min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-fg-3" />
            </div>
          </div>
          <div className="px-2 pt-1 pb-2">
            {connectors.map((c) => (
              <ConnectorModels
                key={c.id}
                touch
                connector={c}
                value={value}
                query={q.toLowerCase()}
                onPick={(choice) => {
                  onChange(choice)
                  setOpen(false)
                  setQ('')
                }}
              />
            ))}
            {!connectors.length && <div className="px-3 py-8 text-center text-[12.5px] text-fg-3">No text model connectors yet.</div>}
          </div>
        </Dialog>
      </>
    )
  }

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align={align}
      className="w-[340px] p-1"
      trigger={
        <button className={cn('no-drag inline-flex h-7.5 max-w-[260px] items-center gap-1.5 rounded-lg border border-line bg-white/[0.04] px-2.5 text-[12px] font-medium text-fg-2 transition hover:border-line-strong hover:text-fg', className)}>
          <span className="size-1.5 rounded-full bg-grad" />
          <span className="truncate">{label}</span>
          <ChevronDown className="size-3 shrink-0 text-fg-3" />
        </button>
      }
    >
      <div className="flex items-center gap-2 border-b border-line px-2.5 pb-1.5">
        <Search className="size-3.5 text-fg-3" />
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search models" className="h-8 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-fg-3" />
      </div>
      <div className="max-h-[380px] overflow-y-auto">
        {connectors.map((c) => (
          <ConnectorModels
            key={c.id}
            connector={c}
            value={value}
            query={q.toLowerCase()}
            onPick={(choice) => {
              onChange(choice)
              setOpen(false)
            }}
          />
        ))}
        {!connectors.length && <div className="px-3 py-6 text-center text-[12px] text-fg-3">No text model connectors yet.</div>}
      </div>
      <button
        onClick={() => {
          setOpen(false)
          navigate('/connectors')
        }}
        className="flex h-8.5 w-full items-center gap-2 rounded-lg border-t border-line px-2.5 text-[12px] text-fg-2 hover:bg-white/[0.05] hover:text-fg"
      >
        <Settings2 className="size-3.5" /> Manage connectors
      </button>
    </Popover>
  )
}
