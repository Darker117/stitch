// Domain types shared by the main process and the renderer.

export type ID = string

// ─── Settings ────────────────────────────────────────────────────────────────

export type BackgroundType = 'gradient' | 'image' | 'video' | 'web' | 'none'

export interface BackgroundSettings {
  type: BackgroundType
  /** Absolute path for image/video backgrounds, or the web entry file. */
  path?: string
  /** Wallpaper Engine workshop id when imported from Wallpaper Engine. */
  wallpaperId?: string
  /** Preview image (used to pick accents for web/scene wallpapers). */
  preview?: string
  /** The wallpaper author's scheme colour, #rrggbb. */
  scheme?: string
  /** 0 → untouched, 1 → fully black. */
  dim: number
  /** Blur in px applied behind content. */
  blur: number
}

export interface ThemeSettings {
  background: BackgroundSettings
  accentMode: 'auto' | 'manual'
  /** Primary accent, #rrggbb. */
  accent: string
  /** Secondary accent for gradients, #rrggbb. */
  accent2: string
  /** Colour the app surfaces are tinted towards, #rrggbb. */
  tint: string
  /** Panel opacity 0.2–0.95 (-1 = automatic). Lower lets the wallpaper show through more. */
  glass?: number
  /** Backdrop blur behind panels, px (-1 = automatic). */
  glassBlur?: number
}

/** A workload that can be pinned to a GPU. */
export type GpuWorkload = 'image' | 'video' | 'audio' | 'voice'

export interface GpuSettings {
  /** nvidia-smi indices Stitch may use. Empty = let ComfyUI decide (single instance). */
  enabled: number[]
  /** Which GPU runs each workload; 'auto' balances across all enabled GPUs. */
  assign: Record<GpuWorkload, number | 'auto'>
  /** true: Stitch launches its own ComfyUI per GPU. false: use a ComfyUI you already run. */
  managed: boolean
}

export interface AppSettings {
  /** Where generated media, imports and exports are written. */
  libraryDir: string
  gpu: GpuSettings
  /** Optional models folder the user picked. Scanned by Stitch and handed to ComfyUI. */
  modelsDir?: string
  /** More model folders the user installed into (Download → "Choose folder"). Scanned and handed to ComfyUI too. */
  extraModelDirs?: string[]
  /** Path to a ComfyUI install (auto-detected from Stability Matrix). */
  comfyDir?: string
  /** Launch managed ComfyUI instances when Stitch starts. */
  comfyAutoLaunch: boolean
  ffmpegPath?: string
  theme: ThemeSettings
  /** Default text model used across the app (story, agent, card generation). */
  defaultLlm?: { connectorId: ID; model: string }
  defaultVoice?: { connectorId: ID }
  userName: string
  /** The player's persona: used as the default player in stories and shown in the sidebar. */
  persona?: { personality?: string; avatarAssetId?: ID }
  onboardingDone: boolean
  /** Civitai browsing preferences (the API key itself lives in encrypted secrets under id "civitai"). */
  civitai: { hideNsfw: boolean }
  /** App updates from GitHub Releases. */
  updates: { autoDownload: boolean }
  /** Phone remote: the Stitch Android app connects over the LAN (or Tailscale) on this port. */
  remote: {
    enabled: boolean
    port: number
    /** While phones are allowed, closing the window keeps Stitch running in the tray. */
    background?: boolean
    /** Access from anywhere: a public HTTPS address for the phone remote. */
    anywhere?: { mode: 'off' | 'cloudflare' | 'tailscale' | 'custom'; customUrl?: string }
  }
}

// ─── App updates ─────────────────────────────────────────────────────────────

export type UpdateStatus = 'unsupported' | 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'

export interface UpdateState {
  status: UpdateStatus
  /** Version that is running now. */
  current: string
  /** Newest version found on GitHub. */
  version?: string
  releaseName?: string
  /** Release notes (HTML from GitHub; sanitise before rendering). */
  releaseNotes?: string
  releaseDate?: string
  progress?: { percent: number; transferred: number; total: number; bytesPerSecond: number }
  error?: string
  checkedAt?: number
  /** The user chose "Later" — the update installs when Stitch quits. */
  deferred?: boolean
}

