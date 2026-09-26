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
  VoiceKind,
  WallpaperItem
} from './types'
import type { SceneData, WorkshopDownload, WorkshopEnvironment, WorkshopItem, WorkshopPage, WorkshopQuery } from './wallpaper'

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
  /** Runs on a linked node PC (Settings → Computers). */
  node?: { id: ID; name: string; gpu: number }
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
  /** ElevenLabs voice library: public owner id, needed to add the voice to the account. */
  ownerId?: string
}

/** ElevenLabs voice library search (`voice:library`). */
export interface VoiceLibraryQuery {
  connectorId: ID
  search?: string
  gender?: string
  age?: string
  accent?: string
  language?: string
  useCase?: string
  category?: 'professional' | 'famous' | 'high_quality'
  sort?: 'trending' | 'usage_character_count_1y' | 'cloned_by_count' | 'created_date'
  page?: number
}

/**
 * Voice engines — the stable contract behind `voice:engines`, `voice:installEngine` and
 * `voice:removeEngine`, shared by Generate → Voice and the app-wide Model Manager.
 *
 * Local engines install on demand into Stitch's managed Python env (`<userData>/voice-engine`):
 * one shared runtime (Python 3.12 + PyTorch) plus each engine's own packages, with weights in
 * `<userData>/voice-engine/hf`. They all run inside the one local voice server, whose status and
 * install/download progress arrive through the `voice:engine` event (`installing`, `activity`,
 * `engines`). Cloud engines are "installed" when their connector has an API key.
 *
 * `voice:removeEngine` deletes only Stitch-managed files for that engine (its packages and
 * downloaded weights); removing the last local engine also removes the shared runtime. Ask the
 * user to confirm first. Cloud engines can't be installed/removed here (use Connectors).
 */
export type VoiceEngineId = 'qwen3' | 'kokoro' | 'pocket' | 'elevenlabs' | 'openai' | 'azure' | 'device'

