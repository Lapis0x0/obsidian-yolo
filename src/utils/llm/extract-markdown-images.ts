import { App, TFile } from 'obsidian'

import {
  batchLookupImageCache,
  batchWriteImageCache,
  buildImageCacheKey,
} from '../../database/json/chat/imageCacheStore'
import { ContentPart } from '../../types/llm/request'

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])

const MIME_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

// Matches both ![[image.png]], ![[image.png|size]], ![[path/image.png|alt]]
// and ![alt](path/to/image.png)
const IMAGE_EMBED_REGEX = /!\[\[([^\]]+)\]\]|!\[([^\]]*)\]\(([^)]+)\)/g

export type ImageCompressionOptions = {
  enabled: boolean
  quality: number // 1-100
}

type YoloSettingsLike = {
  yolo?: {
    baseDir?: string
  }
}

export type ImageExtractOptions = {
  compression?: ImageCompressionOptions
  cache?: { enabled: true; settings?: YoloSettingsLike | null }
}

function getExtension(filename: string): string {
  const dot = filename.lastIndexOf('.')
  return dot >= 0 ? filename.slice(dot + 1).toLowerCase() : ''
}

function isImageExtension(ext: string): boolean {
  return IMAGE_EXTENSIONS.has(ext)
}

/**
 * Parse an image embed match and return the link path and extension.
 * Returns null if the embed is not an image file.
 */
function parseImageEmbed(
  match: RegExpExecArray,
): { linkPath: string; ext: string } | null {
  if (match[1] !== undefined) {
    // Wiki link: ![[path|optional-size-or-alt]]
    const raw = match[1]
    const pipeIndex = raw.indexOf('|')
    const linkPath = pipeIndex >= 0 ? raw.slice(0, pipeIndex) : raw
    const ext = getExtension(linkPath)
    if (!isImageExtension(ext)) return null
    return { linkPath, ext }
  } else if (match[3] !== undefined) {
    // Markdown link: ![alt](path)
    const linkPath = match[3]
    const ext = getExtension(linkPath)
    if (!isImageExtension(ext)) return null
    return { linkPath, ext }
  }
  return null
}

/**
 * Resolve an image link path to a TFile using Obsidian APIs.
 */
function resolveImageFile(
  app: App,
  linkPath: string,
  sourcePath: string,
): TFile | null {
  // Try wiki-link resolution first (handles shortest-path matches)
  const resolved = app.metadataCache.getFirstLinkpathDest(
    linkPath,
    sourcePath,
  )
  if (resolved instanceof TFile) return resolved

  // Fallback: try as direct vault path
  const direct = app.vault.getFileByPath(linkPath)
  if (direct) return direct

  // Fallback: try relative to source file's directory
  const sourceDir = sourcePath.substring(0, sourcePath.lastIndexOf('/'))
  const relativePath = sourceDir ? `${sourceDir}/${linkPath}` : linkPath
  return app.vault.getFileByPath(relativePath) ?? null
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  const CHUNK = 0x8000
  const chunks: string[] = []
  for (let i = 0; i < bytes.length; i += CHUNK) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + CHUNK)))
  }
  return btoa(chunks.join(''))
}

/**
 * Compress an image using Canvas API.
 * GIF is skipped (may be animated).
 * PNG is converted to JPEG (transparency becomes white).
 * JPEG/WebP are re-encoded at the given quality.
 */
async function compressImage(
  buffer: ArrayBuffer,
  ext: string,
  quality: number,
): Promise<{
  base64: string
  mimeType: string
  originalWidth: number
  originalHeight: number
  scaledWidth: number
  scaledHeight: number
}> {
  // GIF: skip compression (may be animated)
  if (ext === 'gif') {
    return {
      base64: arrayBufferToBase64(buffer),
      mimeType: 'image/gif',
      originalWidth: 0,
      originalHeight: 0,
      scaledWidth: 0,
      scaledHeight: 0,
    }
  }

  const scale = quality / 100
  const blob = new Blob([buffer], { type: MIME_TYPES[ext] ?? 'image/png' })
  const bitmap = await createImageBitmap(blob)

  const origWidth = bitmap.width
  const origHeight = bitmap.height

  // Scale dimensions and quality by the same factor
  const targetWidth = Math.round(origWidth * scale)
  const targetHeight = Math.round(origHeight * scale)

  const canvas = new OffscreenCanvas(targetWidth, targetHeight)
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    bitmap.close()
    return {
      base64: arrayBufferToBase64(buffer),
      mimeType: MIME_TYPES[ext] ?? 'image/png',
      originalWidth: origWidth,
      originalHeight: origHeight,
      scaledWidth: origWidth,
      scaledHeight: origHeight,
    }
  }

  // For PNG → JPEG conversion, fill white background first
  if (ext === 'png') {
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, targetWidth, targetHeight)
  }

  ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight)
  bitmap.close()

  // Determine output format
  const outputMime = ext === 'webp' ? 'image/webp' : 'image/jpeg'
  const outputBlob = await canvas.convertToBlob({
    type: outputMime,
    quality: scale,
  })

  const compressedBuffer = await outputBlob.arrayBuffer()
  return {
    base64: arrayBufferToBase64(compressedBuffer),
    mimeType: outputMime,
    originalWidth: origWidth,
    originalHeight: origHeight,
    scaledWidth: targetWidth,
    scaledHeight: targetHeight,
  }
}