// ─── Connectors ──────────────────────────────────────────────────────────────

export type LlmKind =
  | 'openai'
  | 'anthropic'
  | 'openrouter'
  | 'ollama'
  | 'lmstudio'
  | 'gemini'
  | 'openai-compatible'
  /** On-device model in the Stitch phone app (answered on the phone, never by the PC). */
  | 'device'

/** 'device' = on-device speech in the Stitch phone app (answered on the phone, never by the PC). */
export type VoiceKind = 'local-qwen' | 'local-kokoro' | 'local-pocket' | 'elevenlabs' | 'openai-tts' | 'azure' | 'device'

export type ConnectorCategory = 'llm' | 'comfy' | 'voice'

export interface ConnectorBase {
  id: ID
  name: string
  category: ConnectorCategory
  enabled: boolean
  createdAt: number
}

export interface LlmConnector extends ConnectorBase {
  category: 'llm'
  kind: LlmKind
  baseUrl: string
  hasKey: boolean
  /** Cached model list from the last refresh. */
  models?: LlmModelInfo[]
}

export interface ComfyConnector extends ConnectorBase {
  category: 'comfy'
  url: string
  /** Which job kinds this instance accepts. Empty = everything. */
  roles: GenKind[]
  /** When set, Stitch launches and owns this ComfyUI process. */
  managed?: { cudaDevice?: number; port: number }
}

export interface VoiceConnector extends ConnectorBase {
  category: 'voice'
  kind: VoiceKind
  baseUrl?: string
  region?: string
  hasKey: boolean
  /** Default synthesis model, e.g. eleven_multilingual_v2 / eleven_v3, gpt-4o-mini-tts. */
  model?: string
}

export type Connector = LlmConnector | ComfyConnector | VoiceConnector

export interface LlmModelInfo {
  id: string
  name?: string
  contextLength?: number
  description?: string
}

// ─── Assets ──────────────────────────────────────────────────────────────────

export type AssetKind = 'image' | 'video' | 'audio'

export interface Asset {
  id: ID
  kind: AssetKind
  /** Absolute path on disk. */
  path: string
  name: string
  createdAt: number
  source: 'generated' | 'imported' | 'edited' | 'voice'
  projectId?: ID
  width?: number
  height?: number
  /** Seconds. */
  duration?: number
  /** Poster/thumbnail for video. */
  thumbPath?: string
  prompt?: string
  recipeId?: string
  params?: Record<string, unknown>
  characterIds?: ID[]
  tags?: string[]
  favorite?: boolean
  /** Where it was made from, e.g. an adventure turn. `sub: 'cover'` on a scenario/adventure sets its cover. */
  origin?: { type: 'adventure' | 'scenario' | 'character' | 'chat' | 'studio' | 'timeline'; id: ID; sub?: ID }
}

// ─── Generation ──────────────────────────────────────────────────────────────

export type GenKind = 'image' | 'video' | 'audio' | 'voice'

export type ParamType =
  | 'prompt'
  | 'text'
  | 'number'
  | 'int'
  | 'seed'
  | 'select'
  | 'bool'
  | 'aspect'
  | 'image'
  | 'images'
  | 'audio'
  | 'audios'
  | 'video'
  | 'model'
  | 'lora'
  /** A stack of LoRAs: LoraRef[]. */
  | 'loras'

export interface ParamSpec {
  key: string
  label: string
  type: ParamType
  default?: unknown
  min?: number
  max?: number
  step?: number
  options?: { value: string; label: string }[]
  /** For model/lora pickers: the ComfyUI model folder to list. */
  folder?: string
  /** Max items for images/audios. */
  maxItems?: number
  help?: string
  advanced?: boolean
  required?: boolean
}

