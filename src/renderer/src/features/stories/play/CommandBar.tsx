// Bottom command row (Take a Turn / Continue / Retry / Erase) and the turn
// input with Do / Say / Story / See modes.
import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ArrowUp, ChevronDown, Eraser, FastForward, PenLine, RotateCcw, Square, TriangleAlert, X } from 'lucide-react'
import type { AdventureSettings } from '@shared/types'
import { Menu, MenuItem, Tooltip } from '@/components/ui/overlay'
import { cn } from '@/lib/utils'
import { ease, spring } from '@/lib/motion'
import { ActionIcon, CmdButton, useTheme } from './bits'
import type { PlayController, TurnMode } from './usePlay'

const MODES: { value: TurnMode; label: string; hint: string; placeholder: string }[] = [
  { value: 'do', label: 'Do', hint: 'Take an action', placeholder: 'What do you do?' },
  { value: 'say', label: 'Say', hint: 'Speak out loud', placeholder: 'What do you say?' },
  { value: 'story', label: 'Story', hint: 'Write what happens next', placeholder: 'What happens next?' },
  { value: 'see', label: 'See', hint: 'Render an image of the moment', placeholder: 'What do you want to see? (empty = this moment)' }
]

export function CommandBar({ ctl, settings, open, setOpen }: { ctl: PlayController; settings: AdventureSettings; open: boolean; setOpen: (o: boolean) => void }): React.JSX.Element {
  const t = useTheme()
  const [mode, setMode] = useState<TurnMode>('do')
  const [text, setText] = useState('')
  const area = useRef<HTMLTextAreaElement>(null)
  const compact = settings.compactButtons
  const m = MODES.find((x) => x.value === mode)!
  const warn = settings.contextWarning && ctl.lastCtx && (ctl.lastCtx.droppedCards > 0 || ctl.lastCtx.tokens > ctl.lastCtx.budget)

  useEffect(() => {
    if (open) requestAnimationFrame(() => area.current?.focus())
  }, [open, mode])

  useEffect(() => {
    const el = area.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`
  }, [text, open])

  const send = async (): Promise<void> => {
    if (ctl.busy) return
    const v = text
    setText('')
    if (!settings.stickyInput) setOpen(false)
    await ctl.submit(mode, v)
  }

  const cycle = (dir: 1 | -1): void => {
    const i = MODES.findIndex((x) => x.value === mode)
    setMode(MODES[(i + dir + MODES.length) % MODES.length].value)
  }

  const radius = t.button.radius
  return (
    <div className="pointer-events-auto flex w-full flex-col items-center gap-2">
      <AnimatePresence mode="wait" initial={false}>
        {open ? (
          <motion.div
            key="input"
            initial={{ opacity: 0, y: 14, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.98, transition: { duration: 0.16 } }}
            transition={spring}
            className="w-full"
          >
            <div className="glow-border" data-active="true" style={{ borderRadius: t.id === 'cyber' ? 0 : 20, clipPath: t.button.clip }}>
            <div className="flex items-end gap-2 border border-line-strong bg-[var(--panel)] p-2 shadow-[0_24px_60px_-20px_rgb(0_0_0/0.7)] backdrop-blur-2xl" style={{ borderRadius: t.id === 'cyber' ? 0 : 20 }}>
              <Menu
                side="top"
                trigger={
                  <button className="flex h-10 shrink-0 items-center gap-1.5 rounded-xl border border-line bg-[color-mix(in_oklab,var(--fg)_6%,transparent)] px-3 text-[13px] font-semibold text-fg transition hover:border-line-strong">
                    <span className="text-accent">
                      <ActionIcon type={mode} />
                    </span>
                    {m.label}
                    <ChevronDown className="size-3.5 text-fg-3" />
                  </button>
                }
              >
                {MODES.map((x) => (
                  <MenuItem key={x.value} icon={<ActionIcon type={x.value} />} hint={x.hint} onSelect={() => setMode(x.value)}>
                    {x.label}
                  </MenuItem>
                ))}
              </Menu>
              <textarea
                ref={area}
                value={text}
                rows={1}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    void send()
                  } else if (e.key === 'Escape') {
                    e.stopPropagation()
                    setOpen(false)
                  } else if (e.key === 'Tab') {
                    e.preventDefault()
                    cycle(e.shiftKey ? -1 : 1)
                  }
                }}
                placeholder={m.placeholder}
                className="max-h-[180px] min-h-10 flex-1 resize-none bg-transparent px-1 py-2.5 text-[15px] leading-snug text-fg outline-none placeholder:text-fg-3"
              />
              <button onClick={() => setOpen(false)} className="grid size-10 shrink-0 place-items-center rounded-xl text-fg-3 transition hover:bg-white/10 hover:text-fg" aria-label="Close">
                <X className="size-4" />
              </button>
              <motion.button
                whileTap={{ scale: 0.92 }}
                onClick={() => void send()}
                disabled={ctl.busy}
                className="grid size-10 shrink-0 place-items-center rounded-xl bg-grad text-white shadow-[0_8px_20px_-8px_color-mix(in_oklab,var(--accent)_80%,transparent)] disabled:opacity-50"
                aria-label="Submit"
              >
                <ArrowUp className="size-4.5" />
              </motion.button>
            </div>
            </div>
            <div className="mt-1.5 flex justify-center gap-3 text-[11px] text-fg-3">
              <span>
                <b className="font-semibold text-fg-2">Enter</b> to send
              </span>
              <span>
                <b className="font-semibold text-fg-2">Tab</b> to switch mode
              </span>
              <span>
                <b className="font-semibold text-fg-2">Esc</b> to close
              </span>
            </div>
          </motion.div>
        ) : (
          <motion.div key="buttons" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8, transition: { duration: 0.14 } }} transition={{ duration: 0.3, ease }} className="flex items-center gap-2.5">
            {ctl.busy ? (
              <motion.div initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} className="flex items-center gap-3">
                <div className="flex h-11 items-center gap-2.5 border border-line bg-[var(--panel)] px-4 text-[12.5px] text-fg-2 backdrop-blur-xl" style={{ borderRadius: radius, clipPath: t.button.clip }}>
                  <span className="flex gap-1">
                    {[0, 1, 2].map((i) => (
                      <motion.span key={i} className="size-1.5 rounded-full bg-accent" animate={{ opacity: [0.2, 1, 0.2] }} transition={{ duration: 1, repeat: Infinity, delay: i * 0.15 }} />
                    ))}
                  </span>
                  The story is being written…
                </div>
                <CmdButton label="Stop" icon={<Square className="size-3.5 fill-current" />} onClick={ctl.stop} compact={compact} />
              </motion.div>
            ) : (
              <>
                <CmdButton tone="primary" label="Take a turn" icon={<PenLine className="size-4" />} onClick={() => setOpen(true)} compact={compact} />
                <CmdButton label="Continue" icon={<FastForward className="size-4" />} onClick={() => void ctl.continueStory()} compact={compact} />
                <CmdButton label="Retry" icon={<RotateCcw className="size-4" />} onClick={() => void ctl.retry()} compact={compact} />
                <CmdButton label="Erase" icon={<Eraser className="size-4" />} onClick={() => void ctl.erase()} compact={compact} />
                {warn && ctl.lastCtx && (
                  <Tooltip
                    content={
                      ctl.lastCtx.droppedCards > 0
                        ? `${ctl.lastCtx.droppedCards} triggered story card${ctl.lastCtx.droppedCards === 1 ? '' : 's'} didn't fit in the context`
                        : 'The context is over budget'
                    }
                  >
                    <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }} transition={spring} className={cn('grid size-8 place-items-center rounded-full bg-warning/15 text-warning')}>
                      <TriangleAlert className="size-4" />
                    </motion.span>
                  </Tooltip>
                )}
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
