// Character Studio: node workflows that turn ideas, references, image models and LoRAs into
// characters. Desktop edits them on a canvas; phones get the same nodes as a list of steps.
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { AnimatePresence, motion } from 'motion/react'
import {
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  BackgroundVariant,
  Handle,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps
} from '@xyflow/react'
import '@xyflow/react/dist/base.css'
import './studio.css'
import { ArrowDown, Check, ChevronDown, Copy, Maximize2, Minus, Pencil, Play, Plus, Scan, Trash2, Workflow } from 'lucide-react'
import { nanoid } from 'nanoid'
import type { CharacterFlow, FlowEdge, FlowNode, FlowNodeKind, ID } from '@shared/types'
import { errorText } from '@/lib/api'
import { useCompact } from '@/lib/platform'
import { cn } from '@/lib/utils'
import { ease, rise, spring, stagger } from '@/lib/motion'
import { AssetLightbox } from '@/components/media'
import { Button, IconButton } from '@/components/ui/button'
import { Segmented } from '@/components/ui/controls'
import { Input } from '@/components/ui/input'
import { EmptyState, Spinner } from '@/components/ui/misc'
import { Dialog, Menu, MenuItem, MenuLabel, MenuSeparator, Select, Tooltip } from '@/components/ui/overlay'
import { db, useCollection, useCollectionLoaded } from '@/stores/db'
import { toast } from '@/stores/toast'
import { canConnect, connect, descendants, edgeInto, GROUPS, PORT_COLOR, portOf, SPECS, topo } from './graph'
import { FlowContext, NODE_ICON, NodeCard, nodeLabel, PortRow, useStudio, type StudioCtx } from './nodes'
import { resumePending, runFlow, useRuns } from './run'
import { createFlow, TEMPLATES } from './templates'

const LAST = 'stitch.studio.flow'

function remember(id: string): void {
  try {
    localStorage.setItem(LAST, id)
  } catch {
    /* storage unavailable */
  }
}

function recall(): string | null {
  try {
    return localStorage.getItem(LAST)
  } catch {
    return null
  }
}

function updateFlow(id: ID, fn: (f: CharacterFlow) => Partial<CharacterFlow>): void {
  void db.update('flows', id, (f) => ({ ...f, ...fn(f), updatedAt: Date.now() }))
}

// ─── Canvas ──────────────────────────────────────────────────────────────────

type StitchNodeData = { kind: FlowNodeKind }

const StitchNode = memo(function StitchNode({ id }: NodeProps<Node<StitchNodeData>>): React.JSX.Element | null {
  const { flow } = useStudio()
  const node = flow.nodes.find((n) => n.id === id)
  if (!node) return null
  const spec = SPECS[node.kind]
  return (
    <NodeCard
      node={node}
      dragHandle
      className="w-[292px]"
      inputs={
        spec.inputs.length > 0 && (
          <div className="border-b border-line py-1">
            {spec.inputs.map((p) => (
              <PortRow key={p.id} port={p} dir="in" connected={!!edgeInto(flow, id, p.id)}>
                <Handle type="target" position={Position.Left} id={p.id} style={{ ['--port' as string]: PORT_COLOR[p.type] }} />
              </PortRow>
            ))}
          </div>
        )
      }
      outputs={
        <div className="border-t border-line py-1">
          {spec.outputs.map((p) => (
            <PortRow key={p.id} port={p} dir="out" connected={flow.edges.some((e) => e.from === id && e.fromPort === p.id)}>
              <Handle type="source" position={Position.Right} id={p.id} style={{ ['--port' as string]: PORT_COLOR[p.type] }} />
            </PortRow>
          ))}
        </div>
      }
    />
  )
})

const nodeTypes = { stitch: StitchNode }

function toRf(n: FlowNode): Node<StitchNodeData> {
  return { id: n.id, type: 'stitch', position: { x: n.x, y: n.y }, data: { kind: n.kind }, dragHandle: '.node-drag' }
}

function edgeColor(flow: CharacterFlow, e: FlowEdge): string {
  const from = flow.nodes.find((n) => n.id === e.from)
  const port = from && portOf(from.kind, e.fromPort, 'out')
  return port ? PORT_COLOR[port.type] : 'var(--line-strong)'
}