type ImageMatch = {
  startIndex: number
  endIndex: number
  file: TFile
  ext: string
  cacheKey: string
}

/**
 * Extract images embedded in markdown text and build an interleaved
 * ContentPart array (text -> image -> text -> image -> ...).
 *
 * Supports optional compression (Canvas API) and global cache.
 *
 * Returns null contentParts if the text contains no resolvable image embeds.
 * Images that cannot be resolved or read are silently skipped
 * (their original syntax is preserved in the text).
 */
export async function extractMarkdownImages(
  app: App,
  text: string,
  sourcePath: string,
  options?: ImageExtractOptions,
): Promise<{
  contentParts: ContentPart[] | null
}> {
  // First pass: find all image embeds and resolve them
  const matches: ImageMatch[] = []
  const regex = new RegExp(IMAGE_EMBED_REGEX.source, IMAGE_EMBED_REGEX.flags)
  let m: RegExpExecArray | null

  while ((m = regex.exec(text)) !== null) {
    const parsed = parseImageEmbed(m)
    if (!parsed) continue

    const file = resolveImageFile(app, parsed.linkPath, sourcePath)
    if (!file) continue

    const cacheKey = buildImageCacheKey(
      file.path,
      file.stat.mtime,
      file.stat.size,
    )

    matches.push({
      startIndex: m.index,
      endIndex: m.index + m[0].length,
      file,
      ext: parsed.ext,
      cacheKey,
    })
  }

  if (matches.length === 0) {
    return { contentParts: null }
  }

  // Batch cache lookup
  const cacheEnabled = !!options?.cache?.enabled
  let cacheHits = new Map<string, string>()
  if (cacheEnabled) {
    const allKeys = matches.map((m) => m.cacheKey)
    cacheHits = await batchLookupImageCache(
      app,
      allKeys,
      options?.cache?.settings,
    )
  }

  const compression = options?.compression
  const newCacheEntries: Array<{
    hash: string
    dataUrl: string
    sourcePath: string
  }> = []

  // Second pass: build interleaved content parts
  const parts: ContentPart[] = []
  let cursor = 0

  for (const match of matches) {
    // Add text before this image
    if (match.startIndex > cursor) {
      const textBefore = text.slice(cursor, match.startIndex)
      if (textBefore.length > 0) {
        parts.push({ type: 'text', text: textBefore })
      }
    }

    try {
      // Check cache first
      const cachedDataUrl = cacheHits.get(match.cacheKey)
      if (cachedDataUrl) {
        parts.push({
          type: 'image_url',
          image_url: { url: cachedDataUrl, cacheKey: match.cacheKey },
        })
        cursor = match.endIndex
        continue
      }

      // Read and encode the image
      const buffer = await app.vault.readBinary(match.file)
      let dataUrl: string

      if (compression?.enabled && compression.quality < 100) {
        const compressed = await compressImage(
          buffer,
          match.ext,
          compression.quality,
        )
        dataUrl = `data:${compressed.mimeType};base64,${compressed.base64}`
      } else {
        const base64 = arrayBufferToBase64(buffer)
        const mimeType = MIME_TYPES[match.ext] ?? 'image/png'
        dataUrl = `data:${mimeType};base64,${base64}`
      }

      parts.push({
        type: 'image_url',
        image_url: { url: dataUrl, cacheKey: match.cacheKey },
      })

      // Queue for cache write
      if (cacheEnabled) {
        newCacheEntries.push({
          hash: match.cacheKey,
          dataUrl,
          sourcePath: match.file.path,
        })
      }
    } catch {
      // Failed to read/compress image — keep original syntax as text
      parts.push({
        type: 'text',
        text: text.slice(match.startIndex, match.endIndex),
      })
    }

    cursor = match.endIndex
  }

  // Add remaining text after the last image
  if (cursor < text.length) {
    const remaining = text.slice(cursor)
    if (remaining.length > 0) {
      parts.push({ type: 'text', text: remaining })
    }
  }

  // Batch write new cache entries (fire-and-forget)
  if (newCacheEntries.length > 0) {
    void batchWriteImageCache(
      app,
      newCacheEntries,
      options?.cache?.settings,
    )
  }

  return { contentParts: parts }
}
