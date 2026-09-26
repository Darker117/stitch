// Coloured model tags: hardware, censorship variant, abilities, quantisation, languages. Colours come only from
// the theme (accents, status colours and the sunset palette), so they follow the user's theme.
import type { CatalogModel } from './catalog'
import type { DeviceBackend } from './plugin'
import { backendAvailableFor, sizeText } from './store'
import { cn } from '@/lib/utils'

const TONE: Record<string, string> = {
  npu: 'var(--accent-2)',
  gpu: 'var(--accent)',
  cpu: 'var(--sunset-3)',
  standard: 'var(--success)',
  abliterated: 'var(--danger)',
  uncensored: 'var(--warning)',
  vision: 'var(--sunset-1)',
  thinking: 'var(--sunset-2)',
  tools: 'var(--sunset-4)',
  multilingual: 'var(--sunset-3)',
  roleplay: 'var(--sunset-6)',
  coding: 'var(--sunset-1)',
  realistic: 'var(--sunset-4)',
  anime: 'var(--sunset-6)',
  artistic: 'var(--sunset-2)',
  turbo: 'var(--warning)',
  fast: 'var(--warning)',
  quality: 'var(--sunset-2)',
  expressive: 'var(--sunset-6)',
  female: 'var(--sunset-6)',
  male: 'var(--sunset-1)',
  custom: 'var(--accent-2)',
  lang: 'var(--sunset-3)',
  neutral: 'var(--fg-2)'
}

const LABEL: Record<string, string> = {
  npu: 'NPU',
  gpu: 'GPU',
  cpu: 'CPU',
  standard: 'Standard',
  abliterated: 'Abliterated',
  uncensored: 'Uncensored'
}

export function toneOf(tag: string): string {
  const t = tag.toLowerCase()
  if (TONE[t]) return TONE[t]
  if (/^(i?q\d|bf16|f16|fp16|fp8|int\d)/.test(t)) return TONE.neutral
  if (/^[a-z]{2}(-[a-z]{2})?$/i.test(tag)) return TONE.lang
  return TONE.neutral
}

/** One coloured chip. `dim` = present but unavailable here (e.g. NPU on a phone without one). */
export function Tag({ label, tone, dim, title }: { label: string; tone?: string; dim?: boolean; title?: string }): React.JSX.Element {
  const c = tone ?? toneOf(label)
  return (
    <span
      title={title}
      className={cn('inline-flex h-[19px] items-center rounded-full border px-1.5 text-[10.5px] leading-none font-semibold whitespace-nowrap', dim && 'opacity-40')}
      style={{
        color: `color-mix(in oklab, ${c} 72%, white)`,
        background: `color-mix(in oklab, ${c} 15%, transparent)`,
        borderColor: `color-mix(in oklab, ${c} 32%, transparent)`
      }}
    >
      {LABEL[label.toLowerCase()] ?? label}
    </span>
  )
}

function languages(m: CatalogModel): string[] {
  const set = new Set((m.voices ?? []).map((v) => v.language?.split('-')[0]?.toUpperCase()).filter((x): x is string => !!x))
  if (set.size > 3) return ['Multilingual']
  return [...set]
}

/** Every chip for a model card, most important first. */
export function ModelTags({ m, className, max = 9 }: { m: CatalogModel; className?: string; max?: number }): React.JSX.Element {
  const chips: { label: string; tone?: string; dim?: boolean; title?: string }[] = []
  for (const b of ['npu', 'gpu', 'cpu'] as DeviceBackend[]) {
    if (!m.backends.includes(b)) continue
    const here = backendAvailableFor(m, b)
    chips.push({ label: b, dim: !here, title: here ? `Runs on the ${b.toUpperCase()}` : `No ${b.toUpperCase()} support on this phone` })
  }
  if (m.variant) chips.push({ label: m.variant })
  if (m.custom) chips.push({ label: m.source === 'import' ? 'Imported' : m.source === 'civitai' ? 'Civitai' : m.source === 'huggingface' ? 'Hugging Face' : 'Link', tone: TONE.custom })
  for (const t of m.tags ?? []) {
    const quant = /^(i?q\d|bf16|f16|fp16|fp8|int\d)/i.test(t)
    chips.push({ label: quant ? t.toUpperCase() : t.charAt(0).toUpperCase() + t.slice(1), tone: toneOf(t) })
  }
  for (const l of languages(m)) chips.push({ label: l, tone: l === 'Multilingual' ? TONE.multilingual : TONE.lang })
  if (m.task === 'text' && m.contextLength && m.contextLength >= 8192) chips.push({ label: `${Math.round(m.contextLength / 1024)}K ctx`, tone: TONE.neutral })
  if (m.task === 'image' && m.resolution) chips.push({ label: `${m.resolution}px`, tone: TONE.neutral })
  if (m.sizeBytes) chips.push({ label: sizeText(m.sizeBytes), tone: TONE.neutral })
  const shown = chips.slice(0, max)
  return (
    <div className={cn('flex flex-wrap items-center gap-1', className)}>
      {shown.map((c, i) => (
        <Tag key={`${c.label}-${i}`} {...c} />
      ))}
      {chips.length > shown.length && <span className="text-[10.5px] text-fg-3">+{chips.length - shown.length}</span>}
    </div>
  )
}
