// A run-order list of scripts: toggle, remove, drag (or up/down) to reorder,
// and a chevron that reveals the description, hooks and licence.
import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion, Reorder, useDragControls } from 'motion/react'
import { ArrowDown, ArrowUp, ChevronDown, ExternalLink, GripVertical, Pencil, Trash2, TriangleAlert } from 'lucide-react'
import type { StoryScript } from '@shared/types'
import { Button, IconButton } from '@/components/ui/button'
import { Switch } from '@/components/ui/controls'
import { Badge } from '@/components/ui/misc'
import { invoke } from '@/lib/api'
import { cn } from '@/lib/utils'
import { ease, springSoft } from '@/lib/motion'
import { HookChips, KindBadge, ScriptGlyph } from './bits'

export interface RunOrderItem {
  scriptId: string
  enabled: boolean
  /** Undefined when the script was deleted from the library. */
  script?: StoryScript
  removable: boolean
  /** Small tag next to the name, e.g. "Scenario". */
  tag?: string
  /** Extra line in the expanded area. */
  note?: string
}

interface RowProps {
  item: RunOrderItem
  index: number
  count: number
  movable: boolean
  dimmed?: boolean
  onToggle: (enabled: boolean) => void
  onRemove?: () => void
  onMove?: (dir: -1 | 1) => void
  onEdit?: () => void
  onDragEnd?: () => void
}

function RowBody({ item, index, count, movable, dimmed, onToggle, onRemove, onMove, onEdit, grip }: RowProps & { grip?: React.ReactNode }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const s = item.script
  return (
    <div className={cn('transition-opacity duration-300', (dimmed || !item.enabled) && 'opacity-60')}>
      <div className="flex items-center gap-2.5 px-2.5 py-2.5">
        {grip}
        <span className="w-4 shrink-0 text-center font-mono text-[11px] text-fg-3 tabular-nums">{index + 1}</span>
        {s ? <ScriptGlyph name={s.name} /> : <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-danger/10 text-danger ring-1 ring-danger/25"><TriangleAlert className="size-4" /></span>}
        <button className="min-w-0 flex-1 text-left" onClick={() => setOpen((o) => !o)}>
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[13px] font-semibold">{s?.name ?? 'Missing script'}</span>
            {item.tag && <Badge tone="outline">{item.tag}</Badge>}
          </div>
          <div className="truncate text-[11.5px] text-fg-3">{s ? (s.author ? `by ${s.author}` : 'No author') : 'It was deleted from your library'}</div>
        </button>
        {s && <KindBadge script={s} />}
        <Switch size="sm" checked={item.enabled} onChange={onToggle} disabled={!s} />
        {item.removable && onRemove && (
          <IconButton label="Remove from run order" size="sm" onClick={onRemove} className="hover:text-danger">
            <Trash2 className="size-3.5" />
          </IconButton>
        )}
        <IconButton label={open ? 'Collapse' : 'Details'} size="sm" onClick={() => setOpen((o) => !o)}>
          <motion.span animate={{ rotate: open ? 180 : 0 }} transition={{ duration: 0.3, ease }} className="grid place-items-center">
            <ChevronDown className="size-4" />
          </motion.span>
        </IconButton>
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.28, ease }} className="overflow-hidden">
            <div className="flex flex-col gap-3 border-t border-line px-3.5 pt-3 pb-3.5">
              {s?.description && <p className="text-[12px] leading-relaxed text-fg-2">{s.description}</p>}
              {s && <HookChips script={s} />}
              {item.note && <p className="text-[11.5px] text-fg-3">{item.note}</p>}
              <div className="flex flex-wrap items-center gap-2">
                {s && onEdit && (
                  <Button size="sm" icon={<Pencil className="size-3.5" />} onClick={onEdit}>
                    {s.source === 'builtin' ? 'View code' : 'Edit'}
                  </Button>
                )}
                {movable && onMove && (
                  <>
                    <Button size="sm" variant="ghost" icon={<ArrowUp className="size-3.5" />} disabled={index === 0} onClick={() => onMove(-1)}>
                      Earlier
                    </Button>
                    <Button size="sm" variant="ghost" icon={<ArrowDown className="size-3.5" />} disabled={index === count - 1} onClick={() => onMove(1)}>
                      Later
                    </Button>
                  </>
                )}
                <div className="flex-1" />
                {s?.license && <Badge tone="outline">{s.license}</Badge>}
                {s?.sourceUrl && (
                  <Button size="sm" variant="ghost" icon={<ExternalLink className="size-3.5" />} onClick={() => void invoke('sys:openExternal', s.sourceUrl!)}>
                    Source
                  </Button>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function DraggableRow(props: RowProps): React.JSX.Element {
  const controls = useDragControls()
  return (
    <Reorder.Item
      as="div"
      value={props.item.scriptId}
      dragListener={false}
      dragControls={controls}
      onDragEnd={props.onDragEnd}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.16 } }}
      transition={springSoft}
      whileDrag={{ scale: 1.015, boxShadow: '0 18px 40px -18px rgb(0 0 0 / 0.8)' }}
      className="relative rounded-xl border border-line bg-[color-mix(in_oklab,var(--panel-solid)_70%,transparent)]"
    >
      <RowBody
        {...props}
        grip={
          <span onPointerDown={(e) => controls.start(e)} className="-ml-1 grid h-8 w-4 shrink-0 cursor-grab touch-none place-items-center text-fg-3 hover:text-fg active:cursor-grabbing" title="Drag to reorder">
            <GripVertical className="size-4" />
          </span>
        }
      />
    </Reorder.Item>
  )
}

