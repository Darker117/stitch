// Small pieces shared by the script screens.
import type { StoryScript } from '@shared/types'
import { Check } from 'lucide-react'
import { Badge } from '@/components/ui/misc'
import { cn } from '@/lib/utils'
import { builtin } from '../../engine/scripts/builtin'
import { scriptHooks, scriptKindLabel } from '../../engine/scripts/library'
import { HOOK_LABEL } from '../../engine/scripts/runtime'
import type { HookName } from '../../engine/scripts/types'

export function KindBadge({ script }: { script: Pick<StoryScript, 'source'> }): React.JSX.Element {
  return <Badge tone={script.source === 'builtin' ? 'accent' : script.source === 'import' ? 'outline' : 'default'}>{scriptKindLabel(script)}</Badge>
}

/** Library / Input / Context / Output, lit when the script has code there. */
export function HookChips({ script, className }: { script: StoryScript; className?: string }): React.JSX.Element {
  const hooks = scriptHooks(script)
  const hasLibrary = !!builtin(script.id) || !!script.library.trim()
  const all: (HookName | 'library')[] = ['library', 'input', 'context', 'output']
  return (
    <div className={cn('flex flex-wrap gap-1.5', className)}>
      {all.map((h) => {
        const on = h === 'library' ? hasLibrary : hooks.includes(h)
        return (
          <span
            key={h}
            className={cn(
              'inline-flex h-6 items-center gap-1 rounded-full border px-2 text-[11px] font-medium',
              on ? 'border-[color-mix(in_oklab,var(--accent)_35%,transparent)] bg-[color-mix(in_oklab,var(--accent)_10%,transparent)] text-fg' : 'border-line text-fg-3'
            )}
          >
            {on && <Check className="size-3 text-accent" strokeWidth={2.5} />}
            {HOOK_LABEL[h]}
          </span>
        )
      })}
    </div>
  )
}

/** Monogram tile for a script (no per-script art). */
export function ScriptGlyph({ name, className }: { name: string; className?: string }): React.JSX.Element {
  const letters = name.replace(/[^\p{L}\p{N} ]/gu, '').split(/\s+/).filter(Boolean)
  const mono = (letters.length > 1 ? letters[0][0] + letters[1][0] : (letters[0] ?? '?').slice(0, 2)).toUpperCase()
  return (
    <span className={cn('grid size-9 shrink-0 place-items-center rounded-xl bg-grad-soft font-mono text-[11.5px] font-semibold text-fg ring-1 ring-line', className)}>
      {mono}
    </span>
  )
}
