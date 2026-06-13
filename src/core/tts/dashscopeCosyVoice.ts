import { sendTtsHttpRequest } from './httpTransport'
import type {
  TtsProvider,
  TtsProviderProfile,
  TtsSynthesisRequest,
  TtsSynthesisResult,
} from './types'
import {
  base64ToArrayBuffer,
  coerceFileAudioFormat,
  findAudioUrlString,
  findBase64AudioString,
  getResponseMimeType,
  isAudioMimeType,
  joinUrl,
  mimeTypeForAudioFormat,
  truncateResponseBody,
} from './utils'

const DEFAULT_DASHSCOPE_PATH = '/api/v1/services/audio/tts/SpeechSynthesizer'

export class DashScopeCosyVoiceProvider implements TtsProvider {
  readonly format = 'dashscope-cosyvoice' as const
  readonly capabilities = { maxInputChars: 2000 }

  constructor(private readonly profile: TtsProviderProfile) {}

  async synthesize(request: TtsSynthesisRequest): Promise<TtsSynthesisResult> {
    const { baseURL, apiKey, transportMode, requestPath } = this.profile
    const model = request.model.trim()
    const voice = request.voice.trim()
    if (!baseURL.trim() || !model || !voice) {
      throw new Error('TTS config needs baseURL, model, and voice.')
    }

    const outputFormat = coerceFileAudioFormat(request.format)
    const input: Record<string, unknown> = {
      text: request.text,
      voice,
      format: outputFormat,
    }
    if (typeof request.sampleRate === 'number') {
      input.sample_rate = request.sampleRate
    }
    // DashScope CosyVoice calls this field `rate`; the shared TTS form exposes
    // it as `speed` to stay consistent across providers.
    if (typeof request.speed === 'number') input.rate = request.speed
    if (typeof request.pitch === 'number') input.pitch = request.pitch
    if (typeof request.volume === 'number') input.volume = request.volume
    if (request.language?.trim())
      input.language_hints = [request.language.trim()]
    if (request.styleInstruction?.trim()) {
      input.instruction = request.styleInstruction.trim()
    }

    const body = {
      model,
      input,
    }
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (apiKey.trim()) headers.Authorization = `Bearer ${apiKey.trim()}`

    const response = await sendTtsHttpRequest({
      url: joinUrl(baseURL, requestPath.trim() || DEFAULT_DASHSCOPE_PATH),
      headers,
      body: JSON.stringify(body),
      transportMode,
      signal: request.signal,
    })

    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        `DashScope CosyVoice request failed: ${response.status}${response.text ? ` - ${truncateResponseBody(response.text)}` : ''}`,
      )
    }

    const mimeType = getResponseMimeType(response.headers, outputFormat)
    if (isAudioMimeType(mimeType)) {
      return {
        kind: 'file',
        bytes: response.body,
        mimeType,
        format: outputFormat,
      }
    }

    const audioData = findBase64AudioString(response.json)
    if (audioData) {
      return {
        kind: 'file',
        bytes: base64ToArrayBuffer(audioData),
        mimeType: mimeTypeForAudioFormat(outputFormat),
        format: outputFormat,
      }
    }

    const audioUrl = findAudioUrlString(response.json)
    if (audioUrl) {
      const audioResponse = await sendTtsHttpRequest({
        url: audioUrl,
        method: 'GET',
        transportMode,
        signal: request.signal,
      })
      if (audioResponse.status < 200 || audioResponse.status >= 300) {
        throw new Error(
          `DashScope CosyVoice audio download failed: ${audioResponse.status}${audioResponse.text ? ` - ${truncateResponseBody(audioResponse.text)}` : ''}`,
        )
      }
      const audioMime = getResponseMimeType(audioResponse.headers, outputFormat)
      return {
        kind: 'file',
        bytes: audioResponse.body,
        mimeType: isAudioMimeType(audioMime)
          ? audioMime
          : mimeTypeForAudioFormat(outputFormat),
        format: outputFormat,
      }
    }

    throw new Error('DashScope CosyVoice response did not include audio data.')
  }
}