/**
 * Scripts in run order (top runs first). With `onReorder` the rows can be
 * dragged by their grip or moved with Earlier / Later.
 */
export function RunOrderList({
  items,
  onToggle,
  onRemove,
  onReorder,
  onEdit,
  dimmed,
  empty
}: {
  items: RunOrderItem[]
  onToggle: (scriptId: string, enabled: boolean) => void
  onRemove?: (scriptId: string) => void
  onReorder?: (ids: string[]) => void
  onEdit?: (scriptId: string) => void
  dimmed?: boolean
  empty?: React.ReactNode
}): React.JSX.Element {
  const ids = items.map((i) => i.scriptId)
  const [order, setOrder] = useState(ids)
  const orderRef = useRef(order)
  orderRef.current = order
  const key = ids.join('|')
  useEffect(() => setOrder(key ? key.split('|') : []), [key])

  const byId = new Map(items.map((i) => [i.scriptId, i]))
  const shown = order.map((id) => byId.get(id)).filter((i): i is RunOrderItem => !!i)
  const move = (id: string, dir: -1 | 1): void => {
    const i = ids.indexOf(id)
    const j = i + dir
    if (i < 0 || j < 0 || j >= ids.length) return
    const next = [...ids]
    ;[next[i], next[j]] = [next[j], next[i]]
    onReorder?.(next)
  }

  if (!items.length) return <>{empty}</>

  if (!onReorder) {
    return (
      <div className="flex flex-col gap-2">
        <AnimatePresence initial={false}>
          {items.map((item, i) => (
            <motion.div key={item.scriptId} layout initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.98 }} transition={springSoft} className="rounded-xl border border-line bg-[color-mix(in_oklab,var(--panel-solid)_70%,transparent)]">
              <RowBody item={item} index={i} count={items.length} movable={false} dimmed={dimmed} onToggle={(v) => onToggle(item.scriptId, v)} onRemove={onRemove && (() => onRemove(item.scriptId))} onEdit={onEdit && (() => onEdit(item.scriptId))} />
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    )
  }

  return (
    <Reorder.Group as="div" axis="y" values={order} onReorder={setOrder} className="flex flex-col gap-2">
      <AnimatePresence initial={false}>
        {shown.map((item, i) => (
          <DraggableRow
            key={item.scriptId}
            item={item}
            index={i}
            count={shown.length}
            movable
            dimmed={dimmed}
            onToggle={(v) => onToggle(item.scriptId, v)}
            onRemove={onRemove && (() => onRemove(item.scriptId))}
            onMove={(dir) => move(item.scriptId, dir)}
            onEdit={onEdit && (() => onEdit(item.scriptId))}
            onDragEnd={() => {
              const next = orderRef.current
              if (next.join('|') !== key) onReorder(next)
            }}
          />
        ))}
      </AnimatePresence>
    </Reorder.Group>
  )
}
