// Composer → Scripts: describe a mechanic, get an AI Dungeon-compatible script
// (Library / Input / Context / Output), validated in the sandbox, with the
// code on show and an “attach” switch.
import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { AlertTriangle, Braces, Check, CircleCheck, Code2, Ellipsis, Pencil, RefreshCw, Square, Trash2, WandSparkles } from 'lucide-react'
import { Button, Chip, IconButton } from '@/components/ui/button'
import { Input, Textarea } from '@/components/ui/input'
import { Menu, MenuItem, MenuSeparator } from '@/components/ui/overlay'
import { Segmented, Switch } from '@/components/ui/controls'
import { Spinner } from '@/components/ui/misc'
import { cn } from '@/lib/utils'
import { springSoft } from '@/lib/motion'
import { ThinkingBlock } from '@/features/create/Messages'
import type { ScriptDraft } from './draft'
import { composeScript, HOOK_HINT, HOOKS, revalidate, stopScript, type Hook } from './scripts'
import { useComposer } from './store'

const IDEAS = [
  "Track my HP in the author's note",
  'Auto-create story cards for new characters',
  'An inner-thoughts system for NPCs',
  'A day/night clock that advances each turn',
  'Inventory that remembers what I pick up'
]

function ScriptStatus({ s }: { s: ScriptDraft }): React.JSX.Element {
  const base = 'inline-flex h-5 items-center gap-1 rounded-full px-2 text-[10.5px] font-semibold tracking-wide whitespace-nowrap'
  if (s.status === 'writing')
    return (
      <span className={cn(base, 'bg-[color-mix(in_oklab,var(--accent)_16%,transparent)] text-accent')}>
        <Spinner className="size-3" /> {s.validation && !s.validation.ok ? 'Fixing…' : 'Writing…'}
      </span>
    )
  if (s.status === 'checking')
    return (
      <span className={cn(base, 'bg-white/[0.07] text-fg-2')}>
        <Spinner className="size-3" /> Checking…
      </span>
    )
  if (s.status === 'ready')
    return (
      <span className={cn(base, 'bg-success/12 text-success')}>
        <CircleCheck className="size-3" /> Validated
      </span>
    )
  return (
    <span className={cn(base, 'bg-warning/12 text-warning')}>
      <AlertTriangle className="size-3" /> Needs work
    </span>
  )
}