export interface RecipeInfo {
  id: string
  name: string
  kind: GenKind
  /** 'text' | 'image-edit' | 'reference' | 'first-frame' … used by the UI to group. */
  mode: string
  family: string
  description: string
  params: ParamSpec[]
  /** Model files this recipe needs, as ComfyUI folder + filename. */
  requires: { folder: string; name: string }[]
  /** Filled in at runtime: are all required files visible to ComfyUI or on disk? */
  available?: boolean
  missing?: string[]
  /** Rough seconds per run, shown on cards. */
  estSeconds?: number
  /** Built-in or user-imported skill. */
  builtin: boolean
  /** Regex (source) matched against Civitai base-model names to filter compatible models/LoRAs. */
  baseModelMatch?: string
  /** Its automatic model pick is a file Civitai flags NSFW (only NSFW finetunes of this family are installed). */
  autoNsfw?: boolean
}

export type JobStatus = 'queued' | 'running' | 'done' | 'error' | 'canceled'

export interface GenJob {
  id: ID
  recipeId: string
  kind: GenKind
  params: Record<string, unknown>
  status: JobStatus
  createdAt: number
  startedAt?: number
  finishedAt?: number
  progress?: { value: number; max: number; node?: string }
  /** Latest latent preview as a data URL. */
  preview?: string
  outputs: ID[]
  error?: string
  connectorId?: ID
  promptId?: string
  label?: string
  projectId?: ID
  origin?: Asset['origin']
  characterIds?: ID[]
}

export interface GenRequest {
  recipeId: string
  params: Record<string, unknown>
  label?: string
  projectId?: ID
  origin?: Asset['origin']
  characterIds?: ID[]
  /** Number of times to run with incrementing seeds. */
  batch?: number
}

// ─── Characters (Charlock) ───────────────────────────────────────────────────

export type SheetSlot =
  | 'front'
  | 'three-quarter-left'
  | 'three-quarter-right'
  | 'profile-left'
  | 'profile-right'
  | 'back'
  | 'low-angle'
  | 'high-angle'
  | 'full-body'
  | 'expr-happy'
  | 'expr-sad'
  | 'expr-angry'
  | 'expr-surprised'
  | 'expr-neutral'
  | 'light-golden'
  | 'light-night'
  | 'light-studio'
  | 'light-rim'
  | 'light-overcast'

export interface CharacterVoice {
  connectorId?: ID
  /** Provider voice id (ElevenLabs/OpenAI/Azure) when not cloned locally. */
  voiceId?: string
  /** Reference clip used for cloning and for H3 video voice references. */
  sampleAssetId?: ID
  /** Exact words spoken in the sample (needed for local cloning). */
  sampleText?: string
  /** Natural-language description used by voice design. */
  design?: string
  language?: string
}

export interface Character {
  id: ID
  name: string
  description: string
  /** Short visual description injected into prompts. */
  appearance: string
  createdAt: number
  updatedAt: number
  projectId?: ID
  referenceAssetId?: ID
  sheet: Partial<Record<SheetSlot, ID>>
  sheetDetail: 'compact' | 'studio'
  locked: boolean
  voice?: CharacterVoice
  tags: string[]
}

// ─── Stories (scenarios + adventures) ────────────────────────────────────────

export type StoryCardType = 'character' | 'class' | 'race' | 'location' | 'faction' | 'custom'

export interface StoryCardGenerator {
  speedCreate: boolean
  includeSummary: boolean
  logInNotes: boolean
  aiInstructions: string
  storyInfo: string
}

export interface StoryCard {
  id: ID
  type: StoryCardType
  /** For custom cards: the user-facing category name. */
  customType?: string
  name: string
  entry: string
  triggers: string
  notes: string
  /** Linked Charlock character — gives the card a face and a voice. */
  characterId?: ID
  imageAssetId?: ID
  generator?: StoryCardGenerator
  createdAt: number
  updatedAt: number
}

export type OpeningType = 'story' | 'multipleChoice' | 'characterCreator'

export interface CreatorField {
  id: ID
  label: string
  /** Story card type the options are drawn from. */
  cardType: StoryCardType
  customType?: string
}

export interface PlotComponents {
  aiInstructions: string
  plotEssentials: string
  authorsNote: string
  storySummary: string
  thirdPerson: boolean
  /** Optional components the user added. */
  enabled: { storySummary: boolean; thirdPerson: boolean }
}

