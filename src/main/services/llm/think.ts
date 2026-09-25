// Separates model "thinking" from the visible reply in a token stream.
// Handles <think>…</think> (and <thinking>), tags split across chunks, and
// templates that open the think block in the prompt so the output only
// contains the closing tag.

const OPEN = ['<think>', '<thinking>']
const CLOSE = ['</think>', '</thinking>']
const MAX_TAG = 11

export interface ThinkSink {
  text: (delta: string) => void
  reasoning: (delta: string) => void
  /** Earlier "text" turned out to be reasoning: replace both wholesale. */
  reset: (content: string, reasoning: string) => void
}

export class ThinkSplitter {
  content = ''
  reasoning = ''
  private pending = ''
  private mode: 'start' | 'content' | 'think' = 'start'
  private sawOpen = false
  /** Swallow whitespace right after a think block closes. */
  private stripLead = false

  constructor(private sink: ThinkSink) {}

  push(chunk: string): void {
    this.pending += chunk
    this.drain(false)
  }

  end(): void {
    this.drain(true)
    // An unterminated think block with nothing after it: show nothing as the
    // reply, keep it all as reasoning.
  }

  private emitText(t: string): void {
    if (!t) return
    this.content += t
    this.sink.text(t)
  }

  private emitReasoning(t: string): void {
    if (!t) return
    this.reasoning += t
    this.sink.reasoning(t)
  }

  private find(list: string[], from = 0): { index: number; tag: string } | null {
    let best: { index: number; tag: string } | null = null
    for (const tag of list) {
      const i = this.pending.toLowerCase().indexOf(tag, from)
      if (i >= 0 && (!best || i < best.index)) best = { index: i, tag }
    }
    return best
  }

  /** Length of a trailing fragment that might be the start of a tag. */
  private heldTail(final: boolean): number {
    if (final) return 0
    const lower = this.pending.toLowerCase()
    for (let n = Math.min(MAX_TAG, lower.length); n > 0; n--) {
      const tail = lower.slice(-n)
      if ([...OPEN, ...CLOSE].some((t) => t.startsWith(tail))) return n
    }
    return 0
  }

  private drain(final: boolean): void {
    for (;;) {
      if (this.mode === 'start') {
        const trimmed = this.pending.replace(/^\s+/, '')
        if (!trimmed && !final) return
        const open = OPEN.find((t) => trimmed.toLowerCase().startsWith(t))
        if (open) {
          this.pending = trimmed.slice(open.length)
          this.mode = 'think'
          this.sawOpen = true
          continue
        }
        if (!final && OPEN.some((t) => t.startsWith(trimmed.toLowerCase()))) return
        this.pending = trimmed
        this.mode = 'content'
        continue
      }
      if (this.mode === 'think') {
        const close = this.find(CLOSE)
        if (close) {
          this.emitReasoning(this.pending.slice(0, close.index))
          this.pending = this.pending.slice(close.index + close.tag.length)
          this.mode = 'content'
          this.stripLead = true
          continue
        }
        const hold = this.heldTail(final)
        this.emitReasoning(this.pending.slice(0, this.pending.length - hold))
        this.pending = this.pending.slice(this.pending.length - hold)
        return
      }
      // content
      if (this.stripLead) {
        this.pending = this.pending.replace(/^\s+/, '')
        if (!this.pending && !final) return
        this.stripLead = false
      }
      const close = !this.sawOpen ? this.find(CLOSE) : null
      const open = this.find(OPEN)
      if (close && (!open || close.index < open.index)) {
        // Template opened the think block for us: everything so far was thinking.
        const before = this.pending.slice(0, close.index)
        this.reasoning = this.content + before
        this.content = ''
        this.sawOpen = true
        this.pending = this.pending.slice(close.index + close.tag.length)
        this.stripLead = true
        this.sink.reset('', this.reasoning)
        continue
      }
      if (open) {
        this.emitText(this.pending.slice(0, open.index))
        this.pending = this.pending.slice(open.index + open.tag.length)
        this.mode = 'think'
        this.sawOpen = true
        continue
      }
      const hold = this.heldTail(final)
      this.emitText(this.pending.slice(0, this.pending.length - hold))
      this.pending = this.pending.slice(this.pending.length - hold)
      return
    }
  }
}
