import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { nanoid } from 'nanoid'

export type ApiGraph = Record<string, { class_type: string; inputs: Record<string, unknown>; _meta?: { title?: string } }>

export interface OutputFile {
  filename: string
  subfolder: string
  type: string
}

export interface ComfyMessage {
  type: string
  data: Record<string, unknown>
}

/**
 * Thin ComfyUI HTTP + websocket client. Emits:
 *  'message' (ComfyMessage) for every JSON websocket frame
 *  'preview' (promptId|null, dataUrl) for binary latent previews
 *  'open' / 'close'
 */
export class ComfyClient extends EventEmitter {
  readonly clientId: string
  private ws: WebSocket | null = null
  private retry: NodeJS.Timeout | null = null
  private closed = false
  /** prompt currently executing on this server, for routing previews. */
  executing: string | null = null
  connected = false

  /** A stable clientId lets a restarted Stitch keep receiving events for prompts it queued earlier. */
  constructor(
    public url: string,
    clientId?: string
  ) {
    super()
    this.clientId = clientId ?? `stitch-${nanoid(8)}`
    this.setMaxListeners(100)
  }

  private get base(): string {
    return this.url.replace(/\/+$/, '')
  }

  connect(): void {
    this.closed = false
    if (this.ws) return
    const wsUrl = `${this.base.replace(/^http/, 'ws')}/ws?clientId=${this.clientId}`
    let ws: WebSocket
    try {
      ws = new WebSocket(wsUrl)
    } catch {
      this.scheduleReconnect()
      return
    }
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    ws.onopen = () => {
      this.connected = true
      this.emit('open')
    }
    ws.onclose = () => {
      this.ws = null
      if (this.connected) this.emit('close')
      this.connected = false
      this.scheduleReconnect()
    }
    ws.onerror = () => {
      /* onclose follows */
    }
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        try {
          const msg = JSON.parse(ev.data) as ComfyMessage
          if (msg.type === 'executing') {
            const d = msg.data as { node: string | null; prompt_id?: string }
            this.executing = d.node === null ? null : (d.prompt_id ?? this.executing)
          }
          this.emit('message', msg)
        } catch {
          /* ignore */
        }
      } else {
        const buf = Buffer.from(ev.data as ArrayBuffer)
        const eventType = buf.readUInt32BE(0)
        if (eventType === 1) {
          // PREVIEW_IMAGE: [type:4][format:4][bytes]
          const format = buf.readUInt32BE(4)
          const mime = format === 2 ? 'image/png' : 'image/jpeg'
          this.emit('preview', this.executing, `data:${mime};base64,${buf.subarray(8).toString('base64')}`)
        } else if (eventType === 4) {
          // PREVIEW_IMAGE_WITH_METADATA: [type:4][metaLen:4][meta json][bytes]
          const metaLen = buf.readUInt32BE(4)
          try {
            const meta = JSON.parse(buf.subarray(8, 8 + metaLen).toString('utf8')) as { prompt_id?: string; image_type?: string }
            const bytes = buf.subarray(8 + metaLen)
            this.emit('preview', meta.prompt_id ?? this.executing, `data:${meta.image_type ?? 'image/jpeg'};base64,${bytes.toString('base64')}`)
          } catch {
            /* ignore */
          }
        }
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.retry) return
    this.retry = setTimeout(() => {
      this.retry = null
      this.connect()
    }, 3000)
  }

  close(): void {
    this.closed = true
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    this.ws?.close()
    this.ws = null
  }

  private async json<T>(path: string, init?: RequestInit, timeoutMs = 8000): Promise<T> {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = await fetch(`${this.base}${path}`, { ...init, signal: ctrl.signal })
      if (!res.ok) {
        const body = await res.text()
        throw new Error(formatComfyError(res.status, body))
      }
      return (await res.json()) as T
    } finally {
      clearTimeout(t)
    }
  }

  systemStats(): Promise<{
    system: { comfyui_version?: string }
    devices: { name: string; vram_total: number; vram_free: number }[]
  }> {
    return this.json('/system_stats', undefined, 3000)
  }

  queue(): Promise<{ queue_running: unknown[]; queue_pending: unknown[] }> {
    return this.json('/queue', undefined, 3000)
  }

  objectInfo(node?: string): Promise<Record<string, unknown>> {
    return this.json(node ? `/object_info/${encodeURIComponent(node)}` : '/object_info', undefined, 30000)
  }

  async models(folder: string): Promise<string[]> {
    return this.json<string[]>(`/models/${encodeURIComponent(folder)}`)
  }

  async queuePrompt(prompt: ApiGraph): Promise<string> {
    const res = await this.json<{ prompt_id: string; node_errors?: Record<string, unknown> }>(
      '/prompt',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt, client_id: this.clientId }) },
      30000
    )
    return res.prompt_id
  }

  async interrupt(promptId?: string): Promise<void> {
    await fetch(`${this.base}/interrupt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(promptId ? { prompt_id: promptId } : {})
    }).catch(() => {})
  }

  async deleteQueued(promptId: string): Promise<void> {
    await fetch(`${this.base}/queue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delete: [promptId] })
    }).catch(() => {})
  }

  history(promptId: string): Promise<Record<string, { outputs: Record<string, Record<string, unknown>>; status?: { status_str?: string; completed?: boolean; messages?: unknown[] } }>> {
    return this.json(`/history/${encodeURIComponent(promptId)}`)
  }

  /** Upload a local file into ComfyUI's input folder; returns the name to reference. */
  async upload(localPath: string, subfolder = 'stitch'): Promise<string> {
    const form = new FormData()
    const bytes = readFileSync(localPath)
    form.append('image', new Blob([bytes]), basename(localPath))
    form.append('subfolder', subfolder)
    form.append('overwrite', 'true')
    const res = await fetch(`${this.base}/upload/image`, { method: 'POST', body: form })
    if (!res.ok) throw new Error(formatComfyError(res.status, await res.text()))
    const j = (await res.json()) as { name: string; subfolder?: string }
    return j.subfolder ? `${j.subfolder}/${j.name}` : j.name
  }

  async download(file: OutputFile): Promise<Buffer> {
    const q = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder, type: file.type })
    const res = await fetch(`${this.base}/view?${q}`)
    if (!res.ok) throw new Error(`Could not download ${file.filename} (${res.status})`)
    return Buffer.from(await res.arrayBuffer())
  }
}

/** Turn ComfyUI's validation error payloads into one readable line. */
export function formatComfyError(status: number, body: string): string {
  try {
    const j = JSON.parse(body) as {
      error?: { message?: string; details?: string }
      node_errors?: Record<string, { class_type?: string; errors?: { message?: string; details?: string }[] }>
    }
    const parts: string[] = []
    if (j.error?.message) parts.push(j.error.message + (j.error.details ? `: ${j.error.details}` : ''))
    for (const ne of Object.values(j.node_errors ?? {})) {
      for (const e of ne.errors ?? []) parts.push(`${ne.class_type ?? 'node'} — ${e.message}${e.details ? ` (${e.details})` : ''}`)
    }
    if (parts.length) return parts.join('; ').slice(0, 800)
  } catch {
    /* not json */
  }
  return `ComfyUI error ${status}: ${body.slice(0, 300)}`
}
