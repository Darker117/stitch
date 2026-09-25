// Story covers: upload, library pick or AI generation. Generation writes an
// image prompt from the story (LLM), then renders it as a job whose `origin`
// ({ type: 'scenario' | 'adventure', sub: 'cover' }) makes the main process set
// the cover when it finishes — even if the editor was closed meanwhile.
import { create } from 'zustand'
import type { Adventure, Character, GenJob, ID, Scenario } from '@shared/types'
import { errorText } from '@/lib/api'
import { pickTextImageRecipe, sceneImageRequest } from '@/lib/characters'
import type { LlmChoice } from '@/lib/llm'
import { db } from '@/stores/db'
import { isActive, useGen, waitForJob } from '@/stores/gen'
import { toast } from '@/stores/toast'
import { coverPrompt, type StoryInfo } from './ai'

export interface CoverTarget {
  collection: 'scenarios' | 'adventures'
  id: ID
}

export type CoverPhase = 'idle' | 'writing' | 'queued' | 'painting'

export interface CoverProgress {
  phase: CoverPhase
  /** 0..1 while painting, when ComfyUI reports steps. */
  value?: number
  /** Latest latent preview (data URL). */
  preview?: string
  job?: GenJob
}

const key = (t: CoverTarget): string => `${t.collection}:${t.id}`
const originType = (t: CoverTarget): 'scenario' | 'adventure' => (t.collection === 'scenarios' ? 'scenario' : 'adventure')

/** Covers whose prompt is still being written by the text model. */
const useWriting = create<{ keys: Record<string, true> }>(() => ({ keys: {} }))
function setWriting(k: string, on: boolean): void {
  useWriting.setState((s) => {
    const keys = { ...s.keys }
    if (on) keys[k] = true
    else delete keys[k]
    return { keys }
  })
}

export function isCoverJob(j: GenJob, t: CoverTarget): boolean {
  return j.origin?.type === originType(t) && j.origin.id === t.id && j.origin.sub === 'cover'
}

/** Live cover-generation state for a scenario/adventure (editor + story cards). */
export function useCoverProgress(t: CoverTarget): CoverProgress {
  const writing = useWriting((s) => !!s.keys[key(t)])
  const job = useGen((s) => {
    let best: GenJob | undefined
    for (const j of Object.values(s.jobs)) if (isActive(j) && isCoverJob(j, t) && (!best || j.createdAt > best.createdAt)) best = j
    return best
  })
  if (job) return { phase: job.status === 'queued' ? 'queued' : 'painting', value: job.progress?.max ? job.progress.value / job.progress.max : undefined, preview: job.preview, job }
  return { phase: writing ? 'writing' : 'idle' }
}

export const COVER_PHASE_LABEL: Record<Exclude<CoverPhase, 'idle'>, string> = {
  writing: 'Writing a cover prompt…',
  queued: 'Waiting in queue…',
  painting: 'Painting your cover…'
}

/** What the prompt writer knows about a scenario or adventure. */
export function storyInfoOf(doc: Scenario | Adventure): StoryInfo {
  const opening = 'opening' in doc ? doc.opening : (doc.actions[0]?.text ?? '')
  return { title: doc.title, description: doc.description, opening, plot: doc.plot, cards: doc.cards }
}

/**
 * Write a cover prompt from the story and queue the render. Returns once the
 * job is queued; the cover attaches itself when the render finishes.
 */
export async function generateCover(t: CoverTarget, opts: { info?: StoryInfo; steer?: string; llm?: LlmChoice; quiet?: boolean } = {}): Promise<GenJob | undefined> {
  const k = key(t)
  if (useWriting.getState().keys[k]) return undefined
  setWriting(k, true)
  try {
    const doc = db.get(t.collection, t.id)
    if (!doc) throw new Error('The story no longer exists.')
    if (!pickTextImageRecipe()) throw new Error('No image model is available. Start ComfyUI and check Connectors.')
    const info = opts.info ?? storyInfoOf(doc)
    const prompt = await coverPrompt(info, opts.llm, opts.steer)
    // Locked characters named in the prompt keep their faces on the cover.
    const characters = info.cards
      .map((c) => (c.characterId ? db.get('characters', c.characterId) : undefined))
      .filter((c): c is Character => !!c && prompt.toLowerCase().includes(c.name.toLowerCase()))
      .slice(0, 2)
    const req = sceneImageRequest({ prompt, characters, aspect: '16:9', projectId: doc.projectId, origin: { type: originType(t), id: t.id, sub: 'cover' } })
    const [job] = await useGen.getState().submit({ ...req, label: `Cover · ${doc.title || 'Story'}` })
    setWriting(k, false)
    void waitForJob(job.id)
      .then((done) => {
        if (done.status === 'error') toast.error('Cover generation failed', done.error)
      })
      .catch(() => {})
    return job
  } catch (err) {
    if (!opts.quiet) toast.error('Could not generate a cover', errorText(err))
    else throw err
    return undefined
  } finally {
    setWriting(k, false)
  }
}

/** Set (or clear) the cover directly. */
export function setCover(t: CoverTarget, assetId: ID | undefined): Promise<unknown> {
  return db.update(t.collection, t.id, (cur) => ({ ...cur, coverAssetId: assetId, updatedAt: Date.now() }))
}

/** Stop a running cover render. */
export function cancelCover(p: CoverProgress): void {
  if (p.job) void useGen.getState().cancel(p.job.id)
}
