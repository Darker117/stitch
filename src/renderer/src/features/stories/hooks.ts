// Hooks shared by the scenario editor and the play screen.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Adventure, Character, CollectionMap, ID, Scenario } from '@shared/types'
import { fileUrl } from '@/lib/api'
import { db, useCollection, useDoc } from '@/stores/db'

export type SaveState = 'saved' | 'pending' | 'saving'

type Editable = 'scenarios' | 'adventures'

/**
 * Edit a document through a local overlay that is flushed (debounced) to the
 * store. Fields you are not editing keep following live updates.
 */
export function useAutosave<N extends Editable>(
  name: N,
  id: ID | undefined,
  delay = 400
): {
  value: CollectionMap[N] | undefined
  change: (patch: Partial<CollectionMap[N]> | ((cur: CollectionMap[N]) => Partial<CollectionMap[N]>)) => void
  state: SaveState
  flush: () => Promise<void>
} {
  const doc = useDoc(name, id)
  const [overlay, setOverlay] = useState<Partial<CollectionMap[N]>>({})
  const [state, setState] = useState<SaveState>('saved')
  const overlayRef = useRef(overlay)
  const docRef = useRef(doc)
  docRef.current = doc
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const flush = useCallback(async () => {
    clearTimeout(timer.current)
    const patch = overlayRef.current
    if (!id || !Object.keys(patch).length) return
    setState('saving')
    await db.update(name, id, (cur) => ({ ...cur, ...patch, updatedAt: Date.now() }))
    const next = { ...overlayRef.current }
    for (const k of Object.keys(patch) as (keyof typeof patch)[]) if (next[k] === patch[k]) delete next[k]
    overlayRef.current = next
    setOverlay(next)
    setState(Object.keys(next).length ? 'pending' : 'saved')
  }, [id, name])

  const change = useCallback(
    (p: Partial<CollectionMap[N]> | ((cur: CollectionMap[N]) => Partial<CollectionMap[N]>)) => {
      const cur = docRef.current
      if (!cur) return
      const patch = typeof p === 'function' ? p({ ...cur, ...overlayRef.current }) : p
      overlayRef.current = { ...overlayRef.current, ...patch }
      setOverlay(overlayRef.current)
      setState('pending')
      clearTimeout(timer.current)
      timer.current = setTimeout(() => void flush(), delay)
    },
    [delay, flush]
  )

  useEffect(() => () => void flush(), [flush])

  const value = doc ? ({ ...doc, ...overlay } as CollectionMap[N]) : undefined
  return { value, change, state, flush }
}

/** The fields the scenario editor and the play panel both edit. */
export type StoryDoc = Pick<Scenario, 'title' | 'description' | 'tags' | 'coverAssetId' | 'plot' | 'cards' | 'projectId'> & { id: ID }
export type StoryPatch = Partial<StoryDoc>
export type StoryChange = (p: StoryPatch | ((cur: StoryDoc) => StoryPatch)) => void

/** Asset id that best shows a character's face. */
export function faceAssetId(c: Character | undefined): ID | undefined {
  if (!c) return undefined
  return c.sheet.front ?? c.referenceAssetId ?? c.sheet['three-quarter-left'] ?? c.sheet['three-quarter-right'] ?? c.sheet['full-body']
}

export function useCharacterFace(characterId: ID | undefined): { character?: Character; src?: string } {
  const character = useDoc('characters', characterId)
  const asset = useDoc('assets', faceAssetId(character))
  return { character, src: asset ? fileUrl(asset.path) : undefined }
}

export function useCharacters(): Character[] {
  useCollection('assets')
  return useCollection('characters')
}

/** Top-level scenarios (children back multiple-choice options). */
export function useScenarios(): Scenario[] {
  const all = useCollection('scenarios')
  return useMemo(() => all.filter((s) => !s.parentId), [all])
}

export function useAdventures(): Adventure[] {
  const list = useCollection('adventures')
  return useMemo(() => [...list].sort((a, b) => (b.lastPlayedAt ?? b.updatedAt) - (a.lastPlayedAt ?? a.updatedAt)), [list])
}