export interface Scenario {
  id: ID
  /** Set on child scenarios that back a multiple-choice option. */
  parentId?: ID
  title: string
  description: string
  tags: string[]
  coverAssetId?: ID
  projectId?: ID
  createdAt: number
  updatedAt: number
  openingType: OpeningType
  /** Opening story / choice prompt / world description, depending on type. */
  opening: string
  /** Child scenario ids, in order, for multiple choice openings. */
  choices: ID[]
  creatorFields: CreatorField[]
  plot: PlotComponents
  cards: StoryCard[]
  /** Legacy — no longer edited; kept so older scenarios still load. */
  contentRating?: 'everyone' | 'teen' | 'mature' | 'unrated'
  template?: string
  /** Master switch for this scenario's scripts (Details → Scripts Enabled). */
  scriptsEnabled?: boolean
  /** Scripts attached to this scenario, in run order (top runs first). */
  scripts?: ScriptRef[]
}

// ─── Story scripts (AI Dungeon-compatible) ───────────────────────────────────

/**
 * A reusable script in the AI Dungeon format: a shared Library plus Input,
 * Context and Output modifiers, each plain JavaScript using the
 * `const modifier = (text) => ({ text }); modifier(text)` pattern and the
 * AID globals (state, info, history, storyCards, addStoryCard, log, stop…).
 */
export interface StoryScript {
  id: ID
  name: string
  author?: string
  description?: string
  /** 'builtin' ships with Stitch, 'import' came from a file/URL, 'user' was written here or by the composer. */
  source: 'builtin' | 'import' | 'user'
  sourceUrl?: string
  license?: string
  library: string
  input: string
  context: string
  output: string
  createdAt: number
  updatedAt: number
}

export interface ScriptRef {
  scriptId: ID
  enabled: boolean
}

export type ActionType = 'start' | 'do' | 'say' | 'story' | 'continue' | 'see'

export interface StoryAction {
  id: ID
  type: ActionType
  text: string
  createdAt: number
  /** Alternate generations kept by Retry. */
  alternates?: string[]
  media?: { assetId: ID; kind: AssetKind; role: 'see' | 'animate' | 'narrate' }[]
  model?: string
  /** Hidden model thinking for this passage (shown behind “Show thinking”). */
  reasoning?: string
  thinkingMs?: number
}

export type SafetyLevel = 'safe' | 'moderate' | 'mature'
export type PlayTheme = 'dynamic' | 'orcish' | 'atlantis' | 'smores' | 'cyber'
export type TextStyle = 'print' | 'clean' | 'hacker'

export interface AdventureSettings {
  llm?: { connectorId: ID; model: string }
  contextLength: number
  memoryBank: boolean
  autoSummarize: boolean
  responseLength: number
  temperature: number
  topK: number
  topP: number
  safety: SafetyLevel
  imageRecipeId?: string
  videoRecipeId?: string
  rawOutput: boolean
  contextWarning: boolean
  theme: PlayTheme
  textStyle: TextStyle
  textAnimation: boolean
  largeText: boolean
  stickyInput: boolean
  compactButtons: boolean
  autoNarrate: boolean
  autoSee: boolean
  /** Also render a short video clip for every new AI passage. */
  autoAnimate?: boolean
  /** Model + LoRA stack for story stills (applies when the image recipe is used). */
  imageGen?: { model?: string; loras?: LoraRef[]; /** Activation words / style tags appended to every scene prompt. */ trigger?: string }
  /** Model, LoRA stack and length for story clips (applies to the chosen video recipe). */
  videoGen?: { model?: string; loras?: LoraRef[]; trigger?: string; duration?: number }
  /** Voice used by Narrate / Auto Narrate. */
  narrator?: CharacterVoice
}

export interface MemoryEntry {
  id: ID
  text: string
  /** Index of the last action the memory covers. */
  upTo: number
  createdAt: number
}

