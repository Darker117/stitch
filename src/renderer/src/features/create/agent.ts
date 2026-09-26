// The Create agent: an LLM with tools that drive Stitch's generators.
import { nanoid } from 'nanoid'
import type { LlmMessage, LlmTool } from '@shared/ipc'
import type { Asset, Character, Chat, ChatMessage, ChatToolCall, GenJob, ID, Scenario } from '@shared/types'
import { invoke, streamLlm, type StreamHandle } from '@/lib/api'
import { animateScene, characterRefs, pickEditRecipe, sceneImageRequest } from '@/lib/characters'
import { defaultLlm } from '@/lib/llm'
import { runWebTool, WEB_GUIDE, WEB_TOOL_NAMES, WEB_TOOLS, webEnabled } from '@/lib/web'
import { db } from '@/stores/db'
import { useGen, waitForJob } from '@/stores/gen'

export const GENERATIVE_TOOLS = new Set(['generate_image', 'edit_image', 'generate_video', 'generate_audio', 'speak'])

export const TOOLS: LlmTool[] = [
  {
    name: 'generate_image',
    description:
      'Generate still images locally. Mention characters by name in `characters` to keep them on-model (their locked reference images are used automatically).',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Detailed visual prompt: subject, action, setting, composition, lighting, style.' },
        aspect: { type: 'string', enum: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9'] },
        count: { type: 'integer', minimum: 1, maximum: 4 },
        characters: { type: 'array', items: { type: 'string' }, description: 'Names of saved characters that appear.' }
      },
      required: ['prompt']
    }
  },
  {
    name: 'edit_image',
    description: 'Edit an existing image asset with an instruction (change clothing, background, pose, lighting…) while keeping identity.',
    parameters: {
      type: 'object',
      properties: {
        asset_id: { type: 'string' },
        instruction: { type: 'string' },
        aspect: { type: 'string' }
      },
      required: ['asset_id', 'instruction']
    }
  },
  {
    name: 'generate_video',
    description:
      'Generate a short video WITH native audio (dialogue, sound effects, music) using MiniMax H3. Write the prompt as shots with camera moves and describe the soundscape; put spoken lines in quotes and say who speaks. Optionally animate an existing image (first_frame_asset_id) and/or include saved characters.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        duration: { type: 'number', minimum: 2, maximum: 15 },
        aspect: { type: 'string', enum: ['16:9', '9:16', '1:1', '4:3', '3:4'] },
        first_frame_asset_id: { type: 'string' },
        characters: { type: 'array', items: { type: 'string' } }
      },
      required: ['prompt']
    }
  },
  {
    name: 'generate_audio',
    description: 'Generate music (full tracks, instrumentals) or sound effects/ambience.',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['music', 'sfx'] },
        prompt: { type: 'string', description: 'Genre/mood/instruments for music, or a vivid sound description for sfx.' },
        lyrics: { type: 'string' },
        duration: { type: 'number' }
      },
      required: ['kind', 'prompt']
    }
  },
  {
    name: 'speak',
    description: "Voice a line of dialogue or narration. Use a saved character's voice by name, or describe a new voice.",
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        character: { type: 'string', description: 'Saved character name whose voice to use.' },
        delivery: { type: 'string', description: 'How to say it, e.g. "whispering, afraid".' }
      },
      required: ['text']
    }
  },
  {
    name: 'list_characters',
    description: 'List saved characters (name, appearance, whether they are locked with reference images and a voice).',
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'create_character',
    description: 'Create a new character. Optionally attach a reference image asset. The user can then lock a full character sheet.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string', description: 'Personality, role, backstory.' },
        appearance: { type: 'string', description: 'Concise visual description used in prompts.' },
        reference_asset_id: { type: 'string' },
        voice_description: { type: 'string' }
      },
      required: ['name', 'appearance']
    }
  },
  {
    name: 'create_story',
    description: 'Create an interactive story scenario the user can play (AI Dungeon style) with plot essentials and story cards.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
        opening: { type: 'string', description: 'Opening passage in second person present tense.' },
        ai_instructions: { type: 'string' },
        plot_essentials: { type: 'string' },
        cards: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['character', 'location', 'faction', 'race', 'class', 'custom'] },
              name: { type: 'string' },
              entry: { type: 'string' },
              triggers: { type: 'string' }
            },
            required: ['type', 'name', 'entry']
          }
        },
        tags: { type: 'array', items: { type: 'string' } }
      },
      required: ['title', 'opening']
    }
  }
]

