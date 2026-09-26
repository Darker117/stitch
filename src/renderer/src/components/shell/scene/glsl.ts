// Wallpaper Engine shaders (GLSL with HLSL-isms, written for desktop GL's
// lenient rules) → WebGL2 GLSL ES 3.00. Includes and combos were resolved in
// the main process; here we add a compatibility prelude and compile. When the
// driver rejects lines we repair just those lines (see repair.ts) and retry.
import { repairLine, type RepairContext } from './repair'

const COMPAT: [string, string][] = [
  ['GLSL', '1'],
  ['texSample2D', 'texture'],
  ['texSample2DLod', 'textureLod'],
  ['texture2D', 'texture'],
  ['texture2DLod', 'textureLod'],
  ['frac', 'fract'],
  ['lerp', 'mix'],
  ['saturate(x)', 'clamp((x), 0.0, 1.0)'],
  ['mul(x, y)', '((y) * (x))'],
  ['CAST2(x)', '(vec2(x))'],
  ['CAST3(x)', '(vec3(x))'],
  ['CAST4(x)', '(vec4(x))'],
  ['CAST3X3(x)', '(mat3(x))'],
  ['atan2', 'atan'],
  ['ddx', 'dFdx'],
  ['ddy(x)', 'dFdy(-(x))'],
  ['fmod(x, y)', '((x) - (y) * trunc((x) / (y)))'],
  ['log10(x)', '(log2(x) * 0.30102999566)'],
  ['rsqrt', 'inversesqrt'],
  ['clip(x)', 'if ((x) < 0.0) discard'],
  ['texSample2DCompare(s, uv, c)', '(1.0)']
]

/** Words GLSL ES 3.00 reserves that desktop shaders happily use as names. */
const RESERVED =
  /\b(sample|input|output|filter|half|fixed|common|active|buffer|shared|patch|resource|partition|superp|cast|namespace|using|packed|inline|noinline|volatile|public|static|extern|external|interface|long|short|double|unsigned|goto|class|union|enum|typedef|template|this|coherent|restrict|readonly|writeonly|noperspective|subroutine|sizeof|asm)\b/g

/**
 * Wallpaper Engine lets shared headers use uniforms the including shader
 * declares further down; move global uniform/varying declarations above the
 * first function so that compiles in GLSL ES too.
 */
