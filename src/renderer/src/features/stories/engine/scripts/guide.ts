// Instructions an LLM can follow to write scripts that run in Stitch and in
// AI Dungeon alike. Keep it accurate to runtime.ts / sandbox.worker.ts.

export const AID_SCRIPTING_GUIDE = `# Writing AI Dungeon story scripts (Stitch-compatible)

A script has four plain-JavaScript tabs: Library, Input, Context and Output.
For each hook, the Library code is prepended to that hook's code and the two run together as one fresh sloppy-mode script. Nothing but \`state\` and the story cards survives between runs, so keep every persistent value in \`state\`.

## Hooks
- Input: runs on the player's action before it is added. \`text\` is the formatted action, e.g. "\\n> You open the door.\\n" (Do), "\\n> You say \\"Hi.\\"\\n" (Say) or "\\nThe door opens.\\n" (Story). Returning \`stop: true\` cancels the turn. Returning empty text is an error — return "\\n" to blank the action instead.
- Context: runs on the full context right before the model is called. Return the (possibly rewritten) context. Empty text means "use the context as if the script had not run". \`stop: true\` aborts the turn ("the AI is stumped").
- Output: runs on the model's reply before it is shown and saved. Returning empty text is an error.

Every hook tab must end with the modifier pattern — its last expression is the result:
\`\`\`js
const modifier = (text) => {
  // change text here
  return { text }            // Context may also return { text, stop }
}
modifier(text)
\`\`\`
Put shared functions in the Library and call them from the hooks, e.g. Input: \`text = MyScript("input", text)\` inside the modifier.

## Context layout (what the Context hook receives)
\`\`\`
{Plot Essentials}

World Lore:
{story card entry}

{story card entry}

Story Summary:
{summary}

Memories:
{memory}

Recent Story:
{older actions}
> You do something.
{AI continuation}
[Author's note: {author's note}]
{last action}
{front memory}
\`\`\`
Sections without content are omitted. AI Instructions are sent separately (system prompt) and are not part of \`text\`. Player actions are lines starting with "> ".

## Globals
- \`text\` (string): the hook's input. \`stop\` (boolean, false).
- \`state\` (object): persistent per adventure, shared by all scripts. Must be JSON-serializable. Special fields:
  - \`state.memory.context\` / \`state.memory.authorsNote\` override Plot Essentials / Author's Note from the next context on; \`state.memory.frontMemory\` is added after the last action. Empty strings mean "not set".
  - \`state.message\` (string): shown to the player as a notification when it changes.
- \`info\`: \`actionCount\` (number of actions so far), \`characters\` / \`characterNames\` (player names). Context hook only: \`maxChars\` (characters the context may use) and \`memoryLength\` (characters of the memory block). \`info.maxChars\` is undefined in the other hooks — scripts use that to tell hooks apart.
- \`history\`: the most recent actions (up to 100), oldest first: \`{ text, rawText, type }\` with type "start" | "continue" | "do" | "say" | "story" | "see". Read-only.
- \`storyCards\`: array of \`{ id, title, keys, entry, type, description, createdAt, updatedAt, useForCharacterCreation }\`. \`keys\` is a comma-separated trigger list; \`entry\` is what the model sees when a key appears in the recent story; \`description\` holds notes (a good place for per-card data). Cards may be edited in place, reordered, or spliced out; changes are saved after the hook.
- \`addStoryCard(keys, entry, type = "Custom", title = keys, description = "", { returnCard })\` → pushes a new card and returns the new length of storyCards (or the card object itself with \`{ returnCard: true }\`), or false if a card with identical keys exists.
- \`updateStoryCard(index, keys, entry, type, title?, description?)\` / \`removeStoryCard(index)\` → throw if there is no card at that index; omitted values are kept.
- \`log(...values)\` / \`console.log(...)\`: write to the script log.

## Limits
- About 1.5 seconds per script per hook; longer runs are killed. Keep loops bounded.
- No network, timers, storage, workers, import() or eval tricks: fetch, XMLHttpRequest, setTimeout and friends do not exist.
- Wrap risky parsing in try/catch. A script that throws is skipped for that hook and its changes are discarded.
- Keep \`state\` small (well under 40 KB of JSON) and namespaced, e.g. \`state.myScript = state.myScript ?? { turns: 0 }\`.

## Example: count turns and remind the model of the time of day
Library:
\`\`\`js
function clock() {
  state.clock ??= { turn: 0 }
  return state.clock
}
\`\`\`
Input:
\`\`\`js
const modifier = (text) => {
  clock().turn++
  return { text }
}
modifier(text)
\`\`\`
Context:
\`\`\`js
const modifier = (text) => {
  const hour = (8 + clock().turn) % 24
  const note = \`[It is now \${hour}:00.]\`
  return { text: text.replace(/(Recent Story:\\n)/, \`\${note}\\n\\n$1\`) }
}
modifier(text)
\`\`\`
Output:
\`\`\`js
const modifier = (text) => ({ text })
modifier(text)
\`\`\`
`
