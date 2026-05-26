import { requestUrl } from 'obsidian'

import type { OpenAiCompatibleTranscriptionProfile } from '../../settings/schema/setting.types'

import { BaseAsrProvider } from './base'
import type { AsrAudioInput, AsrOptions, AsrResult } from './types'

const DEFAULT_TRANSCRIPTION_PATH = '/audio/transcriptions'

const guessExtensionFromMime = (mimeType: string): string => {
  const lower = mimeType.toLowerCase()
  if (lower.includes('webm')) return 'webm'
  if (lower.includes('ogg')) return 'ogg'
  if (lower.includes('mp4') || lower.includes('m4a')) return 'm4a'
  if (lower.includes('mpeg') || lower.includes('mp3')) return 'mp3'
  if (lower.includes('wav')) return 'wav'
  if (lower.includes('flac')) return 'flac'
  return 'webm'
}

const joinUrl = (baseURL: string, path: string): string => {
  const trimmedBase = baseURL.replace(/\/+$/, '')
  const trimmedPath = path.replace(/^\/+/, '')
  return `${trimmedBase}/${trimmedPath}`
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

const generateBoundary = (): string =>
  `----yolo-asr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

const buildMultipartBody = async (
  boundary: string,
  fields: Array<
    | { name: string; value: string }
    | { name: string; filename: string; contentType: string; blob: Blob }
  >,
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

/**
 * OpenAI-compatible `/v1/audio/transcriptions` provider.
 *
 * Same protocol shape works for the OpenAI cloud STT (`whisper-1`,
 * `gpt-4o-transcribe`, `gpt-4o-mini-transcribe`), and for local OpenAI-API
 * mimics like Speaches, faster-whisper-server and LocalAI. The audio file is
 * sent as `multipart/form-data` with a `file` field; the response is parsed
 * as `{ text: string, language?, segments? }`.
 *
 * The request is dispatched through Obsidian's `requestUrl` so it routes
 * through the host's networking layer (proxy, TLS, CORS bypass) rather than
 * the renderer's `fetch`. `requestUrl` does not honour `AbortSignal` today;
 * cancellation is enforced at the caller by checking `signal.aborted` after
 * the request returns.
 */
export class OpenAiCompatibleTranscriptionProvider extends BaseAsrProvider {
  readonly format = 'openai-compatible-transcription'
  private readonly profile: OpenAiCompatibleTranscriptionProfile

  constructor(profile: OpenAiCompatibleTranscriptionProfile) {
    super()
    this.profile = profile
  }

  async transcribe(
    input: AsrAudioInput,
    options?: AsrOptions,
  ): Promise<AsrResult> {
    const { baseURL, apiKey, model, transcriptionPath, language } = this.profile
    if (!baseURL.trim()) {
      throw new Error('ASR provider is missing baseURL.')
    }
    if (!model.trim()) {
      throw new Error('ASR provider is missing model.')
    }
    if (options?.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError')
    }

    const path =
      transcriptionPath && transcriptionPath.trim().length > 0
        ? transcriptionPath
        : DEFAULT_TRANSCRIPTION_PATH
    const url = joinUrl(baseURL, path)

    const ext = guessExtensionFromMime(input.mimeType || input.blob.type || '')
    const filename = `recording.${ext}`
    const fileContentType = input.blob.type || input.mimeType || 'audio/webm'

    const langCandidate = (options?.language ?? language ?? '').trim()
    const fields: Array<
      | { name: string; value: string }
      | { name: string; filename: string; contentType: string; blob: Blob }
    > = [
      {
        name: 'file',
        filename,
        contentType: fileContentType,
        blob: input.blob,
      },
      { name: 'model', value: model },
      { name: 'response_format', value: 'json' },
    ]
    if (langCandidate && langCandidate !== 'auto') {
      fields.push({ name: 'language', value: langCandidate })
    }
    if (options?.prompt && options.prompt.trim().length > 0) {
      fields.push({ name: 'prompt', value: options.prompt })
    }

    const boundary = generateBoundary()
    const body = await buildMultipartBody(boundary, fields)

    const startedAt = Date.now()
    const headers: Record<string, string> = {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    }
    if (apiKey && apiKey.trim().length > 0) {
      headers.Authorization = `Bearer ${apiKey.trim()}`
    }

    const response = await requestUrl({
      url,
      method: 'POST',
      headers,
      body,
      throw: false,
    })

    if (options?.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError')
    }

    if (response.status < 200 || response.status >= 300) {
      const errBody = response.text ?? ''
      const truncated =
        errBody.length > 500 ? `${errBody.slice(0, 500)}…` : errBody
      throw new Error(
        `ASR transcription failed: ${response.status}${truncated ? ` — ${truncated}` : ''}`,
      )
    }

    let payload: { text?: unknown; language?: unknown } | null = null
    try {
      payload = response.json as {
        text?: unknown
        language?: unknown
      } | null
    } catch {
      payload = null
    }

    const text = payload && typeof payload.text === 'string' ? payload.text : ''
    const resultLanguage =
      payload && typeof payload.language === 'string'
        ? payload.language
        : undefined

    return {
      text,
      language: resultLanguage,
      requestDurationMs: Date.now() - startedAt,
    }
  }
}