export function systemPrompt(projectStyle?: string): string {
  const characters = db.all('characters')
  const roster = characters.length
    ? characters.map((c) => `- ${c.name}${c.locked ? ' (locked)' : ''}: ${c.appearance || c.description}`.slice(0, 220)).join('\n')
    : '(none yet)'
  return `You are Stitch, a creative director and production assistant inside a local AI studio. You plan and make images, short videos with native audio, music, voices, characters and interactive stories using tools that run on the user's own GPUs.

How to work:
- Be concise and warm. Say briefly what you'll make, then call tools. After tools finish, describe the results in one or two lines and suggest a next step.
- Prefer doing over asking. Ask one short clarifying question only when the request is genuinely ambiguous.
- Keep characters consistent: whenever a saved character appears, pass their name in \`characters\`. If the user describes a recurring person who isn't saved, offer to create them.
- Image prompts: concrete subject, action, setting, camera/composition, lighting and style in one rich sentence or two.
- Video prompts (MiniMax H3): write shots like "[Shot 1] … [Shot 2] At 00:02.5 the camera cuts to …", include camera motion, and end with the soundscape: ambient sound, effects, music; put dialogue in quotes with the speaker. Durations 4–8 s work best.
- To animate a picture you just made, pass its asset id as first_frame_asset_id.
- Tool results include asset ids you can reuse.
${webEnabled() ? `${WEB_GUIDE}
` : ''}${projectStyle ? `\nProject style to respect: ${projectStyle}\n` : ''}
Saved characters:
${roster}`
}

function findCharacters(names: unknown): Character[] {
  if (!Array.isArray(names)) return []
  const all = db.all('characters')
  return names
    .map((n) => String(n).toLowerCase().trim())
    .map((n) => all.find((c) => c.name.toLowerCase() === n) ?? all.find((c) => c.name.toLowerCase().includes(n) || n.includes(c.name.toLowerCase())))
    .filter((c): c is Character => !!c)
}

async function runJobs(jobs: GenJob[], onJobs: (ids: ID[]) => void): Promise<{ assets: ID[]; errors: string[] }> {
  onJobs(jobs.map((j) => j.id))
  const done = await Promise.all(jobs.map((j) => waitForJob(j.id)))
  return { assets: done.flatMap((d) => d.outputs), errors: done.filter((d) => d.status === 'error').map((d) => d.error ?? 'failed') }
}

function describe(assets: ID[], errors: string[]): string {
  const list = assets.map((id) => {
    const a = db.get('assets', id)
    return a ? `${a.kind} asset ${id}${a.width ? ` (${a.width}×${a.height})` : ''}${a.duration ? ` ${a.duration.toFixed(1)}s` : ''}` : `asset ${id}`
  })
  return JSON.stringify({ ok: assets.length > 0, assets: list, errors: errors.length ? errors : undefined })
}

