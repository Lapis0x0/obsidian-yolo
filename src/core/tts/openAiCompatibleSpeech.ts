import type { TtsOutputFormat } from '../../settings/schema/setting.types'

import { sendTtsHttpRequest } from './httpTransport'
import type {
  TtsProvider,
  TtsProviderProfile,
  TtsSynthesisRequest,
  TtsSynthesisResult,
} from './types'
import {
  coerceFileAudioFormat,
  getResponseMimeType,
  isAudioMimeType,
  joinUrl,
  mimeTypeForAudioFormat,
  truncateResponseBody,
  wrapPcm16AsWav,
} from './utils'

const DEFAULT_SPEECH_PATH = '/audio/speech'
const DEFAULT_PCM_SAMPLE_RATE = 24000

/**
 * OpenAI-compatible `/v1/audio/speech`.
 *
 * This adapter intentionally targets the direct speech endpoint only. Chat
 * completion audio output has different request/response semantics and stays
 * in a separate provider adapter.
 */
export class OpenAiCompatibleSpeechProvider implements TtsProvider {
  readonly format = 'openai-compatible-speech' as const
  readonly capabilities = { maxInputChars: 4096 }

  constructor(private readonly profile: TtsProviderProfile) {}

  async synthesize(request: TtsSynthesisRequest): Promise<TtsSynthesisResult> {
    const { baseURL, apiKey, transportMode, requestPath } = this.profile
    const model = request.model.trim()
    const voice = request.voice.trim()
    if (!baseURL.trim() || !model || !voice) {
      throw new Error('TTS config needs baseURL, model, and voice.')
    }

    const outputFormat = normalizeOpenAiOutputFormat(request.format)
    const path =
      requestPath.trim().length > 0 ? requestPath.trim() : DEFAULT_SPEECH_PATH
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (apiKey.trim()) headers.Authorization = `Bearer ${apiKey.trim()}`

    const body: Record<string, unknown> = {
      model,
      voice,
      input: request.text,
      response_format: outputFormat,
    }
    if (typeof request.speed === 'number') body.speed = request.speed
    if (request.styleInstruction?.trim()) {
      body.instructions = request.styleInstruction.trim()
    }

    const response = await sendTtsHttpRequest({
      url: joinUrl(baseURL, path),
      headers,
      body: JSON.stringify(body),
      transportMode,
      signal: request.signal,
    })

    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        `TTS speech request failed: ${response.status}${response.text ? ` - ${truncateResponseBody(response.text)}` : ''}`,
      )
    }

    const mimeType = getResponseMimeType(response.headers, outputFormat)
    if (!isAudioMimeType(mimeType) && outputFormat !== 'pcm') {
      throw new Error('TTS speech response did not contain audio data.')
    }

    if (outputFormat === 'pcm') {
      return {
        kind: 'file',
        bytes: wrapPcm16AsWav({
          pcm: response.body,
          sampleRate: request.sampleRate ?? DEFAULT_PCM_SAMPLE_RATE,
          channels: 1,
        }),
        mimeType: mimeTypeForAudioFormat('wav'),
        format: 'wav',
      }
    }

    return {
      kind: 'file',
      bytes: response.body,
      mimeType: mimeType || mimeTypeForAudioFormat(outputFormat),
      format: coerceFileAudioFormat(outputFormat),
    }
  }
}

const normalizeOpenAiOutputFormat = (
  format: TtsOutputFormat,
): Exclude<TtsOutputFormat, 'pcm16'> => (format === 'pcm16' ? 'wav' : format)
