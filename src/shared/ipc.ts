// Typed IPC contract between the renderer and the main process.
// `IpcInvoke` maps channel → [args tuple, result]; `IpcEvents` maps event → payload.

import type {
  AppSettings,
  Asset,
  AssetKind,
  BackgroundSettings,
  CharacterVoice,
  CivitaiModel,
  CivitaiQuery,
  CollectionMap,
  CollectionName,
  Connector,
  DbChange,
  DownloadState,
  GenJob,
  GenRequest,
  ID,
  LlmModelInfo,
  LocalModel,
  ModelMeta,
  RecipeInfo,
  SkillDoc,
  UpdateState,
  WallpaperItem
} from './types'

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] }

// ─── LLM ─────────────────────────────────────────────────────────────────────

export interface LlmToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  toolCalls?: LlmToolCall[]
  toolCallId?: string
  /** Absolute image paths attached to a user message (vision models). */
  images?: string[]
}

export interface LlmTool {
  name: string
  description: string
  /** JSON schema for the arguments object. */
  parameters: Record<string, unknown>
}

export interface LlmRequest {
  connectorId: ID
  model: string
  system?: string
  messages: LlmMessage[]
  maxTokens?: number
  temperature?: number
  topP?: number
  topK?: number
  stop?: string[]
  tools?: LlmTool[]
  /** Context window to request from local servers (Ollama num_ctx). */
  contextLength?: number
  /** Ask the model for a JSON object back. */
  json?: boolean
}

export type LlmEvent =
  | { requestId: string; type: 'delta'; text: string }
  /** Model "thinking" (native reasoning fields or <think> blocks) — never part of the reply. */
  | { requestId: string; type: 'reasoning'; text: string }
  /** Text streamed so far was actually reasoning; replace both buffers. */
  | { requestId: string; type: 'reset'; text: string; reasoning: string }
  | { requestId: string; type: 'done'; text: string; reasoning?: string; toolCalls?: LlmToolCall[]; stopReason?: string }
  | { requestId: string; type: 'error'; message: string }

export interface LlmResult {
  /** The visible reply, with any thinking removed. */
  text: string
  /** The model's thinking, if it produced any. */
  reasoning?: string
  toolCalls?: LlmToolCall[]
  stopReason?: string
}

// ─── ComfyUI ─────────────────────────────────────────────────────────────────

export interface ComfyStatus {
  connectorId: ID
  name: string
  url: string
  online: boolean
  /** Stitch launched and owns the process. */
  managed: boolean
  processState: 'stopped' | 'starting' | 'running' | 'crashed' | 'external'
  gpu?: string
  vramTotal?: number
  vramFree?: number
  queueRemaining: number
  version?: string
  error?: string
}

export interface DetectResult {
  stabilityMatrix?: { dataDir: string; comfyDir?: string; modelsDir: string }
  wallpaperEngine?: { workshopDir: string; count: number }
  ffmpeg?: string
  gpus: { index: number; name: string; memoryMB: number }[]
}

// ─── Voice ───────────────────────────────────────────────────────────────────

export interface VoiceInfo {
  id: string
  name: string
  description?: string
  previewUrl?: string
  labels?: Record<string, string>
  cloned?: boolean
}

export interface SpeakRequest {
  connectorId?: ID
  text: string
  voice: CharacterVoice
  /** Delivery direction, e.g. "whispering, afraid". */
  instructions?: string
  name?: string
  origin?: Asset['origin']
  projectId?: ID
  characterIds?: ID[]
  /** Override the connector's model (e.g. eleven_v3, gpt-4o-mini-tts, qwen3-tts-0.6b). */
  model?: string
  /** Short audition clip: tagged 'voice-preview' and reused when the same voice + text is previewed again. */
  preview?: boolean
}

export interface VoiceEngineStatus {
  installed: boolean
  running: boolean
  busy: 'idle' | 'installing' | 'starting' | 'loading-model' | 'generating'
  device?: string
  port: number
  log: string[]
  error?: string
  models: { id: string; label: string; downloaded: boolean }[]
  /** What the engine is doing right now (install step, model download/load), for progress UI. */
  activity?: { label: string; step?: number; steps?: number; progress?: number; model?: string }
}

// ─── Editor ──────────────────────────────────────────────────────────────────

export interface MediaProbe {
  duration?: number
  width?: number
  height?: number
  hasAudio: boolean
  hasVideo: boolean
  fps?: number
}

export interface ExportProgress {
  exportId: string
  timelineId: ID
  progress: number
  done: boolean
  error?: string
  path?: string
  /** Library asset registered for the finished export. */
  assetId?: ID
  canceled?: boolean
}

// ─── Contract ────────────────────────────────────────────────────────────────

export interface FileFilter {
  name: string
  extensions: string[]
}

export interface IpcInvoke {
  // settings
  'settings:get': [[], AppSettings]
  'settings:update': [[patch: DeepPartial<AppSettings>], AppSettings]

  // generic document store
  'db:list': [[collection: CollectionName], unknown[]]
  'db:get': [[collection: CollectionName, id: ID], unknown | null]
  'db:put': [[collection: CollectionName, doc: unknown], unknown]
  'db:patch': [[collection: CollectionName, id: ID, patch: Record<string, unknown>], unknown]
  'db:delete': [[collection: CollectionName, id: ID], void]