/** Execute one tool call. `onJobs` lets the UI show live progress. */
export async function executeTool(call: ChatToolCall, ctx: { chatId: ID; projectId?: ID; onJobs: (ids: ID[]) => void }): Promise<{ result: string; jobIds?: ID[]; assets?: ID[] }> {
  const a = call.args as Record<string, unknown>
  const { submit, recipes } = useGen.getState()
  const origin = { type: 'chat' as const, id: ctx.chatId }
  const jobIds: ID[] = []
  const track = (ids: ID[]): void => {
    jobIds.push(...ids)
    ctx.onJobs([...jobIds])
  }

  if (WEB_TOOL_NAMES.has(call.name)) return { result: await runWebTool(call.name, a) }

  switch (call.name) {
    case 'generate_image': {
      const chars = findCharacters(a.characters)
      const count = Math.min(4, Math.max(1, Number(a.count ?? 1)))
      const req = sceneImageRequest({ prompt: String(a.prompt), characters: chars, aspect: String(a.aspect ?? '1:1'), origin, projectId: ctx.projectId })
      const jobs = await submit({ ...req, batch: count, label: 'Image' })
      const r = await runJobs(jobs, track)
      return { result: describe(r.assets, r.errors), jobIds, assets: r.assets }
    }
    case 'edit_image': {
      const recipe = pickEditRecipe(recipes) ?? recipes.find((r) => r.id === 'flux-kontext' && r.available)
      if (!recipe) return { result: JSON.stringify({ ok: false, error: 'No image editing model is available.' }) }
      const jobs = await submit({
        recipeId: recipe.id,
        params: { prompt: String(a.instruction), images: [String(a.asset_id)], sizeFrom: 'reference', aspect: String(a.aspect ?? '1:1') },
        label: 'Edit',
        origin,
        projectId: ctx.projectId
      })
      const r = await runJobs(jobs, track)
      return { result: describe(r.assets, r.errors), jobIds, assets: r.assets }
    }
    case 'generate_video': {
      const chars = findCharacters(a.characters)
      const first = typeof a.first_frame_asset_id === 'string' && db.get('assets', a.first_frame_asset_id) ? a.first_frame_asset_id : undefined
      if (!chars.length && !first) {
        const jobs = await submit({
          recipeId: 'h3-fast',
          params: { prompt: String(a.prompt), duration: Number(a.duration ?? 5), aspect: String(a.aspect ?? '16:9'), sizeFrom: 'aspect' },
          label: 'Video',
          origin,
          projectId: ctx.projectId
        })
        const r = await runJobs(jobs, track)
        return { result: describe(r.assets, r.errors), jobIds, assets: r.assets }
      }
      const final = await animateScene({
        prompt: String(a.prompt),
        characters: chars,
        duration: Number(a.duration ?? 5),
        aspect: String(a.aspect ?? '16:9'),
        keyframeAssetId: first,
        origin,
        projectId: ctx.projectId,
        onStage: (_s, job) => track([job.id])
      })
      const assets = final.status === 'done' ? final.outputs : []
      return { result: describe(assets, final.status === 'error' ? [final.error ?? 'failed'] : []), jobIds, assets }
    }
    case 'generate_audio': {
      const music = a.kind !== 'sfx'
      const recipeId = music ? 'ace-step-music' : 'stable-audio-sfx'
      const recipe = recipes.find((r) => r.id === recipeId)
      if (!recipe?.available) {
        return { result: JSON.stringify({ ok: false, error: `${recipe?.name ?? recipeId} isn't installed (missing: ${(recipe?.missing ?? []).join(', ')}). Suggest the user add it, or use generate_video for sound with picture.` }) }
      }
      const jobs = await submit({
        recipeId,
        params: { prompt: String(a.prompt), lyrics: a.lyrics ? String(a.lyrics) : undefined, duration: Number(a.duration ?? (music ? 60 : 8)) },
        label: music ? 'Music' : 'Sound effect',
        origin,
        projectId: ctx.projectId
      })
      const r = await runJobs(jobs, track)
      return { result: describe(r.assets, r.errors), jobIds, assets: r.assets }
    }
    case 'speak': {
      const [ch] = findCharacters(a.character ? [a.character] : [])
      const asset: Asset = await invoke('voice:speak', {
        text: String(a.text),
        voice: ch?.voice ?? {},
        instructions: a.delivery ? String(a.delivery) : undefined,
        origin,
        characterIds: ch ? [ch.id] : undefined,
        projectId: ctx.projectId,
        name: ch ? `${ch.name} line` : 'Voice line'
      })
      return { result: describe([asset.id], []), assets: [asset.id] }
    }
    case 'list_characters': {
      const list = db.all('characters').map((c) => ({ id: c.id, name: c.name, appearance: c.appearance, locked: c.locked, references: characterRefs(c).length, voice: !!c.voice }))
      return { result: JSON.stringify(list) }
    }
    case 'create_character': {
      const now = Date.now()
      const ref = typeof a.reference_asset_id === 'string' && db.get('assets', a.reference_asset_id) ? a.reference_asset_id : undefined
      const c: Character = {
        id: nanoid(10),
        name: String(a.name),
        description: String(a.description ?? ''),
        appearance: String(a.appearance ?? ''),
        createdAt: now,
        updatedAt: now,
        projectId: ctx.projectId,
        referenceAssetId: ref,
        sheet: {},
        sheetDetail: 'compact',
        locked: false,
        voice: a.voice_description ? { design: String(a.voice_description) } : undefined,
        tags: []
      }
      await db.put('characters', c)
      return { result: JSON.stringify({ ok: true, id: c.id, name: c.name, next: 'User can open Characters to lock a sheet.' }) }
    }
    case 'create_story': {
      const now = Date.now()
      const cards = Array.isArray(a.cards) ? (a.cards as Record<string, unknown>[]) : []
      const s: Scenario = {
        id: nanoid(10),
        title: String(a.title),
        description: String(a.description ?? ''),
        tags: Array.isArray(a.tags) ? a.tags.map(String).slice(0, 10) : [],
        projectId: ctx.projectId,
        createdAt: now,
        updatedAt: now,
        openingType: 'story',
        opening: String(a.opening),
        choices: [],
        creatorFields: [],
        plot: {
          aiInstructions: String(a.ai_instructions ?? ''),
          plotEssentials: String(a.plot_essentials ?? ''),
          authorsNote: '',
          storySummary: '',
          thirdPerson: false,
          enabled: { storySummary: false, thirdPerson: false }
        },
        cards: cards.map((c) => ({
          id: nanoid(10),
          type: (['character', 'location', 'faction', 'race', 'class', 'custom'].includes(String(c.type)) ? c.type : 'custom') as Scenario['cards'][number]['type'],
          name: String(c.name ?? ''),
          entry: String(c.entry ?? '').slice(0, 1000),
          triggers: String(c.triggers ?? c.name ?? ''),
          notes: '',
          createdAt: now,
          updatedAt: now
        }))
      }
      await db.put('scenarios', s)
      return { result: JSON.stringify({ ok: true, id: s.id, title: s.title, cards: s.cards.length }) }
    }
  }
  return { result: JSON.stringify({ ok: false, error: `Unknown tool ${call.name}` }) }
}