export interface VoiceEngineInfo {
  id: VoiceEngineId
  name: string
  kind: 'local' | 'cloud'
  /** Local: packages present in the managed env. Cloud: a connector with an API key exists. */
  installed: boolean
  /** An install or removal of this engine is running right now. */
  installing?: boolean
  /** Local: bytes on disk for this engine (its packages + downloaded weights), excluding the shared runtime. */
  sizeBytes?: number
  /** Local: folder holding the engine's weights. */
  path?: string
  license?: string
  supportsCloning: boolean
  /** Built-in preset voices (cloud engines: fetch with `voice:voices`). */
  voices?: VoiceInfo[]
  // ── extras (optional, may grow) ──
  /** Connector kind that routes speech to this engine, and the connector itself when one exists. */
  connectorKind: VoiceKind
  connectorId?: ID
  /** Cloud engine without an API key yet. */
  needsKey?: boolean
  description?: string
  /** Where it runs: the voice GPU (CPU fallback), the CPU, or the cloud. */
  device?: 'gpu' | 'cpu' | 'cloud'
  /** Approximate download size of a fresh install (packages + default weights). */
  downloadBytes?: number
  /** Local weights and whether they are on disk. */
  weights?: { id: string; label: string; downloaded: boolean }[]
  /** Local: size of the shared runtime (Python + PyTorch), reported once for all local engines. */
  runtimeBytes?: number
  homepage?: string
  /** Pocket TTS: the gated voice-cloning weights are on disk (else cloning needs a Hugging Face token). */
  cloningReady?: boolean
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
  models: { id: string; label: string; downloaded: boolean; engine?: VoiceEngineId }[]
  /** What the engine is doing right now (install step, model download/load), for progress UI. */
  activity?: { label: string; step?: number; steps?: number; progress?: number; model?: string; engine?: VoiceEngineId; stepNames?: string[] }
  /** Local engine being installed or removed. */
  installing?: VoiceEngineId
  /** Every voice engine (same shape as `voice:engines`), refreshed with each status event. */
  engines?: VoiceEngineInfo[]
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

// ─── Phone remote ────────────────────────────────────────────────────────────

/** A phone paired with this PC (secrets never leave the main process). */
export interface RemoteDevice {
  id: ID
  name: string
  platform: string
  appVersion?: string
  createdAt: number
  lastSeenAt?: number
  lastAddress?: string
  /** Connected right now. */
  online: boolean
}

export interface RemoteHost {
  address: string
  /** 'LAN' | 'Tailscale' | 'Other' */
  label: string
}

export type AnywhereMode = 'off' | 'cloudflare' | 'tailscale' | 'custom'

/** Public address for the phone remote (Settings → Phone → Access from anywhere). */
export interface AnywhereStatus {
  mode: AnywhereMode
  state: 'off' | 'downloading' | 'starting' | 'ready' | 'error' | 'needs-action'
  /** The public HTTPS address once it's up. */
  url?: string
  error?: string
  /** 0–1 while downloading the tunnel tool. */
  progress?: number
  /** Something the user must do first (e.g. allow Tailscale Funnel), with a link. */
  actionUrl?: string
  actionLabel?: string
  tailscale?: { installed: boolean; running: boolean; dnsName?: string; funnel: boolean }
}

export interface RemoteStatus {
  enabled: boolean
  running: boolean
  port: number
  hosts: RemoteHost[]
  pcId: string
  pcName: string
  error?: string
  devices: RemoteDevice[]
  anywhere: AnywhereStatus
  /** Every address a phone may use, best first (LAN, Tailscale, public). */
  endpoints: string[]
}

export interface PairingInfo {
  /** 6-digit code for typing on the phone. */
  code: string
  expiresAt: number
  /** `stitch://pair?d=…` — what the QR code encodes. */
  url: string
  /** QR code as an SVG string (white modules, transparent background). */
  qrSvg: string
}

/** Folder listing for picking a PC folder from the phone. */
export interface RemoteDirListing {
  path: string | null
  parent: string | null
  entries: { name: string; path: string; dir: boolean }[]
}

// ─── Web search (bundled SearXNG) ────────────────────────────────────────────

export interface WebResult {
  title: string
  url: string
  /** Short excerpt from the search engine. */
  snippet: string
  engines?: string[]
  /** ISO date, when the engine knows it. */
  published?: string
  thumbnail?: string
}

export interface WebSearchRequest {
  query: string
  category?: 'general' | 'news' | 'science' | 'it' | 'images' | 'videos'
  timeRange?: 'day' | 'week' | 'month' | 'year'
  /** SearXNG language code, e.g. `en-US`; default `auto`. */
  language?: string
  page?: number
  /** Most results to return (default `settings.web.maxResults`). */
  limit?: number
  safeSearch?: 0 | 1 | 2
}

export interface WebSearchResult {
  query: string
  results: WebResult[]
  /** Direct answers (calculators, definitions…). */
  answers: string[]
  suggestions: string[]
  infobox?: { title: string; text: string; url?: string }
  /** Engines that failed or timed out. */
  unresponsive?: string[]
  tookMs: number
  /** Which SearXNG answered. */
  where: 'pc' | 'phone'
}

/** A web page reduced to readable text for a model. */
export interface WebPage {
  url: string
  title: string
  text: string
  truncated: boolean
  where: 'pc' | 'phone'
}

export type WebEngineState = 'missing' | 'stopped' | 'starting' | 'running' | 'error'
/** Phone app: where searches go. `auto` = the PC while connected, otherwise this phone. */
export type WebRoute = 'auto' | 'phone' | 'pc'

export interface WebStatus {
  where: 'pc' | 'phone'
  state: WebEngineState
  /** SearXNG version (commit date) that ships with this build. */
  version?: string
  error?: string
  /** Phone app only. */
  route?: WebRoute
}

// ─── Computers (multi-PC compute) ────────────────────────────────────────────
// One Stitch is the main (where you work); others offer their GPUs as nodes on the LAN.
// Nodes are found over UDP, linked with a 6-digit code shown on the node, and reached through
// the phone-remote server's authenticated /api/node/* endpoints (see src/main/cluster/).

export interface GpuLive {
  /** nvidia-smi index. */
  index: number
  name: string
  /** Bytes. */
  memTotal: number
  memUsed: number
  /** 0–100. */
  util?: number
  /** °C. */
  temp?: number
  computeCap?: string
  /** Node: a linked main may use it. */
  shared?: boolean
}

export interface PcHardware {
  gpus: GpuLive[]
  cpu: { model: string; cores: number }
  ram: { total: number; free: number }
  os: string
  /** Stitch version. */
  version: string
  /** A ComfyUI install was found. */
  comfy: boolean
  /** Installed llama.cpp build. */
  llama?: { tag: string; flavor: string }
  at: number
}

/** A service a node runs for its main (ComfyUI or llama.cpp rpc-server on one GPU). */
export interface NodeService {
  kind: 'comfy' | 'rpc'
  gpu: number
  state: 'stopped' | 'installing' | 'starting' | 'running' | 'crashed' | 'error'
  /** 0–1 while installing. */
  progress?: number
  error?: string
}

/** A Stitch PC announcing itself as a node on the LAN. */
export interface FoundPc {
  id: string
  name: string
  address: string
  port: number
  version?: string
  gpus: { name: string; memTotal: number }[]
  /** Already linked to this PC. */
  linked: boolean
}

export interface ModelCopy {
  id: string
  name: string
  folder: string
  sent: number
  total: number
  state: 'copying' | 'done' | 'error' | 'canceled'
  error?: string
}

/** A node linked to this main. */
export interface LinkedNode {
  id: string
  name: string
  address?: string
  port: number
  state: 'connecting' | 'online' | 'offline' | 'revoked'
  error?: string
  version?: string
  hardware?: PcHardware
  services: NodeService[]
  lastSeenAt?: number
  copies: ModelCopy[]
}

/** A main that linked this node. */
export interface LinkedMain {
  id: string
  name: string
  online: boolean
  createdAt: number
  lastSeenAt?: number
  lastAddress?: string
}

export interface ClusterStatus {
  role: 'main' | 'node'
  pcId: string
  name: string
  hardware?: PcHardware
  /** This PC as a node. */
  node: {
    listening: boolean
    port: number
    error?: string
    /** Link code shown while a main may link (10 minutes). */
    linkWindow?: { code: string; expiresAt: number; requestedBy?: string }
    mains: LinkedMain[]
    services: NodeService[]
  }
  /** Nodes found on the network (main). */
  found: FoundPc[]
  /** Linked nodes (main). */
  nodes: LinkedNode[]
}

/** A recipe a node can't run yet, and what it lacks (with the file on this PC when there is one). */
export interface NodeModelGap {
  recipeId: string
  recipeName: string
  kind: string
  missing: { folder: string; label: string; source?: { name: string; size: number } }[]
}

export interface GgufFile {
  path: string
  name: string
  size: number
  /** Folder label (LM Studio, Stitch, …). */
  where: string
}

export interface LlamaDevice {
  /** 'local:<gpu>' or '<nodeId>:<gpu>'. */
  key: string
  label: string
  /** PC name. */
  pc: string
  memTotal: number
  memFree: number
  online: boolean
}

export interface LlamaStatus {
  state: 'missing' | 'installing' | 'stopped' | 'starting' | 'running' | 'error'
  installed?: { tag: string; flavor: string }
  /** What is happening right now (download, a node getting ready, loading the model). */
  step?: { label: string; progress?: number }
  port?: number
  model?: string
  /** Devices holding layers in the running server, in llama.cpp order. */
  devices?: { key: string; label: string; split: number }[]
  connectorId?: string
  error?: string
  /** Speed of the last reply. */
  tokensPerSecond?: number
  promptPerSecond?: number
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
  /** Download a story script (or its JSON) from an http(s) URL. Size-capped. */
  'scripts:fetch': [[url: string], { url: string; text: string; contentType?: string }]

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
  /** Download a local model's weights (e.g. 'base-1.7b', 'kokoro-82m', 'pocket-english') without loading it. */
  'voice:engineDownload': [[modelId: string], void]
  /** All voice engines (local + cloud) — see `VoiceEngineInfo`. Stable: also used by the Model Manager. */
  'voice:engines': [[], VoiceEngineInfo[]]
  /** Install a local engine (and the shared runtime if needed); progress via the `voice:engine` event. */
  'voice:installEngine': [[id: VoiceEngineId], void]
  /** Remove a local engine's Stitch-managed files (packages + weights). Confirm with the user first. */
  'voice:removeEngine': [[id: VoiceEngineId], void]
  /** ElevenLabs voice library (shared voices). */
  'voice:library': [[q: VoiceLibraryQuery], { voices: VoiceInfo[]; hasMore: boolean; total?: number }]
  /** Add an ElevenLabs library voice to the account so it can be used for speech. */
  'voice:addLibraryVoice': [[req: { connectorId: ID; ownerId: string; voiceId: string; name: string }], { voiceId: string }]
  /** Synthesis models offered by a voice connector (ElevenLabs lists them live). */
  'voice:models': [[connectorId: ID], { value: string; label: string; hint?: string }[]]

