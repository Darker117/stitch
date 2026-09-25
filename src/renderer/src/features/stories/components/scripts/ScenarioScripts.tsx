// Details → Scripts for a scenario, like AI Dungeon's: the Scripts Enabled
// switch, Edit scripts, the run order and + Add Script.
import { useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Braces, Plus, TriangleAlert } from 'lucide-react'
import type { Scenario, ScriptRef, StoryScript } from '@shared/types'
import { Button } from '@/components/ui/button'
import { SwitchRow } from '@/components/ui/controls'
import { ease } from '@/lib/motion'
import { db, useDoc } from '@/stores/db'
import { overlapWarning, useScripts } from '../../engine/scripts/library'
import { newScriptDraft } from '../../engine/scripts/templates'
import { RunOrderList, type RunOrderItem } from './RunOrder'
import { ScriptEditor } from './ScriptEditor'
import { ScriptLibrary } from './ScriptLibrary'

export function ScenarioScripts({ scenarioId }: { scenarioId: string }): React.JSX.Element | null {
  const scenario = useDoc('scenarios', scenarioId)
  const all = useScripts()
  const byId = useMemo(() => new Map(all.map((s) => [s.id, s])), [all])
  const [picker, setPicker] = useState(false)
  const [editor, setEditor] = useState<{ id?: string; draft?: Partial<StoryScript> & { name: string }; n: number } | null>(null)

  if (!scenario) return null

  if (scenario.parentId) {
    return (
      <div className="flex flex-col gap-2.5">
        <div className="label-caps">Scripts</div>
        <p className="text-[12px] text-fg-3">Scripts are set on the main scenario and run for every choice.</p>
      </div>
    )
  }

  const refs = scenario.scripts ?? []
  const enabled = !!scenario.scriptsEnabled
  const update = (fn: (cur: Scenario) => Partial<Scenario>): void => void db.update('scenarios', scenarioId, (cur) => ({ ...cur, ...fn(cur), updatedAt: Date.now() }))
  const setRefs = (fn: (refs: ScriptRef[]) => ScriptRef[]): void => update((cur) => ({ scripts: fn(cur.scripts ?? []) }))
  const add = (id: string): void => setRefs((r) => (r.some((x) => x.scriptId === id) ? r : [...r, { scriptId: id, enabled: true }]))

  const items: RunOrderItem[] = refs.map((r) => ({ scriptId: r.scriptId, enabled: r.enabled, script: byId.get(r.scriptId), removable: true }))
  const warning = overlapWarning(
    refs.filter((r) => r.enabled).map((r) => r.scriptId),
    byId
  )

  const editScripts = (): void => {
    const first = refs[0]?.scriptId
    if (first) setEditor({ id: first, n: Date.now() })
    else setEditor({ draft: newScriptDraft(`${scenario.title || 'Scenario'} script`), n: Date.now() })
  }

  return (
    <div className="flex flex-col gap-2.5">
      <div className="label-caps">Scripts</div>
      <div className="flex flex-col gap-4 rounded-2xl border border-line bg-white/[0.03] p-4">
        <SwitchRow
          label="Scripts Enabled"
          help="Run these scripts in every adventure played from this scenario — including ones already started."
          checked={enabled}
          onChange={(v) => update(() => ({ scriptsEnabled: v }))}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button icon={<Braces className="size-3.5" />} onClick={editScripts}>
            Edit scripts
          </Button>
          <span className="text-[11.5px] text-fg-3">Write or change code — Library, Input, Context and Output.</span>
        </div>
        <div className="h-px bg-line" />
        <div className="flex items-baseline justify-between gap-3">
          <div>
            <div className="text-[12.5px] font-semibold">Run order</div>
            <div className="text-[11.5px] text-fg-3">This scenario · top runs first</div>
          </div>
          {refs.length > 0 && <span className="text-[11.5px] text-fg-3 tabular-nums">{refs.filter((r) => r.enabled).length} of {refs.length} on</span>}
        </div>
        <RunOrderList
          items={items}
          dimmed={!enabled}
          onToggle={(id, v) => setRefs((r) => r.map((x) => (x.scriptId === id ? { ...x, enabled: v } : x)))}
          onRemove={(id) => setRefs((r) => r.filter((x) => x.scriptId !== id))}
          onReorder={(ids) => setRefs((r) => ids.map((id) => r.find((x) => x.scriptId === id)).filter((x): x is ScriptRef => !!x))}
          onEdit={(id) => setEditor({ id, n: Date.now() })}
          empty={<p className="rounded-xl border border-dashed border-line px-4 py-5 text-center text-[12px] text-fg-3">No scripts yet. Add Auto-Cards, Inner Self, one of yours, or any AI Dungeon script.</p>}
        />
        <AnimatePresence initial={false}>
          {warning && (
            <motion.p initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.2, ease }} className="flex items-start gap-2 text-[12px] text-warning">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" /> {warning}
            </motion.p>
          )}
          {!enabled && refs.length > 0 && (
            <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="text-[12px] text-fg-3">
              Scripts are off — none of these run until you turn Scripts Enabled on.
            </motion.p>
          )}
        </AnimatePresence>
        <Button variant="secondary" icon={<Plus className="size-3.5" />} className="self-start" onClick={() => setPicker(true)}>
          Add Script
        </Button>
      </div>

      <ScriptLibrary
        open={picker}
        onClose={() => setPicker(false)}
        added={refs.map((r) => r.scriptId)}
        onPick={(id) => {
          add(id)
          if (!enabled && !refs.length) update(() => ({ scriptsEnabled: true }))
        }}
      />
      <ScriptEditor
        key={editor?.n ?? 0}
        open={!!editor}
        onClose={() => setEditor(null)}
        scriptId={editor?.id}
        draft={editor?.draft}
        switchable={refs.map((r) => r.scriptId)}
        onCreated={(id) => {
          add(id)
          if (!refs.length && scenario.scriptsEnabled === undefined) update(() => ({ scriptsEnabled: true }))
        }}
        onDuplicated={(from, to) => setRefs((r) => r.map((x) => (x.scriptId === from ? { ...x, scriptId: to } : x)))}
      />
    </div>
  )
}
