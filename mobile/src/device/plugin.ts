// Contract for the native `StitchDevice` Capacitor plugin (android/app/src/main/java/com/stitch/mobile/device).
// On-device generation: text (LiteRT-LM), images (ONNX Runtime Stable Diffusion) and voice (on-device TTS),
// each on the Qualcomm NPU (QNN), the GPU or the CPU. The model catalog lives in `catalog.ts`; native code only
// downloads the files it is handed, and runs the formats below.
import { registerPlugin, type PluginListenerHandle } from '@capacitor/core'

export type DeviceTask = 'text' | 'image' | 'voice'
/** npu = Qualcomm Hexagon NPU through QNN. */
export type DeviceBackend = 'npu' | 'gpu' | 'cpu'

export interface BackendSupport {
  id: DeviceBackend
  available: boolean
  /** Why it's unavailable, or a note ("Adreno 750", "Hexagon v75"). */
  note?: string
}

export interface DeviceInfo {
  manufacturer: string
  model: string
  /** Build.SOC_MODEL, e.g. "SM8650". */
  soc?: string
  /** Friendly chip name when known, e.g. "Snapdragon 8 Gen 3". */
  socName?: string
  androidVersion: string
  sdk: number
  abi: string
  ramBytes: number
  freeStorageBytes: number
  qualcomm: boolean
  /** Hexagon HTP architecture, e.g. "v75" (Qualcomm only). */
  htpArch?: string
  gpu?: string
  backends: Record<DeviceTask, BackendSupport[]>
}

/** Model file formats the native runtimes understand. */
export type DeviceFormat =
  /** One .litertlm bundle (LiteRT-LM). */
  | 'litertlm'
  /** Stable Diffusion as ONNX: tokenizer (vocab.json + merges.txt), text_encoder, unet, vae_decoder. */
  | 'sd-onnx'
  /** On-device TTS model (see `voiceEngine`). */
  | 'tts-onnx'
  /** Android's built-in TextToSpeech — nothing to download. */
  | 'tts-system'

export interface DeviceFile {
  url: string
  /** Relative path inside the model folder, e.g. "unet/model.onnx". */
  path: string
  /** Expected size in bytes when known (used for progress and completeness). */
  size?: number
}

export interface DownloadEvent {
  id: string
  state: 'downloading' | 'done' | 'error' | 'canceled'
  receivedBytes: number
  totalBytes: number
  /** File currently downloading. */
  file?: string
  error?: string
}

export interface ModelStatus {
  id: string
  /** Every file is present and complete. */
  ready: boolean
  /** Bytes on disk for this model. */
  sizeBytes: number
  /** Absolute folder path on the phone. */
  dir: string
  downloading: boolean
}

export interface ChatTurn {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface TextGenerateOptions {
  requestId: string
  modelId: string
  backend: DeviceBackend
  /** Folder of a ready model (from `status`). */
  dir: string
  /** File inside `dir` to load (the .litertlm bundle). */
  file: string
  system?: string
  messages: ChatTurn[]
  maxTokens?: number
  temperature?: number
  topP?: number
  topK?: number
  /** Stop sequences; generation ends when the output contains one (it is trimmed). */
  stop?: string[]
  contextLength?: number
  /** Extra model facts from the catalog (enableThinking, speculativeDecoding, sampler: null for NPU builds …). */
  config?: Record<string, unknown>
}

export interface TextEvent {
  requestId: string
  delta: string
}

export interface ImageGenerateOptions {
  jobId: string
  modelId: string
  backend: DeviceBackend
  dir: string
  prompt: string
  negativePrompt?: string
  steps: number
  /** Classifier-free guidance; <= 1 disables the unconditional pass (turbo/LCM models). */
  guidance: number
  seed: number
  width: number
  height: number
  /** 'euler' | 'euler-a' | 'lcm' | 'turbo' */
  scheduler: string
  /** Extra model facts from the catalog (latent channels, prediction type, fixed resolution …). */
  config?: Record<string, unknown>
}

export interface ImageEvent {
  jobId: string
  step: number
  steps: number
  /** Small JPEG preview as a data URL (decoded latents), when available. */
  preview?: string
  phase?: 'loading' | 'encoding' | 'denoising' | 'decoding'
}

export interface ImageResult {
  /** Absolute path of the PNG on the phone. */
  path: string
  width: number
  height: number
  seed: number
  backend: DeviceBackend
  seconds: number
}

export interface SpeakOptions {
  modelId: string
  backend: DeviceBackend
  /** Folder of a ready model; empty for the system voice. */
  dir: string
  format: DeviceFormat
  text: string
  /** Voice/speaker id from the catalog (or a system voice name). */
  voice?: string
  speed?: number
  config?: Record<string, unknown>
}

export interface SpeakResult {
  /** Absolute path of a 16-bit PCM WAV on the phone. */
  path: string
  sampleRate: number
  duration: number
  backend: DeviceBackend
}

export interface SystemVoice {
  id: string
  name: string
  language: string
  quality?: number
  network?: boolean
}

export interface StitchDevicePlugin {
  info(): Promise<DeviceInfo>

  /** Download (or resume) a model's files into its folder. Progress arrives as `download` events. */
  download(opts: { id: string; files: DeviceFile[]; headers?: Record<string, string> }): Promise<void>
  cancelDownload(opts: { id: string }): Promise<void>
  status(opts: { ids: string[]; files?: Record<string, DeviceFile[]> }): Promise<{ models: ModelStatus[] }>
  deleteModel(opts: { id: string }): Promise<void>

  /** Stream a chat reply; `text` events carry deltas. Resolves with the full reply. */
  textGenerate(opts: TextGenerateOptions): Promise<{ text: string; stopReason: string; backend: DeviceBackend; tokensPerSecond?: number }>
  textAbort(opts: { requestId: string }): Promise<void>

  imageGenerate(opts: ImageGenerateOptions): Promise<ImageResult>
  imageCancel(opts: { jobId: string }): Promise<void>

  speak(opts: SpeakOptions): Promise<SpeakResult>
  systemVoices(): Promise<{ voices: SystemVoice[] }>

  /** Free loaded models (all, or one task). */
  unload(opts?: { task?: DeviceTask }): Promise<void>
  /** Delete a generated output file once it has been uploaded. */
  deleteFile(opts: { path: string }): Promise<void>
  /** Safe-area and keyboard insets in CSS px (the WebView doesn't report env() reliably). */
  insets(): Promise<{ top: number; bottom: number; left: number; right: number; ime: number }>

  addListener(event: 'download', fn: (e: DownloadEvent) => void): Promise<PluginListenerHandle>
  addListener(event: 'text', fn: (e: TextEvent) => void): Promise<PluginListenerHandle>
  addListener(event: 'image', fn: (e: ImageEvent) => void): Promise<PluginListenerHandle>
  addListener(event: 'insets', fn: (e: { top: number; bottom: number; left: number; right: number; ime: number }) => void): Promise<PluginListenerHandle>
}

export const StitchDevice = registerPlugin<StitchDevicePlugin>('StitchDevice')