  // wallpaper engine
  'wallpaper:list': [[], WallpaperItem[]]
  'wallpaper:apply': [[id: string], { background: BackgroundSettings; schemeColor?: string }]
  'wallpaper:pickCustom': [[], { background: BackgroundSettings } | null]
  /** A scene wallpaper compiled for the WebGL renderer (textures extracted to the cache). */
  'wallpaper:scene': [[id: string], SceneData]
  /** Steam Workshop browse/search (no key, no login). */
  'wallpaper:search': [[query: WorkshopQuery], WorkshopPage]
  'wallpaper:details': [[id: string], WorkshopItem | null]
  /** Open the item in the Steam client on the PC and watch for its download. */
  'wallpaper:subscribe': [[id: string], WorkshopDownload]
  'wallpaper:environment': [[], WorkshopEnvironment & { downloads: WorkshopDownload[] }]

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
  // curated model catalog (Hugging Face), installs and the model manager.
  // Downloads of every source share civitai:downloads / civitai:cancelDownload and the download:progress event.
  /** Default base folder for model downloads (settings → Stability Matrix → <userData>/models). */
  'models:home': [[], import('./types').ModelsHome]
  'models:catalog': [[], import('./types').CatalogEntry[]]
  /** What a recipe still needs, with sizes and sources. */
  'models:installPlan': [[recipeId: string, entryId?: string], import('./types').InstallPlan]
  /** Download a recipe's (or catalog entry's) missing files. */
  'models:install': [[req: import('./types').InstallRequest], DownloadState[]]
  'models:inventory': [[refresh?: boolean], import('./types').ModelInventory]
  /** Move a model file (with its sidecars) or a model folder to the Recycle Bin. */
  'models:trash': [[path: string], void]
  /** Forget a folder added through "Choose folder" (files stay on disk). */
  'models:forgetDir': [[path: string], void]
  /** extra_model_paths.yaml snippet that points a ComfyUI you run yourself at Stitch's model folders. */
  'models:comfyYaml': [[], string]
  'hf:status': [[], { hasToken: boolean; username?: string }]
  'hf:setToken': [[token: string | null], { ok: boolean; message: string }]

