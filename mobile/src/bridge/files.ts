// Files between phone and PC: pick on the phone → upload to the PC; open PC files on the phone.
import { Browser } from '@capacitor/browser'
import { Capacitor } from '@capacitor/core'
import { Directory, Filesystem } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'
import { link, useLink } from './connection'
import { mediaUrl } from './media'

interface PickOpts {
  filters?: { name: string; extensions: string[] }[]
  multi?: boolean
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska', m4v: 'video/mp4',
  mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', opus: 'audio/ogg',
  json: 'application/json', txt: 'text/plain', js: 'text/javascript', mjs: 'text/javascript'
}

function acceptFor(opts: PickOpts): string {
  const exts = (opts.filters ?? []).flatMap((f) => f.extensions)
  if (!exts.length || exts.includes('*')) return ''
  const parts = new Set<string>()
  for (const e of exts) {
    parts.add(`.${e}`)
    const m = MIME_BY_EXT[e.toLowerCase()]
    if (m) parts.add(m)
  }
  return [...parts].join(',')
}

/** The phone's own file chooser (gallery, camera, Files, Drive …). */
export function pickPhoneFiles(opts: PickOpts): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = !!opts.multi
    const accept = acceptFor(opts)
    if (accept) input.accept = accept
    input.style.display = 'none'
    let settled = false
    const done = (files: File[]): void => {
      if (settled) return
      settled = true
      input.remove()
      resolve(files)
    }
    input.addEventListener('change', () => done([...(input.files ?? [])]))
    input.addEventListener('cancel', () => done([]))
    document.body.appendChild(input)
    input.click()
  })
}

/** Send a phone file to the PC; returns its path there. */
export async function uploadToPc(file: Blob, name: string, onProgress?: (p: number) => void): Promise<string> {
  const token = useLink.getState().pairing?.token
  const base = link.baseUrl()
  if (!token || !base) throw new Error("Can't reach your PC right now")
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${base}/api/upload?name=${encodeURIComponent(name)}`)
    xhr.setRequestHeader('x-stitch-token', token)
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total)
    xhr.onload = () => {
      try {
        const data = JSON.parse(xhr.responseText) as { path?: string; error?: string }
        if (xhr.status === 200 && data.path) resolve(data.path)
        else reject(new Error(data.error ?? `Upload failed (${xhr.status})`))
      } catch {
        reject(new Error(`Upload failed (${xhr.status})`))
      }
    }
    xhr.onerror = () => reject(new Error('Upload failed — is the PC still reachable?'))
    xhr.send(file)
  })
}

function localUrl(path: string): string {
  const p = path.replace(/\\/g, '/')
  return `stitch://local/${encodeURI(p).replace(/#/g, '%23').replace(/\?/g, '%3F')}`
}

const baseName = (p: string): string => p.split(/[\\/]/).pop() ?? 'file'

/**
 * Open a file that lives on the PC: download it to the phone's cache and hand it to the share
 * sheet (save to gallery, send, open with …). Very large files stream in the browser instead.
 */
export async function openPcFile(path: string): Promise<void> {
  const url = mediaUrl(localUrl(path))
  if (!Capacitor.isNativePlatform()) {
    window.open(url, '_blank')
    return
  }
  let size = 0
  try {
    const head = await fetch(url, { method: 'HEAD' })
    size = Number(head.headers.get('content-length') ?? 0)
  } catch {
    /* unknown */
  }
  if (size > 150 * 1024 ** 2) {
    await Browser.open({ url })
    return
  }
  const name = baseName(path)
  const dest = `shared/${Date.now()}-${name}`
  const res = await Filesystem.downloadFile({ url, path: dest, directory: Directory.Cache, recursive: true })
  const uri = res.path ? (res.path.startsWith('file:') ? res.path : `file://${res.path}`) : (await Filesystem.getUri({ path: dest, directory: Directory.Cache })).uri
  await Share.share({ title: name, files: [uri] })
}

export async function openExternal(url: string): Promise<void> {
  if (Capacitor.isNativePlatform()) await Browser.open({ url })
  else window.open(url, '_blank', 'noopener')
}
