import { protocol } from 'electron'
import { createReadStream, readFileSync, statSync } from 'node:fs'
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

export function registerWallpaperDir(id: string, dir: string): void {
  wallpaperDirs.set(id, resolve(dir))
}

/** Root folder of a registered wallpaper item (served to phones by the remote server too). */
export function wallpaperRoot(id: string): string | undefined {
  return wallpaperDirs.get(id)
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
    const root = wallpaperDirs.get(url.hostname.slice(3))
    if (!root) return null
    const full = resolve(join(root, rel || 'index.html'))
    if (full !== root && !full.startsWith(root + sep)) return null
    return full
  }
  return null
}

/**
 * Wallpaper Engine's web API, emulated: feed the wallpaper its default user
 * properties from project.json and stub the audio/media listeners, so pages
 * that wait for those callbacks actually start drawing.
 */
export function wallpaperShim(root: string): string {
  let props: Record<string, unknown> = {}
  try {
    const pj = JSON.parse(readFileSync(join(root, 'project.json'), 'utf8').replace(/^﻿/, '')) as {
      general?: { properties?: Record<string, { value?: unknown; type?: string }> }
    }
    props = pj.general?.properties ?? {}
  } catch {
    /* no properties */
  }
  return `<script>(function(){
var props=${JSON.stringify(props).replace(/</g, '\\u003c')};
var noop=function(){};
window.wallpaperRegisterAudioListener=function(cb){var a=[];for(var i=0;i<128;i++)a.push(0);setInterval(function(){try{cb(a)}catch(e){}},33)};
['wallpaperRegisterMediaStatusListener','wallpaperRegisterMediaPropertiesListener','wallpaperRegisterMediaThumbnailListener','wallpaperRegisterMediaPlaybackListener','wallpaperRegisterMediaTimelineListener','wallpaperRequestRandomFileForProperty'].forEach(function(k){window[k]=noop});
function apply(){var l=window.wallpaperPropertyListener;if(!l)return;try{l.applyUserProperties&&l.applyUserProperties(props)}catch(e){}try{l.applyGeneralProperties&&l.applyGeneralProperties({fps:60})}catch(e){}try{l.setPaused&&l.setPaused(false)}catch(e){}}
window.addEventListener('load',function(){setTimeout(apply,30);setTimeout(apply,700)});
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
        const shim = wallpaperShim(root)
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
