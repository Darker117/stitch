// Lenient JSON for small local models: tolerates code fences, prose around the
// object, raw newlines inside strings, trailing commas and truncated output.

function extract(text: string): string | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)(?:```|$)/.exec(text)
  const body = fenced && fenced[1].includes('{') ? fenced[1] : text
  const start = body.indexOf('{')
  if (start < 0) return null
  const end = body.lastIndexOf('}')
  return end > start ? body.slice(start, end + 1) : body.slice(start)
}

/** Escape control characters inside strings and close anything left open. */
function repair(src: string): string {
  let out = ''
  let inStr = false
  let esc = false
  const stack: string[] = []
  for (const ch of src) {
    if (inStr) {
      if (esc) {
        esc = false
        out += ch
      } else if (ch === '\\') {
        esc = true
        out += ch
      } else if (ch === '"') {
        inStr = false
        out += ch
      } else if (ch === '\n') out += '\\n'
      else if (ch === '\r') continue
      else if (ch === '\t') out += '\\t'
      else out += ch
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') stack.push('}')
    else if (ch === '[') stack.push(']')
    else if ((ch === '}' || ch === ']') && stack[stack.length - 1] === ch) stack.pop()
    out += ch
  }
  if (inStr) out += '"'
  out = out.replace(/,\s*$/, '')
  // A key cut off before its value: `"key":` gets null, a bare `"key"` in an object is dropped.
  if (/:\s*$/.test(out)) out += 'null'
  else if (stack[stack.length - 1] === '}' && /[{,]\s*"[^"]*"\s*$/.test(out)) out = out.replace(/,?\s*"[^"]*"\s*$/, '')
  while (stack.length) out += stack.pop()
  return out.replace(/,\s*([}\]])/g, '$1')
}

export function looseJson<T = Record<string, unknown>>(text: string): T | null {
  const body = extract(text)
  if (!body) return null
  try {
    return JSON.parse(body) as T
  } catch {
    try {
      return JSON.parse(repair(body)) as T
    } catch {
      return null
    }
  }
}

/**
 * Read a (possibly still streaming) string value out of partial JSON, e.g.
 * the "reply" field while the rest of the object is still being written.
 */
export function partialString(text: string, key: string): string | undefined {
  const m = new RegExp(`"${key}"\\s*:\\s*"`).exec(text)
  if (!m) return undefined
  let out = ''
  for (let i = m.index + m[0].length; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\\') {
      const n = text[i + 1]
      if (n === undefined) break
      i++
      if (n === 'n') out += '\n'
      else if (n === 't') out += '\t'
      else if (n === 'u') {
        const hex = text.slice(i + 1, i + 5)
        if (hex.length < 4) break
        out += String.fromCharCode(parseInt(hex, 16))
        i += 4
      } else out += n
    } else if (ch === '"') break
    else out += ch
  }
  return out
}

/** Story text is plain prose: drop markdown emphasis/headings the model may add. */
export function stripMarkdown(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/(^|[^\w*])\*([^*\n]+)\*(?=[^\w*]|$)/g, '$1$2')
    .replace(/(^|\W)_([^_\n]+)_(?=\W|$)/g, '$1$2')
}

export function str(v: unknown, max = 5000): string {
  if (v === undefined || v === null) return ''
  if (Array.isArray(v)) return v.map((x) => str(x, max)).filter(Boolean).join('\n')
  if (typeof v === 'object') return ''
  return String(v).trim().slice(0, max)
}

export function strList(v: unknown, max = 12): string[] {
  if (Array.isArray(v)) return v.map((x) => str(x, 200)).filter(Boolean).slice(0, max)
  if (typeof v === 'string')
    return v
      .split(/[,\n]/)
      .map((x) => x.trim())
      .filter(Boolean)
      .slice(0, max)
  return []
}
