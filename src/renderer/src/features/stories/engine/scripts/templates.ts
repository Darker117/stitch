// Starter code for new scripts and empty hooks.
import type { StoryScript } from '@shared/types'
import type { HookName } from './types'

export const HOOK_TEMPLATE: Record<HookName, string> = {
  input: `// Input: runs on the player's action before it is added\nconst modifier = (text) => {\n  return { text }\n}\nmodifier(text)\n`,
  context: `// Context: runs on the full context before the model is called\nconst modifier = (text) => {\n  return { text, stop }\n}\nmodifier(text)\n`,
  output: `// Output: runs on the model's reply before it is shown\nconst modifier = (text) => {\n  return { text }\n}\nmodifier(text)\n`
}

export function newScriptDraft(name = 'New script'): Partial<StoryScript> & { name: string } {
  return { name, library: '// Shared code for every hook goes here.\n', input: HOOK_TEMPLATE.input, context: HOOK_TEMPLATE.context, output: HOOK_TEMPLATE.output }
}