function ZoomControls(): React.JSX.Element {
  const rf = useReactFlow()
  const btn = 'grid size-8 place-items-center rounded-lg text-fg-2 transition hover:bg-white/[0.08] hover:text-fg max-md:size-10'
  return (
    <Panel position="bottom-left" className="!m-3">
      <div className="glass-strong hairline flex items-center gap-0.5 rounded-xl p-1 shadow-[var(--shadow-pop)]">
        <button className={btn} onClick={() => void rf.zoomOut({ duration: 200 })} aria-label="Zoom out">
          <Minus className="size-3.5" />
        </button>
        <button className={btn} onClick={() => void rf.zoomIn({ duration: 200 })} aria-label="Zoom in">
          <Plus className="size-3.5" />
        </button>
        <button className={btn} onClick={() => void rf.fitView({ padding: 0.18, duration: 350 })} aria-label="Fit to screen">
          <Scan className="size-3.5" />
        </button>
      </div>
    </Panel>
  )
}

function Canvas({ flow, onAddAt }: { flow: CharacterFlow; onAddAt: (fn: (kind: FlowNodeKind) => { x: number; y: number }) => void }): React.JSX.Element {
  const compact = useCompact()
  const rf = useReactFlow()
  const wrap = useRef<HTMLDivElement>(null)
  const [nodes, setNodes] = useState<Node<StitchNodeData>[]>(() => flow.nodes.map(toRf))
  const [selectedEdges, setSelectedEdges] = useState<Set<string>>(new Set())

  // Keep the canvas in step with the doc (adds, deletes, moves from elsewhere) without fighting a drag.
  useEffect(() => {
    setNodes((prev) => {
      const byId = new Map(prev.map((n) => [n.id, n]))
      return flow.nodes.map((d) => {
        const p = byId.get(d.id)
        if (!p) return toRf(d)
        if (p.dragging || (p.position.x === d.x && p.position.y === d.y)) return p
        return { ...p, position: { x: d.x, y: d.y } }
      })
    })
  }, [flow.nodes])

  // New nodes land in the free space nearest the middle of the view, which then glides to them.
  useEffect(() => {
    onAddAt(() => {
      const r = wrap.current?.getBoundingClientRect()
      const c = r ? rf.screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 }) : { x: 0, y: 0 }
      const W = 292
      const H = 340
      const GAP = 28
      const boxes = rf.getNodes().map((n) => ({ x: n.position.x, y: n.position.y, w: n.measured?.width ?? W, h: n.measured?.height ?? H }))
      const free = (x: number, y: number): boolean => boxes.every((b) => x + W + GAP <= b.x || x >= b.x + b.w + GAP || y + H + GAP <= b.y || y >= b.y + b.h + GAP)
      let spot = { x: c.x - W / 2, y: c.y - H / 2 }
      search: for (let ring = 0; ring < 40; ring++) {
        for (let dx = -ring; dx <= ring; dx++) {
          for (let dy = -ring; dy <= ring; dy++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue
            const x = c.x - W / 2 + dx * 80
            const y = c.y - H / 2 + dy * 80
            if (free(x, y)) {
              spot = { x, y }
              break search
            }
          }
        }
      }
      void rf.setCenter(spot.x + W / 2, spot.y + H / 2, { zoom: rf.getZoom(), duration: 450 })
      return { x: Math.round(spot.x), y: Math.round(spot.y) }
    })
  }, [rf, onAddAt])

  const edges: Edge[] = useMemo(
    () =>
      flow.edges.map((e) => ({
        id: e.id,
        source: e.from,
        sourceHandle: e.fromPort,
        target: e.to,
        targetHandle: e.toPort,
        selected: selectedEdges.has(e.id),
        style: { stroke: edgeColor(flow, e) }
      })),
    [flow, selectedEdges]
  )

  const onNodesChange = useCallback((changes: NodeChange<Node<StitchNodeData>>[]) => setNodes((nds) => applyNodeChanges(changes.filter((c) => c.type !== 'remove'), nds)), [])
  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      const next = applyEdgeChanges(changes.filter((c) => c.type === 'select'), edges)
      setSelectedEdges(new Set(next.filter((e) => e.selected).map((e) => e.id)))
    },
    [edges]
  )

  return (
    <div ref={wrap} className="stitch-flow size-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStop={(_, __, dragged) => {
          const moved = new Map(dragged.map((n) => [n.id, n.position]))
          updateFlow(flow.id, (f) => ({ nodes: f.nodes.map((n) => (moved.has(n.id) ? { ...n, x: Math.round(moved.get(n.id)!.x), y: Math.round(moved.get(n.id)!.y) } : n)) }))
        }}
        onDelete={({ nodes: gone, edges: cut }) => {
          const ids = new Set(gone.map((n) => n.id))
          const edgeIds = new Set(cut.map((e) => e.id))
          if (!ids.size && !edgeIds.size) return
          updateFlow(flow.id, (f) => ({ nodes: f.nodes.filter((n) => !ids.has(n.id)), edges: f.edges.filter((e) => !edgeIds.has(e.id) && !ids.has(e.from) && !ids.has(e.to)) }))
        }}
        isValidConnection={(c) => !!c.sourceHandle && !!c.targetHandle && canConnect(flow, c.source, c.sourceHandle, c.target, c.targetHandle)}
        onConnect={(c: Connection) => {
          if (!c.sourceHandle || !c.targetHandle || !canConnect(flow, c.source, c.sourceHandle, c.target, c.targetHandle)) return
          updateFlow(flow.id, (f) => ({ edges: connect(f, c.source, c.sourceHandle!, c.target, c.targetHandle!) }))
        }}
        fitView
        fitViewOptions={{ padding: 0.18, maxZoom: 1 }}
        minZoom={0.25}
        maxZoom={1.6}
        deleteKeyCode={['Backspace', 'Delete']}
        colorMode="dark"
        attributionPosition="top-right"
        panOnScroll={!compact}
        zoomOnPinch
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.3} color="rgb(255 255 255 / 0.09)" />
        <ZoomControls />
        {!compact && (
          <MiniMap
            position="bottom-right"
            pannable
            zoomable
            className="!m-3"
            nodeColor={(n) => {
              const kind = (n.data as StitchNodeData).kind
              const g = SPECS[kind].group
              return g === 'Look' ? 'var(--accent-2)' : g === 'Make' ? 'var(--accent)' : 'rgb(255 255 255 / 0.35)'
            }}
            maskColor="rgb(0 0 0 / 0.45)"
          />
        )}
        {!flow.nodes.length && (
          <Panel position="top-center" className="!mt-24">
            <div className="glass-strong hairline max-w-sm rounded-2xl px-5 py-4 text-center">
              <div className="text-[14px] font-semibold">An empty canvas</div>
              <p className="mt-1 text-[12.5px] text-fg-3">Add nodes from the toolbar, then drag from an output dot to an input to connect them.</p>
            </div>
          </Panel>
        )}
      </ReactFlow>
    </div>
  )
}

