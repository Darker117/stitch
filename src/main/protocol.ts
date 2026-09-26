import { protocol } from 'electron'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'

/**
 * stitch://local/<abs path>      → any local file (the app's own UI only)
 * stitch://wp-<id>/<rel path>     → files inside one Wallpaper Engine item,
 *                                   so sandboxed web wallpapers can load their
 *                                   own assets but nothing else on disk.
 */
export const SCHEME = 'stitch'

export const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.opus': 'audio/ogg',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm'
}

const wallpaperDirs = new Map<string, string>()
/** Presets: their own folder (for files they add) and property values over the base wallpaper's. */
const wallpaperExtras = new Map<string, { fallback?: string; properties?: Record<string, unknown> }>()

export function registerWallpaperDir(id: string, dir: string, extra?: { fallback?: string; properties?: Record<string, unknown> }): void {
  const key = id.toLowerCase()
  wallpaperDirs.set(key, resolve(dir))
  if (extra) wallpaperExtras.set(key, { fallback: extra.fallback ? resolve(extra.fallback) : undefined, properties: extra.properties })
  else wallpaperExtras.delete(key)
}

/** Root folder of a registered wallpaper item (served to phones by the remote server too). */
export function wallpaperRoot(id: string): string | undefined {
  return wallpaperDirs.get(id.toLowerCase())
}

export function registerSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true, bypassCSP: true }
    }
  ])
}

/** Build a stitch://local URL for an absolute path. */
export function mediaUrl(absPath: string): string {
  const p = absPath.replace(/\\/g, '/')
  return `${SCHEME}://local/${encodeURI(p).replace(/#/g, '%23').replace(/\?/g, '%3F')}`
}

function resolveRequest(url: URL): string | null {
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '')
  if (url.hostname === 'local') {
    return normalize(rel)
  }
  if (url.hostname.startsWith('wp-')) {
    const id = url.hostname.slice(3)
    const root = wallpaperDirs.get(id)
    if (!root) return null
    const full = resolve(join(root, rel || 'index.html'))
    if (full !== root && !full.startsWith(root + sep)) return null
    // Presets keep the files they add (e.g. a custom background) in their own folder.
    const fallback = wallpaperExtras.get(id)?.fallback
    if (fallback && !existsSync(full)) {
      const alt = resolve(join(fallback, rel))
      if (alt.startsWith(fallback + sep) && existsSync(alt)) return alt
    }
    return full
  }
  return null
}

type WeProperty = { type?: string; value?: unknown; min?: number }

/** Property values the way Wallpaper Engine hands them to `applyUserProperties`. */
function weProperties(raw: Record<string, WeProperty>, overrides?: Record<string, unknown>): Record<string, { type: string; value: unknown }> {
  const out: Record<string, { type: string; value: unknown }> = {}
  for (const [key, p] of Object.entries(raw)) {
    if (!p || typeof p !== 'object') continue
    const type = String(p.type ?? '').toLowerCase()
    let value = overrides && overrides[key] !== undefined ? overrides[key] : p.value
    if (value === undefined && type === 'text') continue
    switch (type) {
      case 'bool':
        value = value === true || value === 1 || value === '1' || value === 'true'
        break
      case 'slider': {
        const n = Number(value)
        value = Number.isFinite(n) ? n : Number(p.min ?? 0)
        break
      }
      case 'color':
        value = Array.isArray(value) ? value.join(' ') : typeof value === 'string' ? value : '1 1 1'
        break
      case 'textinput':
      case 'file':
      case 'directory':
        value = value == null ? '' : String(value)
        break
    }
    out[key] = { type, value }
  }
  return out
}

/**
 * Wallpaper Engine's web API, emulated: the wallpaper's listener gets its
 * general properties (fps) and user properties (project.json defaults, or a
 * preset's) once the page has loaded, the audio listener receives 128 bands
 * (64 left + 64 right) ~30 times a second — real system audio when the Stitch
 * window forwards it, silence otherwise — mouse movement over the desktop is
 * forwarded (like Wallpaper Engine does; clicks stay with Stitch), and the
 * media/file APIs answer so pages that wait on them keep running.
 */
