// Connector types Stitch knows how to talk to.
import type { ConnectorCategory, LlmKind, VoiceKind } from '@shared/types'
import { themedHue } from '@/lib/theme'

export interface CatalogEntry {
  key: string
  name: string
  category: ConnectorCategory
  kind?: LlmKind | VoiceKind
  blurb: string
  baseUrl?: string
  needsKey: boolean
  needsRegion?: boolean
  local: boolean
  /** Two-letter monogram and gradient for the badge. */
  mono: string
  hue: [string, string]
  docs?: string
  /** A key field shown even though it isn't required (e.g. Pocket TTS's Hugging Face token). */
  optionalKey?: boolean
  keyLabel?: string
}

export const CATALOG: CatalogEntry[] = [
  { key: 'lmstudio', name: 'LM Studio', category: 'llm', kind: 'lmstudio', blurb: 'Run open models locally with an OpenAI-compatible server.', baseUrl: 'http://127.0.0.1:1234/v1', needsKey: false, local: true, mono: 'LM', hue: ['#6d65b8', '#8f78b2'] },
  { key: 'ollama', name: 'Ollama', category: 'llm', kind: 'ollama', blurb: 'Local models with full context-window control.', baseUrl: 'http://127.0.0.1:11434', needsKey: false, local: true, mono: 'Ol', hue: ['#8f78b2', '#ad849d'] },
  { key: 'anthropic', name: 'Anthropic', category: 'llm', kind: 'anthropic', blurb: 'Claude models for rich, reliable storytelling.', baseUrl: 'https://api.anthropic.com', needsKey: true, local: false, mono: 'An', hue: ['#cc7b62', '#c85d56'], docs: 'https://console.anthropic.com/settings/keys' },
  { key: 'openai', name: 'OpenAI', category: 'llm', kind: 'openai', blurb: 'GPT models for chat, agents and story generation.', baseUrl: 'https://api.openai.com/v1', needsKey: true, local: false, mono: 'Oa', hue: ['#ad849d', '#8e3452'], docs: 'https://platform.openai.com/api-keys' },
  { key: 'openrouter', name: 'OpenRouter', category: 'llm', kind: 'openrouter', blurb: 'Hundreds of models behind one key, including uncensored story models.', baseUrl: 'https://openrouter.ai/api/v1', needsKey: true, local: false, mono: 'OR', hue: ['#aa3b51', '#6d65b8'], docs: 'https://openrouter.ai/keys' },
  { key: 'gemini', name: 'Google Gemini', category: 'llm', kind: 'gemini', blurb: 'Gemini through its OpenAI-compatible endpoint.', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', needsKey: true, local: false, mono: 'Ge', hue: ['#6d65b8', '#cc7b62'], docs: 'https://aistudio.google.com/apikey' },
  { key: 'custom', name: 'Custom endpoint', category: 'llm', kind: 'openai-compatible', blurb: 'Any OpenAI-compatible server: KoboldCpp, text-generation-webui, vLLM, TabbyAPI…', baseUrl: 'http://127.0.0.1:5000/v1', needsKey: false, local: true, mono: '{}', hue: ['#312b47', '#8f78b2'] },
  { key: 'comfy', name: 'ComfyUI', category: 'comfy', blurb: 'Image, video and audio generation on your GPUs (Stability Matrix install detected automatically).', baseUrl: 'http://127.0.0.1:8188', needsKey: false, local: true, mono: 'Cu', hue: ['#c85d56', '#cc7b62'] },
  { key: 'voice-local', name: 'Stitch Voice', category: 'voice', kind: 'local-qwen', blurb: 'Local Qwen3-TTS: clone any voice from a few seconds, or design one from a description.', baseUrl: 'http://127.0.0.1:7862', needsKey: false, local: true, mono: 'Qw', hue: ['#8e3452', '#ad849d'] },
  { key: 'voice-kokoro', name: 'Kokoro', category: 'voice', kind: 'local-kokoro', blurb: 'Local Kokoro-82M (Apache-2.0): 49 preset voices in 8 languages, light enough for any GPU or the CPU. Install it in Generate → Voice.', needsKey: false, local: true, mono: 'Ko', hue: ['#ad849d', '#cc7b62'], docs: 'https://huggingface.co/hexgrad/Kokoro-82M' },
  { key: 'voice-pocket', name: 'Pocket TTS', category: 'voice', kind: 'local-pocket', blurb: "Kyutai's 100M-parameter TTS that runs on the CPU, with voice cloning. Cloning uses gated weights: accept the terms on Hugging Face and add a read token.", needsKey: false, optionalKey: true, keyLabel: 'Hugging Face token', local: true, mono: 'Pk', hue: ['#8f78b2', '#c85d56'], docs: 'https://huggingface.co/kyutai/pocket-tts' },
  { key: 'elevenlabs', name: 'ElevenLabs', category: 'voice', kind: 'elevenlabs', blurb: 'Studio-grade voices and instant voice cloning.', needsKey: true, local: false, mono: '11', hue: ['#312b47', '#cc7b62'], docs: 'https://elevenlabs.io/app/settings/api-keys' },
  { key: 'openai-tts', name: 'OpenAI Voice', category: 'voice', kind: 'openai-tts', blurb: 'Expressive TTS with natural-language delivery instructions.', baseUrl: 'https://api.openai.com/v1', needsKey: true, local: false, mono: 'Ov', hue: ['#ad849d', '#6d65b8'] },
  { key: 'azure', name: 'Azure Speech', category: 'voice', kind: 'azure', blurb: 'Hundreds of neural voices with speaking styles via SSML.', needsKey: true, needsRegion: true, local: false, mono: 'Az', hue: ['#6d65b8', '#312b47'], docs: 'https://portal.azure.com' }
]

export function catalogFor(c: { category: ConnectorCategory; kind?: string }): CatalogEntry | undefined {
  if (c.category === 'comfy') return CATALOG.find((e) => e.key === 'comfy')
  return CATALOG.find((e) => e.category === c.category && e.kind === c.kind)
}

export function Mono({ entry, size = 40, className }: { entry: Pick<CatalogEntry, 'mono' | 'hue'>; size?: number; className?: string }): React.JSX.Element {
  return (
    <span
      className={className}
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.3,
        display: 'grid',
        placeItems: 'center',
        background: `linear-gradient(135deg, ${themedHue(entry.hue[0])}, ${themedHue(entry.hue[1])})`,
        boxShadow: 'inset 0 1px 0 rgb(255 255 255 / 0.25), 0 6px 18px -8px rgb(0 0 0 / 0.6)',
        color: 'white',
        fontWeight: 700,
        fontSize: size * 0.34,
        letterSpacing: '-0.02em',
        flexShrink: 0
      }}
    >
      {entry.mono}
    </span>
  )
}
