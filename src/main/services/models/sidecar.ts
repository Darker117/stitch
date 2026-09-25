// Writes Stability Matrix-compatible sidecars next to model files:
// `<name>.cm-info.json` (PascalCase keys, as SM writes them) and
// `<name>.preview.jpeg`. Extra keys (PreviewNsfwLevel…) are ignored by SM.
import { nativeImage } from 'electron'
import { rename, writeFile } from 'node:fs/promises'
import { civitaiImageVariant } from '@shared/civitai'
import type { RawModel, RawVersion } from './civitai'
import { stemOf } from './library'

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface PreviewPick {
  url: string
  nsfwLevel: number
  type: 'image' | 'video'
}

/** First safe-for-work still if there is one, else the first image. */
export function pickPreview(images: any[] | undefined): PreviewPick | undefined {
  const list = (images ?? []).filter((i) => typeof i?.url === 'string' && i.url)
  const sfw = (i: any): boolean => typeof i.nsfwLevel === 'number' && i.nsfwLevel > 0 && i.nsfwLevel <= 2
  const pick = list.find((i) => i.type !== 'video' && sfw(i)) ?? list.find(sfw) ?? list.find((i) => i.type !== 'video') ?? list[0]
  if (!pick) return undefined
  return { url: pick.url, nsfwLevel: typeof pick.nsfwLevel === 'number' ? pick.nsfwLevel : 0, type: pick.type === 'video' ? 'video' : 'image' }
}

export function buildCmInfo(model: RawModel | undefined, version: RawVersion, file: any | undefined, preview?: PreviewPick): Record<string, unknown> {
  const hashes = file?.hashes ?? {}
  const stats = model?.stats ?? version?.stats ?? {}
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [])
  return {
    ModelId: model?.id ?? version?.modelId ?? null,
    ModelName: model?.name ?? version?.model?.name ?? file?.name ?? 'Unknown',
    ModelDescription: model?.description ?? null,
    Nsfw: (model?.nsfw ?? version?.model?.nsfw) === true,
    Tags: arr(model?.tags),
    ModelType: model?.type ?? version?.model?.type ?? 'Checkpoint',
    VersionId: version?.id ?? null,
    VersionName: version?.name ?? null,
    VersionDescription: version?.description ?? null,
    AuthorUsername: model?.creator?.username ?? version?.creator?.username ?? null,
    BaseModel: version?.baseModel ?? null,
    RemoteFileName: file?.name ?? null,
    RemoteFileId: file?.id ?? null,
    FileMetadata: { fp: file?.metadata?.fp ?? null, size: file?.metadata?.size ?? null, format: file?.metadata?.format ?? null },
    ImportedAt: new Date().toISOString(),
    Hashes: { SHA256: hashes.SHA256 ?? null, CRC32: hashes.CRC32 ?? null, BLAKE3: hashes.BLAKE3 ?? null },
    TrainedWords: arr(version?.trainedWords),
    Stats: {
      favoriteCount: stats.favoriteCount ?? 0,
      commentCount: stats.commentCount ?? 0,
      thumbsUpCount: stats.thumbsUpCount ?? 0,
      downloadCount: stats.downloadCount ?? 0,
      ratingCount: stats.ratingCount ?? 0,
      rating: stats.rating ?? 0
    },
    UserTitle: null,
    ThumbnailImageUrl: null,
    InferenceDefaults: null,
    Source: 0,
    SourceUrl: null,
    // Stitch additions (Stability Matrix ignores unknown keys).
    PreviewNsfwLevel: preview?.nsfwLevel ?? null,
    PreviewImageUrl: preview?.url ?? null
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function writeCmInfo(modelPath: string, info: Record<string, unknown>): Promise<string> {
  const dest = `${stemOf(modelPath)}.cm-info.json`
  const tmp = `${dest}.tmp`
  await writeFile(tmp, JSON.stringify(info), 'utf8')
  await rename(tmp, dest)
  return dest
}

/** Download a preview still next to the model. Returns its path, or undefined. */
export async function savePreview(modelPath: string, pick: PreviewPick): Promise<string | undefined> {
  const url = civitaiImageVariant(pick.url, { width: 1024, poster: pick.type === 'video' })
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000), headers: { 'User-Agent': 'Stitch/0.1 (+desktop)' } })
    if (!res.ok) return undefined
    const type = res.headers.get('content-type') ?? ''
    const buf = Buffer.from(await res.arrayBuffer())
    const stem = stemOf(modelPath)
    if (/jpe?g/i.test(type) || (!type && buf[0] === 0xff && buf[1] === 0xd8)) {
      await writeFile(`${stem}.preview.jpeg`, buf)
      return `${stem}.preview.jpeg`
    }
    // Stability Matrix looks for .preview.jpeg — convert what we can.
    const img = nativeImage.createFromBuffer(buf)
    if (!img.isEmpty()) {
      await writeFile(`${stem}.preview.jpeg`, img.toJPEG(90))
      return `${stem}.preview.jpeg`
    }
    const ext = /webp/i.test(type) ? 'webp' : /png/i.test(type) ? 'png' : /gif/i.test(type) ? 'gif' : /mp4/i.test(type) ? 'mp4' : undefined
    if (!ext) return undefined
    await writeFile(`${stem}.preview.${ext}`, buf)
    return `${stem}.preview.${ext}`
  } catch {
    return undefined
  }
}