// ─── Steps (phones) ──────────────────────────────────────────────────────────

function SourcePicker({ flow, node, port }: { flow: CharacterFlow; node: FlowNode; port: ReturnType<typeof portOf> & object }): React.JSX.Element {
  const current = edgeInto(flow, node.id, port.id)
  const below = descendants(flow, node.id)
  const options = flow.nodes.flatMap((n) =>
    below.has(n.id)
      ? []
      : SPECS[n.kind].outputs.filter((o) => o.type === port.type).map((o) => ({ value: `${n.id}:${o.id}`, label: nodeLabel(flow, n.id) }))
  )
  return (
    <div className="flex items-center gap-2 px-3 py-1">
      <span className="size-1.5 shrink-0 rounded-full" style={{ background: PORT_COLOR[port.type], opacity: current ? 1 : 0.45 }} />
      <span className="w-[78px] shrink-0 text-[11.5px] font-medium text-fg-2">
        {port.label}
        {port.required && !current && <span className="text-accent"> *</span>}
      </span>
      <Select
        size="sm"
        className="h-9 min-w-0 flex-1"
        value={current ? `${current.from}:${current.fromPort}` : 'none'}
        onChange={(v) => {
          if (v === 'none') updateFlow(flow.id, (f) => ({ edges: f.edges.filter((e) => !(e.to === node.id && e.toPort === port.id)) }))
          else {
            const [from, fromPort] = v.split(':')
            updateFlow(flow.id, (f) => ({ edges: connect(f, from, fromPort, node.id, port.id) }))
          }
        }}
        options={[{ value: 'none', label: port.required ? 'Choose…' : 'None' }, ...options]}
      />
    </div>
  )
}

