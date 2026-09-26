// Every `window.stitch.invoke` goes through here: most calls go to the PC, some are answered on the
// phone (file pickers, on-device models), and some PC results get phone additions merged in.
import { link } from './connection'

export const PASS: unique symbol = Symbol('pass')
type Local = (args: unknown[]) => unknown | typeof PASS | Promise<unknown | typeof PASS>
type Merge = (result: unknown, args: unknown[]) => unknown | Promise<unknown>

const locals = new Map<string, Local[]>()
const merges = new Map<string, Merge[]>()

/** Answer a channel on the phone. Return PASS to let the PC handle this particular call. */
export function override(channel: string, fn: Local): void {
  const list = locals.get(channel) ?? []
  list.push(fn)
  locals.set(channel, list)
}

/** Post-process a PC result on the phone (e.g. add on-device models to a list). */
export function merge(channel: string, fn: Merge): void {
  const list = merges.get(channel) ?? []
  list.push(fn)
  merges.set(channel, list)
}

export async function route(channel: string, args: unknown[]): Promise<unknown> {
  for (const fn of locals.get(channel) ?? []) {
    const r = await fn(args)
    if (r !== PASS) return r
  }
  let result = await link.call(channel, args)
  for (const fn of merges.get(channel) ?? []) result = await fn(result, args)
  return result
}

/** Emit an event produced on the phone to the app, exactly like one from the PC. */
export function emitLocal(event: string, payload: unknown): void {
  link.dispatch(event, payload)
}
