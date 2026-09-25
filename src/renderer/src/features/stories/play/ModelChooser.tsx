// "Story Models": the user's text models grouped by connector, as cards.
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { AnimatePresence, motion } from 'motion/react'
import { Blocks, Check, Cloud, Cpu, RefreshCw } from 'lucide-react'
import type { LlmConnector } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Badge, Spinner } from '@/components/ui/misc'
import { cn } from '@/lib/utils'
import { spring } from '@/lib/motion'
import { isLocalKind, LLM_KIND_LABEL, modelLabel, useLlmConnectors, useModels, type LlmChoice } from '@/lib/llm'
import { useSettings } from '@/stores/settings'

function ctxLabel(n?: number): string | undefined {
  if (!n) return undefined
  return n >= 1000 ? `${Math.round(n / 1024)}k context` : `${n} context`
}

function Group({ connector, current, selected, onSelect }: { connector: LlmConnector; current?: LlmChoice; selected?: LlmChoice; onSelect: (c: LlmChoice) => void }): React.JSX.Element | null {
  const { models, loading, error, refresh } = useModels(connector.id)
  const [more, setMore] = useState(false)
  const def = useSettings((s) => s.settings?.defaultLlm)
  const isCur = (id: string): boolean => current?.connectorId === connector.id && current.model === id
  const sorted = [...models].sort((a, b) => Number(isCur(b.id)) - Number(isCur(a.id)))
  const list = more ? sorted : sorted.slice(0, 4)
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 px-1">
        <span className="text-fg-3">{isLocalKind(connector.kind) ? <Cpu className="size-3.5" /> : <Cloud className="size-3.5" />}</span>
        <span className="label-caps text-fg-2">{connector.name}</span>
        {LLM_KIND_LABEL[connector.kind] !== connector.name && <span className="text-[10.5px] text-fg-3">{LLM_KIND_LABEL[connector.kind]}</span>}
        <button onClick={refresh} className="ml-auto grid size-6 place-items-center rounded-md text-fg-3 hover:bg-white/10 hover:text-fg" title="Refresh models">
          {loading ? <Spinner className="size-3" /> : <RefreshCw className="size-3" />}
        </button>
      </div>
      {error && <div className="px-1 text-[11.5px] text-fg-3">{/fetch failed|ECONNREFUSED|network/i.test(error) ? 'Not reachable — is it running?' : error}</div>}
      {!error && !loading && !models.length && <div className="px-1 text-[11.5px] text-fg-3">No models found — is it running?</div>}
      <div className="grid grid-cols-1 gap-1.5">
        <AnimatePresence initial={false}>
          {list.map((m) => {
            const choice = { connectorId: connector.id, model: m.id }
            const sel = selected?.connectorId === connector.id && selected.model === m.id
            const tags = [ctxLabel(m.contextLength), LLM_KIND_LABEL[connector.kind], isLocalKind(connector.kind) ? 'Local' : 'Cloud'].filter(Boolean) as string[]
            return (
              <motion.button
                key={m.id}
                layout
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={spring}
                onClick={() => onSelect(choice)}
                className={cn(
                  'relative flex flex-col gap-1.5 rounded-xl border px-3 py-2.5 text-left transition-colors',
                  sel ? 'border-[color-mix(in_oklab,var(--accent)_55%,transparent)] bg-[color-mix(in_oklab,var(--accent)_10%,transparent)]' : 'border-line bg-white/[0.03] hover:border-line-strong hover:bg-white/[0.05]'
                )}
              >
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{(m.name ?? m.id).replace(/^[^/]+\//, '')}</span>
                  {isCur(m.id) && <Badge tone="accent">CURRENT</Badge>}
                  {def?.connectorId === connector.id && def.model === m.id && <Badge tone="outline">DEFAULT</Badge>}
                  {sel && <Check className="size-3.5 text-accent" />}
                </div>
                <div className="flex flex-wrap gap-1">
                  {tags.map((t) => (
                    <span key={t} className="rounded-md bg-white/[0.06] px-1.5 py-0.5 text-[10.5px] font-medium text-fg-2">
                      {t}
                    </span>
                  ))}
                </div>
              </motion.button>
            )
          })}
        </AnimatePresence>
      </div>
      {models.length > 4 && (
        <button onClick={() => setMore((v) => !v)} className="self-start px-1 text-[12px] font-semibold text-accent hover:brightness-125">
          {more ? 'Show fewer models' : `Show more models (${models.length - 4})`}
        </button>
      )}
    </div>
  )
}

export function ModelChooser({ current, onUse, onDone }: { current?: LlmChoice; onUse: (c: LlmChoice) => void; onDone?: () => void }): React.JSX.Element {
  const connectors = useLlmConnectors()
  const navigate = useNavigate()
  const [selected, setSelected] = useState<LlmChoice | undefined>(current)
  const changed = selected && (selected.connectorId !== current?.connectorId || selected.model !== current?.model)
  return (
    <div className="flex flex-col gap-4">
      {connectors.map((c) => (
        <Group key={c.id} connector={c} current={current} selected={selected} onSelect={setSelected} />
      ))}
      {!connectors.length && (
        <div className="flex flex-col items-center gap-3 py-6 text-center">
          <Blocks className="size-5 text-fg-3" />
          <div className="text-[12.5px] text-fg-2">No text model connectors yet.</div>
          <Button size="sm" onClick={() => navigate('/connectors')}>
            Open Connectors
          </Button>
        </div>
      )}
      {selected && (
        <Button
          variant="primary"
          size="lg"
          disabled={!changed}
          className="w-full tracking-wide uppercase"
          onClick={() => {
            onUse(selected)
            onDone?.()
          }}
        >
          {changed ? `Use ${modelLabel(selected)}` : `Using ${modelLabel(selected)}`}
        </Button>
      )}
    </div>
  )
}
