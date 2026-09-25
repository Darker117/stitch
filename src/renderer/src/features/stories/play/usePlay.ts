// Play controller: turns, streaming, retry/alternates, undo/redo, edits and
// per-turn media (See / Animate / Narrate). Story scripts' Input hook runs
// before a player action is added, their Output hook before a reply is saved.
import { useCallback, useEffect, useRef, useState } from 'react'
import { nanoid } from 'nanoid'
import type { ActionType, Adventure, GenJob, StoryAction } from '@shared/types'
import { errorText } from '@/lib/api'
import { db } from '@/stores/db'
import { waitForJob } from '@/stores/gen'
import { toast } from '@/stores/toast'
import { action as makeAction } from '../engine/adventure'
import type { ContextResult } from '../engine/context'
import { animateAction, narrateAction, seeAction } from '../engine/media'
import { runTurn, upkeep, type TurnHandle } from '../engine/turn'
import { cleanOutput, isAiAction } from '../engine/text'
import { prepareScripts, runInputScripts, runOutputScripts, ScriptStopError } from '../engine/scripts/play'

export type TurnMode = 'do' | 'say' | 'story' | 'see'

export interface Streaming {
  targetId: string
  retry: boolean
  text: string
  /** Appended pieces, for the per-token fade. */
  chunks: string[]
  /** Hidden model thinking, if the model reasons. */
  reasoning: string
  startedAt: number
}

export interface Thought {
  text: string
  ms: number
}

export interface MediaPending {
  see?: 'prompt'
  animate?: 'prompt' | 'keyframe' | 'video'
  keyframeJobId?: string
  narrate?: boolean
}

export interface PlayController {
  streaming: Streaming | null
  busy: boolean
  freshId: string | undefined
  lastCtx: ContextResult | null
  pending: Record<string, MediaPending>
  /** Thinking behind passages generated this session. */
  thoughts: Record<string, Thought>
  autoplay: string | null
  submit: (mode: TurnMode, text: string) => Promise<void>
  continueStory: () => Promise<void>
  retry: () => Promise<void>
  erase: () => Promise<void>
  undo: () => Promise<void>
  redo: () => Promise<void>
  stop: () => void
  edit: (id: string, text: string) => Promise<void>
  remove: (id: string) => Promise<void>
  cycle: (id: string, dir: -1 | 1) => Promise<void>
  see: (id: string, focus?: string) => Promise<GenJob[] | undefined>
  animate: (id: string) => Promise<void>
  narrate: (id: string) => Promise<void>
  generateOpening: () => Promise<void>
}

function latest(id: string): Adventure | undefined {
  return db.get('adventures', id)
}

/** Resolve once `assetId` shows up in the turn's media (main attaches it as the job lands). */
async function untilAttached(advId: string, actionId: string, assetId: string, timeoutMs = 8000): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const a = latest(advId)?.actions.find((x) => x.id === actionId)
    if (!a) return false
    if (a.media?.some((m) => m.assetId === assetId)) return true
    await new Promise((r) => setTimeout(r, 150))
  }
  return false
}

