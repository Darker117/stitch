// Whitelist sanitizer for third-party HTML (Civitai model descriptions).
// Parses into an inert document and rebuilds only allowed elements; every
// other attribute (on*, style, class, id…) is dropped.

const ALLOWED = new Set(['p', 'br', 'strong', 'b', 'em', 'i', 'u', 'a', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'blockquote', 'code', 'pre', 'hr', 'img'])
/** Elements whose content is dropped entirely (not unwrapped). */
const DROP = new Set(['script', 'style', 'iframe', 'object', 'embed', 'noscript', 'template', 'svg', 'math', 'head', 'title', 'link', 'meta', 'form', 'input', 'button', 'textarea', 'select', 'video', 'audio', 'canvas', 'frame', 'frameset'])
/** Block elements mapped onto an allowed equivalent so paragraphs survive. */
const RENAME: Record<string, string> = { div: 'p', section: 'p', article: 'p', h5: 'h4', h6: 'h4' }

function safeUrl(raw: string | null): string | null {
  if (!raw) return null
  try {
    const url = new URL(raw.trim(), 'https://civitai.com/')
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
  } catch {
    return null
  }
}

export function sanitizeHtml(html: string | undefined | null): string {
  if (!html) return ''
  const src = new DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, 'text/html')
  const out = document.implementation.createHTMLDocument('')
  const root = out.createElement('div')

  const walk = (from: Node, to: Node, depth: number): void => {
    if (depth > 40) return
    for (const child of Array.from(from.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        to.appendChild(out.createTextNode(child.textContent ?? ''))
        continue
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue
      const el = child as Element
      const raw = el.tagName.toLowerCase()
      if (DROP.has(raw)) continue
      const tag = RENAME[raw] ?? raw
      if (!ALLOWED.has(tag)) {
        walk(el, to, depth + 1) // unwrap unknown elements, keep their text
        continue
      }
      const clean = out.createElement(tag)
      if (tag === 'a') {
        const href = safeUrl(el.getAttribute('href'))
        if (href) {
          clean.setAttribute('href', href)
          clean.setAttribute('target', '_blank')
          clean.setAttribute('rel', 'noopener noreferrer')
        }
      } else if (tag === 'img') {
        const url = safeUrl(el.getAttribute('src'))
        if (!url) continue
        clean.setAttribute('src', url)
        clean.setAttribute('alt', (el.getAttribute('alt') ?? '').slice(0, 200))
        clean.setAttribute('loading', 'lazy')
        clean.setAttribute('referrerpolicy', 'no-referrer')
      }
      walk(el, clean, depth + 1)
      // Skip empty paragraphs Civitai's editor leaves behind.
      if (tag === 'p' && !clean.textContent?.trim() && !clean.querySelector('img,br')) continue
      to.appendChild(clean)
    }
  }
  walk(src.body, root, 0)
  return root.innerHTML
}

/** Plain-text excerpt of HTML (for card blurbs). */
export function htmlToText(html: string | undefined | null, max = 240): string {
  if (!html) return ''
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const text = (doc.body.textContent ?? '').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}
