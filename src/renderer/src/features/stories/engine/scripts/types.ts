// Shapes of the AI Dungeon scripting API as scripts see it, plus the
// messages exchanged with the sandbox worker. Plain data only — everything
// here crosses a structured-clone boundary.

export type HookName = 'input' | 'context' | 'output'
export const HOOKS: HookName[] = ['input', 'context', 'output']

/** A story card as AID scripts see it (`storyCards[i]`). */
export interface AidCard {
  id: string
  title: string
  /** Comma-separated trigger keys. */
  keys: string
  entry: string
  /** Free-form type label: character, class, race, location, faction, custom, or anything else. */
  type: string
  /** The card's notes. */
  description: string
  createdAt: string
  updatedAt: string
  useForCharacterCreation: boolean
}

/** One entry of AID's `history` array. */
export interface AidHistoryEntry {
  text: string
  /** Deprecated alias of `text`, still read by older scripts. */
  rawText: string
  type: string
}

export interface AidInfo {
  actionCount: number
  characters: string[]
  characterNames: string[]
  /** Only defined in the context hook (scripts use that to detect it). */
  maxChars?: number
  memoryLength?: number
  contextTokens?: number
}

/** Everything one hook run needs. `state` is shared by every script of the adventure. */
export interface AidEnv {
  text: string
  state: Record<string, unknown>
  info: AidInfo
  history: AidHistoryEntry[]
  storyCards: AidCard[]
  /** The user's own memory (AID's legacy `memory` global): plot essentials and author's note. */
  memory: { context: string; authorsNote: string }
}

export type LogLevel = 'log' | 'info' | 'warn' | 'error'

export interface SandboxLog {
  level: LogLevel
  message: string
}

export interface SandboxRequest {
  type: 'run'
  /** Library + hook code, evaluated as one sloppy-mode script. */
  code: string
  env: AidEnv
  /** Compile only (syntax check), without running. */
  compileOnly?: boolean
}

export interface SandboxResponse {
  ok: boolean
  /** The `text` the hook returned (null when it returned null). */
  text: string | null
  stop: boolean
  /** Did the code's last expression produce a `{ text }` object (the `modifier(text)` pattern)? */
  returned: boolean
  state: Record<string, unknown>
  storyCards: AidCard[]
  logs: SandboxLog[]
  error?: string
  /** 1-based line of the error inside `code`, when known. */
  line?: number
  errorKind?: 'syntax' | 'runtime' | 'timeout' | 'crash' | 'state'
  ms: number
}

/** One line of the per-adventure script log. */
export interface ScriptLogEntry {
  id: string
  at: number
  scriptId?: string
  script: string
  hook: HookName | 'library'
  level: LogLevel
  message: string
}
