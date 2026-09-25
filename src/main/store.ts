import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CollectionMap, CollectionName, ID } from '@shared/types'
import { emit } from './ipc'

/**
 * Tiny JSON document store: one file per collection, held in memory and
 * flushed to disk (atomically) shortly after each change.
 */
class Collection<T extends { id: ID }> {
  private docs = new Map<ID, T>()
  private loaded = false
  private timer: NodeJS.Timeout | null = null

  constructor(
    readonly name: CollectionName,
    private readonly file: string
  ) {}

  private load(): void {
    if (this.loaded) return
    this.loaded = true
    if (!existsSync(this.file)) return
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Record<ID, T>
      for (const [id, doc] of Object.entries(raw)) this.docs.set(id, doc)
    } catch (err) {
      console.error(`[store] could not read ${this.file}, starting empty`, err)
      try {
        renameSync(this.file, `${this.file}.corrupt-${Date.now()}`)
      } catch {
        /* ignore */
      }
    }
  }

  private scheduleFlush(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, 250)
  }

  flush(): void {
    if (!this.loaded) return
    const obj: Record<ID, T> = {}
    for (const [id, doc] of this.docs) obj[id] = doc
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(obj))
    renameSync(tmp, this.file)
  }

  list(): T[] {
    this.load()
    return [...this.docs.values()]
  }

  get(id: ID): T | null {
    this.load()
    return this.docs.get(id) ?? null
  }

  put(doc: T, silent = false): T {
    this.load()
    this.docs.set(doc.id, doc)
    this.scheduleFlush()
    if (!silent) emit('db:changed', { collection: this.name, id: doc.id, op: 'put', doc })
    return doc
  }

  patch(id: ID, patch: Partial<T>): T {
    const cur = this.get(id)
    if (!cur) throw new Error(`${this.name}/${id} not found`)
    return this.put({ ...cur, ...patch, id })
  }

  delete(id: ID): void {
    this.load()
    if (!this.docs.delete(id)) return
    this.scheduleFlush()
    emit('db:changed', { collection: this.name, id, op: 'delete' })
  }
}

const collections = new Map<CollectionName, Collection<{ id: ID }>>()

export function dataDir(): string {
  const dir = join(app.getPath('userData'), 'data')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function db<N extends CollectionName>(name: N): Collection<CollectionMap[N]> {
  let col = collections.get(name)
  if (!col) {
    col = new Collection(name, join(dataDir(), `${name}.json`))
    collections.set(name, col)
  }
  return col as unknown as Collection<CollectionMap[N]>
}

export function flushAll(): void {
  for (const col of collections.values()) {
    try {
      col.flush()
    } catch (err) {
      console.error('[store] flush failed', err)
    }
  }
}
