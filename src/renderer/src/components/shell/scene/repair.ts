// Line repairs for Wallpaper Engine shaders that lean on desktop GLSL / HLSL
// leniency (implicit int↔float conversion, vector truncation and broadcast,
// scalar-first min/max/pow, float array indices, int conditions). Each repair
// is small and only applied to a line the driver rejected, guided by the
// driver's own error message.

export interface RepairContext {
  intMacros: Set<string>
  ints: Set<string>
  /** Global varying/uniform vectors and their sizes. */
  vectors: Map<string, number>
}

/** Split `for (…)` into [header, rest]. */
function splitLoop(line: string): [string, string] {
  const loop = /^\s*for\s*\(/.exec(line)
  if (!loop) return ['', line]
  let depth = 0
  for (let i = loop[0].length - 1; i < line.length; i++) {
    if (line[i] === '(') depth++
    else if (line[i] === ')' && --depth === 0) return [line.slice(0, i + 1), line.slice(i + 1)]
  }
  return ['', line]
}

/** Integer literals → float literals, leaving indices, int declarations and loop headers alone. */
export function floatLiterals(line: string): string {
  const [head, body] = splitLoop(line)
  const fixed = body.replace(/(\d+)(?![\w.])/g, (m, digits: string, offset: number, str: string) => {
    const before = str.slice(0, offset)
    if (/[\w.]$/.test(before)) return m // part of an identifier, decimal or exponent
    if (/[\d.][eE][-+]?$/.test(before)) return m
    const trimmed = before.trimEnd()
    if (trimmed.endsWith('[')) return m
    if (/\b(?:int|uint|[iu]vec[234])\s*\(\s*$/.test(trimmed)) return m
    if (/\b(?:int|uint)\s+\w+\s*=\s*$/.test(trimmed)) return m
    if (/(?:<<|>>|%|&|\||\^)$/.test(trimmed)) return m
    return `${digits}.0`
  })
  return head + fixed
}

/** Wrap integer-valued macros in float(). */
function floatMacros(line: string, intMacros: Set<string>): string {
  if (!intMacros.size) return line
  return line.replace(/\b([A-Za-z_]\w*)\b/g, (m, id: string, offset: number, str: string) => {
    if (!intMacros.has(id)) return m
    const before = str.slice(0, offset).trimEnd()
    if (before.endsWith('[') || before.endsWith('float(')) return m
    return `float(${id})`
  })
}

/** Wrap int variables in float() (not indices, increments or declarations). */
function floatVariables(line: string, ints: Set<string>): string {
  if (!ints.size) return line
  if (/^\s*for\s*\(/.test(line)) {
    // Only a loop's condition compares against floats.
    const parts = line.split(';')
    if (parts.length >= 3) {
      parts[1] = floatVariables(parts[1], ints)
      return parts.join(';')
    }
  }
  return line.replace(/\b([A-Za-z_]\w*)\b/g, (m, id: string, offset: number, str: string) => {
    if (!ints.has(id)) return m
    const before = str.slice(0, offset)
    const after = str.slice(offset + id.length)
    const open = (before.match(/\[/g)?.length ?? 0) - (before.match(/\]/g)?.length ?? 0)
    if (open > 0) return m
    if (/\.\s*$/.test(before) || /\b(?:u?int)\s+$/.test(before)) return m
    // Already converted.
    if (/\b(?:int|uint|float)\s*\(\s*$/.test(before) && /^\s*\)/.test(after)) return m
    if (/^\s*(?:\+\+|--|[-+*/%]?=(?!=)|\[)/.test(after) || /(?:\+\+|--)\s*$/.test(before)) return m
    return `float(${id})`
  })
}

/** HLSL's `%` works on floats; GLSL wants mod(). */
function floatModulo(line: string): string {
  const operand = String.raw`(?:[A-Za-z_][\w.]*(?:\[[^\]]*\])?|\d+(?:\.\d*)?|\((?:[^()]|\([^()]*\))*\))`
  return line.replace(new RegExp(`(${operand})\\s*%\\s*(${operand})`, 'g'), 'mod(float($1), float($2))')
}

/** `texture(sampler, vec4)` → use .xy like HLSL's tex2D does. */
function textureCoords(line: string): string {
  return line.replace(/\b(texSample2D|texture|texture2D)\s*\(([^,()]+),\s*((?:[^()]|\([^()]*\))+?)\)/g, (m, fn: string, s: string, uv: string) =>
    /\.xy\s*\)?$/.test(uv.trim()) ? m : `${fn}(${s}, (${uv.trim()}).xy)`
  )
}

/** `vec2 a = 0.0, b = 0.0, c = x;` → one declaration each, converted. */
function splitDeclarations(line: string): string {
  const m = /^(\s*)((?:const\s+)?(?:(?:highp|mediump|lowp)\s+)?(?:[iu]?vec[234]|float|u?int))\s+(.+);(\s*\/\/.*)?$/.exec(line)
  if (!m) return line
  const parts = splitArgs(m[3])
  if (parts.length < 2) return line
  const type = m[2].replace(/^const\s+|(?:highp|mediump|lowp)\s+/g, '')
  return (
    m[1] +
    parts
      .map((p) => {
        const eq = p.indexOf('=')
        return eq < 0 ? `${m[2]} ${p.trim()};` : `${m[2]} ${p.slice(0, eq).trim()} = ${type}(${p.slice(eq + 1).trim()});`
      })
      .join(' ') +
    (m[4] ?? '')
  )
}

/** Top-level comma split of a call's argument list. */
function splitArgs(s: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of s) {
    if (ch === '(' || ch === '[') depth++
    else if (ch === ')' || ch === ']') depth--
    if (ch === ',' && depth === 0) {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out
}

/** `max(0.0, v3)` and friends: give every argument the widest argument's type. */
function broadcastCalls(line: string, names: Set<string>): string {
  let out = ''
  let i = 0
  const re = /\b([A-Za-z_]\w*)\s*\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(line))) {
    if (!names.has(m[1])) continue
    const open = m.index + m[0].length - 1
    let depth = 0
    let close = -1
    for (let j = open; j < line.length; j++) {
      if (line[j] === '(') depth++
      else if (line[j] === ')' && --depth === 0) {
        close = j
        break
      }
    }
    if (close < 0) break
    const args = splitArgs(line.slice(open + 1, close))
    if (args.length < 2 || args.length > 3) continue
    const zero = (a: string): string => `(${a.trim()}) * 0.0`
    const widened = args.map((a, k) => `(${a.trim()} + ${args.filter((_, o) => o !== k).map(zero).join(' + ')})`)
    out += line.slice(i, open + 1) + widened.join(', ') + ')'
    i = close + 1
    re.lastIndex = close + 1
  }
  return out + line.slice(i)
}

/** Position just after the first assignment operator (`=`, `+=`, …, not comparisons). */
function assignment(line: string): number {
  const m = /(?:[-+*/]?=)(?!=)/g
  let hit: RegExpExecArray | null
  while ((hit = m.exec(line))) {
    const prev = line[hit.index - 1] ?? ''
    if (hit[0] === '=' && /[=<>!]/.test(prev)) continue
    return hit.index + hit[0].length
  }
  return -1
}

type Kind = { dim: number; int: boolean } | null

function kindOf(t: string): Kind {
  const v = /(\d)-component vector of (float|int)/.exec(t)
  if (v) return { dim: Number(v[1]), int: v[2] === 'int' }
  if (/\bu?int\b/.test(t)) return { dim: 1, int: true }
  if (/\b(?:float|bool)\b/.test(t)) return { dim: 1, int: false }
  return null
}

/** Convert an assignment's right-hand side to the type the driver asked for. */
function convertAssignment(line: string, err: string): string {
  const m = /cannot convert from '([^']*)' to '([^']*)'/.exec(err)
  if (!m) return line
  const from = kindOf(m[1])
  const to = kindOf(m[2])
  if (!from || !to) return line
  const unsigned = /\buint\b/.test(m[2])
  const wrap = (rhs: string): string => {
    const e = rhs.trim()
    if (to.dim === 1 && to.int) return `${unsigned ? 'uint' : 'int'}(${from.dim > 1 ? `(${e}).x` : e})`
    if (to.dim === 1) return from.dim > 1 ? `(${e}).x` : `float(${e})`
    const vec = `${to.int ? 'i' : ''}vec${to.dim}`
    if (from.dim === 1) return `${vec}(${e})`
    if (from.dim > to.dim) return `${vec}((${e}).${'xyzw'.slice(0, to.dim)})`
    return `${vec}(${e})`
  }
  if (/^\s*for\s*\(/.test(line)) {
    const parts = line.split(';')
    const at = assignment(parts[0])
    if (at < 0) return line
    parts[0] = parts[0].slice(0, at) + ' ' + wrap(parts[0].slice(at))
    return parts.join(';')
  }
  const at = assignment(line)
  const end = line.indexOf(';', Math.max(at, 0))
  if (at < 0 || end < at) return line
  const rhs = line.slice(at, end)
  // Several declarations on one line: too ambiguous.
  if (splitArgs(rhs).length > 1) return line
  return `${line.slice(0, at)} ${wrap(rhs)}${line.slice(end)}`
}

/** `if (INT)` / `INT ? a : b` → bool(INT). */
function boolCondition(line: string): string {
  const cond = line.replace(/\b(if|while)\s*\((.*)\)(\s*\{?\s*)$/, (_m, kw: string, c: string, tail: string) => `${kw} (bool(${c}))${tail}`)
  if (cond !== line) return cond
  return line.replace(/(=\s*)([^=?;]+?)\s*\?/, (_m, eq: string, c: string) => `${eq}bool(${c}) ?`)
}

/** Float expressions used as array indices → int(). */
function intIndices(line: string): string {
  return line.replace(/\[([^[\]]+)\]/g, (m, inner: string) => (/^\s*\d+\s*$/.test(inner) || /^\s*int\(/.test(inner) ? m : `[int(${inner})]`))
}

/** HLSL truncates the bigger vector in mixed-size math; swizzle global vectors down to the smaller size. */
function truncateVectors(line: string, err: string, vectors: Map<string, number>): string {
  const dims = [...err.matchAll(/(\d)-component vector/g)].map((m) => Number(m[1]))
  if (dims.length < 2) return line
  const k = Math.min(...dims)
  const big = Math.max(...dims)
  if (k === big) return line
  const swz = 'xyzw'.slice(0, k)
  return line.replace(/\b([A-Za-z_]\w*)\b/g, (m, id: string, offset: number, str: string) => {
    const d = vectors.get(id)
    if (d === undefined || d <= k) return m
    if (/\.\s*$/.test(str.slice(0, offset)) || /^\s*[.[]/.test(str.slice(offset + id.length))) return m
    return `${id}.${swz}`
  })
}

const MATH = new Set(['max', 'min', 'pow', 'step', 'mod', 'atan', 'distance', 'dot', 'mix', 'clamp', 'smoothstep', 'reflect', 'cross'])

/**
 * The next repair for a rejected line, or the same line when we've run out
 * of ideas. `used` remembers which repairs this line already had.
 */
export function repairLine(line: string, err: string, ctx: RepairContext, used: Set<string>): string {
  if (/^\s*#/.test(line)) return line
  const overloads = new Set([...err.matchAll(/'(\w+)' : no matching overloaded function found/g)].map((m) => m[1]).filter((n) => MATH.has(n)))
  const candidates: [string, () => string][] = [
    ['declarations', () => (/cannot convert from/.test(err) ? splitDeclarations(line) : line)],
    ['modulo', () => (/'%' : wrong operand types/.test(err) ? floatModulo(line) : line)],
    ['literals', () => floatLiterals(line)],
    ['bool', () => (/boolean expression expected/.test(err) ? boolCondition(line) : line)],
    ['index', () => (/integer expression required/.test(err) ? intIndices(line) : line)],
    ['texture', () => (/'texture' : no matching overloaded function/.test(err) ? textureCoords(line) : line)],
    ['truncate', () => (/-component vector/.test(err) ? truncateVectors(line, err, ctx.vectors) : line)],
    ['overload', () => (overloads.size ? broadcastCalls(line, overloads) : line)],
    ['variables', () => floatVariables(line, ctx.ints)],
    ['convert', () => (/cannot convert from/.test(err) ? convertAssignment(line, err) : line)],
    ['macros', () => floatMacros(line, ctx.intMacros)],
    ['convert2', () => (/cannot convert from/.test(err) ? convertAssignment(line, err) : line)]
  ]
  for (const [name, fix] of candidates) {
    if (used.has(name)) continue
    used.add(name)
    const next = fix()
    if (next !== line) return next
  }
  return line
}
