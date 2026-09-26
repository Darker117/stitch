// Typed access to the main process.
import type { EventChannel, IpcEvents, InvokeArgs, InvokeChannel, InvokeResult, LlmEvent, LlmRequest, LlmResult } from '@shared/ipc'
import { nanoid } from 'nanoid'

export function invoke<C extends InvokeChannel>(channel: C, ...args: InvokeArgs<C>): Promise<InvokeResult<C>> {
  return window.stitch.invoke(channel, ...args) as Promise<InvokeResult<C>>
}

export function on<E extends EventChannel>(event: E, listener: (payload: IpcEvents[E]) => void): () => void {
  return window.stitch.on(event, listener as (p: unknown) => void)
}

/** Strip Electron's "Error invoking remote method 'x': Error: " prefix. */
export function errorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

function localUrl(path: string): string {
  const p = path.replace(/\\/g, '/')
  return `stitch://local/${encodeURI(p).replace(/#/g, '%23').replace(/\?/g, '%3F')}`
}

/** URL the renderer can load for a local file (images, video, audio). On the phone this is the PC's media server. */
export function fileUrl(path: string | undefined | null): string {
  if (!path) return ''
  return resolveUrl(localUrl(path))
}

/** A downscaled still for grids and cards (the phone fetches a JPEG thumbnail; desktop loads the file). */
export function thumbUrl(path: string | undefined | null, size = 480): string {
  if (!path) return ''
  const url = localUrl(path)
  return window.stitch.mediaUrl ? window.stitch.mediaUrl(url, { thumb: size }) : url
}

/** Rewrite a stitch:// URL for wherever this renderer runs (identity on desktop). */
export function resolveUrl(url: string): string {
  return window.stitch.mediaUrl ? window.stitch.mediaUrl(url) : url
}

export interface StreamHandle {
  requestId: string
  done: Promise<LlmResult>
  abort: () => void
}

/**
 * Stream a chat completion. `onText` receives the accumulated visible reply;
 * `onReasoning` receives the accumulated thinking (never part of the reply).
 */
export function streamLlm(req: LlmRequest, onText?: (full: string, delta: string) => void, onReasoning?: (full: string) => void): StreamHandle {
  const requestId = nanoid(10)
  let full = ''
  let thought = ''
  let off: () => void = () => {}
  const done = new Promise<LlmResult>((resolve, reject) => {
    off = on('llm:event', (ev: LlmEvent) => {
      if (ev.requestId !== requestId) return
      if (ev.type === 'delta') {
        full += ev.text
        onText?.(full, ev.text)
      } else if (ev.type === 'reasoning') {
        thought += ev.text
        onReasoning?.(thought)
      } else if (ev.type === 'reset') {
        full = ev.text
        thought = ev.reasoning
        onText?.(full, '')
        onReasoning?.(thought)
      } else if (ev.type === 'done') {
        off()
        resolve({ text: ev.text || full, reasoning: ev.reasoning ?? (thought || undefined), toolCalls: ev.toolCalls, stopReason: ev.stopReason })
      } else if (ev.type === 'error') {
        off()
        reject(new Error(ev.message))
      }
    })
    invoke('llm:stream', req, requestId).catch((err) => {
      off()
      reject(err)
    })
  })
  return {
    requestId,
    done,
    abort: () => {
      void invoke('llm:abort', requestId)
    }
  }
}

/** Parse a JSON object out of a model reply (tolerates code fences and prose). */
export function parseJsonLoose<T = Record<string, unknown>>(text: string): T | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const body = fenced ? fenced[1] : text
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(body.slice(start, end + 1)) as T
  } catch {
    return null
  }
}