  'editor:export': [[timelineId: ID, outPath: string], { exportId: string }]
  'editor:cancelExport': [[exportId: string], void]
  /** Short-GOP preview copy of a video asset for smooth scrubbing (null if ffmpeg is missing). */
  'editor:proxy': [[assetId: ID], string | null]

  // phone remote (Settings → Phone). Pairing-management channels are not callable from phones.
  'remote:status': [[], RemoteStatus]
  'remote:setEnabled': [[enabled: boolean, port?: number], RemoteStatus]
  /** Start (or restart) a 10-minute pairing window; returns the code and QR. */
  'remote:pairStart': [[], PairingInfo]
  'remote:pairCancel': [[], void]
  'remote:revoke': [[deviceId: ID], void]
  /** Access from anywhere: off, a Cloudflare tunnel, Tailscale Funnel or your own address. */
  'remote:setAnywhere': [[mode: AnywhereMode, customUrl?: string], RemoteStatus]
  /** Phones: browse PC folders (no path = drives / home). */
  'remote:listDir': [[path?: string], RemoteDirListing]
  /** Phones: a PC path for saving an export (`<library>/exports/<name>`, made unique). */
  'remote:savePath': [[name: string], string]
  /** Phones: unpair the calling phone (answered by the remote server itself). */
  'remote:forgetMe': [[], void]

