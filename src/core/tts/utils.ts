import type { TtsOutputFormat } from '../../settings/schema/setting.types'

export const joinUrl = (baseURL: string, path: string): string => {
  if (/^https?:\/\//i.test(path)) return path
  const trimmedBase = baseURL.replace(/\/+$/, '')
  const trimmedPath = path.replace(/^\/+/, '')
  return `${trimmedBase}/${trimmedPath}`
}

export const truncateResponseBody = (body: string): string =>
  body.length > 500 ? `${body.slice(0, 500)}...` : body

export const mimeTypeForAudioFormat = (format: TtsOutputFormat): string => {
  switch (format) {
    case 'wav':
    case 'pcm':
    case 'pcm16':
      return 'audio/wav'
    case 'opus':
      return 'audio/ogg; codecs=opus'
    case 'aac':
      return 'audio/aac'
    case 'flac':
      return 'audio/flac'
    case 'mp3':
    default:
      return 'audio/mpeg'
  }
}

export const extensionForAudioFormat = (format: TtsOutputFormat): string =>
  format === 'pcm' || format === 'pcm16' ? 'wav' : format

export const coerceFileAudioFormat = (
  format: TtsOutputFormat,
): Exclude<TtsOutputFormat, 'pcm' | 'pcm16'> =>
  format === 'pcm' || format === 'pcm16' ? 'wav' : format

export const getResponseMimeType = (
  headers: Headers,
  fallbackFormat: TtsOutputFormat,
): string => {
  const contentType = headers.get('content-type')?.split(';')[0]?.trim()
  return contentType || mimeTypeForAudioFormat(fallbackFormat)
}

export const isAudioMimeType = (mimeType: string): boolean =>
  mimeType.toLowerCase().startsWith('audio/')

export const base64ToArrayBuffer = (base64: string): ArrayBuffer => {
  const normalized = base64.includes(',')
    ? base64.slice(base64.lastIndexOf(',') + 1)
    : base64
  const binary =
    typeof atob === 'function'
      ? atob(normalized)
      : (globalThis as unknown as { Buffer: typeof Buffer }).Buffer.from(
          normalized,
          'base64',
        ).toString('binary')
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes.buffer
}

export const findBase64AudioString = (payload: unknown): string | null => {
  if (!payload || typeof payload !== 'object') return null
  const visited = new Set<unknown>()
  const queue: unknown[] = [payload]
  const likelyAudioKeys = new Set(['data', 'audio', 'content', 'url'])

  while (queue.length > 0) {
    const current = queue.shift()
    if (!current || typeof current !== 'object' || visited.has(current)) {
      continue
    }
    visited.add(current)
    if (Array.isArray(current)) {
      queue.push(...current)
      continue
    }
    for (const [key, value] of Object.entries(current)) {
      if (typeof value === 'string' && likelyAudioKeys.has(key)) {
        const candidate = value.trim()
        if (candidate.startsWith('data:audio/') || looksLikeBase64(candidate)) {
          return candidate
        }
      } else if (value && typeof value === 'object') {
        queue.push(value)
      }
    }
  }
  return null
}

export const findAudioUrlString = (payload: unknown): string | null => {
  if (!payload || typeof payload !== 'object') return null
  const visited = new Set<unknown>()
  const queue: unknown[] = [payload]
  const likelyUrlKeys = new Set(['url', 'audio_url', 'audioUrl'])

  while (queue.length > 0) {
    const current = queue.shift()
    if (!current || typeof current !== 'object' || visited.has(current)) {
      continue
    }
    visited.add(current)
    if (Array.isArray(current)) {
      queue.push(...current)
      continue
    }
    for (const [key, value] of Object.entries(current)) {
      if (typeof value === 'string' && likelyUrlKeys.has(key)) {
        const candidate = value.trim()
        if (/^https?:\/\//i.test(candidate)) return candidate
      } else if (value && typeof value === 'object') {
        queue.push(value)
      }
    }
  }
  return null
}

const looksLikeBase64 = (value: string): boolean =>
  value.length >= 24 && /^[A-Za-z0-9+/]+={0,2}$/.test(value)

export const wrapPcm16AsWav = ({
  pcm,
  sampleRate,
  channels,
}: {
  pcm: ArrayBuffer
  sampleRate: number
  channels: 1 | 2
}): ArrayBuffer => {
  const pcmBytes = new Uint8Array(pcm)
  const header = new ArrayBuffer(44)
  const view = new DataView(header)
  const bytesPerSample = 2
  const byteRate = sampleRate * channels * bytesPerSample
  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + pcmBytes.byteLength, true)
  writeAscii(view, 8, 'WAVE')
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, channels * bytesPerSample, true)
  view.setUint16(34, 16, true)
  writeAscii(view, 36, 'data')
  view.setUint32(40, pcmBytes.byteLength, true)

  const out = new Uint8Array(44 + pcmBytes.byteLength)
  out.set(new Uint8Array(header), 0)
  out.set(pcmBytes, 44)
  return out.buffer
}

const writeAscii = (view: DataView, offset: number, value: string): void => {
  for (let i = 0; i < value.length; i++) {
    view.setUint8(offset + i, value.charCodeAt(i))
  }
}
