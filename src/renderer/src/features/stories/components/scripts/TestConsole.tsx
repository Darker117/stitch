// Test console: run one hook of the script being edited against sample text
// or a real adventure, and show the text it returns, its logs, and what it
// did to state and story cards. Nothing is saved.
import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { CircleAlert, CircleCheck, Info, Play, RotateCcw, TriangleAlert } from 'lucide-react'
import type { Adventure, StoryScript } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Segmented, Switch } from '@/components/ui/controls'
import { Textarea } from '@/components/ui/input'
import { Badge } from '@/components/ui/misc'
import { Select } from '@/components/ui/overlay'
import { cn } from '@/lib/utils'
import { ease } from '@/lib/motion'
import { useCollection } from '@/stores/db'
import { sampleAdventure, sampleText, testHook, type TestRun } from '../../engine/scripts/test'
import type { HookName, LogLevel } from '../../engine/scripts/types'

const LEVEL: Record<LogLevel, { icon: React.ReactNode; tone: string }> = {
  log: { icon: <span className="mt-[7px] size-1 rounded-full bg-fg-3" />, tone: 'text-fg-2' },
  info: { icon: <Info className="size-3.5 text-accent-2" />, tone: 'text-fg-2' },
  warn: { icon: <TriangleAlert className="size-3.5 text-warning" />, tone: 'text-warning' },
  error: { icon: <CircleAlert className="size-3.5 text-danger" />, tone: 'text-danger' }
}

export function LogLine({ level, children, meta }: { level: LogLevel; children: React.ReactNode; meta?: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-start gap-2 px-2.5 py-1.5">
      <span className="grid w-3.5 shrink-0 place-items-center pt-px">{LEVEL[level].icon}</span>
      <div className="min-w-0 flex-1">
        {meta && <div className="text-[10.5px] text-fg-3">{meta}</div>}
        <div className={cn('selectable font-mono text-[11.5px] leading-relaxed break-words whitespace-pre-wrap', LEVEL[level].tone)}>{children}</div>
      </div>
    </div>
  )
}

function Block({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="label-caps">{title}</span>
        {aside}
      </div>
      {children}
    </div>
  )
}

const MODE_TEXT = {
  native: 'Unchanged — sent in the normal chat layout.',
  header: 'World info rewritten — replaces the story sections of the system prompt.',
  raw: 'Rewritten — sent as one AI Dungeon-style prompt.'
}

function changedKeys(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  return [...keys].filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
}

