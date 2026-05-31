import type { TtsOutputFormat } from '../../settings/schema/setting.types'

import { sendTtsHttpRequest } from './httpTransport'
import type {
  TtsProvider,
  TtsProviderProfile,
  TtsSynthesisRequest,
  TtsSynthesisResult,
} from './types'
import {
  base64ToArrayBuffer,
  findBase64AudioString,
  joinUrl,
  mimeTypeForAudioFormat,
  truncateResponseBody,
  wrapPcm16AsWav,
} from './utils'

const DEFAULT_CHAT_COMPLETIONS_PATH = '/chat/completions'
const DEFAULT_PCM_SAMPLE_RATE = 24000
const MIMO_OUTPUT_FORMATS = new Set(['wav', 'mp3', 'pcm', 'pcm16'])

export class MimoChatAudioTtsProvider implements TtsProvider {
  readonly format = 'mimo-chat-audio-tts' as const
  readonly capabilities = { maxInputChars: 6000 }

  constructor(private readonly profile: TtsProviderProfile) {}

  async synthesize(request: TtsSynthesisRequest): Promise<TtsSynthesisResult> {
    const { baseURL, apiKey, transportMode, requestPath } = this.profile
    const model = request.model.trim()
    const voice = request.voice.trim()
    if (!baseURL.trim() || !model || !voice) {
      throw new Error('TTS config needs baseURL, model, and voice.')
    }

    const path =
      requestPath.trim().length > 0
        ? requestPath.trim()
        : DEFAULT_CHAT_COMPLETIONS_PATH
    const outputFormat = normalizeMimoOutputFormat(request.format)
    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = []
    if (request.styleInstruction?.trim()) {
      messages.push({
        role: 'user',
        content: request.styleInstruction.trim(),
      })
    }
    // MiMo TTS expects the text to be spoken as assistant content rather than
    // a user instruction. Keeping that shape isolated here avoids confusing
    // the generic OpenAI-compatible speech adapter.
    messages.push({ role: 'assistant', content: request.text })

    const body: Record<string, unknown> = {
      model,
      modalities: ['audio'],
      audio: {
        voice,
        format: outputFormat,
      },
      messages,
    }
    if (typeof request.speed === 'number') body.speed = request.speed

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (apiKey.trim()) headers.Authorization = `Bearer ${apiKey.trim()}`

    const response = await sendTtsHttpRequest({
      url: joinUrl(baseURL, path),
      headers,
      body: JSON.stringify(body),
      transportMode,
      signal: request.signal,
    })

    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        `MiMo TTS request failed: ${response.status}${response.text ? ` - ${truncateResponseBody(response.text)}` : ''}`,
      )
    }

    const audioData =
      extractMimoAudioData(response.json) ??
      findBase64AudioString(response.json)
    if (!audioData) {
      throw new Error('MiMo TTS response did not include base64 audio data.')
    }

    const bytes = base64ToArrayBuffer(audioData)
    if (outputFormat === 'pcm' || outputFormat === 'pcm16') {
      return {
        kind: 'file',
        bytes: wrapPcm16AsWav({
          pcm: bytes,
          sampleRate: request.sampleRate ?? DEFAULT_PCM_SAMPLE_RATE,
          channels: 1,
        }),
        mimeType: mimeTypeForAudioFormat('wav'),
        format: 'wav',
      }
    }

    return {
      kind: 'file',
      bytes,
      mimeType: mimeTypeForAudioFormat(outputFormat),
      format: outputFormat,
    }
  }
}

const normalizeMimoOutputFormat = (
  format: TtsOutputFormat,
): TtsOutputFormat => {
  if (MIMO_OUTPUT_FORMATS.has(format)) return format
  throw new Error('MiMo TTS supports only wav, mp3, pcm, or pcm16 output.')
}

const extractMimoAudioData = (payload: unknown): string | null => {
  if (!payload || typeof payload !== 'object') return null
  const choices = (payload as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) return null
  const first = choices[0]
  if (!first || typeof first !== 'object') return null
  const message = (first as { message?: unknown }).message
  if (!message || typeof message !== 'object') return null
  const audio = (message as { audio?: unknown }).audio
  if (!audio || typeof audio !== 'object') return null
  const data = (audio as { data?: unknown }).data
  return typeof data === 'string' ? data : null
}