export function wallpaperShim(root: string, id?: string): string {
  let props: Record<string, WeProperty> = {}
  try {
    const pj = JSON.parse(readFileSync(join(root, 'project.json'), 'utf8').replace(/^﻿/, '')) as {
      general?: { properties?: Record<string, WeProperty> }
    }
    props = pj.general?.properties ?? {}
  } catch {
    /* no properties */
  }
  const overrides = id ? wallpaperExtras.get(id.toLowerCase())?.properties : undefined
  const json = JSON.stringify(weProperties(props, overrides)).replace(/</g, '\\u003c')
  return `<script>(function(){
var props=${json},general={fps:60},listener=window.wallpaperPropertyListener||null,applied=null,loaded=document.readyState==='complete';
function apply(){var l=listener;if(!l||applied===l||!loaded)return;applied=l;
try{l.applyGeneralProperties&&l.applyGeneralProperties(general)}catch(e){console.error(e)}
try{l.applyUserProperties&&l.applyUserProperties(props)}catch(e){console.error(e)}
try{l.setPaused&&l.setPaused(false)}catch(e){}}
try{Object.defineProperty(window,'wallpaperPropertyListener',{configurable:true,get:function(){return listener},set:function(v){listener=v;applied=null;setTimeout(apply,0)}})}catch(e){}
window.addEventListener('load',function(){loaded=true;setTimeout(apply,0);try{parent.postMessage({stitchWallpaper:'hello',w:innerWidth,h:innerHeight,dpr:devicePixelRatio},'*')}catch(e){}});
var audio=[],zeros=[],lastAudio=0,audioOn=false;for(var i=0;i<128;i++)zeros.push(0);
function send(a){for(var i=0;i<audio.length;i++){try{audio[i](a)}catch(e){}}}
window.wallpaperRegisterAudioListener=function(cb){if(typeof cb!=='function')return;audio.push(cb);if(audioOn)return;audioOn=true;
try{parent.postMessage({stitchWallpaper:'audio'},'*')}catch(e){}
setInterval(function(){if(Date.now()-lastAudio>250)send(zeros)},33)};
function move(x,y){var t=document.elementFromPoint(x,y)||document.body||document.documentElement;var o={clientX:x,clientY:y,screenX:x,screenY:y,pageX:x,pageY:y,bubbles:true,cancelable:true,view:window};try{t.dispatchEvent(new PointerEvent('pointermove',Object.assign({pointerId:1,pointerType:'mouse',isPrimary:true},o)))}catch(e){}try{t.dispatchEvent(new MouseEvent('mousemove',o))}catch(e){}}
window.addEventListener('message',function(ev){if(ev.source!==window.parent)return;var d=ev.data;if(!d)return;if(d.stitchAudio){lastAudio=Date.now();send(Array.prototype.slice.call(d.stitchAudio))}else if(d.stitchPointer){move(d.stitchPointer[0],d.stitchPointer[1])}});
window.wallpaperRegisterMediaStatusListener=function(cb){try{cb({enabled:false})}catch(e){}};
['wallpaperRegisterMediaPropertiesListener','wallpaperRegisterMediaThumbnailListener','wallpaperRegisterMediaPlaybackListener','wallpaperRegisterMediaTimelineListener'].forEach(function(k){window[k]=function(){}});
window.wallpaperRequestRandomFileForProperty=function(name,cb){if(typeof cb==='function')setTimeout(function(){try{cb(name,'')}catch(e){}},0)};
})();</script>`
}

/** Who asked? Wallpaper pages must never read files outside their own folder. */
function fromWallpaper(request: Request): boolean {
  const origin = request.headers.get('origin') ?? ''
  const referer = request.headers.get('referer') ?? ''
  return origin === 'null' || origin.startsWith(`${SCHEME}://wp-`) || referer.startsWith(`${SCHEME}://wp-`)
}

export function registerProtocolHandler(): void {
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url)
    if (url.hostname === 'local' && fromWallpaper(request)) return new Response('Forbidden', { status: 403 })
    const path = resolveRequest(url)
    if (!path) return new Response('Not found', { status: 404 })

    // Inject the Wallpaper Engine shim into a wallpaper's HTML pages.
    if (url.hostname.startsWith('wp-') && /\.html?$/i.test(path)) {
      const root = wallpaperDirs.get(url.hostname.slice(3))!
      try {
        let html = readFileSync(path, 'utf8')
        const shim = wallpaperShim(root, url.hostname.slice(3))
        html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + shim) : shim + html
        return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' } })
      } catch {
        return new Response('Not found', { status: 404 })
      }
    }

    let size: number
    try {
      const st = statSync(path)
      if (!st.isFile()) return new Response('Not found', { status: 404 })
      size = st.size
    } catch {
      return new Response('Not found', { status: 404 })
    }

    const headers = new Headers({
      'Content-Type': MIME[extname(path).toLowerCase()] ?? 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache'
    })

    const range = request.headers.get('range')
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range)
      if (m) {
        let start = m[1] ? parseInt(m[1], 10) : 0
        let end = m[2] ? parseInt(m[2], 10) : size - 1
        if (!m[1] && m[2]) {
          start = Math.max(0, size - parseInt(m[2], 10))
          end = size - 1
        }
        end = Math.min(end, size - 1)
        if (start > end || start >= size) {
          headers.set('Content-Range', `bytes */${size}`)
          return new Response(null, { status: 416, headers })
        }
        headers.set('Content-Range', `bytes ${start}-${end}/${size}`)
        headers.set('Content-Length', String(end - start + 1))
        const stream = Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream
        return new Response(stream, { status: 206, headers })
      }
    }

    headers.set('Content-Length', String(size))
    const stream = Readable.toWeb(createReadStream(path)) as ReadableStream
    return new Response(stream, { status: 200, headers })
  })
}
