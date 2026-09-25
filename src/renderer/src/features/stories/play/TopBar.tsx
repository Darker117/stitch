// Play-screen top bar: Now Playing (left) and model / undo / redo / settings (right).
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { motion } from 'motion/react'
import { Check, Clapperboard, Feather, Link2, LogOut, Pencil, Redo2, Settings2, Undo2 } from 'lucide-react'
import type { Adventure } from '@shared/types'
import { Button, IconButton } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverClose, Tooltip } from '@/components/ui/overlay'
import { Avatar } from '@/components/ui/misc'
import { cn, pluralize } from '@/lib/utils'
import { ease } from '@/lib/motion'
import { modelLabel, type LlmChoice } from '@/lib/llm'
import { CoverArt, FlameMark } from '../components/art'
import { CharacterLinkPicker } from '../components/cards'
import { useCharacterFace } from '../hooks'
import { ModelChooser } from './ModelChooser'

function PlayerRow({ adv, onChange }: { adv: Adventure; onChange: (p: Partial<Adventure['player']>) => void }): React.JSX.Element {
  const { character, src } = useCharacterFace(adv.player.characterId)
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(adv.player.name)
  return (
    <div className="flex items-center gap-2.5 rounded-xl border border-line bg-white/[0.03] p-2.5">
      <Avatar src={src} name={adv.player.name || character?.name} size={34} className="ring-2 ring-[color-mix(in_oklab,var(--accent)_40%,transparent)]" />
      <div className="min-w-0 flex-1">
        {editing ? (
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                onChange({ name: name.trim() || adv.player.name })
                setEditing(false)
              }
            }}
            className="h-8"
          />
        ) : (
          <>
            <div className="truncate text-[13px] font-semibold">{adv.player.name || 'You'}</div>
            <div className="truncate text-[11px] text-fg-3">{character ? `Playing as ${character.name}` : 'Player'}</div>
          </>
        )}
      </div>
      {editing ? (
        <IconButton
          label="Save name"
          size="sm"
          onClick={() => {
            onChange({ name: name.trim() || adv.player.name })
            setEditing(false)
          }}
        >
          <Check className="size-3.5" />
        </IconButton>
      ) : (
        <IconButton
          label="Edit name"
          size="sm"
          onClick={() => {
            setName(adv.player.name)
            setEditing(true)
          }}
        >
          <Pencil className="size-3.5" />
        </IconButton>
      )}
      <CharacterLinkPicker value={adv.player.characterId} onChange={(id) => onChange({ characterId: id })}>
        <IconButton label="Play as a Stitch character" size="sm">
          <Link2 className="size-3.5" />
        </IconButton>
      </CharacterLinkPicker>
    </div>
  )
}

export function TopBar({
  adv,
  model,
  panelOpen,
  onTogglePanel,
  onModel,
  onPlayer,
  onUndo,
  onRedo,
  onStudio,
  busy
}: {
  adv: Adventure
  model?: LlmChoice
  panelOpen: boolean
  onTogglePanel: () => void
  onModel: (c: LlmChoice) => void
  onPlayer: (p: Partial<Adventure['player']>) => void
  onUndo: () => void
  onRedo: () => void
  onStudio: () => void
  busy: boolean
}): React.JSX.Element {
  const navigate = useNavigate()
  const [modelsOpen, setModelsOpen] = useState(false)
  const turns = adv.actions.filter((a) => a.type !== 'start').length
  const canUndo = !busy && adv.actions.length > 1
  const canRedo = !busy && adv.redo.length > 0

  return (
    <>
      <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease, delay: 0.1 }} className="no-drag absolute top-[7px] left-3 z-[60]">
        <Popover
          side="bottom"
          align="start"
          className="w-[320px] p-3"
          trigger={
            <button className="group flex h-9 max-w-[360px] items-center gap-2.5 rounded-xl border border-line bg-[var(--panel)] pr-3.5 pl-1 backdrop-blur-xl transition hover:border-line-strong">
              <span className="grid size-7 place-items-center rounded-lg bg-[color-mix(in_oklab,var(--fg)_7%,transparent)] transition-transform duration-300 group-hover:scale-105">
                <FlameMark size={18} />
              </span>
              <span className="truncate font-serif text-[14px] font-semibold" style={{ color: 'var(--st-text)' }}>
                {adv.title || 'Untitled adventure'}
              </span>
            </button>
          }
        >
          <div className="label-caps px-1 pb-2">Now playing</div>
          <div className="overflow-hidden rounded-xl border border-line">
            <CoverArt coverAssetId={adv.coverAssetId} template={undefined} compact className="aspect-[16/7] w-full">
              <div className="absolute inset-0 bg-[linear-gradient(to_top,rgb(0_0_0/0.7),transparent_60%)]" />
              <div className="absolute inset-x-0 bottom-0 p-3">
                <div className="truncate font-serif text-[16px] font-semibold text-white">{adv.title || 'Untitled adventure'}</div>
                <div className="text-[11px] text-white/70">{pluralize(turns, 'turn')}</div>
              </div>
            </CoverArt>
          </div>
          <div className="mt-3">
            <PlayerRow adv={adv} onChange={onPlayer} />
          </div>
          <PopoverClose asChild>
            <Button variant="secondary" className="mt-3 w-full" icon={<Clapperboard className="size-3.5" />} disabled={!adv.actions.some((a) => a.media?.length)} onClick={onStudio}>
              Send to Studio
            </Button>
          </PopoverClose>
          <PopoverClose asChild>
            <Button variant="danger" className="mt-2 w-full tracking-wide uppercase" icon={<LogOut className="size-3.5" />} onClick={() => navigate('/stories')}>
              Exit game
            </Button>
          </PopoverClose>
        </Popover>
      </motion.div>

      <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease, delay: 0.15 }} className="no-drag absolute top-[7px] right-[150px] z-[60] flex items-center gap-1 rounded-xl border border-line bg-[var(--panel)] p-0.5 backdrop-blur-xl">
        <Popover open={modelsOpen} onOpenChange={setModelsOpen} side="bottom" align="end" className="w-[400px] p-3" trigger={
          <button className="flex h-8 items-center gap-1.5 rounded-[10px] px-2.5 text-[12px] font-medium text-fg-2 transition hover:bg-white/[0.07] hover:text-fg">
            <Feather className="size-3.5" />
            <span className="max-w-[140px] truncate">{modelLabel(model)}</span>
          </button>
        }>
          <div className="label-caps px-1 pb-3">Story models</div>
          <div className="max-h-[62vh] overflow-y-auto px-0.5 pb-0.5">
            <ModelChooser current={model} onUse={onModel} onDone={() => setModelsOpen(false)} />
          </div>
        </Popover>
        <Tooltip content="Undo">
          <IconButton label="Undo" size="md" onClick={onUndo} disabled={!canUndo} className="size-8">
            <Undo2 className="size-4" />
          </IconButton>
        </Tooltip>
        <Tooltip content="Redo">
          <IconButton label="Redo" size="md" onClick={onRedo} disabled={!canRedo} className="size-8">
            <Redo2 className="size-4" />
          </IconButton>
        </Tooltip>
        <Tooltip content={panelOpen ? 'Close settings' : 'Settings'}>
          <IconButton label="Settings" size="md" onClick={onTogglePanel} className={cn('size-8', panelOpen && 'bg-[color-mix(in_oklab,var(--accent)_16%,transparent)] text-accent')}>
            <Settings2 className="size-4" />
          </IconButton>
        </Tooltip>
      </motion.div>
    </>
  )
}