export function usePlay(advId: string | undefined, flush: () => Promise<void>): PlayController {
  const [streaming, setStreaming] = useState<Streaming | null>(null)
  const [freshId, setFreshId] = useState<string | undefined>()
  const [lastCtx, setLastCtx] = useState<ContextResult | null>(null)
  const [pending, setPending] = useState<Record<string, MediaPending>>({})
  const [autoplay, setAutoplay] = useState<string | null>(null)
  const [thoughts, setThoughts] = useState<Record<string, Thought>>({})
  const handle = useRef<TurnHandle | null>(null)
  const stopped = useRef(false)
  const partial = useRef('')
  const mounted = useRef(true)
  const initFresh = useRef(false)
  const running = useRef(false)
  const [scripting, setScripting] = useState(false)

  // Warm the script sandbox when the adventure has scripts.
  useEffect(() => {
    if (advId) prepareScripts(latest(advId))
  }, [advId])

  // Highlight the newest AI passage from the previous session too.
  useEffect(() => {
    if (!advId || initFresh.current) return
    const adv = latest(advId)
    if (!adv) return
    initFresh.current = true
    const last = adv.actions[adv.actions.length - 1]
    if (last && last.type === 'continue') setFreshId(last.id)
  })

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      handle.current?.abort()
    }
  }, [])

  const mark = useCallback((id: string, patch: MediaPending | null) => {
    setPending((p) => {
      const next = { ...p }
      if (patch === null) delete next[id]
      else next[id] = { ...(p[id] ?? {}), ...patch }
      return next
    })
  }, [])

  const see = useCallback(
    async (id: string, focus?: string): Promise<GenJob[] | undefined> => {
      await flush()
      const adv = advId ? latest(advId) : undefined
      const target = adv?.actions.find((a) => a.id === id)
      if (!adv || !target) return
      mark(id, { see: 'prompt' })
      try {
        return await seeAction(adv, target, focus)
      } catch (err) {
        toast.error('Could not render the scene', errorText(err))
        return undefined
      } finally {
        setPending((p) => {
          const n = { ...p }
          if (n[id]) n[id] = { ...n[id], see: undefined }
          return n
        })
      }
    },
    [advId, mark, flush]
  )

  const animate = useCallback(
    async (id: string) => {
      await flush()
      const adv = advId ? latest(advId) : undefined
      const target = adv?.actions.find((a) => a.id === id)
      if (!adv || !target) return
      mark(id, { animate: 'prompt' })
      try {
        const job = await animateAction(adv, target, (stage, j) => mark(id, { animate: stage, keyframeJobId: stage === 'keyframe' ? j.id : undefined }))
        if (job.status === 'error') toast.error('Animation failed', job.error)
      } catch (err) {
        toast.error('Could not animate the scene', errorText(err))
      } finally {
        setPending((p) => {
          const n = { ...p }
          if (n[id]) n[id] = { ...n[id], animate: undefined, keyframeJobId: undefined }
          return n
        })
      }
    },
    [advId, mark, flush]
  )

  const narrate = useCallback(
    async (id: string) => {
      await flush()
      const adv = advId ? latest(advId) : undefined
      const target = adv?.actions.find((a) => a.id === id)
      if (!adv || !target) return
      mark(id, { narrate: true })
      try {
        const asset = await narrateAction(adv, target)
        if (mounted.current) setAutoplay(asset.id)
      } catch (err) {
        toast.error('Narration unavailable', `${errorText(err)}. Set up a voice under Connectors → Voice.`)
      } finally {
        setPending((p) => {
          const n = { ...p }
          if (n[id]) n[id] = { ...n[id], narrate: undefined }
          return n
        })
      }
    },
    [advId, mark, flush]
  )

  /** Both images and video: render the still, then animate from it so the clip matches. */
  const seeThenAnimate = useCallback(
    async (id: string) => {
      if (!advId) return
      const jobs = await see(id)
      const job = jobs?.[0]
      if (!job) return
      mark(id, { animate: 'keyframe', keyframeJobId: job.id })
      const done = await waitForJob(job.id)
      if (done.status !== 'done' || !done.outputs?.length) {
        mark(id, { animate: undefined, keyframeJobId: undefined })
        return
      }
      await untilAttached(advId, id, done.outputs[0])
      await animate(id)
    },
    [advId, see, animate, mark]
  )

  /** Stream a continuation of the current history. `retryId` regenerates that AI action. */
  const generate = useCallback(
    async (retryId?: string) => {
      if (!advId || running.current) return
      running.current = true
      try {
        await generateInner(advId, retryId)
      } finally {
        running.current = false
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [advId, flush, see, animate, seeThenAnimate, narrate]
  )

  async function generateInner(advId: string, retryId?: string): Promise<void> {
    {
      await flush()
      const adv = latest(advId)
      if (!adv) return
      const idx = retryId ? adv.actions.findIndex((a) => a.id === retryId) : -1
      const history = idx >= 0 ? adv.actions.slice(0, idx) : adv.actions
      const targetId = retryId ?? nanoid(10)
      stopped.current = false
      partial.current = ''
      const startedAt = Date.now()
      setStreaming({ targetId, retry: !!retryId, text: '', chunks: [], reasoning: '', startedAt })
      const h = runTurn(
        adv,
        history,
        (display) => {
          partial.current = display
          if (!mounted.current) return
          setStreaming((s) => {
            if (!s || s.targetId !== targetId) return s
            const chunks = display.startsWith(s.text) ? (display.length > s.text.length ? [...s.chunks, display.slice(s.text.length)] : s.chunks) : [display]
            return { ...s, text: display, chunks }
          })
        },
        (reasoning) => {
          if (!mounted.current) return
          setStreaming((s) => (s && s.targetId === targetId ? { ...s, reasoning } : s))
        }
      )
      handle.current = h
      let text: string | null = null
      let ctx: ContextResult | null = null
      let model: string | undefined
      let thought: { text: string; ms: number } | undefined
      try {
        const res = await h.done
        text = res.text
        ctx = res.context
        model = res.llm.model
        if (res.reasoning) {
          const t = { text: res.reasoning, ms: Date.now() - startedAt }
          thought = t
          if (mounted.current) setThoughts((all) => ({ ...all, [targetId]: t }))
        }
      } catch (err) {
        if (stopped.current && partial.current.trim()) {
          text = cleanOutput(partial.current, { raw: adv.settings.rawOutput }) || partial.current.trim()
        } else if (err instanceof ScriptStopError) {
          toast.info('A script stopped this turn', err.message)
        } else if (!stopped.current && mounted.current) {
          toast.error('The story model failed', errorText(err))
        }
      } finally {
        handle.current = null
      }
      if (!mounted.current) return
      if (text === null && stopped.current && partial.current.trim()) text = partial.current.trim()
      // Output hook: scripts may rewrite (or swallow) the reply before it is kept.
      if (text) text = (await runOutputScripts(advId, history, text)).trim()
      if (text) {
        const final = text
        await db.update('adventures', advId, (cur) => {
          if (retryId) {
            return {
              ...cur,
              updatedAt: Date.now(),
              lastPlayedAt: Date.now(),
              actions: cur.actions.map((a) => {
                if (a.id !== retryId) return a
                const alts = a.alternates?.length ? a.alternates : [a.text]
                return { ...a, text: final, alternates: [...alts.filter((x) => x !== final), final], model, media: a.media, reasoning: thought?.text, thinkingMs: thought?.ms }
              })
            }
          }
          return {
            ...cur,
            updatedAt: Date.now(),
            lastPlayedAt: Date.now(),
            actions: [...cur.actions, { id: targetId, type: 'continue', text: final, createdAt: Date.now(), alternates: [final], model, reasoning: thought?.text, thinkingMs: thought?.ms }]
          }
        })
        setFreshId(targetId)
        if (ctx) {
          setLastCtx(ctx)
          void upkeep(advId, ctx)
        }
        const fresh = latest(advId)
        if (fresh && !stopped.current) {
          const { autoSee, autoAnimate, autoNarrate } = fresh.settings
          if (autoSee && autoAnimate) void seeThenAnimate(targetId)
          else if (autoSee) void see(targetId)
          else if (autoAnimate) void animate(targetId)
          if (autoNarrate) void narrate(targetId)
        }
      }
      setStreaming(null)
    }
  }

  const append = useCallback(
    async (a: StoryAction) => {
      if (!advId) return
      await db.update('adventures', advId, (cur) => ({ ...cur, actions: [...cur.actions, a], redo: [], updatedAt: Date.now(), lastPlayedAt: Date.now() }))
    },
    [advId]
  )

  const submit = useCallback(
    async (mode: TurnMode, raw: string) => {
      if (!advId || running.current) return
      const text = raw.trim()
      if (mode === 'see') {
        const a = makeAction('see', text)
        await append(a)
        await see(a.id, text || undefined)
        return
      }
      if (!text) {
        await generate()
        return
      }
      let type = mode as ActionType
      let body = text
      // Input hook: scripts may rewrite the action, or stop the turn.
      running.current = true
      setScripting(true)
      try {
        await flush()
        const res = await runInputScripts(advId, type, body)
        if (res?.stop) {
          if (!res.messaged) toast.info('A script stopped this turn')
          return
        }
        if (res) {
          type = res.type
          body = res.text
        }
      } finally {
        running.current = false
        if (mounted.current) setScripting(false)
      }
      if (body.trim()) await append(makeAction(type, body))
      setFreshId(undefined)
      await generate()
    },
    [advId, append, generate, see, flush]
  )

  const continueStory = useCallback(async () => {
    setFreshId(undefined)
    await generate()
  }, [generate])

  const retry = useCallback(async () => {
    if (!advId) return
    const adv = latest(advId)
    const last = adv?.actions[adv.actions.length - 1]
    if (!last) return
    if (isAiAction(last) && last.type !== 'start') await generate(last.id)
    else await generate()
  }, [advId, generate])

  const stop = useCallback(() => {
    if (!handle.current) return
    stopped.current = true
    handle.current.abort()
  }, [])

  const erase = useCallback(async () => {
    if (!advId) return
    stop()
    await db.update('adventures', advId, (cur) => ({ ...cur, actions: cur.actions.slice(0, -1), updatedAt: Date.now() }))
  }, [advId, stop])

  const undo = useCallback(async () => {
    if (!advId || handle.current) return
    await db.update('adventures', advId, (cur) => {
      const last = cur.actions[cur.actions.length - 1]
      if (!last || (last.type === 'start' && cur.actions.length === 1)) return cur
      return { ...cur, actions: cur.actions.slice(0, -1), redo: [...cur.redo, last], updatedAt: Date.now() }
    })
  }, [advId])

  const redo = useCallback(async () => {
    if (!advId || handle.current) return
    await db.update('adventures', advId, (cur) => {
      const next = cur.redo[cur.redo.length - 1]
      if (!next) return cur
      return { ...cur, actions: [...cur.actions, next], redo: cur.redo.slice(0, -1), updatedAt: Date.now() }
    })
  }, [advId])

  const edit = useCallback(
    async (id: string, text: string) => {
      if (!advId) return
      await db.update('adventures', advId, (cur) => ({ ...cur, actions: cur.actions.map((a) => (a.id === id ? { ...a, text } : a)), updatedAt: Date.now() }))
    },
    [advId]
  )

  const remove = useCallback(
    async (id: string) => {
      if (!advId) return
      await db.update('adventures', advId, (cur) => ({ ...cur, actions: cur.actions.filter((a) => a.id !== id), updatedAt: Date.now() }))
    },
    [advId]
  )

  const cycle = useCallback(
    async (id: string, dir: -1 | 1) => {
      if (!advId) return
      await db.update('adventures', advId, (cur) => ({
        ...cur,
        actions: cur.actions.map((a) => {
          if (a.id !== id || !a.alternates?.length) return a
          const i = a.alternates.indexOf(a.text)
          const n = a.alternates.length
          const next = a.alternates[(((i < 0 ? n - 1 : i) + dir) % n + n) % n]
          return { ...a, text: next }
        })
      }))
    },
    [advId]
  )

  /** Character creator / empty openings: let the AI write the first scene. */
  const generateOpening = useCallback(async () => {
    await generate()
  }, [generate])

  return {
    streaming,
    busy: !!streaming || scripting,
    freshId,
    lastCtx,
    pending,
    thoughts,
    autoplay,
    submit,
    continueStory,
    retry,
    erase,
    undo,
    redo,
    stop,
    edit,
    remove,
    cycle,
    see,
    animate,
    narrate,
    generateOpening
  }
}
