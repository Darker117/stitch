// JSON over the phone WebSocket, with binary values (Uint8Array/Buffer) carried as base64.

const BYTES = '$b64'

export function encode(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === 'object') {
      if (v instanceof Uint8Array) return { [BYTES]: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64') }
      // Buffer.toJSON runs before the replacer sees the value.
      if ((v as { type?: string }).type === 'Buffer' && Array.isArray((v as { data?: unknown }).data)) {
        return { [BYTES]: Buffer.from((v as { data: number[] }).data).toString('base64') }
      }
    }
    return v
  })
}

export function decode<T = unknown>(text: string): T {
  return JSON.parse(text, (_key, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof v[BYTES] === 'string' && Object.keys(v).length === 1) {
      const buf = Buffer.from(v[BYTES] as string, 'base64')
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
    }
    return v
  }) as T
}
