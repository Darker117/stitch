// Wallpaper Engine shaders are GLSL with a few HLSL-isms, `#include`s and
// "combos" (compile-time switches). Uniforms carry JSON annotations naming the
// material value that feeds them and their defaults:
//
//   // [COMBO] {"material":"…","combo":"NOISE","type":"options","default":1}
//   uniform float g_Speed; // {"material":"speed","label":"…","default":1}
//   uniform sampler2D g_Texture1; // {"combo":"MASK","default":"util/white"}
//
// This module inlines includes, evaluates the preprocessor conditionals for a
// given set of combos, and reads the annotations. The renderer finishes the
// job (GLSL ES prelude, compile).

export interface UniformInfo {
  type: string
  name: string
  material?: string
  label?: string
  default?: unknown
  combo?: string
}

export interface Annotations {
  combos: Record<string, number>
  uniforms: Map<string, UniformInfo>
}

/** Pull the first balanced {...} JSON object out of a comment. */
function jsonIn(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inStr = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (inStr) {
      if (c === '\\') i++
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1)) as Record<string, unknown>
      } catch {
        return null
      }
    }
  }
  return null
}

export function parseAnnotations(...sources: string[]): Annotations {
  const combos: Record<string, number> = {}
  const uniforms = new Map<string, UniformInfo>()
  for (const src of sources) {
    for (const line of src.split(/\r?\n/)) {
      const combo = /^\s*\/\/\s*\[COMBO\]\s*(.*)$/.exec(line)
      if (combo) {
        const j = jsonIn(combo[1])
        if (j && typeof j.combo === 'string') combos[j.combo] = Number(j.default ?? 0) || 0
        continue
      }
      const u = /^\s*uniform\s+(?:(?:lowp|mediump|highp)\s+)?(\w+)\s+(\w+)\s*(?:\[[^\]]*\])?\s*;(.*)$/.exec(line)
      if (!u) continue
      const [, type, name, rest] = u
      const info: UniformInfo = uniforms.get(name) ?? { type, name }
      const comment = rest.indexOf('//')
      const j = comment >= 0 ? jsonIn(rest.slice(comment)) : null
      if (j) {
        if (typeof j.material === 'string') info.material = j.material
        if (typeof j.label === 'string') info.label = j.label
        if (j.default !== undefined) info.default = j.default
        if (typeof j.combo === 'string') info.combo = j.combo
      }
      uniforms.set(name, info)
    }
  }
  return { combos, uniforms }
}

// ─── Preprocessor ────────────────────────────────────────────────────────────

type Macro = { body: string; fn: boolean }

/** Evaluate a #if expression (C preprocessor rules: unknown identifiers are 0). */
function evaluate(expr: string, macros: Map<string, Macro>, depth = 0): number {
  const tokens = expr.match(/0[xX][0-9a-fA-F]+|\d+\.?\d*(?:[eE][-+]?\d+)?[fFuUlL]*|\.\d+|[A-Za-z_]\w*|\|\||&&|==|!=|<=|>=|<<|>>|[-+*/%()<>!~&|^?:,]/g) ?? []
  let i = 0
  const peek = (): string | undefined => tokens[i]
  const next = (): string | undefined => tokens[i++]

  const primary = (): number => {
    const t = next()
    if (t === undefined) return 0
    if (t === '(') {
      const v = ternary()
      if (peek() === ')') next()
      return v
    }
    if (t === 'defined') {
      let name = next()
      if (name === '(') {
        name = next()
        if (peek() === ')') next()
      }
      return name && macros.has(name) ? 1 : 0
    }
    if (/^[A-Za-z_]/.test(t)) {
      const m = macros.get(t)
      if (!m || m.fn) {
        // Function-like macro calls: skip the argument list, value 0.
        if (peek() === '(') {
          let d = 0
          do {
            const x = next()
            if (x === '(') d++
            else if (x === ')') d--
          } while (d > 0 && i < tokens.length)
        }
        return 0
      }
      if (depth > 16) return 0
      // An empty #define counts as "on".
      return m.body.trim() ? evaluate(m.body, macros, depth + 1) : 1
    }
    const n = t.replace(/[fFuUlL]+$/, '')
    return n.startsWith('0x') || n.startsWith('0X') ? parseInt(n, 16) : Number(n) || 0
  }
  const unary = (): number => {
    const t = peek()
    if (t === '!') return next(), unary() ? 0 : 1
    if (t === '-') return next(), -unary()
    if (t === '+') return next(), unary()
    if (t === '~') return next(), ~unary()
    return primary()
  }
  const binary = (ops: string[][], level: number): number => {
    if (level >= ops.length) return unary()
    let v = binary(ops, level + 1)
    while (ops[level].includes(peek() ?? '')) {
      const op = next()!
      const r = binary(ops, level + 1)
      switch (op) {
        case '||': v = v || r ? 1 : 0; break
        case '&&': v = v && r ? 1 : 0; break
        case '|': v = v | r; break
        case '^': v = v ^ r; break
        case '&': v = v & r; break
        case '==': v = v === r ? 1 : 0; break
        case '!=': v = v !== r ? 1 : 0; break
        case '<': v = v < r ? 1 : 0; break
        case '>': v = v > r ? 1 : 0; break
        case '<=': v = v <= r ? 1 : 0; break
        case '>=': v = v >= r ? 1 : 0; break
        case '<<': v = v << r; break
        case '>>': v = v >> r; break
        case '+': v = v + r; break
        case '-': v = v - r; break
        case '*': v = v * r; break
        case '/': v = r ? Math.trunc(v / r) : 0; break
        case '%': v = r ? v % r : 0; break
      }
    }
    return v
  }
  const LEVELS = [['||'], ['&&'], ['|'], ['^'], ['&'], ['==', '!='], ['<', '>', '<=', '>='], ['<<', '>>'], ['+', '-'], ['*', '/', '%']]
  const ternary = (): number => {
    const c = binary(LEVELS, 0)
    if (peek() === '?') {
      next()
      const a = ternary()
      if (peek() === ':') next()
      const b = ternary()
      return c ? a : b
    }
    return c
  }
  try {
    return ternary()
  } catch {
    return 0
  }
}

function stripBlockComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''))
}

/**
 * Resolve includes and conditionals. `defines` are the combos; they're also
 * emitted as #defines so the shader body can use them. Macros the shader
 * defines itself stay in the output for the GLSL compiler.
 */
export function preprocess(source: string, defines: Record<string, number>, include: (name: string) => string | null): string {
  const macros = new Map<string, Macro>()
  const out: string[] = []
  for (const [k, v] of Object.entries(defines)) {
    macros.set(k, { body: String(v), fn: false })
    out.push(`#define ${k} ${v}`)
  }
  const included = new Set<string>()
  // Conditional stack: active = this branch emits; taken = some branch of this #if already ran.
  const stack: { active: boolean; taken: boolean; parent: boolean }[] = []
  const active = (): boolean => (stack.length ? stack[stack.length - 1].active : true)

  const run = (src: string, depth: number): void => {
    const lines = stripBlockComments(src).split(/\r?\n/)
    for (let li = 0; li < lines.length; li++) {
      let line = lines[li]
      while (line.endsWith('\\') && li + 1 < lines.length) line = line.slice(0, -1) + lines[++li]
      const d = /^\s*#\s*(\w+)\s*(.*)$/.exec(line)
      if (!d) {
        if (active()) out.push(line)
        continue
      }
      const [, dir, restRaw] = d
      const rest = restRaw.replace(/\/\/.*$/, '').trim()
      switch (dir) {
        case 'if': {
          const on = active() && evaluate(rest, macros) !== 0
          stack.push({ active: on, taken: on, parent: active() })
          break
        }
        case 'ifdef':
        case 'ifndef': {
          const name = rest.split(/\s+/)[0]
          const has = macros.has(name)
          const on = active() && (dir === 'ifdef' ? has : !has)
          stack.push({ active: on, taken: on, parent: active() })
          break
        }
        case 'elif': {
          const top = stack[stack.length - 1]
          if (!top) break
          if (top.taken || !top.parent) top.active = false
          else {
            top.active = evaluate(rest, macros) !== 0
            top.taken = top.active
          }
          break
        }
        case 'else': {
          const top = stack[stack.length - 1]
          if (!top) break
          top.active = top.parent && !top.taken
          top.taken = true
          break
        }
        case 'endif':
          stack.pop()
          break
        default: {
          if (!active()) break
          if (dir === 'include') {
            const name = /["<]([^">]+)[">]/.exec(rest)?.[1]
            if (!name || included.has(name) || depth > 8) break
            included.add(name)
            const text = include(name)
            if (text != null) run(text, depth + 1)
            break
          }
          if (dir === 'define') {
            const m = /^([A-Za-z_]\w*)(\()?/.exec(rest)
            if (!m) break
            const name = m[1]
            const fn = !!m[2]
            // Redefinitions (including our combos) are errors in GLSL ES.
            if (macros.has(name)) out.push(`#undef ${name}`)
            macros.set(name, { body: fn ? '' : rest.slice(name.length).trim(), fn })
            out.push(line.replace(/\/\/.*$/, ''))
            break
          }
          if (dir === 'undef') {
            macros.delete(rest.split(/\s+/)[0])
            out.push(line)
            break
          }
          // #require, #version and friends are Wallpaper Engine / desktop GL specific.
          if (dir === 'require' || dir === 'version' || dir === 'extension') break
          out.push(line)
        }
      }
    }
  }
  run(source, 0)
  return out.join('\n')
}