  // web search for text models (Skills → Web search): the SearXNG bundled with the app
  'web:status': [[], WebStatus]
  /** Start (or restart) the bundled SearXNG. Searches start it on demand too. */
  'web:start': [[], WebStatus]
  'web:stop': [[], WebStatus]
  'web:search': [[req: WebSearchRequest], WebSearchResult]
  /** Fetch a page and reduce it to readable text (default 12 000 characters). */
  'web:page': [[url: string, maxChars?: number], WebPage]
  /** Phone app: where searches go (answered on the phone; the PC ignores it). */
  'web:setRoute': [[route: WebRoute], WebStatus]
  /** Phone app only (answered on the phone, never by the PC): run every generation on the phone's own hardware. */
  'phone:deviceOnly': [[value?: boolean], { deviceOnly: boolean; ready: { text: number; image: number; voice: number } }]

  // computers (Settings → Computers): link other Stitch PCs and use their GPUs
  /** Also keeps live hardware sampling on for a minute (the page calls it periodically). */
  'cluster:status': [[], ClusterStatus]
  'cluster:setRole': [[role: 'main' | 'node'], ClusterStatus]
  /** Node: open (or close) the 10-minute window in which a main can link with the shown code. */
  'cluster:linkWindow': [[open: boolean], ClusterStatus]
  /** Main: ask a found PC to show its link code. */
  'cluster:requestLink': [[pcId: string], void]
  /** Main: link a found PC with the code it shows. */
  'cluster:link': [[pcId: string, code: string], LinkedNode]
  /** Main: find a node by address (other subnet, Tailscale): `192.168.1.20` or `host:port`. */
  'cluster:probe': [[address: string], FoundPc]
  /** Main: forget a node (it is told to forget this PC too). */
  'cluster:unlink': [[nodeId: string], void]
  /** Node: cut a main off. */
  'cluster:revokeMain': [[mainId: string], void]
  /** Main: recipes a node can't run and the missing files. */
  'cluster:modelGaps': [[nodeId: string], NodeModelGap[]]
  /** Main: copy a model file from this PC to a node over the link. */
  'cluster:copyModel': [[nodeId: string, folder: string, name: string], void]
  'cluster:cancelCopy': [[copyId: string], void]
  /** Main: the log of a node's ComfyUI or rpc-server. */
  'cluster:nodeLogs': [[nodeId: string, kind: 'comfy' | 'rpc', gpu: number], string[]]

  // llama.cpp text engine
  'llama:status': [[], LlamaStatus]
  /** Download the official llama.cpp build for this PC (also happens on first start). */
  'llama:install': [[], LlamaStatus]
  'llama:models': [[refresh?: boolean], GgufFile[]]
  /** GPUs that can hold layers: this PC's and linked nodes'. */
  'llama:devices': [[], LlamaDevice[]]
  /** GGUF files in a Hugging Face repo (`owner/name`). */
  'llama:hfFiles': [[repo: string], { path: string; size: number }[]]
  /** Download a GGUF from Hugging Face into <userData>/models/llm (progress via download:progress). */
  'llama:download': [[repo: string, path: string], DownloadState]
  'llama:start': [[], LlamaStatus]
  'llama:stop': [[], LlamaStatus]
  'llama:logs': [[], string[]]
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
  'remote:changed': RemoteStatus
  /** A phone just paired (Settings → Phone celebrates, then closes the QR). */
  'remote:paired': RemoteDevice
  'web:status': WebStatus
  /** A workshop subscription we're waiting on changed state (ready = on disk). */
  'wallpaper:download': WorkshopDownload
  'cluster:changed': ClusterStatus
  'llama:status': LlamaStatus
}

export type InvokeChannel = keyof IpcInvoke
export type InvokeArgs<C extends InvokeChannel> = IpcInvoke[C][0]
export type InvokeResult<C extends InvokeChannel> = IpcInvoke[C][1]
export type EventChannel = keyof IpcEvents

export type { CollectionMap }
