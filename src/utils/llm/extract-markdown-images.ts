import { App, TFile } from 'obsidian'

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
const IMAGE_EMBED_REGEX =
  /!\[\[([^\]]+)\]\]|!\[([^\]]*)\]\(([^)]+)\)/g

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
function parseImageEmbed(match: RegExpExecArray): {
  linkPath: string
  ext: string
} | null {
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
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

type ImageMatch = {
  startIndex: number
  endIndex: number
  file: TFile
  ext: string
}

/**
 * Extract images embedded in markdown text and build an interleaved
 * ContentPart array (text → image → text → image → ...).
 *
 * Returns null if the text contains no resolvable image embeds.
 * Images that cannot be resolved or read are silently skipped
 * (their original syntax is preserved in the text).
 */
export async function extractMarkdownImages(
  app: App,
  text: string,
  sourcePath: string,
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

    matches.push({
      startIndex: m.index,
      endIndex: m.index + m[0].length,
      file,
      ext: parsed.ext,
    })
  }

  if (matches.length === 0) {
    return { contentParts: null }
  }

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

    // Read and encode the image
    try {
      const buffer = await app.vault.readBinary(match.file)
      const base64 = arrayBufferToBase64(buffer)
      const mimeType = MIME_TYPES[match.ext] ?? 'image/png'
      const dataUrl = `data:${mimeType};base64,${base64}`

      parts.push({
        type: 'image_url',
        image_url: { url: dataUrl },
      })
    } catch {
      // Failed to read image — keep original syntax as text
      parts.push({ type: 'text', text: text.slice(match.startIndex, match.endIndex) })
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

  return { contentParts: parts }
}
