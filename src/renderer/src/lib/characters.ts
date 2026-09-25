// Character consistency: sheet slots, reference selection and scene requests
// that keep characters on-model across images and video.
import type { Character, GenJob, GenRequest, ID, RecipeInfo, SheetSlot } from '@shared/types'
import { db } from '@/stores/db'
import { useGen, waitForJob } from '@/stores/gen'

export interface SlotDef {
  slot: SheetSlot
  label: string
  group: 'angles' | 'expressions' | 'lighting'
  /** Instruction appended to the edit prompt. */
  prompt: string
  aspect: string
}

const KEEP = 'Keep the exact same person from <image1>: identical face, hairstyle, hair colour, skin tone, body shape, outfit, accessories and markings. Plain light-grey studio background, soft even light, sharp focus, character reference photo.'

export const SHEET_SLOTS: SlotDef[] = [
  { slot: 'front', label: 'Front', group: 'angles', aspect: '3:4', prompt: 'Head-and-shoulders portrait facing the camera straight on, neutral expression.' },
  { slot: 'three-quarter-left', label: '3/4 Left', group: 'angles', aspect: '3:4', prompt: 'Head-and-shoulders portrait, head turned three-quarters to their left.' },
  { slot: 'three-quarter-right', label: '3/4 Right', group: 'angles', aspect: '3:4', prompt: 'Head-and-shoulders portrait, head turned three-quarters to their right.' },
  { slot: 'profile-left', label: 'Profile L', group: 'angles', aspect: '3:4', prompt: 'Strict side profile facing left, head and shoulders.' },
  { slot: 'profile-right', label: 'Profile R', group: 'angles', aspect: '3:4', prompt: 'Strict side profile facing right, head and shoulders.' },
  { slot: 'back', label: 'Back', group: 'angles', aspect: '3:4', prompt: 'Seen from directly behind, head and shoulders, showing the back of the hair and outfit.' },
  { slot: 'low-angle', label: 'Low angle', group: 'angles', aspect: '3:4', prompt: 'Dramatic low-angle shot looking up at the character, waist up.' },
  { slot: 'high-angle', label: 'High angle', group: 'angles', aspect: '3:4', prompt: 'High-angle shot looking down at the character, waist up.' },
  { slot: 'full-body', label: 'Full body', group: 'angles', aspect: '9:16', prompt: 'Full-body standing pose from head to feet, arms relaxed, whole outfit visible including shoes.' },
  { slot: 'expr-happy', label: 'Joy', group: 'expressions', aspect: '1:1', prompt: 'Close-up portrait, genuinely happy, warm smile.' },
  { slot: 'expr-sad', label: 'Sorrow', group: 'expressions', aspect: '1:1', prompt: 'Close-up portrait, sad expression, glistening eyes.' },
  { slot: 'expr-angry', label: 'Anger', group: 'expressions', aspect: '1:1', prompt: 'Close-up portrait, furious expression, furrowed brow.' },
  { slot: 'expr-surprised', label: 'Surprise', group: 'expressions', aspect: '1:1', prompt: 'Close-up portrait, shocked and surprised, eyes wide.' },
  { slot: 'expr-neutral', label: 'Calm', group: 'expressions', aspect: '1:1', prompt: 'Close-up portrait, calm and thoughtful expression.' },
  { slot: 'light-golden', label: 'Golden hour', group: 'lighting', aspect: '3:4', prompt: 'Portrait lit by warm golden-hour sunlight from the side, outdoor bokeh.' },
  { slot: 'light-night', label: 'Night neon', group: 'lighting', aspect: '3:4', prompt: 'Portrait at night lit by magenta and teal neon signs.' },
  { slot: 'light-studio', label: 'Studio key', group: 'lighting', aspect: '3:4', prompt: 'Portrait with a dramatic studio key light and dark background.' },
  { slot: 'light-rim', label: 'Rim light', group: 'lighting', aspect: '3:4', prompt: 'Portrait with strong rim light outlining the silhouette, moody.' },
  { slot: 'light-overcast', label: 'Overcast', group: 'lighting', aspect: '3:4', prompt: 'Portrait under soft overcast daylight, muted tones.' }
]

export function slotsFor(detail: Character['sheetDetail']): SlotDef[] {
  return detail === 'studio' ? SHEET_SLOTS : SHEET_SLOTS.filter((s) => s.group === 'angles')
}

