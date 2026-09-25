// Play panel → Scripts, like AI Dungeon's Edit Adventure → Scripts: the
// scenario's scripts (can be switched off here, not removed), this
// adventure's own scripts, the recent script log and the script state.
import { useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Braces, Eraser, Plus, RotateCcw, ScrollText, TriangleAlert } from 'lucide-react'
import type { Adventure, Scenario } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/misc'
import { ease } from '@/lib/motion'
import { adventureScriptRefs, activeScriptIds, overlapWarning, useScripts, type AdventureScriptRef } from '../../engine/scripts/library'
import { resetScriptState, useScriptLog, useScriptLogStore } from '../../engine/scripts/play'
import { HOOK_LABEL } from '../../engine/scripts/runtime'
import { RunOrderList, type RunOrderItem } from './RunOrder'
import { ScriptEditor } from './ScriptEditor'
import { ScriptLibrary } from './ScriptLibrary'
import { LogLine } from './TestConsole'

type Change = (p: Partial<Adventure> | ((cur: Adventure) => Partial<Adventure>)) => void

function time(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function AdventureScripts({ adv, scenario, change }: { adv: Adventure; scenario?: Scenario; change: Change }): React.JSX.Element {
  const all = useScripts()
  const byId = useMemo(() => new Map(all.map((s) => [s.id, s])), [all])
  const log = useScriptLog(adv.id)
  const [picker, setPicker] = useState(false)
  const [editor, setEditor] = useState<{ id: string; n: number } | null>(null)
  const [showState, setShowState] = useState(false)

  const refs = adventureScriptRefs(adv, scenario)
  const fromScenario = refs.filter((r) => r.fromScenario)
  const own = refs.filter((r) => !r.fromScenario)
  const setRefs = (next: AdventureScriptRef[]): void => change({ scripts: next })
  const toggle = (id: string, enabled: boolean): void => setRefs(refs.map((r) => (r.scriptId === id ? { ...r, enabled } : r)))
  const running = activeScriptIds(adv, scenario)
  const warning = overlapWarning(running, byId)
  const item = (r: AdventureScriptRef, removable: boolean): RunOrderItem => ({ scriptId: r.scriptId, enabled: r.enabled, script: byId.get(r.scriptId), removable })
  const stateJson = JSON.stringify(adv.scriptState ?? {}, null, 2)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3 rounded-2xl border border-line bg-grad-soft p-4">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-white/10 text-fg">
          <Braces className="size-4.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold">{running.length ? `${running.length} script${running.length === 1 ? '' : 's'} running` : 'No scripts running'}</div>
          <div className="text-[11.5px] leading-snug text-fg-2">Input, Context and Output hooks run on every turn, top to bottom.</div>
        </div>
      </div>

      {scenario && !scenario.scriptsEnabled && (scenario.scripts?.length ?? 0) > 0 && (
        <p className="text-[12px] text-fg-3">This scenario&apos;s scripts are turned off in its Details.</p>
      )}

      {fromScenario.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="label-caps">From this scenario</div>
          <RunOrderList items={fromScenario.map((r) => item(r, false))} onToggle={toggle} onEdit={(id) => setEditor({ id, n: Date.now() })} />
        </div>
      )}

      <div className="flex flex-col gap-2">
        <div className="label-caps">This adventure</div>
        <RunOrderList
          items={own.map((r) => item(r, true))}
          onToggle={toggle}
          onRemove={(id) => setRefs(refs.filter((r) => r.scriptId !== id))}
          onReorder={(ids) => setRefs([...fromScenario, ...ids.map((id) => own.find((r) => r.scriptId === id)).filter((r): r is AdventureScriptRef => !!r)])}
          onEdit={(id) => setEditor({ id, n: Date.now() })}
          empty={<p className="rounded-xl border border-dashed border-line px-3 py-4 text-center text-[12px] text-fg-3">Add scripts just for this adventure. They run after the scenario&apos;s.</p>}
        />
        <Button variant="secondary" size="sm" icon={<Plus className="size-3.5" />} className="self-start" onClick={() => setPicker(true)}>
          Add Script
        </Button>
      </div>

      <AnimatePresence initial={false}>
        {warning && (
          <motion.p initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.2, ease }} className="flex items-start gap-2 text-[12px] text-warning">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" /> {warning}
          </motion.p>
        )}
      </AnimatePresence>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="label-caps flex items-center gap-1.5">
            <ScrollText className="size-3.5" /> Script log
          </span>
          {log.length > 0 && (
            <button onClick={() => useScriptLogStore.getState().clear(adv.id)} className="flex items-center gap-1 text-[11px] font-medium text-fg-3 hover:text-fg">
              <Eraser className="size-3" /> Clear
            </button>
          )}
        </div>
        {log.length ? (
          <div className="max-h-[300px] divide-y divide-line overflow-y-auto rounded-xl border border-line bg-black/20">
            <AnimatePresence initial={false}>
              {[...log].reverse().map((l) => (
                <motion.div key={l.id} initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2, ease }}>
                  <LogLine level={l.level} meta={`${time(l.at)} · ${l.script} · ${HOOK_LABEL[l.hook]}`}>
                    {l.message}
                  </LogLine>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        ) : (
          <p className="text-[12px] text-fg-3">Logs, errors and messages from this session&apos;s turns show up here.</p>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <button onClick={() => setShowState((v) => !v)} className="label-caps flex items-center gap-1.5 hover:text-fg">
            Script state <Badge>{(new Blob([stateJson]).size / 1024).toFixed(1)} KB</Badge>
          </button>
          <Button size="xs" variant="ghost" icon={<RotateCcw className="size-3" />} onClick={() => void resetScriptState(adv.id)} disabled={stateJson === '{}'}>
            Reset
          </Button>
        </div>
        <AnimatePresence initial={false}>
          {showState && (
            <motion.pre initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.2, ease }} className="selectable max-h-[260px] overflow-auto rounded-xl border border-line bg-black/25 p-2.5 font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap text-fg-2">
              {stateJson.slice(0, 30000)}
            </motion.pre>
          )}
        </AnimatePresence>
      </div>

      <ScriptLibrary
        open={picker}
        onClose={() => setPicker(false)}
        added={refs.map((r) => r.scriptId)}
        adventureId={adv.id}
        onPick={(id) => change((cur) => {
          const now = adventureScriptRefs(cur, scenario)
          return now.some((r) => r.scriptId === id) ? {} : { scripts: [...now, { scriptId: id, enabled: true }] }
        })}
      />
      <ScriptEditor
        key={editor?.n ?? 0}
        open={!!editor}
        onClose={() => setEditor(null)}
        scriptId={editor?.id}
        adventureId={adv.id}
        onDuplicated={(from, to) => {
          // A scenario script can't be swapped out here: switch it off and run the copy instead.
          const src = refs.find((r) => r.scriptId === from)
          if (src?.fromScenario) setRefs([...refs.map((r) => (r.scriptId === from ? { ...r, enabled: false } : r)), { scriptId: to, enabled: true }])
          else setRefs(refs.map((r) => (r.scriptId === from ? { ...r, scriptId: to } : r)))
        }}
      />
    </div>
  )
}
