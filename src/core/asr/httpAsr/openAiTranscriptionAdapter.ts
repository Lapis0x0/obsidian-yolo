import type {
  AsrAudioFormat,
  AsrTransportMode,
} from '../../../settings/schema/setting.types'
import { transcodeToWav } from '../audioTranscode'
import { BaseAsrProvider } from '../base'
import { sendAsrMultipartRequest } from '../httpTransport'
import type { AsrAudioInput, AsrOptions, AsrResult } from '../types'

import {
  type MultipartField,
  buildMultipartBody,
  generateMultipartBoundary,
  guessAudioExtensionFromMime,
  joinUrl,
  truncateResponseBody,
} from './common'

export type TranscriptionProviderProfile = {
  baseURL: string
  apiKey: string
  model: string
  transcriptionPath: string
  transportMode: AsrTransportMode
  /**
   * When 'wav', we decode the captured opus/webm via the host AudioContext
   * and re-pack it as 16-bit PCM WAV before upload. Useful for servers whose
   * /v1/audio/transcriptions implementation refuses webm (some older local
   * Whisper deployments only accept wav/mp3). 'auto' = upload as captured.
   */
  audioFormat: AsrAudioFormat
  language: string
}

const DEFAULT_TRANSCRIPTION_PATH = '/audio/transcriptions'

/**
 * OpenAI-compatible `/v1/audio/transcriptions` provider.
 *
 * Same protocol shape works for the OpenAI cloud STT (`whisper-1`,
 * `gpt-4o-transcribe`, `gpt-4o-mini-transcribe`), and for local OpenAI-API
 * mimics like Speaches, faster-whisper-server and LocalAI. The audio file is
 * sent as `multipart/form-data` with a `file` field; the response is parsed
 * as `{ text: string, language?, segments? }`.
 *
 * The request is dispatched through the ASR HTTP transport selected in the
 * profile. Desktop auto follows the LLM provider path (Node fetch, then
 * browser fetch); explicit Obsidian requestUrl remains available for servers
 * that need it.
 */
export class OpenAiCompatibleTranscriptionProvider extends BaseAsrProvider {
  readonly format = 'openai-compatible-transcription'
  private readonly profile: TranscriptionProviderProfile

  constructor(profile: TranscriptionProviderProfile) {
    super()
    this.profile = profile
  }

  async transcribe(
    input: AsrAudioInput,
    options?: AsrOptions,
  ): Promise<AsrResult> {
    const {
      baseURL,
      apiKey,
      model,
      transcriptionPath,
      transportMode,
      audioFormat,
      language,
    } = this.profile
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

    // Optionally transcode the captured webm/opus blob into 16-bit PCM WAV
    // before upload. Needed for stricter transcription endpoints that refuse
    // the OpenAI default of accepting webm.
    const effectiveInput =
      audioFormat === 'wav' ? await transcodeToWav(input) : input

    const ext = guessAudioExtensionFromMime(
      effectiveInput.mimeType || effectiveInput.blob.type || '',
    )
    const filename = `recording.${ext}`
    const fileContentType =
      effectiveInput.blob.type || effectiveInput.mimeType || 'audio/webm'

    const langCandidate = (options?.language ?? language ?? '').trim()
    const fields: MultipartField[] = [
      {
        name: 'file',
        filename,
        contentType: fileContentType,
        blob: effectiveInput.blob,
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

    const boundary = generateMultipartBoundary()
    const body = await buildMultipartBody(boundary, fields)

    const startedAt = Date.now()
    const headers: Record<string, string> = {}
    if (apiKey && apiKey.trim().length > 0) {
      headers.Authorization = `Bearer ${apiKey.trim()}`
    }

    const response = await sendAsrMultipartRequest({
      url,
      body,
      boundary,
      headers,
      transportMode,
      signal: options?.signal,
    })

    if (options?.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError')
    }

    if (response.status < 200 || response.status >= 300) {
      const truncated = truncateResponseBody(response.text)
      throw new Error(
        `ASR transcription failed: ${response.status}${truncated ? ` — ${truncated}` : ''}`,
      )
    }

    const payload = response.json as {
      text?: unknown
      language?: unknown
    } | null

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
