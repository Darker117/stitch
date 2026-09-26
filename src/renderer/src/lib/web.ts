// Web search for text models: the SearXNG bundled with Stitch (on the PC, and inside the phone app)
// behind two tools any chat model can call — `web_search` and `open_page`.
import type { LlmTool } from '@shared/ipc'
import { useSettings } from '@/stores/settings'
import { invoke } from './api'

export const WEB_TOOLS: LlmTool[] = [
  {
    name: 'web_search',
    description:
      "Search the web (private metasearch through SearXNG on the user's own devices). Use it for facts you aren't sure of, anything recent, real people, places, products, references and visual inspiration. Returns titles, URLs and snippets — open_page reads a result in full.",
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for, like you would type it into a search engine.' },
        time_range: { type: 'string', enum: ['day', 'week', 'month', 'year'], description: 'Only recent results.' },
        category: { type: 'string', enum: ['general', 'news', 'science', 'it', 'images', 'videos'] }
      },
      required: ['query']
    }
  },
  {
    name: 'open_page',
    description: 'Read a web page as plain text (articles, docs, wiki pages, recipes…). Use URLs from web_search results.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'http(s) URL' } },
      required: ['url']
    }
  }
]

export const WEB_TOOL_NAMES = new Set(WEB_TOOLS.map((t) => t.name))

/** Settings → Skills → Web search: are the tools on? */
export function webEnabled(): boolean {
  return useSettings.getState().settings?.web?.enabled !== false
}

/** System-prompt lines that teach a model when to reach for the web. */
export const WEB_GUIDE = `- You can search the web with web_search and read pages with open_page. Use them whenever an answer depends on facts you aren't sure of, recent events, or specific real-world details: search, open the one or two most relevant results, then answer and cite the pages you used as markdown links. Don't search for purely creative requests.`

const CATEGORIES = new Set(['general', 'news', 'science', 'it', 'images', 'videos'])
const RANGES = new Set(['day', 'week', 'month', 'year'])

/** Run a web tool call and return the JSON text handed back to the model. */
export async function runWebTool(name: string, args: Record<string, unknown>): Promise<string> {
  if (name === 'web_search') {
    const query = String(args.query ?? '').trim()
    if (!query) return JSON.stringify({ ok: false, error: 'Empty query' })
    const category = typeof args.category === 'string' && CATEGORIES.has(args.category) ? (args.category as 'general') : undefined
    const timeRange = typeof args.time_range === 'string' && RANGES.has(args.time_range) ? (args.time_range as 'day') : undefined
    const r = await invoke('web:search', { query, category, timeRange })
    return JSON.stringify({
      ok: true,
      query: r.query,
      answers: r.answers.length ? r.answers.slice(0, 3) : undefined,
      infobox: r.infobox ? { title: r.infobox.title, text: r.infobox.text.slice(0, 700), url: r.infobox.url } : undefined,
      results: r.results.map((x, i) => ({ n: i + 1, title: x.title, url: x.url, snippet: x.snippet.slice(0, 320), published: x.published })),
      note: r.results.length ? undefined : 'No results — try different words.'
    })
  }
  if (name === 'open_page') {
    const url = String(args.url ?? '').trim()
    if (!/^https?:\/\//i.test(url)) return JSON.stringify({ ok: false, error: 'open_page needs a full http(s) URL' })
    const p = await invoke('web:page', url, 7000)
    return JSON.stringify({ ok: true, url: p.url, title: p.title, text: p.text, truncated: p.truncated || undefined })
  }
  return JSON.stringify({ ok: false, error: `Unknown tool ${name}` })
}

/** Sources listed in a finished web_search result (for the chat's tool card). */
export function searchSources(result: string | undefined): { title: string; url: string }[] {
  try {
    const j = JSON.parse(result ?? '') as { results?: { title?: string; url?: string }[] }
    return (j.results ?? []).filter((x): x is { title: string; url: string } => !!x.url).map((x) => ({ title: x.title || x.url, url: x.url }))
  } catch {
    return []
  }
}