/**
 * Many local models (Qwen/Hermes/Mistral templates) print tool calls as text
 * instead of using the API's tool channel. Recover them so the agent still acts.
 */
export function extractTextToolCalls(text: string): { calls: { name: string; args: Record<string, unknown> }[]; rest: string } {
  const names = new Set([...TOOLS, ...WEB_TOOLS].map((t) => t.name))
  const calls: { name: string; args: Record<string, unknown> }[] = []
  let rest = text

  const take = (raw: string): boolean => {
    try {
      const j = JSON.parse(raw) as unknown
      const list = Array.isArray(j) ? j : [j]
      let found = false
      for (const item of list as Record<string, unknown>[]) {
        const name = String(item.name ?? (item.function as Record<string, unknown> | undefined)?.name ?? '')
        let args = item.arguments ?? item.parameters ?? (item.function as Record<string, unknown> | undefined)?.arguments ?? {}
        if (typeof args === 'string') args = JSON.parse(args)
        if (names.has(name)) {
          calls.push({ name, args: args as Record<string, unknown> })
          found = true
        }
      }
      return found
    } catch {
      return false
    }
  }

  // <tool_call>{…}</tool_call>, possibly with a missing opening tag.
  const tagged = /(?:<tool_call>)?\s*(\{[\s\S]*?\})\s*<\/tool_call>/g
  for (const m of text.matchAll(tagged)) if (take(m[1])) rest = rest.replace(m[0], '')
  // Mistral: [TOOL_CALLS] [ … ]
  const mistral = /\[TOOL_CALLS\]\s*(\[[\s\S]*\])/.exec(rest)
  if (mistral && take(mistral[1])) rest = rest.replace(mistral[0], '')
  // Fenced or bare JSON objects that look like a call.
  if (!calls.length) {
    for (const m of rest.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) if (take(m[1])) rest = rest.replace(m[0], '')
  }
  if (!calls.length) {
    const start = rest.indexOf('{"name"')
    if (start >= 0) {
      let depth = 0
      for (let i = start; i < rest.length; i++) {
        if (rest[i] === '{') depth++
        else if (rest[i] === '}' && --depth === 0) {
          if (take(rest.slice(start, i + 1))) rest = rest.slice(0, start) + rest.slice(i + 1)
          break
        }
      }
    }
  }
  return { calls, rest: rest.replace(/<\/?tool_call>/g, '').trim() }
}