export interface Adventure {
  id: ID
  scenarioId?: ID
  title: string
  description: string
  tags: string[]
  coverAssetId?: ID
  projectId?: ID
  createdAt: number
  updatedAt: number
  lastPlayedAt: number
  plot: PlotComponents
  cards: StoryCard[]
  actions: StoryAction[]
  redo: StoryAction[]
  memories: MemoryEntry[]
  /** Actions before this index are folded into plot.storySummary by auto summarization. */
  summaryUpTo?: number
  /** `persona` is the profile personality, kept only while the player plays as themselves. */
  player: { name: string; characterId?: ID; persona?: string; choices: Record<string, string> }
  settings: AdventureSettings
  contentRating?: Scenario['contentRating']
  /**
   * Scripts for this adventure, in run order. Entries with `fromScenario` were
   * copied from the scenario: they can be disabled here but not removed.
   */
  scripts?: (ScriptRef & { fromScenario?: boolean })[]
  /** The AID `state` object scripts share across turns (persisted per adventure). */
  scriptState?: Record<string, unknown>
  /** Last full context sent to the model — for "Inspect input". */
  lastInput?: { system: string; messages: { role: string; content: string }[]; tokens: number; droppedCards: number }
}

// ─── Projects, chats, skills, timelines ──────────────────────────────────────

export interface Project {
  id: ID
  name: string
  description: string
  /** Style notes inherited by every generation in the project. */
  style: string
  coverAssetId?: ID
  characterIds: ID[]
  createdAt: number
  updatedAt: number
}

export interface ChatToolCall {
  id: string
  name: string
  args: Record<string, unknown>
  status: 'pending' | 'approved' | 'rejected' | 'running' | 'done' | 'error'
  result?: string
  jobIds?: ID[]
}

export interface ChatMessage {
  id: ID
  role: 'user' | 'assistant' | 'tool'
  content: string
  createdAt: number
  toolCalls?: ChatToolCall[]
  toolCallId?: string
  attachments?: ID[]
  /** Hidden model thinking, shown behind a "Show thinking" toggle. */
  reasoning?: string
  /** How long the model thought, ms. */
  thinkingMs?: number
}

export interface Chat {
  id: ID
  title: string
  projectId?: ID
  createdAt: number
  updatedAt: number
  messages: ChatMessage[]
  askBeforeGenerating: boolean
  llm?: { connectorId: ID; model: string }
}

export interface SkillDoc {
  id: ID
  name: string
  description: string
  kind: GenKind
  coverAssetId?: ID
  /** ComfyUI API-format graph. */
  graph: Record<string, { class_type: string; inputs: Record<string, unknown>; _meta?: { title?: string } }>
  /** Which node inputs are exposed as parameters. */
  bindings: { key: string; label: string; type: ParamType; node: string; input: string; default?: unknown; min?: number; max?: number; options?: { value: string; label: string }[] }[]
  estSeconds?: number
  createdAt: number
  updatedAt: number
}

export interface TimelineClip {
  id: ID
  assetId: ID
  trackId: ID
  /** Seconds on the timeline. */
  start: number
  /** In/out within the source, seconds. */
  in: number
  out: number
  volume: number
  muted?: boolean
  fadeIn?: number
  fadeOut?: number
  /** Text overlay clips. */
  text?: { content: string; size: number; color: string; x: number; y: number }
}

export interface TimelineTrack {
  id: ID
  kind: 'video' | 'audio' | 'text'
  name: string
  muted: boolean
  locked: boolean
  hidden: boolean
}

export interface Timeline {
  id: ID
  name: string
  projectId?: ID
  width: number
  height: number
  fps: number
  tracks: TimelineTrack[]
  clips: TimelineClip[]
  createdAt: number
  updatedAt: number
}

// ─── Wallpaper Engine ────────────────────────────────────────────────────────

export interface WallpaperItem {
  id: string
  title: string
  type: 'scene' | 'video' | 'web' | 'application' | string
  dir: string
  /** Main file (video file / index.html / scene.json). */
  file?: string
  preview?: string
  /** Scheme colour from Wallpaper Engine as #rrggbb. */
  schemeColor?: string
  contentRating?: string
  tags?: string[]
}

// ─── Model library & Civitai ─────────────────────────────────────────────────

