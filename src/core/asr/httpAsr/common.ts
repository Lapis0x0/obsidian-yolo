import type { AsrSegment } from '../types'

export type MultipartField =
  | { name: string; value: string }
  | { name: string; filename: string; contentType: string; blob: Blob }

export const joinUrl = (baseURL: string, path: string): string => {
  if (/^https?:\/\//i.test(path)) return path
  const trimmedBase = baseURL.replace(/\/+$/, '')
  const trimmedPath = path.replace(/^\/+/, '')
  return `${trimmedBase}/${trimmedPath}`
}

export const guessAudioExtensionFromMime = (mimeType: string): string => {
  const lower = mimeType.toLowerCase()
  if (lower.includes('webm')) return 'webm'
  if (lower.includes('ogg')) return 'ogg'
  if (lower.includes('mp4') || lower.includes('m4a')) return 'm4a'
  if (lower.includes('mpeg') || lower.includes('mp3')) return 'mp3'
  if (lower.includes('wav')) return 'wav'
  if (lower.includes('flac')) return 'flac'
  return 'webm'
}

export const guessAudioFormatLabelFromMime = (mimeType: string): string =>
  guessAudioExtensionFromMime(mimeType)

export const truncateResponseBody = (body: string): string =>
  body.length > 500 ? `${body.slice(0, 500)}…` : body

export const blobToBase64 = async (blob: Blob): Promise<string> => {
  const buffer = await blob.arrayBuffer()
  return bytesToBase64(new Uint8Array(buffer))
}

export const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize)
    binary += String.fromCharCode(...chunk)
  }
  if (typeof btoa === 'function') return btoa(binary)
  // Fallback for environments without atob/btoa.
  return (globalThis as any).Buffer.from(binary, 'binary').toString('base64')
}

export const formatSpeakerAwareTranscript = (
  segments: AsrSegment[],
): string => {
  const blocks: Array<{ label: string | null; text: string[] }> = []
  for (const segment of segments) {
    const label = segment.speakerLabel ?? null
    const last = blocks[blocks.length - 1]
    if (last && last.label === label) {
      last.text.push(segment.text)
      continue
    }
    blocks.push({ label, text: [segment.text] })
  }

  return blocks
    .map((block) => {
      const text = block.text.join(' ').trim()
      return block.label ? `${block.label}: ${text}` : text
    })
    .filter(Boolean)
    .join('\n\n')
}

const encodeUtf8 = (input: string): Uint8Array =>
  new TextEncoder().encode(input)

const concatUint8 = (parts: Uint8Array[]): Uint8Array => {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

export const generateMultipartBoundary = (): string =>
  `----yolo-asr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

export const buildMultipartBody = async (
  boundary: string,
  fields: MultipartField[],
): Promise<ArrayBuffer> => {
  const parts: Uint8Array[] = []
  const crlf = '\r\n'
  for (const field of fields) {
    parts.push(encodeUtf8(`--${boundary}${crlf}`))
    if ('value' in field) {
      parts.push(
        encodeUtf8(
          `Content-Disposition: form-data; name="${field.name}"${crlf}${crlf}`,
        ),
      )
      parts.push(encodeUtf8(field.value))
      parts.push(encodeUtf8(crlf))
    } else {
      parts.push(
        encodeUtf8(
          `Content-Disposition: form-data; name="${field.name}"; filename="${field.filename}"${crlf}` +
            `Content-Type: ${field.contentType}${crlf}${crlf}`,
        ),
      )
      const bytes = new Uint8Array(await field.blob.arrayBuffer())
      parts.push(bytes)
      parts.push(encodeUtf8(crlf))
    }
  }
  parts.push(encodeUtf8(`--${boundary}--${crlf}`))
  const merged = concatUint8(parts)
  return merged.buffer.slice(
    merged.byteOffset,
    merged.byteOffset + merged.byteLength,
  )
}
