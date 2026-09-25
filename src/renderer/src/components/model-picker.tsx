// Text-model picker: connectors → models, with search and "set as default".
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { motion } from 'motion/react'
import { Check, ChevronDown, Cpu, Globe, RefreshCw, Search, Settings2, Star } from 'lucide-react'
import type { LlmConnector } from '@shared/types'
import { cn } from '@/lib/utils'
import { springSoft } from '@/lib/motion'
import { isLocalKind, LLM_KIND_LABEL, modelLabel, useLlmConnectors, useModels, type LlmChoice } from '@/lib/llm'
import { useSettings } from '@/stores/settings'
import { Popover } from './ui/overlay'
import { Spinner } from './ui/misc'

function ConnectorModels({ connector, value, onPick, query }: { connector: LlmConnector; value?: LlmChoice; onPick: (c: LlmChoice) => void; query: string }): React.JSX.Element | null {
  const { models, loading, error, refresh } = useModels(connector.id)
  const settings = useSettings((s) => s.settings)
  const update = useSettings((s) => s.update)
  const list = models.filter((m) => !query || m.id.toLowerCase().includes(query) || m.name?.toLowerCase().includes(query)).slice(0, 80)
  if (query && !list.length) return null
  return (
    <div className="py-1">
      <div className="flex items-center gap-2 px-2.5 pt-1.5 pb-1">
        <span className="text-fg-3">{isLocalKind(connector.kind) ? <Cpu className="size-3" /> : <Globe className="size-3" />}</span>
        <span className="label-caps">{connector.name}</span>
        <span className="text-[10.5px] text-fg-3">{LLM_KIND_LABEL[connector.kind]}</span>
        <button onClick={refresh} className="ml-auto grid size-5 place-items-center rounded text-fg-3 hover:text-fg" title="Refresh models">
          {loading ? <Spinner className="size-3" /> : <RefreshCw className="size-3" />}
        </button>
      </div>
      {error && <div className="px-2.5 pb-1.5 text-[11px] text-danger">{error}</div>}
      {!error && !loading && !models.length && <div className="px-2.5 pb-1.5 text-[11px] text-fg-3">No models found — is it running?</div>}
      {list.map((m) => {
        const active = value?.connectorId === connector.id && value.model === m.id
        const isDefault = settings?.defaultLlm?.connectorId === connector.id && settings.defaultLlm.model === m.id
        return (
          <button
            key={m.id}
            onClick={() => onPick({ connectorId: connector.id, model: m.id })}
            className={cn('group relative flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[12.5px] transition-colors', active ? 'text-fg' : 'text-fg-2 hover:bg-white/[0.06] hover:text-fg')}
          >
            {active && <motion.span layoutId="model-active" className="absolute inset-0 rounded-lg bg-white/[0.08]" transition={springSoft} />}
            <span className="relative min-w-0 flex-1 truncate">{m.name ?? m.id}</span>
            {m.contextLength && <span className="relative text-[10.5px] text-fg-3 tabular-nums">{Math.round(m.contextLength / 1000)}k</span>}
            <span
              role="button"
              title={isDefault ? 'Default model' : 'Set as default'}
              onClick={(e) => {
                e.stopPropagation()
                void update({ defaultLlm: { connectorId: connector.id, model: m.id } })
              }}
              className={cn('relative grid size-5 place-items-center rounded transition', isDefault ? 'text-accent' : 'text-fg-3 opacity-0 group-hover:opacity-100 hover:text-fg')}
            >
              <Star className={cn('size-3', isDefault && 'fill-current')} />
            </span>
            {active && <Check className="relative size-3.5 text-accent" />}
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