/** Coarse role of a model file, shown as a coloured tag. */
export type ModelKind = 'checkpoint' | 'unet' | 'lora' | 'controlnet' | 'vae' | 'textencoder' | 'embedding' | 'upscaler' | 'clipvision' | 'other'

/** Metadata for a model file — from a Stability Matrix `.cm-info.json` sidecar, Civitai, or none. */
export interface ModelMeta {
  source: 'civitai' | 'local'
  modelId?: number
  versionId?: number
  name: string
  versionName?: string
  /** Civitai model type, e.g. "LORA", "Checkpoint", "Controlnet". */
  civitaiType?: string
  /** Civitai base model, e.g. "Krea 2", "Illustrious", "Flux.2 Klein 4B", "MiniMax H3". */
  baseModel?: string
  /** Activation keywords. */
  trainedWords: string[]
  /** HTML description. */
  description?: string
  tags: string[]
  nsfw: boolean
  author?: string
  /** Local thumbnail (`<name>.preview.jpeg`). */
  previewPath?: string
  sha256?: string
  /** Small cached copy of `previewPath` for grids and pickers. */
  thumbPath?: string
  /** Civitai nsfwLevel of the preview image when known (Stitch-written sidecars). */
  previewNsfwLevel?: number
  versionDescription?: string
  stats?: { downloadCount?: number; thumbsUpCount?: number; favoriteCount?: number }
  fileMeta?: { fp?: string | null; size?: string | null; format?: string | null }
  importedAt?: string
}

export interface LocalModel {
  /** ComfyUI folder key: checkpoints, diffusion_models, loras, vae, text_encoders, controlnet, embeddings, upscale_models… */
  folder: string
  /** Name as ComfyUI references it (path relative to the folder, forward slashes). */
  name: string
  path: string
  size: number
  kind: ModelKind
  meta?: ModelMeta
}

/** One LoRA in a stack. */
export interface LoraRef {
  name: string
  strength: number
}

export interface CivitaiImage {
  url: string
  /** Civitai level: 1 PG, 2 PG-13, 4 R, 8 X, 16 XXX. */
  nsfwLevel: number
  width?: number
  height?: number
  type?: 'image' | 'video'
  /** Blurhash placeholder (shown instead of hidden NSFW images). */
  hash?: string
}

export interface CivitaiFile {
  id: number
  name: string
  sizeKB: number
  type: string
  primary?: boolean
  metadata?: { fp?: string | null; size?: string | null; format?: string | null }
  downloadUrl: string
  hashes?: Record<string, string>
}

export interface CivitaiVersion {
  id: number
  name: string
  baseModel: string
  trainedWords: string[]
  description?: string
  images: CivitaiImage[]
  files: CivitaiFile[]
  publishedAt?: string
  downloadCount?: number
}

export interface CivitaiModel {
  id: number
  name: string
  type: string
  nsfw: boolean
  description?: string
  tags: string[]
  creator?: string
  creatorImage?: string
  stats?: { downloadCount?: number; thumbsUpCount?: number; favoriteCount?: number }
  versions: CivitaiVersion[]
}

export interface CivitaiQuery {
  query?: string
  /** Civitai model types: Checkpoint, LORA, LoCon, DoRA, Controlnet, TextualInversion, VAE, Upscaler, … */
  types?: string[]
  /** Civitai base models: "SDXL 1.0", "SD 1.5", "Illustrious", "Pony", "Flux.1 D", "Krea 2", "Qwen", … */
  baseModels?: string[]
  sort?: string
  period?: string
  /** Include NSFW results (thumbnails are still hidden in the UI when the toggle is on). */
  nsfw?: boolean
  cursor?: string
  limit?: number
}

export interface DownloadState {
  id: string
  name: string
  modelId?: number
  versionId?: number
  folder: string
  received: number
  total: number
  status: 'queued' | 'downloading' | 'done' | 'error' | 'canceled'
  error?: string
  path?: string
  startedAt: number
  /** Where the file comes from. */
  source?: 'civitai' | 'huggingface'
  /** Install batch (recipe or catalog entry id) this file belongs to. */
  group?: string
  /** Transient detail, e.g. "Resuming…" or "Verifying checksum…". */
  note?: string
}