/** Convert stored chat messages to LLM messages. */
export function toLlmMessages(messages: ChatMessage[]): LlmMessage[] {
  const out: LlmMessage[] = []
  for (const m of messages) {
    // Calls recovered from plain text are replayed as text, because the model
    // (or its server template) has no native tool channel.
    if (m.role === 'tool') {
      if (m.toolCallId?.startsWith('txt_')) out.push({ role: 'user', content: `[Tool result]\n${m.content}` })
      else out.push({ role: 'tool', content: m.content, toolCallId: m.toolCallId })
      continue
    }
    if (m.role === 'assistant') {
      const textCalls = m.toolCalls?.filter((t) => t.id.startsWith('txt_')) ?? []
      if (textCalls.length) {
        const calls = textCalls.map((t) => `<tool_call>${JSON.stringify({ name: t.name, arguments: t.args })}</tool_call>`).join('\n')
        out.push({ role: 'assistant', content: [m.content, calls].filter(Boolean).join('\n') })
      } else {
        out.push({ role: 'assistant', content: m.content, toolCalls: m.toolCalls?.map((t) => ({ id: t.id, name: t.name, args: t.args })) })
      }
      continue
    }
    const images = (m.attachments ?? []).map((id) => db.get('assets', id)).filter((x): x is Asset => !!x && x.kind === 'image')
    const others = (m.attachments ?? []).map((id) => db.get('assets', id)).filter((x): x is Asset => !!x && x.kind !== 'image')
    const note = [...images, ...others].map((x) => `[Attached ${x.kind} asset id: ${x.id}]`).join('\n')
    out.push({ role: 'user', content: note ? `${m.content}\n\n${note}` : m.content, images: images.map((x) => x.path) })
  }
  return out
}

export interface RunCallbacks {
  onUpdate: (chat: Chat) => void
  approve: (call: ChatToolCall) => Promise<boolean>
}

// Research turns (search → read → answer) need a few more steps than generation alone.
const MAX_STEPS = 10

/**
 * Run the agent until it stops calling tools. Persists every step so the
 * conversation survives navigation. Returns a handle for aborting.
 */