export function TestConsole({ script, adventureId }: { script: StoryScript; adventureId?: string }): React.JSX.Element {
  const adventures = useCollection('adventures')
  const sample = useMemo(() => sampleAdventure(), [])
  const [hook, setHook] = useState<HookName>(() => (script.input.trim() ? 'input' : script.context.trim() ? 'context' : script.output.trim() ? 'output' : 'input'))
  const [advId, setAdvId] = useState(adventureId ?? 'sample')
  const adv: Adventure = (advId !== 'sample' && adventures.find((a) => a.id === advId)) || sample
  const [text, setText] = useState('')
  const [savedState, setSavedState] = useState(true)
  const [run, setRun] = useState<TestRun | null>(null)
  const [running, setRunning] = useState(false)

  // Refill the sample text when the hook or the adventure changes (not on every save).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setText(sampleText(hook, adv)), [hook, advId])

  const go = async (): Promise<void> => {
    setRunning(true)
    try {
      setRun(await testHook(script, hook, adv, text, savedState ? adv.scriptState : {}))
    } finally {
      setRunning(false)
    }
  }

  const defined = script[hook].trim().length > 0
  const out = run?.out
  const keys = run && out ? changedKeys(run.env.state, out.state) : []
  const textChanged = run && out ? out.text !== run.env.text : false

  return (
    // Phones: the whole console scrolls as one column (its pane scrolls, not the results box).
    <div className="flex h-full flex-col max-md:h-auto">
      <div className="flex flex-col gap-3 border-b border-line p-4">
        <Segmented
          size="sm"
          caps
          className="w-full [&>button]:flex-1 [&>button]:justify-center max-md:[&>button]:h-8"
          value={hook}
          onChange={(h) => {
            setHook(h)
            setRun(null)
          }}
          items={[
            { value: 'input', label: 'Input' },
            { value: 'context', label: 'Context' },
            { value: 'output', label: 'Output' }
          ]}
        />
        <Select
          size="sm"
          value={advId}
          onChange={(v) => {
            setAdvId(v)
            setRun(null)
          }}
          options={[
            { value: 'sample', label: 'Sample adventure', hint: 'A short built-in scene' },
            ...adventures
              .filter((a) => a.actions.length)
              .slice(0, 40)
              .map((a) => ({ value: a.id, label: a.title || 'Untitled adventure', hint: `${a.actions.length} actions · ${a.cards.length} cards` }))
          ]}
        />
        <label className="flex items-center justify-between gap-3 text-[12px] text-fg-2">
          Start from the adventure&apos;s saved state
          <Switch size="sm" checked={savedState} onChange={setSavedState} />
        </label>
        <Block
          title={hook === 'context' ? 'Context text' : hook === 'input' ? 'Player input' : 'Model reply'}
          aside={
            <button onClick={() => setText(sampleText(hook, adv))} className="flex items-center gap-1 text-[11px] font-medium text-fg-3 hover:text-fg">
              <RotateCcw className="size-3" /> Reset
            </button>
          }
        >
          <Textarea value={text} onChange={(e) => setText(e.target.value)} minRows={3} maxRows={hook === 'context' ? 9 : 5} className="font-mono text-[11.5px]" spellCheck={false} />
        </Block>
        <Button variant="primary" icon={<Play className="size-3.5 fill-current" />} loading={running} disabled={!defined} onClick={() => void go()}>
          {defined ? `Run ${hook} hook` : `No ${hook} code`}
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4 max-md:flex-none max-md:overflow-visible max-md:pb-6">
        <AnimatePresence mode="wait" initial={false}>
          {!run || !out ? (
            <motion.p key="idle" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="pt-6 text-center text-[12px] leading-relaxed text-fg-3">
              Runs your unsaved code in the sandbox against {advId === 'sample' ? 'a sample scene' : 'this adventure'}. Nothing is saved.
            </motion.p>
          ) : (
            <motion.div key={`${run.hook}-${out.ms}`} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.25, ease }} className="flex flex-col gap-4">
              <div className="flex flex-wrap items-center gap-2">
                {out.errors ? (
                  <span className="flex items-center gap-1.5 text-[12.5px] font-semibold text-danger">
                    <CircleAlert className="size-4" /> {out.errors} error{out.errors === 1 ? '' : 's'}
                  </span>
                ) : (
                  <span className="flex items-center gap-1.5 text-[12.5px] font-semibold text-success">
                    <CircleCheck className="size-4" /> Ran cleanly
                  </span>
                )}
                <Badge>{Math.round(out.ms)} ms</Badge>
                {out.stop && <Badge tone="warning">stop</Badge>}
                {textChanged ? <Badge tone="accent">text changed</Badge> : <Badge>text unchanged</Badge>}
              </div>
              {out.message && (
                <div className="rounded-xl border border-line bg-grad-soft px-3 py-2 text-[12px] text-fg">
                  <span className="label-caps mr-2">Message</span>
                  {out.message}
                </div>
              )}
              {run.mode && <p className="text-[11.5px] text-fg-3">Model input: {MODE_TEXT[run.mode]}</p>}
              <Block title="Returned text">
                <pre className="selectable max-h-[220px] overflow-auto rounded-xl border border-line bg-black/25 p-2.5 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-fg-2">{out.text || <span className="text-fg-3">(empty)</span>}</pre>
              </Block>
              <Block title={`Log · ${out.logs.length}`}>
                {out.logs.length ? (
                  <div className="max-h-[240px] divide-y divide-line overflow-auto rounded-xl border border-line bg-black/20">
                    {out.logs.map((l) => (
                      <LogLine key={l.id} level={l.level}>
                        {l.message}
                      </LogLine>
                    ))}
                  </div>
                ) : (
                  <p className="text-[11.5px] text-fg-3">Nothing logged. Use log(…) or console.log(…).</p>
                )}
              </Block>
              <Block title="Story cards">
                {run.cards.added.length + run.cards.changed.length + run.cards.removed.length === 0 ? (
                  <p className="text-[11.5px] text-fg-3">No changes.</p>
                ) : (
                  <div className="flex flex-col gap-1 text-[12px]">
                    {run.cards.added.map((c) => (
                      <div key={`a-${c.id}-${c.title}`} className="flex gap-2">
                        <span className="w-4 font-mono text-success">+</span>
                        <span className="truncate">{c.title || c.keys || 'Untitled'}</span>
                        <span className="text-fg-3">{c.type}</span>
                      </div>
                    ))}
                    {run.cards.changed.map(({ after }) => (
                      <div key={`c-${after.id}`} className="flex gap-2">
                        <span className="w-4 font-mono text-accent">~</span>
                        <span className="truncate">{after.title || after.keys || 'Untitled'}</span>
                      </div>
                    ))}
                    {run.cards.removed.map((c) => (
                      <div key={`r-${c.id}`} className="flex gap-2">
                        <span className="w-4 font-mono text-danger">−</span>
                        <span className="truncate text-fg-2 line-through">{c.title || c.keys || 'Untitled'}</span>
                      </div>
                    ))}
                  </div>
                )}
              </Block>
              <Block title="State" aside={keys.length ? <span className="text-[11px] text-accent">changed: {keys.join(', ')}</span> : <span className="text-[11px] text-fg-3">unchanged</span>}>
                <pre className="selectable max-h-[240px] overflow-auto rounded-xl border border-line bg-black/25 p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-fg-2">{JSON.stringify(out.state, null, 2).slice(0, 20000)}</pre>
              </Block>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}
