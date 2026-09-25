// "Inspect input": the exact system prompt and messages sent to the model.
import { useMemo, useState } from 'react'
import { motion } from 'motion/react'
import { Copy } from 'lucide-react'
import type { Adventure } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Segmented } from '@/components/ui/controls'
import { Dialog } from '@/components/ui/overlay'
import { Badge } from '@/components/ui/misc'
import { ease } from '@/lib/motion'
import { toast } from '@/stores/toast'
import { contextFor } from '../engine/turn'

export function InspectDialog({ open, onClose, adv }: { open: boolean; onClose: () => void; adv: Adventure }): React.JSX.Element {
  const [which, setWhich] = useState<'last' | 'next'>(adv.lastInput ? 'last' : 'next')
  const next = useMemo(() => (open ? contextFor(adv, adv.actions) : null), [open, adv])
  const data =
    which === 'last' && adv.lastInput
      ? { ...adv.lastInput, budget: undefined as number | undefined, included: undefined as string[] | undefined }
      : next
        ? { system: next.system, messages: next.messages, tokens: next.tokens, droppedCards: next.droppedCards, budget: next.budget, included: next.included.map((c) => c.name) }
        : null
  const full = data ? `SYSTEM:\n${data.system}\n\n${data.messages.map((m) => `${m.role.toUpperCase()}:\n${m.content}`).join('\n\n')}` : ''
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Inspect input"
      description="Exactly what the story model receives."
      width={760}
      headerAction={
        <Segmented
          size="sm"
          value={which}
          onChange={setWhich}
          items={[
            { value: 'last', label: 'Last sent' },
            { value: 'next', label: 'Next turn' }
          ]}
        />
      }
      footer={
        <Button
          icon={<Copy className="size-3.5" />}
          onClick={() => {
            void navigator.clipboard.writeText(full)
            toast.success('Copied')
          }}
          disabled={!data}
        >
          Copy all
        </Button>
      }
    >
      {!data ? (
        <div className="p-8 text-center text-[13px] text-fg-3">Nothing has been sent yet. Take a turn first.</div>
      ) : (
        <motion.div key={which} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.25, ease }} className="flex flex-col gap-4 p-5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="accent">~{data.tokens.toLocaleString()} tokens</Badge>
            {data.budget !== undefined && <Badge>budget {data.budget.toLocaleString()}</Badge>}
            <Badge>{data.messages.length} messages</Badge>
            {data.droppedCards > 0 && <Badge tone="warning">{data.droppedCards} card(s) didn&apos;t fit</Badge>}
            {data.included?.map((n) => (
              <Badge key={n} tone="outline">
                {n}
              </Badge>
            ))}
          </div>
          <div>
            <div className="label-caps mb-1.5">System</div>
            <pre className="selectable max-h-[300px] overflow-auto rounded-xl border border-line bg-black/30 p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-fg-2">{data.system}</pre>
          </div>
          <div className="flex flex-col gap-2">
            <div className="label-caps">Messages</div>
            {data.messages.map((m, i) => (
              <div key={i} className="rounded-xl border border-line bg-white/[0.02] p-3">
                <div className="mb-1 text-[10.5px] font-bold tracking-wider text-accent uppercase">{m.role}</div>
                <pre className="selectable font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-fg-2">{m.content}</pre>
              </div>
            ))}
          </div>
        </motion.div>
      )}
    </Dialog>
  )
}