export function runAgent(chatId: ID, cb: RunCallbacks): { abort: () => void; done: Promise<void> } {
  let current: StreamHandle | null = null
  let aborted = false
  const save = async (fn: (c: Chat) => Chat): Promise<Chat | undefined> => {
    const next = await db.update('chats', chatId, (c) => ({ ...fn(c), updatedAt: Date.now() }))
    if (next) cb.onUpdate(next)
    return next
  }

  // Wake the web search engine while the model thinks, so a first search doesn't wait for it to start.
  if (webEnabled()) void invoke('web:start').catch(() => {})

  const done = (async () => {
    for (let step = 0; step < MAX_STEPS && !aborted; step++) {
      const chat = db.get('chats', chatId)
      if (!chat) return
      const llm = chat.llm ?? defaultLlm()
      if (!llm) throw new Error('No text model available. Add one in Connectors.')
      const project = chat.projectId ? db.get('projects', chat.projectId) : undefined
      const msgId = nanoid(10)
      await save((c) => ({ ...c, messages: [...c.messages, { id: msgId, role: 'assistant', content: '', createdAt: Date.now() }] }))
      // Live view of this step: visible reply + hidden thinking (+ how long it took).
      let liveText = ''
      let liveThought = ''
      const started = Date.now()
      let thinkingMs: number | undefined
      const push = (): void => {
        const c = db.get('chats', chatId)
        if (!c) return
        cb.onUpdate({
          ...c,
          messages: c.messages.map((m) => (m.id === msgId ? { ...m, content: liveText, reasoning: liveThought || undefined, thinkingMs } : m))
        })
      }
      current = streamLlm(
        { connectorId: llm.connectorId, model: llm.model, system: systemPrompt(project?.style), messages: toLlmMessages(chat.messages), tools: webEnabled() ? [...TOOLS, ...WEB_TOOLS] : TOOLS, maxTokens: 4096, temperature: 0.7 },
        (full) => {
          liveText = full
          if (full && liveThought && thinkingMs === undefined) thinkingMs = Date.now() - started
          push()
        },
        (thought) => {
          liveThought = thought
          push()
        }
      )
      let res
      try {
        res = await current.done
      } catch (err) {
        await save((c) => ({ ...c, messages: c.messages.map((m) => (m.id === msgId ? { ...m, content: `⚠ ${err instanceof Error ? err.message : String(err)}` } : m)) }))
        return
      }
      let text = res.text
      let calls: ChatToolCall[] = (res.toolCalls ?? []).map((t) => ({ id: t.id || nanoid(8), name: t.name, args: t.args, status: 'pending' }))
      if (!calls.length) {
        const recovered = extractTextToolCalls(text)
        if (recovered.calls.length) {
          text = recovered.rest
          calls = recovered.calls.map((t) => ({ id: `txt_${nanoid(8)}`, name: t.name, args: t.args, status: 'pending' }))
        }
      }
      const reasoning = res.reasoning || liveThought || undefined
      if (reasoning && thinkingMs === undefined) thinkingMs = Date.now() - started
      await save((c) => ({
        ...c,
        messages: c.messages.map((m) => (m.id === msgId ? { ...m, content: text, reasoning, thinkingMs: reasoning ? thinkingMs : undefined, toolCalls: calls.length ? calls : undefined } : m))
      }))
      if (!calls.length || aborted) return

      for (const call of calls) {
        const setCall = (patch: Partial<ChatToolCall>): Promise<Chat | undefined> =>
          save((c) => ({
            ...c,
            messages: c.messages.map((m) => (m.id === msgId ? { ...m, toolCalls: m.toolCalls?.map((t) => (t.id === call.id ? { ...t, ...patch } : t)) } : m))
          }))
        const needsOk = GENERATIVE_TOOLS.has(call.name) && db.get('chats', chatId)?.askBeforeGenerating
        if (needsOk) {
          const ok = await cb.approve(call)
          if (!ok) {
            await setCall({ status: 'rejected', result: 'User declined.' })
            await save((c) => ({ ...c, messages: [...c.messages, { id: nanoid(10), role: 'tool', toolCallId: call.id, content: '{"ok":false,"error":"The user declined this generation."}', createdAt: Date.now() }] }))
            continue
          }
        }
        await setCall({ status: 'running' })
        try {
          const r = await executeTool(call, { chatId, projectId: chat.projectId, onJobs: (ids) => void setCall({ jobIds: ids }) })
          await setCall({ status: 'done', result: r.result, jobIds: r.jobIds })
          await save((c) => ({ ...c, messages: [...c.messages, { id: nanoid(10), role: 'tool', toolCallId: call.id, content: r.result, createdAt: Date.now(), attachments: r.assets }] }))
        } catch (err) {
          const msg = err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err)
          await setCall({ status: 'error', result: msg })
          await save((c) => ({ ...c, messages: [...c.messages, { id: nanoid(10), role: 'tool', toolCallId: call.id, content: JSON.stringify({ ok: false, error: msg }), createdAt: Date.now() }] }))
        }
      }
    }
  })()

  return {
    abort: () => {
      aborted = true
      current?.abort()
    },
    done
  }
}

/** Short title from the first message, generated in the background. */
export async function titleChat(chatId: ID, firstMessage: string): Promise<void> {
  const fallback = firstMessage.replace(/\s+/g, ' ').slice(0, 48)
  const llm = db.get('chats', chatId)?.llm ?? defaultLlm()
  if (!llm) return
  try {
    const r = await invoke('llm:complete', {
      connectorId: llm.connectorId,
      model: llm.model,
      system: 'Write a 2–5 word title for this creative request. Reply with the title only, no quotes.',
      messages: [{ role: 'user', content: firstMessage.slice(0, 800) }],
      maxTokens: 20,
      temperature: 0.4
    })
    // Small models sometimes answer instead of titling — keep it to a few words.
    const title = r.text
      .replace(/["'*#]/g, '')
      .trim()
      .split('\n')[0]
      .split(/\s+/)
      .slice(0, 6)
      .join(' ')
      .replace(/[.,:;!]+$/, '')
      .slice(0, 60)
    await db.patch('chats', chatId, { title: title || fallback })
  } catch {
    /* keep fallback */
  }
}
