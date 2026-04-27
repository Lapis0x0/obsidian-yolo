import type { App, TFile } from 'obsidian'

import { MentionableImage } from '../../types/mentionable'

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
 * Read a vault image TFile and return a base64 data URL suitable for the
 * `image_url` content part used by OpenAI / Anthropic vision payloads.
 */
export async function tFileToImageDataUrl(
  app: App,
  file: TFile,
): Promise<string> {
  const ext = file.extension?.toLowerCase() ?? ''
  const mimeType =
    getImageMimeTypeFromExtension(ext) ?? 'application/octet-stream'
  const buffer = await app.vault.readBinary(file)
  const base64 = arrayBufferToBase64(buffer)
  return `data:${mimeType};base64,${base64}`
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  const chunkSize = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize)
    binary += String.fromCharCode.apply(null, Array.from(chunk))
  }
  return btoa(binary)
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.readAsDataURL(file)
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('Failed to read file'))
  })
}