/** Edit recipe used for sheets & scenes: Qwen 2.1 Edit, else Flux 2 Klein. */
export function pickEditRecipe(recipes: RecipeInfo[] = useGen.getState().recipes): RecipeInfo | undefined {
  const ok = (r: RecipeInfo): boolean => !!r.available && !r.autoNsfw
  return recipes.find((r) => r.id === 'qwen21-edit' && ok(r)) ?? recipes.find((r) => r.id === 'flux2-klein' && ok(r)) ?? recipes.find((r) => r.id === 'qwen21-edit' && r.available) ?? recipes.find((r) => r.id === 'flux2-klein' && r.available)
}

export function pickTextImageRecipe(recipes: RecipeInfo[] = useGen.getState().recipes): RecipeInfo | undefined {
  // Automatic picks skip recipes whose only installed models are NSFW finetunes, unless nothing else is available.
  const order = ['krea2-t2i', 'flux2-klein', 'qwen21-t2i', 'anima-t2i', 'sdxl-checkpoint']
  return order.map((id) => recipes.find((r) => r.id === id && r.available && !r.autoNsfw)).find(Boolean) ?? order.map((id) => recipes.find((r) => r.id === id && r.available)).find(Boolean)
}

/** Best identity references for a character, most useful first. */
export function characterRefs(c: Character, max = 3): ID[] {
  const order: (SheetSlot | 'ref')[] = ['front', 'ref', 'full-body', 'three-quarter-left', 'three-quarter-right']
  const out: ID[] = []
  for (const k of order) {
    const id = k === 'ref' ? c.referenceAssetId : c.sheet[k]
    if (id && !out.includes(id) && db.get('assets', id)) out.push(id)
    if (out.length >= max) break
  }
  return out
}

/** Build a generation request for one sheet slot. */
export function sheetSlotRequest(c: Character, slot: SlotDef, recipe: RecipeInfo): GenRequest {
  const ref = c.referenceAssetId ?? c.sheet.front
  if (!ref) throw new Error('Upload a reference image first')
  const prompt = recipe.id === 'flux2-klein' ? `${slot.prompt} ${KEEP.replace(/<image1>/g, 'image 1')}` : `${slot.prompt} ${KEEP}`
  return {
    recipeId: recipe.id,
    params: { prompt, images: [ref], aspect: slot.aspect, quality: c.sheetDetail === 'studio' ? '1.5' : '1' },
    label: `${c.name} · ${slot.label}`,
    origin: { type: 'character', id: c.id, sub: slot.slot },
    characterIds: [c.id],
    projectId: c.projectId
  }
}

/**
 * Scene still with any number of locked characters. Uses an edit model with
 * their references when available, otherwise folds their appearance into text.
 */
interface SceneOpts {
  prompt: string
  characters: Character[]
  aspect?: string
  style?: string
  origin?: GenRequest['origin']
  projectId?: ID
  recipeId?: string
  /** Model / LoRA params for recipeId — merged only when that recipe is the one used. */
  extraParams?: Record<string, unknown>
}

export function sceneImageRequest(opts: SceneOpts): GenRequest {
  const req = buildSceneRequest(opts)
  if (opts.extraParams && opts.recipeId && req.recipeId === opts.recipeId) {
    const extra = Object.fromEntries(Object.entries(opts.extraParams).filter(([, v]) => v !== undefined && !(Array.isArray(v) && !v.length)))
    req.params = { ...req.params, ...extra }
  }
  return req
}

function buildSceneRequest(opts: SceneOpts): GenRequest {
  const recipes = useGen.getState().recipes
  const withRefs = opts.characters.filter((c) => characterRefs(c, 1).length)
  const edit = opts.recipeId ? recipes.find((r) => r.id === opts.recipeId && r.mode === 'reference') : pickEditRecipe(recipes)
  const style = opts.style ? ` Style: ${opts.style}.` : ''
  if (withRefs.length && edit && (!opts.recipeId || edit.id === opts.recipeId)) {
    const images: ID[] = []
    const names: string[] = []
    for (const c of withRefs.slice(0, edit.id === 'flux2-klein' ? 4 : 6)) {
      const ref = characterRefs(c, 1)[0]
      images.push(ref)
      names.push(edit.id === 'flux2-klein' ? `${c.name} is the person in image ${images.length}` : `${c.name} is the person in <image${images.length}>`)
    }
    return {
      recipeId: edit.id,
      params: { prompt: `${opts.prompt}${style} ${names.join('; ')}. Keep each character's face, hair and outfit exactly as in their reference.`, images, aspect: opts.aspect ?? '16:9', quality: '1' },
      label: 'Scene',
      origin: opts.origin,
      characterIds: opts.characters.map((c) => c.id),
      projectId: opts.projectId
    }
  }
  const t2i = (opts.recipeId && recipes.find((r) => r.id === opts.recipeId)) || pickTextImageRecipe(recipes)
  if (!t2i) throw new Error('No image model is available. Start ComfyUI and check Connectors.')
  const looks = opts.characters.filter((c) => c.appearance).map((c) => `${c.name}: ${c.appearance}`)
  return {
    recipeId: t2i.id,
    params: { prompt: `${opts.prompt}${style}${looks.length ? ` Characters — ${looks.join('; ')}.` : ''}`, aspect: opts.aspect ?? '16:9' },
    label: 'Scene',
    origin: opts.origin,
    characterIds: opts.characters.map((c) => c.id),
    projectId: opts.projectId
  }
}

