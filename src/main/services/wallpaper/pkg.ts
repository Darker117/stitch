// Wallpaper Engine scene packages (scene.pkg / gifscene.pkg): a small header
// with a file table, followed by the files back to back.
//
//   string  magic      "PKGV00xx" (u32 length-prefixed)
//   u32     count
//   count × { string name, u32 offset, u32 size }   offsets are relative to the data start
//   ...data
import { closeSync, openSync, readSync, statSync } from 'node:fs'

export interface PkgEntry {
  name: string
  offset: number
  size: number
}

export class Pkg {
  readonly version: string
  readonly entries = new Map<string, PkgEntry>()
  private readonly fd: number
  private readonly dataStart: number

  constructor(readonly path: string) {
    this.fd = openSync(path, 'r')
    try {
      const fileSize = statSync(path).size
      // The header is usually a few KB; read generously and grow if needed.
      let head = this.read(0, Math.min(fileSize, 1 << 16))
      let pos = 0
      const need = (n: number): void => {
        if (pos + n <= head.length) return
        if (head.length >= fileSize) throw new Error('Truncated scene package')
        head = this.read(0, Math.min(fileSize, head.length * 4 + n))
      }
      const u32 = (): number => {
        need(4)
        const v = head.readUInt32LE(pos)
        pos += 4
        return v
      }
      const str = (): string => {
        const n = u32()
        if (n > 4096) throw new Error('Not a scene package')
        need(n)
        const s = head.toString('utf8', pos, pos + n)
        pos += n
        return s
      }
      this.version = str()
      if (!this.version.startsWith('PKGV')) throw new Error('Not a scene package')
      const count = u32()
      if (count > 200_000) throw new Error('Corrupt scene package')
      for (let i = 0; i < count; i++) {
        const name = str().replace(/\\/g, '/')
        const offset = u32()
        const size = u32()
        this.entries.set(name, { name, offset, size })
      }
      this.dataStart = pos
      for (const e of this.entries.values()) {
        if (this.dataStart + e.offset + e.size > fileSize) throw new Error(`Scene package entry out of range: ${e.name}`)
      }
    } catch (err) {
      closeSync(this.fd)
      throw err
    }
  }

  private read(at: number, length: number): Buffer {
    const buf = Buffer.alloc(length)
    let got = 0
    while (got < length) {
      const n = readSync(this.fd, buf, got, length - got, at + got)
      if (n <= 0) break
      got += n
    }
    return got === length ? buf : buf.subarray(0, got)
  }

  has(name: string): boolean {
    return this.entries.has(name)
  }

  get(name: string): Buffer | null {
    const e = this.entries.get(name)
    return e ? this.read(this.dataStart + e.offset, e.size) : null
  }

  close(): void {
    try {
      closeSync(this.fd)
    } catch {
      /* already closed */
    }
  }
}
