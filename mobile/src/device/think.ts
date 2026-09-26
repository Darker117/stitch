// Streaming splitter for <think>…</think> blocks, so on-device "thinking" never reaches reply text
// (mirrors what the PC does in services/llm/think.ts).

export interface ThinkSplitter {
  push: (chunk: string) => void
  end: () => void
  readonly text: string
  readonly reasoning: string
}

const OPEN = '<think>'
const CLOSE = '</think>'

export function thinkSplitter(onText: (delta: string) => void, onReasoning: (delta: string) => void): ThinkSplitter {
  let text = ''
  let reasoning = ''
  let inThink = false
  let pending = ''

  const emit = (s: string): void => {
    if (!s) return
    if (inThink) {
      reasoning += s
      onReasoning(s)
    } else {
      // Drop leading whitespace right after a think block.
      if (!text) s = s.replace(/^\s+/, '')
      if (!s) return
      text += s
      onText(s)
    }
  }

  const push = (chunk: string): void => {
    pending += chunk
    for (;;) {
      const tag = inThink ? CLOSE : OPEN
      const i = pending.indexOf(tag)
      if (i >= 0) {
        emit(pending.slice(0, i))
        pending = pending.slice(i + tag.length)
        inThink = !inThink
        continue
      }
      // Keep a possible partial tag at the end for the next chunk.
      let keep = 0
      for (let k = Math.min(tag.length - 1, pending.length); k > 0; k--) {
        if (tag.startsWith(pending.slice(-k))) {
          keep = k
          break
        }
      }
      emit(pending.slice(0, pending.length - keep))
      pending = pending.slice(pending.length - keep)
      return
    }
  }

  return {
    push,
    end: () => {
      emit(pending)
      pending = ''
    },
    get text() {
      return text
    },
    get reasoning() {
      return reasoning
    }
  }
}
