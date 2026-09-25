import { useMemo } from 'react'
import { nanoid } from 'nanoid'
import type { Character, GenJob, ID, SheetSlot } from '@shared/types'
import { pickEditRecipe, sheetSlotRequest, slotsFor } from '@/lib/characters'
import { db } from '@/stores/db'
import { useGen } from '@/stores/gen'

export async function createCharacter(opts: { name: string; referenceAssetId?: ID; detail: Character['sheetDetail']; projectId?: ID; appearance?: string }): Promise<Character> {
  const now = Date.now()
  const c: Character = {
    id: nanoid(10),
    name: opts.name.trim() || 'Untitled character',
    description: '',
    appearance: opts.appearance ?? '',
    createdAt: now,
    updatedAt: now,
    projectId: opts.projectId,
    referenceAssetId: opts.referenceAssetId,
    sheet: {},
    sheetDetail: opts.detail,
    locked: false,
    tags: []
  }
  await db.put('characters', c)
  return c
}

/** Queue the whole sheet (or a subset of slots). Returns the number of jobs. */
export async function generateSheet(c: Character, only?: SheetSlot[]): Promise<number> {
  const recipe = pickEditRecipe()
  if (!recipe) throw new Error('Character sheets need Qwen Image 2.1 Edit or Flux 2 Klein. Start ComfyUI and check that the model is installed.')
  const slots = slotsFor(c.sheetDetail).filter((s) => !only || only.includes(s.slot))
  const { submit } = useGen.getState()
  for (const s of slots) await submit(sheetSlotRequest(c, s, recipe))
  return slots.length
}

/** Latest job per sheet slot for a character. */
export function useSlotJobs(characterId: ID | undefined): Partial<Record<SheetSlot, GenJob>> {
  const jobs = useGen((s) => s.jobs)
  return useMemo(() => {
    const out: Partial<Record<SheetSlot, GenJob>> = {}
    if (!characterId) return out
    for (const j of Object.values(jobs)) {
      if (j.origin?.type !== 'character' || j.origin.id !== characterId || !j.origin.sub) continue
      const slot = j.origin.sub as SheetSlot
      if (!out[slot] || out[slot]!.createdAt < j.createdAt) out[slot] = j
    }
    return out
  }, [jobs, characterId])
}