function hoistDeclarations(body: string): string {
  const lines = body.split('\n')
  let depth = 0
  let firstBlock = -1
  const moved: string[] = []
  const keep: string[] = []
  for (const line of lines) {
    const global = depth === 0
    if (global && firstBlock >= 0 && /^\s*(?:uniform|varying|attribute)\b[^{]*;/.test(line)) moved.push(line)
    else keep.push(line)
    if (global && firstBlock < 0 && line.includes('{')) {
      // The function's signature may sit on the line above a lone brace.
      let at = keep.length - 1
      if (/^\s*\{/.test(line)) {
        at--
        while (at > 0 && !keep[at].trim()) at--
      }
      firstBlock = Math.max(0, at)
    }
    for (const ch of line.replace(/\/\/.*$/, '')) {
      if (ch === '{') depth++
      else if (ch === '}') depth = Math.max(0, depth - 1)
    }
  }
  if (!moved.length || firstBlock < 0) return body
  keep.splice(firstBlock, 0, ...moved)
  return keep.join('\n')
}

function assemble(stage: 'vs' | 'fs', body: string): string {
  const own = new Set([...body.matchAll(/^\s*#\s*define\s+([A-Za-z_]\w*)/gm)].map((m) => m[1]))
  const lines = ['#version 300 es', 'precision highp float;', 'precision highp int;', 'precision highp sampler2D;']
  if (stage === 'vs') lines.push('#define attribute in', '#define varying out')
  else lines.push('#define varying in', 'out vec4 stitch_FragColor;', '#define gl_FragColor stitch_FragColor')
  for (const [name, value] of COMPAT) {
    const id = name.replace(/\(.*$/, '')
    if (!own.has(id)) lines.push(`#define ${name} ${value}`)
  }
  const cleaned = body.replace(/^\s*#\s*version.*$/gm, '').replace(RESERVED, (w) => `${w}_`)
  return `${lines.join('\n')}\n${hoistDeclarations(cleaned)}`
}

/**
 * Make a fragment-shader input writable (desktop GLSL allows assigning to
 * varyings) or give it a different type than the vertex shader's output:
 * the input gets a new name and main() starts by copying it into a global.
 */
function localVarying(frag: string, name: string, localType: string, inputType: string): string {
  const decl = new RegExp(`^(\\s*)varying\\s+(?:(?:highp|mediump|lowp)\\s+)?\\w+\\s+${name}\\s*;`, 'm')
  if (!decl.test(frag)) return frag
  const dim = (t: string): number => (t === 'float' ? 1 : Number(/vec(\d)/.exec(t)?.[1] ?? 1))
  const from = dim(inputType)
  const to = dim(localType)
  const value =
    from === to ? `${name}_in` : from > to ? `${localType}(${name}_in.${'xyzw'.slice(0, to)})` : `${localType}(${name}_in${', 0.0'.repeat(to - from)})`
  let out = frag.replace(decl, `$1varying ${inputType} ${name}_in;\n$1${localType} ${name};`)
  out = out.replace(/(\bvoid\s+main\s*\(\s*(?:void)?\s*\)\s*\{)/, `$1\n\t${name} = ${value};`)
  return out
}

function compileStage(gl: WebGL2RenderingContext, type: number, source: string): { shader?: WebGLShader; log?: string; source: string } {
  let lines = source.split('\n')
  const ctx: RepairContext = {
    intMacros: new Set([...source.matchAll(/^\s*#\s*define\s+([A-Za-z_]\w*)\s+-?\d+\s*$/gm)].map((m) => m[1])),
    ints: new Set([...source.matchAll(/\b(?:const\s+)?(?:(?:highp|mediump|lowp)\s+)?u?int\s+([A-Za-z_]\w*)\s*(?=[=;,)])/g)].map((m) => m[1])),
    vectors: new Map(
      [...source.matchAll(/^\s*(?:varying|uniform|in|out)\s+(?:(?:highp|mediump|lowp)\s+)?vec([234])\s+([A-Za-z_]\w*)\s*;/gm)].map((m) => [m[2], Number(m[1])] as [string, number])
    )
  }
  const used = new Map<number, Set<string>>()
  const whole = new Set<string>()
  let log = ''
  for (let round = 0; round < 80; round++) {
    const shader = gl.createShader(type)!
    gl.shaderSource(shader, lines.join('\n'))
    gl.compileShader(shader)
    if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return { shader, source: lines.join('\n') }
    log = gl.getShaderInfoLog(shader) ?? ''
    gl.deleteShader(shader)
    // Whole-shader repairs first: they change line numbers.
    const builtin = /'(\w+)' : Name of a built-in function cannot be redeclared/.exec(log)?.[1]
    if (builtin && !whole.has(`b:${builtin}`)) {
      whole.add(`b:${builtin}`)
      lines = lines.join('\n').replace(new RegExp(`\\b${builtin}\\s*\\(`, 'g'), `${builtin}_wp(`).split('\n')
      used.clear()
      continue
    }
    const input = /can't modify an input "(\w+)"/.exec(log)?.[1]
    if (input && type === gl.FRAGMENT_SHADER && !whole.has(`v:${input}`)) {
      whole.add(`v:${input}`)
      const t = new RegExp(`varying\\s+(?:(?:highp|mediump|lowp)\\s+)?(\\w+)\\s+${input}\\s*;`).exec(lines.join('\n'))?.[1]
      if (t) {
        lines = localVarying(lines.join('\n'), input, t, t).split('\n')
        used.clear()
        continue
      }
    }
    const errors = new Map<number, string>()
    for (const m of log.matchAll(/ERROR:\s*\d+:(\d+):([^\n]*)/g)) {
      const n = Number(m[1]) - 1
      if (n >= 0 && n < lines.length) errors.set(n, (errors.get(n) ?? '') + m[2])
    }
    let changed = false
    for (const [n, err] of errors) {
      const tried = used.get(n) ?? new Set<string>()
      used.set(n, tried)
      const next = repairLine(lines[n], err, ctx, tried)
      if (next !== lines[n]) {
        lines[n] = next
        changed = true
      }
    }
    if (!changed) break
  }
  // Quote the offending lines so failures are diagnosable.
  const quoted = [...new Set([...log.matchAll(/ERROR:\s*\d+:(\d+):/g)].map((m) => Number(m[1]) - 1))]
    .slice(0, 3)
    .map((n) => `  > ${lines[n]?.trim()}`)
    .join('\n')
  return { log: `${log.replace(/\0/g, '').trim()}\n${quoted}`, source: lines.join('\n') }
}

export interface UniformSlot {
  loc: WebGLUniformLocation
  type: number
  size: number
}

export interface CompiledProgram {
  program: WebGLProgram
  uniforms: Map<string, UniformSlot>
  /** Sampler uniform → texture unit. */
  samplers: Map<string, number>
}

export const ATTR_POSITION = 0
export const ATTR_TEXCOORD = 1

/** Compile a Wallpaper Engine program. Returns an error string when the driver won't take it. */
export function compileProgram(gl: WebGL2RenderingContext, vert: string, frag: string): CompiledProgram | string {
  let vertSrc = assemble('vs', vert)
  let fragSrc = assemble('fs', frag)
  let program: WebGLProgram | null = null
  for (let attempt = 0; attempt < 4 && !program; attempt++) {
    const vs = compileStage(gl, gl.VERTEX_SHADER, vertSrc)
    if (!vs.shader) return `vertex: ${vs.log?.slice(0, 600)}`
    const fs = compileStage(gl, gl.FRAGMENT_SHADER, fragSrc)
    if (!fs.shader) {
      gl.deleteShader(vs.shader)
      return `fragment: ${fs.log?.slice(0, 600)}`
    }
    const p = gl.createProgram()!
    gl.attachShader(p, vs.shader)
    gl.attachShader(p, fs.shader)
    gl.bindAttribLocation(p, ATTR_POSITION, 'a_Position')
    gl.bindAttribLocation(p, ATTR_TEXCOORD, 'a_TexCoord')
    gl.linkProgram(p)
    gl.deleteShader(vs.shader)
    gl.deleteShader(fs.shader)
    if (gl.getProgramParameter(p, gl.LINK_STATUS)) {
      program = p
      break
    }
    const log = gl.getProgramInfoLog(p) ?? ''
    gl.deleteProgram(p)
    // HLSL passes e.g. a float4 texcoord to a float2 input; give the fragment shader what the vertex shader writes.
    const name = /varying '(\w+)' differ/.exec(log)?.[1] ?? /FRAGMENT varying (\w+) does not match/.exec(log)?.[1]
    const typeIn = (src: string): string | undefined => (name ? new RegExp(`varying\\s+(?:(?:highp|mediump|lowp)\\s+)?(\\w+)\\s+${name}\\s*;`).exec(src)?.[1] : undefined)
    const vsType = typeIn(vs.source)
    const fsType = typeIn(fs.source)
    // The fragment shader's input was renamed to make it writable: follow it in the vertex shader.
    if (name?.endsWith('_in') && !vsType && fsType) {
      const base = name.slice(0, -3)
      if (new RegExp(`\\b${base}\\b`).test(vs.source)) {
        vertSrc = vs.source.replace(new RegExp(`\\b${base}\\b`, 'g'), name)
        fragSrc = fs.source
        continue
      }
    }
    if (!name || !vsType || !fsType || vsType === fsType) return `link: ${log.slice(0, 600)}`
    vertSrc = vs.source.replace(new RegExp(`\\b${name}\\b`, 'g'), `${name}_in`)
    fragSrc = localVarying(fs.source, name, fsType, vsType)
  }
  if (!program) return 'link: could not match varyings'
  const uniforms = new Map<string, UniformSlot>()
  const samplers = new Map<string, number>()
  const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number
  let nextUnit = 8
  gl.useProgram(program)
  for (let i = 0; i < count; i++) {
    const info = gl.getActiveUniform(program, i)
    if (!info) continue
    const loc = gl.getUniformLocation(program, info.name)
    if (!loc) continue
    const name = info.name.replace(/\[0\]$/, '')
    uniforms.set(name, { loc, type: info.type, size: info.size })
    if (info.type === gl.SAMPLER_2D) {
      const m = /^g_Texture(\d+)$/.exec(name)
      const unit = m && Number(m[1]) < 8 ? Number(m[1]) : Math.min(nextUnit++, 15)
      samplers.set(name, unit)
      gl.uniform1i(loc, unit)
    }
  }
  return { program, uniforms, samplers }
}

/** Upload a material/engine value, whatever shape it arrived in. */
export function setUniform(gl: WebGL2RenderingContext, u: UniformSlot, value: number | ArrayLike<number> | boolean): void {
  const arr = typeof value === 'number' ? [value] : typeof value === 'boolean' ? [value ? 1 : 0] : value
  const vecN = (n: number): number[] => {
    const out: number[] = []
    for (let i = 0; i < n; i++) out.push(arr.length === 1 ? (i === 3 && n === 4 ? 1 : arr[0]) : (arr[i] ?? (i === 3 ? 1 : 0)))
    return out
  }
  switch (u.type) {
    case gl.FLOAT:
      if (u.size > 1) {
        const buf = new Float32Array(u.size)
        for (let i = 0; i < u.size && i < arr.length; i++) buf[i] = arr[i]
        gl.uniform1fv(u.loc, buf)
      } else gl.uniform1f(u.loc, arr[0] ?? 0)
      break
    case gl.FLOAT_VEC2:
      gl.uniform2fv(u.loc, vecN(2))
      break
    case gl.FLOAT_VEC3:
      gl.uniform3fv(u.loc, vecN(3))
      break
    case gl.FLOAT_VEC4:
      gl.uniform4fv(u.loc, vecN(4))
      break
    case gl.INT:
    case gl.BOOL:
      gl.uniform1i(u.loc, Math.round(arr[0] ?? 0))
      break
    case gl.FLOAT_MAT4:
      if (arr.length >= 16) gl.uniformMatrix4fv(u.loc, false, arr as Float32Array)
      break
    case gl.FLOAT_MAT3:
      if (arr.length >= 9) gl.uniformMatrix3fv(u.loc, false, arr as Float32Array)
      break
  }
}