  // system
  'sys:pickFiles': [[opts: { filters?: FileFilter[]; multi?: boolean; title?: string }], string[]]
  'sys:pickFolder': [[opts?: { title?: string; defaultPath?: string }], string | null]
  'sys:saveDialog': [[opts: { defaultPath?: string; filters?: FileFilter[] }], string | null]
  'sys:openPath': [[path: string], void]
  'sys:showInFolder': [[path: string], void]
  'sys:openExternal': [[url: string], void]
  'sys:detect': [[], DetectResult]
  'sys:readText': [[path: string], string]
  'sys:writeText': [[path: string, content: string], void]

  // assets
  'assets:import': [[paths: string[], meta?: Partial<Asset>], Asset[]]
  'assets:saveBytes': [[bytes: Uint8Array, kind: AssetKind, ext: string, meta?: Partial<Asset>], Asset]
  'assets:delete': [[id: ID, deleteFile: boolean], void]
  'assets:probe': [[path: string], MediaProbe]
  'assets:copyTo': [[id: ID, dest: string], void]

  // connectors
  'connectors:save': [[connector: Connector, apiKey?: string | null], Connector]
  'connectors:delete': [[id: ID], void]
  'connectors:test': [[id: ID], { ok: boolean; message: string }]

  // llm
  'llm:models': [[connectorId: ID, refresh?: boolean], LlmModelInfo[]]
  'llm:stream': [[req: LlmRequest, requestId: string], void]
  'llm:complete': [[req: LlmRequest], LlmResult]
  'llm:abort': [[requestId: string], void]

  // comfy
  'comfy:status': [[], ComfyStatus[]]
  'comfy:launch': [[connectorId: ID], void]
  'comfy:stop': [[connectorId: ID], void]
  'comfy:logs': [[connectorId: ID], string[]]
  'comfy:models': [[folder: string], string[]]
  /** Rebuild Stitch-managed ComfyUI instances from settings.gpu and (re)launch them. */
  'gpu:apply': [[], void]
  'gpu:list': [[], DetectResult['gpus']]

  // app updates (GitHub Releases via electron-updater)
  'update:get': [[], UpdateState]
  /** Check GitHub now. Resolves with the state once the check finishes. */
  'update:check': [[], UpdateState]
  /** Start downloading a found update (only needed when auto-download is off). */
  'update:download': [[], void]
  /** Quit, install the downloaded update silently and relaunch. */
  'update:install': [[], void]
  /** "Later": install on the next quit instead of now. */
  'update:defer': [[], void]

  // generation
  'gen:recipes': [[], RecipeInfo[]]
  'gen:submit': [[req: GenRequest], GenJob[]]
  'gen:cancel': [[jobId: ID], void]
  'gen:jobs': [[], GenJob[]]
  'gen:clearFinished': [[], void]
  'gen:wait': [[jobId: ID], GenJob]

  // skills
  'skills:analyze': [[workflowJson: string, name?: string], SkillDoc]

  // voice
  'voice:voices': [[connectorId: ID], VoiceInfo[]]
  'voice:speak': [[req: SpeakRequest], Asset]
  'voice:clone': [[req: { connectorId: ID; name: string; sampleAssetId: ID; sampleText?: string }], { voiceId: string }]
  'voice:design': [[req: { description: string; text: string; language?: string; name?: string; characterIds?: ID[] }], Asset]
  'voice:engineStatus': [[], VoiceEngineStatus]
  'voice:engineInstall': [[], void]
  'voice:engineStart': [[], void]
  'voice:engineStop': [[], void]
  /** Download a local model's weights (e.g. 'base-1.7b') without loading it. */
  'voice:engineDownload': [[modelId: string], void]

  // wallpaper engine
  'wallpaper:list': [[], WallpaperItem[]]
  'wallpaper:apply': [[id: string], { background: BackgroundSettings; schemeColor?: string }]
  'wallpaper:pickCustom': [[], { background: BackgroundSettings } | null]

  // editor
  // model library & civitai
  'models:local': [[refresh?: boolean], LocalModel[]]
  /** Hash a local file and fetch its Civitai info; writes a Stability Matrix-style sidecar. */
  'models:identify': [[path: string], ModelMeta | null]
  'models:delete': [[path: string], void]
  'civitai:status': [[], { hasKey: boolean; username?: string }]
  'civitai:setKey': [[key: string | null], { ok: boolean; message: string }]
  'civitai:search': [[q: CivitaiQuery], { items: CivitaiModel[]; nextCursor?: string }]
  'civitai:model': [[id: number], CivitaiModel]
  'civitai:baseModels': [[], string[]]
  'civitai:download': [[req: { modelId: number; versionId: number; fileId?: number; folder?: string }], DownloadState]
  'civitai:cancelDownload': [[id: string], void]
  'civitai:downloads': [[], DownloadState[]]

  'editor:export': [[timelineId: ID, outPath: string], { exportId: string }]
  'editor:cancelExport': [[exportId: string], void]
  /** Short-GOP preview copy of a video asset for smooth scrubbing (null if ffmpeg is missing). */
  'editor:proxy': [[assetId: ID], string | null]
}

export interface IpcEvents {
  'settings:changed': AppSettings
  'db:changed': DbChange
  'llm:event': LlmEvent
  'comfy:status': ComfyStatus[]
  'gen:job': GenJob
  'voice:engine': VoiceEngineStatus
  'editor:export': ExportProgress
  'download:progress': DownloadState
  /** Local model files or their metadata changed (download finished, identified, deleted). */
  'models:changed': null
  'update:state': UpdateState
}

export type InvokeChannel = keyof IpcInvoke
export type InvokeArgs<C extends InvokeChannel> = IpcInvoke[C][0]
export type InvokeResult<C extends InvokeChannel> = IpcInvoke[C][1]
export type EventChannel = keyof IpcEvents

export type { CollectionMap }
