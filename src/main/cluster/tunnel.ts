// TCP over an authenticated WebSocket. ComfyUI and llama.cpp's rpc-server listen on 127.0.0.1 on
// the node and are never exposed to the LAN: the main opens a local listener per service
// (127.0.0.1:<random>), and each connection to it becomes one WebSocket to the node's
// /api/node/tcp endpoint (token-checked before the upgrade), which the node splices onto its local
// service. One WebSocket per TCP connection keeps backpressure end to end and never blocks one
// stream behind another.
import { createServer, type Server, type Socket } from 'node:net'
import WebSocket, { createWebSocketStream } from 'ws'

/** Pipe a TCP socket and a WebSocket both ways; closing either closes both. */
export function splice(sock: Socket, ws: WebSocket): void {
  sock.setNoDelay(true)
  const stream = createWebSocketStream(ws)
  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    sock.destroy()
    stream.destroy()
  }
  sock.pipe(stream).pipe(sock)
  sock.on('error', close)
  sock.on('close', close)
  stream.on('error', close)
  stream.on('close', close)
}

export interface TunnelTarget {
  url: string
  headers: Record<string, string>
}

/** A local listener whose connections are relayed to one service on a node. */
export class TcpTunnel {
  private server: Server | null = null
  private sockets = new Set<Socket>()
  port = 0

  constructor(
    private readonly target: () => TunnelTarget | null,
    private readonly label: string
  ) {}

  async listen(): Promise<number> {
    if (this.server) return this.port
    const server = createServer((sock) => this.onConnection(sock))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    this.server = server
    this.port = (server.address() as { port: number }).port
    return this.port
  }

  private onConnection(sock: Socket): void {
    const t = this.target()
    if (!t) {
      sock.destroy()
      return
    }
    this.sockets.add(sock)
    sock.on('close', () => this.sockets.delete(sock))
    const ws = new WebSocket(t.url, { headers: t.headers, perMessageDeflate: false, handshakeTimeout: 8000, maxPayload: 256 * 1024 * 1024 })
    ws.on('unexpected-response', (_req, res) => {
      console.warn(`[cluster] ${this.label} tunnel refused (${res.statusCode})`)
      ws.terminate()
      sock.destroy()
    })
    splice(sock, ws)
  }

  /** Drop live connections (e.g. the node went away) but keep listening. */
  reset(): void {
    for (const s of this.sockets) s.destroy()
    this.sockets.clear()
  }

  close(): void {
    this.reset()
    this.server?.close()
    this.server = null
  }
}
