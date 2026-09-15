import type { App, TFile } from 'obsidian'

import {
  type LocalCacheApp,
  buildImageCacheKey,
  lookupImageDataUrls,
  writeImageDataUrls,
} from '../../database/local-cache/localCacheStore'
import { MentionableImage } from '../../types/mentionable'
import { arrayBufferToBase64 } from '../base64'

/**
 * Vault-file extensions we treat as images for vision payloads.
 *
 * Restricted to the intersection supported by all current provider adapters
 * (OpenAI / Anthropic / Bedrock / Gemini): jpeg, png, gif, webp. Adding
 * formats outside this set (e.g. svg, bmp, heic) would fail provider-side
 * MIME validation and abort the whole request.
 */
export const IMAGE_FILE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
])

const EXTENSION_TO_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

export type ImageCompressionOptions = {
  enabled: boolean
  quality: number // 1-100
}

/**
 * Largest image file a read tool (`fs_read`, `read_file`) will decode. The
 * file is read whole and drawn onto a canvas to compress, so the bound is on
 * memory, not on what a provider accepts — compression brings anything under
 * it down to a sendable size.
 */
export const IMAGE_READ_MAX_BYTES = 20 * 1024 * 1024

export function isImageTFile(file: TFile): boolean {
  const ext = file.extension?.toLowerCase() ?? ''
  return IMAGE_FILE_EXTENSIONS.has(ext)
}

export function getImageMimeTypeFromExtension(ext: string): string | null {
  return EXTENSION_TO_MIME[ext.toLowerCase()] ?? null
}

export function parseImageDataUrl(dataUrl: string): {
  mimeType: string
  base64Data: string
} {
  const matches = dataUrl.match(/^data:([^;]+);base64,(.+)/)
  if (!matches) {
    throw new Error('Invalid image data URL format')
  }
  const [, mimeType, base64Data] = matches
  return { mimeType, base64Data }
}

export async function fileToMentionableImage(
  file: File,
): Promise<MentionableImage> {
  const base64Data = await fileToBase64(file)
  return {
    type: 'image',
    name: file.name,
    mimeType: file.type,
    data: base64Data,
  }
}

/**
 * Encode image bytes as a base64 data URL, compressing with the Canvas API
 * when `compression` is enabled below quality 100.
 * GIF is never compressed (may be animated).
 * PNG is converted to JPEG (transparency becomes white).
 * JPEG/WebP are re-encoded at the given quality.
 */
export async function encodeImageDataUrl(
  buffer: ArrayBuffer,
  ext: string,
  compression?: ImageCompressionOptions,
): Promise<string> {
  const normalizedExt = ext.toLowerCase()
  const mimeType =
    getImageMimeTypeFromExtension(normalizedExt) ?? 'application/octet-stream'
  if (
    !compression?.enabled ||
    compression.quality >= 100 ||
    normalizedExt === 'gif'
  ) {
    return `data:${mimeType};base64,${arrayBufferToBase64(buffer)}`
  }

  const scale = compression.quality / 100
  const blob = new Blob([buffer], { type: mimeType })
  const bitmap = await createImageBitmap(blob)

  // Scale dimensions and quality by the same factor
  const targetWidth = Math.round(bitmap.width * scale)
  const targetHeight = Math.round(bitmap.height * scale)

  const canvas = new OffscreenCanvas(targetWidth, targetHeight)
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    bitmap.close()
    return `data:${mimeType};base64,${arrayBufferToBase64(buffer)}`
  }

  // For PNG → JPEG conversion, fill white background first
  if (normalizedExt === 'png') {
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, targetWidth, targetHeight)
  }

  ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight)
  bitmap.close()

  const outputMime = normalizedExt === 'webp' ? 'image/webp' : 'image/jpeg'
  const outputBlob = await canvas.convertToBlob({
    type: outputMime,
    quality: scale,
  })
  const base64 = arrayBufferToBase64(await outputBlob.arrayBuffer())
  return `data:${outputMime};base64,${base64}`
}

/**
 * Read a vault image TFile and return a base64 data URL suitable for the
 * `image_url` content part used by OpenAI / Anthropic vision payloads.
 *
 * Pass `options.cache` to enable the local image cache, and
 * `options.compression` to compress on a cache miss. Both default to off.
 */
export async function tFileToImageDataUrl(
  app: App,
  file: TFile,
  options?: {
    cache?: boolean
    compression?: ImageCompressionOptions
  },
): Promise<string> {
  const ext = file.extension?.toLowerCase() ?? ''

  if (options?.cache) {
    return cachedImageDataUrl(app, {
      key: buildImageCacheKey(file.path, file.stat.mtime, file.stat.size),
      sourcePath: file.path,
      ext,
      readBytes: () => app.vault.readBinary(file),
      compression: options.compression,
    })
  }

  const buffer = await app.vault.readBinary(file)
  return encodeImageDataUrl(buffer, ext, options?.compression)
}

/**
 * The encoded data URL for an image, served from the local cache when present
 * and encoded then cached otherwise. The source only supplies its identity and
 * a way to read its bytes, so a vault file and a file read straight from disk
 * share one cache and one compression path.
 */
export async function cachedImageDataUrl(
  app: LocalCacheApp,
  source: {
    key: string
    sourcePath: string
    ext: string
    readBytes: () => Promise<ArrayBuffer>
    compression?: ImageCompressionOptions
  },
): Promise<string> {
  const cached = (await lookupImageDataUrls(app, [source.key])).get(source.key)
  if (cached !== undefined) {
    return cached
  }
  const dataUrl = await encodeImageDataUrl(
    await source.readBytes(),
    source.ext,
    source.compression,
  )
  await writeImageDataUrls(app, [
    { key: source.key, dataUrl, sourcePath: source.sourcePath },
  ])
  return dataUrl
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.readAsDataURL(file)
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('Failed to read file'))
  })
}