function ScriptCard({ s }: { s: ScriptDraft }): React.JSX.Element {
  const busy = useComposer((st) => !!st.busy)
  const mine = useComposer((st) => st.busy?.kind === 'script' && st.busy.id === s.id)
  const { updateScript, removeScript } = useComposer.getState()
  const firstHook = HOOKS.find((h) => h !== 'library' && s[h].trim()) ?? HOOKS.find((h) => s[h].trim()) ?? 'input'
  const [hook, setHook] = useState<Hook>(firstHook)
  const [editing, setEditing] = useState(false)
  const [change, setChange] = useState('')
  // While the model writes, follow the hook it is on; afterwards land on one with code.
  const writing = s.status === 'writing'
  const latest = [...HOOKS].reverse().find((h) => s[h].trim())
  const shown: Hook = writing && mine && latest ? latest : hook
  useEffect(() => {
    if (!writing && !s[hook].trim()) setHook(firstHook)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [writing])

  return (
    <motion.div layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, height: 0 }} transition={springSoft} className="overflow-hidden rounded-2xl border border-line bg-white/[0.03]">
      <div className="flex items-start gap-3 p-4 pb-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-grad-soft text-accent">
          <Code2 className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div className="truncate text-[13.5px] font-semibold">{s.name || 'New script'}</div>
            <ScriptStatus s={s} />
          </div>
          <p className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-fg-2">{s.description || s.request}</p>
        </div>
        <label className={cn('flex items-center gap-2 text-[11.5px] font-medium text-fg-2', (s.status === 'writing' || s.status === 'checking') && 'opacity-50')}>
          Attach
          <Switch size="sm" checked={s.attach} disabled={s.status === 'writing' || s.status === 'checking'} onChange={(v) => updateScript(s.id, { attach: v })} />
        </label>
        {mine ? (
          <IconButton label="Stop" size="sm" onClick={stopScript}>
            <Square className="size-3 fill-current" />
          </IconButton>
        ) : (
          <Menu
            align="end"
            trigger={
              <IconButton label="Script options" size="sm">
                <Ellipsis className="size-4" />
              </IconButton>
            }
          >
            <MenuItem icon={<RefreshCw />} disabled={busy} onSelect={() => void composeScript(s.request, { id: s.id })}>
              Rewrite from scratch
            </MenuItem>
            <MenuItem icon={<Pencil />} onSelect={() => setEditing((e) => !e)}>
              {editing ? 'Stop editing code' : 'Edit code'}
            </MenuItem>
            <MenuItem icon={<Check />} disabled={s.status === 'writing'} onSelect={() => void revalidate(s.id)}>
              Validate again
            </MenuItem>
            <MenuSeparator />
            <MenuItem icon={<Trash2 />} danger onSelect={() => removeScript(s.id)}>
              Remove
            </MenuItem>
          </Menu>
        )}
      </div>

      {s.reasoning && s.status === 'writing' && (
        <div className="px-4 pb-2">
          <ThinkingBlock reasoning={s.reasoning} live={mine} />
        </div>
      )}

      <div className="border-t border-line bg-black/20">
        <div className="flex items-center gap-2 px-3 pt-2.5">
          <Segmented
            size="sm"
            value={shown}
            onChange={setHook}
            items={HOOKS.map((h) => ({
              value: h,
              label: (
                <span className="flex items-center gap-1.5">
                  {h[0].toUpperCase() + h.slice(1)}
                  <span className={cn('size-1.5 rounded-full', s[h].trim() ? 'bg-accent' : 'bg-white/15')} />
                </span>
              )
            }))}
          />
          <span className="truncate text-[11px] text-fg-3">{HOOK_HINT[shown]}</span>
        </div>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={`${shown}-${editing}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }} className="p-3">
            {editing ? (
              <Textarea
                value={s[shown]}
                onChange={(e) => updateScript(s.id, { [shown]: e.target.value, status: 'error', error: 'Edited — validate again.' })}
                minRows={6}
                maxRows={22}
                spellCheck={false}
                className="font-mono text-[11.5px] leading-[1.6]"
              />
            ) : s[shown].trim() ? (
              <pre className="selectable max-h-[300px] overflow-auto rounded-xl border border-line bg-black/30 p-3 font-mono text-[11.5px] leading-[1.6] whitespace-pre text-fg-2">
                {s[shown]}
                {s.status === 'writing' && mine && <span className="st-caret" />}
              </pre>
            ) : (
              <div className="rounded-xl border border-dashed border-line px-3 py-4 text-center text-[11.5px] text-fg-3">{s.status === 'writing' ? 'Writing…' : 'Not used by this script.'}</div>
            )}
          </motion.div>
        </AnimatePresence>
        {(s.error || (s.validation && (s.validation.errors.length > 0 || s.validation.logs.length > 0))) && s.status !== 'writing' && (
          <div className="flex flex-col gap-1.5 px-4 pb-3">
            {s.validation?.errors.map((e, i) => (
              <div key={i} className="flex gap-2 text-[11.5px] leading-snug text-warning">
                <AlertTriangle className="mt-px size-3.5 shrink-0" />
                <span className="font-mono">{e}</span>
              </div>
            ))}
            {s.error && !s.validation?.errors.length && <div className="text-[11.5px] text-warning">{s.error}</div>}
            {s.validation && s.validation.logs.length > 0 && <div className="truncate font-mono text-[10.5px] text-fg-3">log: {s.validation.logs.slice(-3).join(' · ')}</div>}
          </div>
        )}
        {!mine && s.status !== 'checking' && (
          <div className="flex gap-2 border-t border-line px-3 py-2.5">
            <Input value={change} onChange={(e) => setChange(e.target.value)} placeholder="Ask for a change… e.g. start at 20 HP" className="h-8 text-[12px]" onKeyDown={(e) => e.key === 'Enter' && change.trim() && !busy && (void composeScript(s.request, { id: s.id, change }), setChange(''))} />
            <Button
              size="sm"
              variant="secondary"
              icon={<WandSparkles className="size-3.5" />}
              disabled={!change.trim() || busy}
              onClick={() => {
                void composeScript(s.request, { id: s.id, change })
                setChange('')
              }}
            >
              Revise
            </Button>
          </div>
        )}
      </div>
    </motion.div>
  )
}

export function ScriptsSection(): React.JSX.Element {
  const scripts = useComposer((s) => s.draft.scripts)
  const busy = useComposer((s) => !!s.busy)
  const [req, setReq] = useState('')
  const go = (text = req): void => {
    if (!text.trim() || busy) return
    void composeScript(text.trim())
    setReq('')
  }
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[12px] leading-relaxed text-fg-3">
        Describe a mechanic and the composer writes an AI Dungeon-compatible script — Library, Input, Context and Output — checks it in the sandbox and attaches it to the scenario. You can also just ask for one in the chat.
      </p>
      <div className="flex gap-2">
        <Input value={req} onChange={(e) => setReq(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go()} icon={<Braces className="size-3.5" />} placeholder="e.g. Track my HP in the author's note and warn me when it's low" />
        <Button variant="primary" icon={<WandSparkles className="size-3.5" />} disabled={!req.trim() || busy} onClick={() => go()}>
          Write script
        </Button>
      </div>
      {!scripts.length && (
        <div className="flex flex-wrap gap-1.5">
          {IDEAS.map((i) => (
            <Chip key={i} disabled={busy} onClick={() => go(i)}>
              {i}
            </Chip>
          ))}
        </div>
      )}
      <AnimatePresence initial={false}>
        {scripts.map((s) => (
          <ScriptCard key={s.id} s={s} />
        ))}
      </AnimatePresence>
    </div>
  )
}
