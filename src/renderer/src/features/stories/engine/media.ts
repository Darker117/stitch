// See / Animate / Narrate for story turns, and Send to Studio.
import { nanoid } from 'nanoid'
import type { Adventure, Asset, Character, GenJob, StoryAction, Timeline, TimelineClip, TimelineTrack } from '@shared/types'
import { invoke } from '@/lib/api'
import { animateScene, sceneImageRequest } from '@/lib/characters'
import { db } from '@/stores/db'
import { useGen } from '@/stores/gen'
import { useSettings } from '@/stores/settings'
import { scenePrompt } from './ai'
import { cardMatches, triggeredCards } from './context'
import { storyModel } from './llm'
import { isPlayerAction, playerLine } from './text'

/** Linked Stitch characters whose cards are mentioned in `text`. */
export function charactersIn(adv: Adventure, text: string): Character[] {
  const out: Character[] = []
  for (const card of adv.cards) {
    if (!card.characterId || !cardMatches(card, text)) continue
    const c = db.get('characters', card.characterId)
    if (c && !out.some((x) => x.id === c.id)) out.push(c)
  }
  if (adv.player.characterId && adv.player.name && new RegExp(`\\b${adv.player.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text)) {
    const c = db.get('characters', adv.player.characterId)
    if (c && !out.some((x) => x.id === c.id)) out.push(c)
  }
  return out
}

function recentText(adv: Adventure, target: StoryAction, count = 4): string {
  const idx = adv.actions.findIndex((a) => a.id === target.id)
  const upto = idx >= 0 ? adv.actions.slice(0, idx + 1) : adv.actions
  return upto
    .filter((a) => a.type !== 'see')
    .slice(-count)
    .map((a) => (isPlayerAction(a) ? playerLine(a.type, a.text) : a.text))
    .join('\n\n')
}

async function promptFor(adv: Adventure, target: StoryAction, focus?: string): Promise<{ prompt: string; characters: Character[] }> {
  const recent = recentText(adv, target)
  const scope = `${target.type === 'see' ? '' : target.text}\n${focus ?? ''}`.trim() || recent
  const characters = charactersIn(adv, scope || recent)
  const cards = triggeredCards(adv.cards, [scope, recent])
  const prompt = await scenePrompt({ recent, focus: focus || undefined, cards, names: characters.map((c) => c.name), llm: storyModel(adv) })
  return { prompt, characters }
}

/** Append the user's always-on words (LoRA activation words, style tags). */
function withTrigger(prompt: string, trigger?: string): string {
  const t = trigger?.trim()
  return t ? `${prompt.trim().replace(/[,.]?$/, ',')} ${t}` : prompt
}

/** Render a still for a turn. The image attaches to the action when it finishes. */
export async function seeAction(adv: Adventure, target: StoryAction, focus?: string): Promise<GenJob[]> {
  const { prompt, characters } = await promptFor(adv, target, focus)
  const req = sceneImageRequest({
    prompt: withTrigger(prompt, adv.settings.imageGen?.trigger),
    characters,
    aspect: '16:9',
    origin: { type: 'adventure', id: adv.id, sub: target.id },
    projectId: adv.projectId,
    recipeId: adv.settings.imageRecipeId,
    extraParams: { model: adv.settings.imageGen?.model, loras: adv.settings.imageGen?.loras }
  })
  req.label = `See · ${adv.title}`.slice(0, 60)
  return useGen.getState().submit(req)
}

/** Animate a turn (uses its See image as the keyframe when there is one). */
export async function animateAction(adv: Adventure, target: StoryAction, onStage?: (stage: 'keyframe' | 'video', job: GenJob) => void): Promise<GenJob> {
  const still = [...(target.media ?? [])].reverse().find((m) => m.kind === 'image')
  const stillAsset = still ? db.get('assets', still.assetId) : undefined
  let prompt = stillAsset?.prompt
  let characters: Character[]
  if (prompt) {
    characters = charactersIn(adv, `${target.text}\n${prompt}`)
  } else {
    const p = await promptFor(adv, target)
    prompt = p.prompt
    characters = p.characters
  }
  return animateScene({
    prompt: withTrigger(`${prompt} Subtle natural motion, cinematic camera movement.`, adv.settings.videoGen?.trigger),
    characters,
    keyframeAssetId: still?.assetId,
    aspect: '16:9',
    duration: adv.settings.videoGen?.duration,
    origin: { type: 'adventure', id: adv.id, sub: target.id },
    projectId: adv.projectId,
    onStage,
    videoRecipeId: adv.settings.videoRecipeId,
    videoParams: { model: adv.settings.videoGen?.model, loras: adv.settings.videoGen?.loras },
    imageRecipeId: adv.settings.imageRecipeId,
    imageParams: { model: adv.settings.imageGen?.model, loras: adv.settings.imageGen?.loras }
  })
}

/** Speak a turn aloud with the narrator voice and attach the clip. */
export async function narrateAction(adv: Adventure, target: StoryAction): Promise<Asset> {
  const text = isPlayerAction(target) ? playerLine(target.type, target.text) : target.text
  const settings = useSettings.getState().settings
  const voice = adv.settings.narrator ?? { connectorId: settings?.defaultVoice?.connectorId }
  const characters = charactersIn(adv, text)
  const asset = await invoke('voice:speak', {
    connectorId: voice.connectorId ?? settings?.defaultVoice?.connectorId,
    text,
    voice,
    name: `${adv.title} · narration`,
    origin: { type: 'adventure', id: adv.id, sub: target.id },
    projectId: adv.projectId,
    characterIds: characters.map((c) => c.id)
  })
  await db.update('adventures', adv.id, (cur) => ({
    ...cur,
    actions: cur.actions.map((a) =>
      a.id === target.id && !(a.media ?? []).some((m) => m.assetId === asset.id)
        ? { ...a, media: [...(a.media ?? []), { assetId: asset.id, kind: 'audio' as const, role: 'narrate' as const }] }
        : a
    )
  }))
  return asset
}

async function durationOf(asset: Asset): Promise<number> {
  if (asset.duration && asset.duration > 0) return asset.duration
  try {
    const p = await invoke('assets:probe', asset.path)
    return p.duration && p.duration > 0 ? p.duration : asset.kind === 'image' ? 4 : 5
  } catch {
    return asset.kind === 'image' ? 4 : 5
  }
}

/**
 * Build a Studio timeline from the adventure's media: V1 stills (4 s) and
 * videos (their duration), A1 narration aligned to its turn, T1 for titles.
 */
export async function buildTimeline(adv: Adventure): Promise<Timeline> {
  const now = Date.now()
  const V: TimelineTrack = { id: nanoid(8), kind: 'video', name: 'V1', muted: false, locked: false, hidden: false }
  const A: TimelineTrack = { id: nanoid(8), kind: 'audio', name: 'A1', muted: false, locked: false, hidden: false }
  const T: TimelineTrack = { id: nanoid(8), kind: 'text', name: 'T1', muted: false, locked: false, hidden: false }
  const clips: TimelineClip[] = []
  let cursor = 0
  for (const a of adv.actions) {
    const media = a.media ?? []
    if (!media.length) continue
    const turnStart = cursor
    let visualEnd = turnStart
    // Prefer an animation over its keyframe still for the same turn.
    const videos = media.filter((m) => m.kind === 'video')
    const visuals = videos.length ? videos : media.filter((m) => m.kind === 'image')
    for (const m of visuals) {
      const asset = db.get('assets', m.assetId)
      if (!asset) continue
      const d = m.kind === 'image' ? 4 : await durationOf(asset)
      clips.push({ id: nanoid(8), assetId: asset.id, trackId: V.id, start: visualEnd, in: 0, out: d, volume: 1 })
      visualEnd += d
    }
    let audioEnd = turnStart
    for (const m of media.filter((x) => x.kind === 'audio')) {
      const asset = db.get('assets', m.assetId)
      if (!asset) continue
      const d = await durationOf(asset)
      clips.push({ id: nanoid(8), assetId: asset.id, trackId: A.id, start: audioEnd, in: 0, out: d, volume: 1 })
      audioEnd += d
    }
    cursor = Math.max(visualEnd, audioEnd)
  }
  const tl: Timeline = {
    id: nanoid(10),
    name: adv.title || 'Adventure',
    projectId: adv.projectId,
    width: 1920,
    height: 1080,
    fps: 30,
    tracks: [V, A, T],
    clips,
    createdAt: now,
    updatedAt: now
  }
  await db.put('timelines', tl)
  return tl
}