function Steps({ flow, onAdd }: { flow: CharacterFlow; onAdd: (k: FlowNodeKind) => void }): React.JSX.Element {
  const order = topo(flow)
  return (
    <motion.div variants={stagger(0.04)} initial="initial" animate="animate" className="space-y-2.5">
      {order.map((n, i) => (
        <motion.div key={n.id} variants={rise} layout transition={spring}>
          {i > 0 && (
            <div className="flex justify-center pb-2.5 text-fg-3">
              <ArrowDown className="size-3.5" />
            </div>
          )}
          <NodeCard
            node={n}
            inputs={
              SPECS[n.kind].inputs.length > 0 && (
                <div className="border-b border-line py-1.5">
                  {SPECS[n.kind].inputs.map((p) => (
                    <SourcePicker key={p.id} flow={flow} node={n} port={p} />
                  ))}
                </div>
              )
            }
          />
        </motion.div>
      ))}
      <AddNodeMenu
        onAdd={onAdd}
        align="center"
        trigger={
          <button className="flex h-12 w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-line-strong text-[13px] font-medium text-fg-2 transition active:scale-[0.98]">
            <Plus className="size-4" /> Add a step
          </button>
        }
      />
    </motion.div>
  )
}

// ─── Studio ──────────────────────────────────────────────────────────────────

/**
 * Connect a freshly added node so building a chain takes one tap per step: its inputs come from
 * the newest node that makes that kind of value (a LoRA slots into the end of the model chain),
 * and its output fills the first step still missing that input.
 */
function wireIn(flow: CharacterFlow, node: FlowNode): Pick<CharacterFlow, 'nodes' | 'edges'> {
  const spec = SPECS[node.kind]
  let f = flow
  const newest = [...topo(flow)].reverse().filter((n) => n.id !== node.id)
  for (const p of spec.inputs) {
    if (!p.required && p.type === 'image') continue
    const src = newest.find((n) => SPECS[n.kind].outputs.some((o) => o.type === p.type))
    const out = src && SPECS[src.kind].outputs.find((o) => o.type === p.type)
    if (!src || !out || !canConnect(f, src.id, out.id, node.id, p.id)) continue
    const moved = node.kind === 'lora' ? f.edges.filter((e) => e.from === src.id && e.fromPort === out.id) : []
    f = { ...f, edges: f.edges.filter((e) => !moved.includes(e)) }
    f = { ...f, edges: connect(f, src.id, out.id, node.id, p.id) }
    for (const e of moved) f = { ...f, edges: connect(f, node.id, 'model', e.to, e.toPort) }
  }
  if (node.kind !== 'lora') {
    for (const o of spec.outputs) {
      const target = topo(f).find((n) => n.id !== node.id && SPECS[n.kind].inputs.some((p) => p.type === o.type && !edgeInto(f, n.id, p.id)))
      const p = target && SPECS[target.kind].inputs.find((x) => x.type === o.type && !edgeInto(f, target.id, x.id))
      if (target && p && canConnect(f, node.id, o.id, target.id, p.id)) f = { ...f, edges: connect(f, node.id, o.id, target.id, p.id) }
    }
  }
  return { nodes: f.nodes, edges: f.edges }
}

function AddNodeMenu({ trigger, onAdd, align = 'end' }: { trigger: React.ReactNode; onAdd: (k: FlowNodeKind) => void; align?: 'start' | 'center' | 'end' }): React.JSX.Element {
  return (
    <Menu trigger={trigger} align={align} className="max-h-[min(560px,70vh)] w-[280px] overflow-y-auto">
      {GROUPS.map((g, gi) => (
        <div key={g}>
          {gi > 0 && <MenuSeparator />}
          <MenuLabel>{g}</MenuLabel>
          {Object.values(SPECS)
            .filter((s) => s.group === g)
            .map((s) => (
              <MenuItem key={s.kind} icon={NODE_ICON[s.kind]} description={s.blurb} onSelect={() => onAdd(s.kind)}>
                {s.title}
              </MenuItem>
            ))}
        </div>
      ))}
    </Menu>
  )
}

