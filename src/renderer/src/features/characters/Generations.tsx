// Generations organised by the character they feature (sheet panels live on each sheet instead).
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { AnimatePresence, motion } from 'motion/react'
import { ArrowRight, ChevronLeft, Images, UserRound } from 'lucide-react'
import type { Asset, Character, ID } from '@shared/types'
import { thumbUrl } from '@/lib/api'
import { characterRefs } from '@/lib/characters'
import { cn } from '@/lib/utils'
import { ease, rise, spring, stagger } from '@/lib/motion'
import { AssetThumb } from '@/components/media'
import { EmptyState } from '@/components/ui/misc'
import { useCollection, useDoc } from '@/stores/db'

/** A character's own generations: scenes, portraits, clips — not their sheet panels. */
export function isCharacterGeneration(a: Asset, characterId?: ID): boolean {
  if (a.source !== 'generated' || !a.characterIds?.length) return false
  if (a.origin?.type === 'character' && a.origin.sub) return false
  return !characterId || a.characterIds.includes(characterId)
}

export function useCharacterGenerations(): { c: Character; items: Asset[] }[] {
  const characters = useCollection('characters')
  const assets = useCollection('assets')
  return useMemo(() => {
    const by = new Map<ID, Asset[]>()
    for (const a of assets) {
      if (!isCharacterGeneration(a)) continue
      for (const id of a.characterIds!) {
        const list = by.get(id) ?? []
        list.push(a)
        by.set(id, list)
      }
    }
    return characters
      .filter((c) => by.has(c.id))
      .map((c) => ({ c, items: by.get(c.id)!.sort((a, b) => b.createdAt - a.createdAt) }))
      .sort((a, b) => b.items[0].createdAt - a.items[0].createdAt)
  }, [characters, assets])
}

function Avatar({ c, className }: { c: Character; className?: string }): React.JSX.Element {
  const ref = useDoc('assets', characterRefs(c, 1)[0])
  return (
    <span className={cn('relative grid shrink-0 place-items-center overflow-hidden rounded-full border border-line bg-white/[0.05]', className)}>
      {ref ? <img src={thumbUrl(ref.path, 120)} className="absolute inset-0 size-full object-cover" /> : <UserRound className="size-3.5 text-fg-3" />}
    </span>
  )
}

const PREVIEW = 12

export function CharacterGenerations({ onOpen }: { onOpen: (assetId: ID) => void }): React.JSX.Element {
  const groups = useCharacterGenerations()
  const navigate = useNavigate()
  const [focus, setFocus] = useState<ID | null>(null)
  const focused = groups.find((g) => g.c.id === focus)

  if (!groups.length) {
    return <EmptyState icon={<Images />} title="No character generations yet" body="Scenes, portraits and clips made with a character are collected here, one shelf per character." />
  }

  return (
    <div>
      {/* Character filter: every shelf, or one character's whole collection. */}
      <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 [scrollbar-width:none] max-md:-mx-4 max-md:px-4">
        <Chip active={!focused} onClick={() => setFocus(null)}>
          All characters
        </Chip>
        {groups.map(({ c, items }) => (
          <Chip key={c.id} active={focused?.c.id === c.id} onClick={() => setFocus(c.id)}>
            <Avatar c={c} className="-ml-1.5 size-6" />
            {c.name}
            <span className="text-fg-3 tabular-nums">{items.length}</span>
          </Chip>
        ))}
      </div>

      <AnimatePresence mode="wait" initial={false}>
        {focused ? (
          <motion.div key={focused.c.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.3, ease }} className="mt-5">
            <div className="mb-4 flex items-center gap-3">
              <button onClick={() => setFocus(null)} className="grid size-8 place-items-center rounded-lg border border-line text-fg-2 transition hover:bg-white/[0.06] hover:text-fg max-md:size-10" aria-label="All characters">
                <ChevronLeft className="size-4" />
              </button>
              <Avatar c={focused.c} className="size-10" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[16px] font-semibold">{focused.c.name}</div>
                <div className="text-[12px] text-fg-3">{focused.items.length} generations</div>
              </div>
              <button onClick={() => navigate(`/characters/${focused.c.id}`)} className="flex items-center gap-1 text-[12px] font-semibold text-accent hover:brightness-125 max-md:py-2">
                Open <ArrowRight className="size-3.5" />
              </button>
            </div>
            <Grid items={focused.items} onOpen={onOpen} />
          </motion.div>
        ) : (
          <motion.div key="all" variants={stagger(0.05)} initial="initial" animate="animate" exit={{ opacity: 0 }} className="mt-5 space-y-8 max-md:space-y-6">
            {groups.map(({ c, items }) => (
              <motion.section key={c.id} variants={rise}>
                <div className="mb-3 flex items-center gap-2.5">
                  <Avatar c={c} className="size-8" />
                  <button onClick={() => navigate(`/characters/${c.id}`)} className="min-w-0 truncate text-[14.5px] font-semibold transition hover:text-accent">
                    {c.name}
                  </button>
                  <span className="text-[12px] text-fg-3 tabular-nums">{items.length}</span>
                  <div className="flex-1" />
                  {items.length > PREVIEW && (
                    <button onClick={() => setFocus(c.id)} className="flex items-center gap-1 text-[12px] font-semibold text-fg-2 transition hover:text-fg max-md:py-2">
                      See all <ArrowRight className="size-3.5" />
                    </button>
                  )}
                </div>
                <Grid items={items.slice(0, PREVIEW)} onOpen={onOpen} />
              </motion.section>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className={cn(
        'relative flex h-9 shrink-0 items-center gap-2 rounded-full border px-3.5 text-[12.5px] font-medium whitespace-nowrap transition-colors duration-200 max-md:h-10',
        active ? 'border-transparent text-fg' : 'border-line text-fg-2 hover:text-fg'
      )}
    >
      {active && <motion.span layoutId="gen-chip" transition={spring} className="absolute inset-0 rounded-full border border-[color-mix(in_oklab,var(--accent)_45%,transparent)] bg-white/[0.08]" />}
      <span className="relative flex items-center gap-2">{children}</span>
    </button>
  )
}

export function Grid({ items, onOpen }: { items: Asset[]; onOpen: (id: ID) => void }): React.JSX.Element {
  return (
    <div className="grid grid-cols-6 gap-2.5 max-lg:grid-cols-5 max-md:grid-cols-3 max-md:gap-2">
      {items.map((a) => (
        <AssetThumb key={a.id} asset={a} className="aspect-square" onClick={() => onOpen(a.id)} />
      ))}
    </div>
  )
}