/**
 * Animate a scene with consistent characters. With the H3 ref2va model it
 * references the characters (and their voices) directly; otherwise it first
 * renders a locked keyframe and animates it with FastH3.
 */
export async function animateScene(opts: {
  prompt: string
  characters: Character[]
  duration?: number
  aspect?: string
  keyframeAssetId?: ID
  origin?: GenRequest['origin']
  projectId?: ID
  onStage?: (stage: 'keyframe' | 'video', job: GenJob) => void
  /** Preferred video recipe ('h3-fast' | 'h3-reference'); default picks the best available. */
  videoRecipeId?: string
  /** Model / LoRAs for the video recipe. */
  videoParams?: Record<string, unknown>
  /** Recipe + model / LoRAs for the keyframe still. */
  imageRecipeId?: string
  imageParams?: Record<string, unknown>
}): Promise<GenJob> {
  const { recipes, submit } = useGen.getState()
  const extras = (id: string): Record<string, unknown> =>
    opts.videoParams && opts.videoRecipeId === id ? Object.fromEntries(Object.entries(opts.videoParams).filter(([, v]) => v !== undefined && !(Array.isArray(v) && !v.length))) : {}
  const ref = recipes.find((r) => r.id === 'h3-reference' && r.available)
  const hasRef2va = !!ref && (ref.missing ?? []).length === 0 && hasModel(/ref2va/i)
  if (hasRef2va && (!opts.videoRecipeId || opts.videoRecipeId === 'h3-reference') && opts.characters.some((c) => characterRefs(c, 1).length)) {
    const images: ID[] = []
    const audios: ID[] = []
    const tags: string[] = []
    for (const c of opts.characters) {
      const r = characterRefs(c, 1)[0]
      if (r) {
        images.push(r)
        tags.push(`<Picture ${images.length}> is ${c.name}`)
      }
      if (c.voice?.sampleAssetId && audios.length < 3) {
        audios.push(c.voice.sampleAssetId)
        tags.push(`${c.name} speaks with the voice of <Audio ${audios.length}>`)
      }
    }
    const [job] = await submit({
      recipeId: 'h3-reference',
      params: { prompt: `${tags.join('. ')}. ${opts.prompt}`, images, audios, duration: opts.duration ?? 5, aspect: opts.aspect ?? '16:9', ...extras('h3-reference') },
      label: 'Animated scene',
      origin: opts.origin,
      characterIds: opts.characters.map((c) => c.id),
      projectId: opts.projectId
    })
    opts.onStage?.('video', job)
    return waitForJob(job.id)
  }

  let keyframe = opts.keyframeAssetId
  if (!keyframe) {
    const [kf] = await submit(sceneImageRequest({ prompt: opts.prompt, characters: opts.characters, aspect: opts.aspect ?? '16:9', projectId: opts.projectId, recipeId: opts.imageRecipeId, extraParams: opts.imageParams }))
    opts.onStage?.('keyframe', kf)
    const done = await waitForJob(kf.id)
    if (done.status !== 'done' || !done.outputs[0]) return done
    keyframe = done.outputs[0]
  }
  const [job] = await submit({
    recipeId: 'h3-fast',
    params: { prompt: opts.prompt, firstFrame: keyframe, duration: opts.duration ?? 5, aspect: opts.aspect ?? '16:9', ...extras('h3-fast') },
    label: 'Animated scene',
    origin: opts.origin,
    characterIds: opts.characters.map((c) => c.id),
    projectId: opts.projectId
  })
  opts.onStage?.('video', job)
  return waitForJob(job.id)
}

function hasModel(re: RegExp): boolean {
  return (useGen.getState().models.diffusion_models ?? []).some((m) => re.test(m))
}