function FlowMenu({ flow, flows, onPick }: { flow: CharacterFlow; flows: CharacterFlow[]; onPick: (id: ID) => void }): React.JSX.Element {
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(flow.name)
  return (
    <>
      <Menu
        trigger={
          <button className="flex h-9 max-w-[min(320px,60vw)] min-w-0 items-center gap-2 rounded-xl border border-line bg-white/[0.04] pr-2.5 pl-3 text-[13px] font-semibold transition hover:bg-white/[0.07] max-md:h-10">
            <Workflow className="size-3.5 shrink-0 text-accent" />
            <span className="truncate">{flow.name}</span>
            <ChevronDown className="size-3.5 shrink-0 text-fg-3" />
          </button>
        }
        className="w-[280px]"
      >
        <MenuLabel>Your workflows</MenuLabel>
        {flows.map((f) => (
          <MenuItem key={f.id} icon={<Workflow />} onSelect={() => onPick(f.id)} right={f.id === flow.id ? <Check className="size-3.5 text-accent" /> : undefined}>
            <span className="block truncate">{f.name}</span>
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuLabel>New from a template</MenuLabel>
        {TEMPLATES.map((t) => (
          <MenuItem key={t.id} icon={<Plus />} description={t.blurb} onSelect={() => void createFlow(t.id).then((f) => onPick(f.id))}>
            {t.name}
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem
          icon={<Pencil />}
          onSelect={() => {
            setName(flow.name)
            setRenaming(true)
          }}
        >
          Rename
        </MenuItem>
        <MenuItem
          icon={<Copy />}
          onSelect={() => {
            const now = Date.now()
            const copy: CharacterFlow = { ...structuredClone(flow), id: nanoid(10), name: `${flow.name} copy`, createdAt: now, updatedAt: now }
            void db.put('flows', copy).then(() => onPick(copy.id))
          }}
        >
          Duplicate
        </MenuItem>
        <MenuItem
          icon={<Trash2 />}
          danger
          onSelect={() => {
            const next = flows.find((f) => f.id !== flow.id)
            void db.remove('flows', flow.id)
            if (next) onPick(next.id)
          }}
        >
          Delete workflow
        </MenuItem>
      </Menu>
      <Dialog open={renaming} onOpenChange={setRenaming} title="Rename workflow">
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault()
            updateFlow(flow.id, () => ({ name: name.trim() || flow.name }))
            setRenaming(false)
          }}
        >
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
          <div className="flex justify-end">
            <Button type="submit" variant="primary">
              Save
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  )
}

/** The whole studio: toolbar plus canvas (or steps). `fill` stretches it to its container. */
export function CharacterStudio({ fill, className }: { fill?: boolean; className?: string }): React.JSX.Element {
  const compact = useCompact()
  const navigate = useNavigate()
  const flows = useCollection('flows')
  const loaded = useCollectionLoaded('flows')
  useCollection('characters')
  useCollection('assets')
  const [flowId, setFlowId] = useState<string | null>(() => recall())
  const flow = flows.find((f) => f.id === flowId) ?? flows[0]
  const [view, setView] = useState<'canvas' | 'steps'>(compact ? 'steps' : 'canvas')
  const [lightbox, setLightbox] = useState<ID | null>(null)
  const running = useRuns((s) => (flow ? !!s.flows[flow.id] : false))
  const placeRef = useRef<((kind: FlowNodeKind) => { x: number; y: number }) | null>(null)
  const creating = useRef(false)

  // First visit: start people off with the idea-to-character workflow.
  useEffect(() => {
    if (loaded && !flows.length && !creating.current) {
      creating.current = true
      void createFlow('idea').then((f) => setFlowId(f.id))
    }
  }, [loaded, flows.length])

  useEffect(() => {
    if (flow) {
      remember(flow.id)
      resumePending(flow)
    }
  }, [flow?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const pick = useCallback((id: ID) => setFlowId(id), [])

  const ctx: StudioCtx | null = useMemo(
    () =>
      flow
        ? {
            flow,
            openAsset: setLightbox,
            removeNode: (id) => updateFlow(flow.id, (f) => ({ nodes: f.nodes.filter((n) => n.id !== id), edges: f.edges.filter((e) => e.from !== id && e.to !== id) })),
            duplicateNode: (id) =>
              updateFlow(flow.id, (f) => {
                const n = f.nodes.find((x) => x.id === id)
                if (!n) return {}
                const { results: _r, selected: _s, pending: _p, pendingSig: _q, sig: _g, characterId: _c, ...data } = n.data
                return { nodes: [...f.nodes, { ...n, id: nanoid(8), x: n.x + 40, y: n.y + 40, data }] }
              })
          }
        : null,
    [flow]
  )

  const addNode = (kind: FlowNodeKind): void => {
    if (!flow) return
    const spec = SPECS[kind]
    const pos = placeRef.current?.(kind) ?? { x: Math.max(0, ...flow.nodes.map((n) => n.x + 380)), y: 0 }
    const node: FlowNode = { id: nanoid(8), kind, x: pos.x, y: pos.y, data: spec.defaults() }
    updateFlow(flow.id, (cur) => wireIn({ ...cur, nodes: [...cur.nodes, node] }, node))
  }

  const runAll = (): void => {
    if (!flow) return
    runFlow(flow.id).then(
      () => toast.success('Workflow finished', 'Portraits and saves are done; sheet panels keep rendering in the background.'),
      (err) => toast.error("The workflow stopped", errorText(err))
    )
  }

  if (!flow || !ctx) {
    return (
      <div className={cn('grid place-items-center', fill ? 'h-full' : 'h-[420px]', className)}>
        {loaded ? <EmptyState icon={<Workflow />} title="Setting up the studio…" /> : <Spinner />}
      </div>
    )
  }

  const steps = view === 'steps'
  const runButton = (
    <Button variant="primary" icon={running ? <Spinner className="size-3.5" /> : <Play className="size-3.5 fill-current" />} disabled={running || !flow.nodes.some((n) => SPECS[n.kind].runs)} onClick={runAll}>
      {running ? 'Running…' : 'Run workflow'}
    </Button>
  )
  return (
    <FlowContext.Provider value={ctx}>
      <div className={cn('flex min-h-0 flex-col', fill && 'h-full', className)}>
        <div className="flex flex-wrap items-center gap-2 pb-3">
          <FlowMenu flow={flow} flows={flows} onPick={pick} />
          <div className="flex-1" />
          {compact && (
            <Segmented
              size="sm"
              className="max-md:[&>button]:h-8"
              value={view}
              onChange={setView}
              items={[
                { value: 'steps', label: 'Steps' },
                { value: 'canvas', label: 'Canvas' }
              ]}
            />
          )}
          {!steps && (
            <AddNodeMenu
              onAdd={addNode}
              trigger={
                <Button icon={<Plus className="size-3.5" />} className="max-md:h-10">
                  Add node
                </Button>
              }
            />
          )}
          {!compact && runButton}
          {!fill && !compact && (
            <Tooltip content="Full screen">
              <IconButton label="Full screen" onClick={() => navigate('/characters/studio')}>
                <Maximize2 className="size-4" />
              </IconButton>
            </Tooltip>
          )}
        </div>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={`${flow.id}:${view}`}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.25, ease }}
            className={cn(steps ? '' : 'glass hairline relative min-h-0 overflow-hidden rounded-[22px]', !steps && (fill ? 'flex-1' : 'h-[calc(100vh-260px)] min-h-[540px] max-md:h-[68vh] max-md:min-h-0'))}
          >
            {steps ? (
              <Steps flow={flow} onAdd={addNode} />
            ) : (
              <ReactFlowProvider>
                <Canvas
                  flow={flow}
                  onAddAt={(fn) => {
                    placeRef.current = fn
                  }}
                />
              </ReactFlowProvider>
            )}
          </motion.div>
        </AnimatePresence>
        {/* Phones: the run button rides along at the bottom while you scroll through the steps. */}
        {compact && <div className="sticky bottom-3 z-20 mt-4 flex [&>button]:h-12 [&>button]:flex-1 [&>button]:rounded-2xl [&>button]:shadow-[0_16px_40px_-12px_rgb(0_0_0/0.8)]">{runButton}</div>}
      </div>
      <AssetLightbox assetId={lightbox} onClose={() => setLightbox(null)} />
    </FlowContext.Provider>
  )
}