// ─── Model catalog, installs & manager ───────────────────────────────────────

/** One downloadable file from the curated catalog (Hugging Face). */
export interface CatalogFile {
  /** Model folder key: a ComfyUI folder (diffusion_models, vae…) or a Stitch runtime folder ('yue'). */
  folder: string
  /** Name as the loader references it (relative to the folder, forward slashes). */
  name: string
  /** Hugging Face repo id. */
  repo: string
  /** Path inside the repo. */
  path: string
  revision?: string
  size: number
  sha256?: string
  /** Needs a Hugging Face token whose account accepted the licence. */
  gated?: boolean
}

export interface CatalogEntry {
  id: string
  name: string
  description: string
  /** Recipes this download makes runnable. */
  recipes: string[]
  files: CatalogFile[]
  license?: string
  /** Model page. */
  url?: string
}

export interface ModelsHome {
  /** Default base folder for downloads. */
  path: string
  layout: 'stability-matrix' | 'comfyui'
  source: 'settings' | 'stability-matrix' | 'app'
  /** A ComfyUI you run yourself sees this folder without extra setup. */
  externalComfySees: boolean
}

export interface InstallPlanFile extends CatalogFile {
  /** Requirement label, e.g. "ACE 1.5 VAE". */
  label: string
  /** installed = ComfyUI sees it · hidden = on disk but ComfyUI doesn't list it yet. */
  status: 'installed' | 'hidden' | 'missing' | 'queued' | 'downloading'
  /** Where it will be saved on disk. */
  dest?: string
  downloadId?: string
}

export interface InstallPlan {
  recipeId: string
  /** Catalog entry the files come from (the recipe's default unless one was asked for). */
  entryId?: string
  /** Every catalog entry that can make this recipe runnable (default first). */
  alternatives: { id: string; name: string; description: string; bytes: number }[]
  files: InstallPlanFile[]
  /** Bytes still to download. */
  bytes: number
  /** Missing requirements the catalog has no source for. */
  unknown: string[]
  gated: boolean
  hasHfToken: boolean
  home: ModelsHome
}

export interface InstallRequest {
  recipeId?: string
  entryId?: string
  /** Base models folder to install into; omitted = the default models path. */
  dest?: string
}

export type ModelLocationKind = 'settings' | 'stability-matrix' | 'comfyui' | 'comfy-extra' | 'app' | 'extra' | 'voice'

export interface ModelLocation {
  id: string
  kind: ModelLocationKind
  label: string
  path: string
  exists: boolean
  /** New downloads go here by default. */
  isDefault: boolean
  /** Bytes of model files Stitch found here. */
  bytes: number
  files: number
  /** Free / total bytes on the drive. */
  free?: number
  total?: number
  /** Stitch added it (Download → Choose folder) and can forget it. */
  removable: boolean
}

export interface ModelUse {
  id: string
  name: string
}

export interface ManagedModel {
  path: string
  locationId: string
  folder: string
  /** Name as loaders reference it. */
  name: string
  kind: ModelKind
  size: number
  /** An interrupted download (`.part`) — resumable, or remove it to free the space. */
  partial?: boolean
  usedBy: ModelUse[]
  catalogId?: string
  meta?: ModelMeta
}

export interface ModelInventory {
  locations: ModelLocation[]
  models: ManagedModel[]
  scannedAt: number
}

// ─── Misc ────────────────────────────────────────────────────────────────────

export type CollectionName =
  | 'connectors'
  | 'assets'
  | 'characters'
  | 'scenarios'
  | 'adventures'
  | 'projects'
  | 'chats'
  | 'skills'
  | 'timelines'
  | 'jobs'
  | 'scripts'

export interface CollectionMap {
  connectors: Connector
  assets: Asset
  characters: Character
  scenarios: Scenario
  adventures: Adventure
  projects: Project
  chats: Chat
  skills: SkillDoc
  timelines: Timeline
  jobs: GenJob
  scripts: StoryScript
}

export interface DbChange {
  collection: CollectionName
  id: ID
  op: 'put' | 'delete'
  doc?: unknown
}
