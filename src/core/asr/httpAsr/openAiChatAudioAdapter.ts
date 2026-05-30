import type {
  AsrAudioFormat,
  AsrTransportMode,
} from '../../../settings/schema/setting.types'
import { transcodeToWav } from '../audioTranscode'
import { BaseAsrProvider } from '../base'
import { sendAsrJsonRequest } from '../httpTransport'
import type { AsrAudioInput, AsrOptions, AsrResult } from '../types'

import {
  blobToBase64,
  guessAudioFormatLabelFromMime,
  joinUrl,
  truncateResponseBody,
} from './common'

export type ChatAudioProviderProfile = {
  baseURL: string
  apiKey: string
  model: string
  chatCompletionsPath: string
  audioContentFormat: string
  audioFormat: AsrAudioFormat
  transportMode: AsrTransportMode
  language: string
}

const DEFAULT_CHAT_COMPLETIONS_PATH = '/chat/completions'

const buildAudioContentPart = (
  format: string,
  base64Audio: string,
  audioFormatLabel: string,
): unknown => {
  // OpenAI / OpenRouter / OpenAI-compatible multimodal style (default).
  // This is the only schema documented by OpenAI for `/v1/chat/completions`
  // audio input today; other vLLM-served ASR models that target OpenAI-API
  // compatibility (Qwen3-ASR `qwen-asr-serve`, FireRedASR2-LLM) accept this
  // shape directly.
  if (format === 'input_audio' || format === '' || format === undefined) {
    return {
      type: 'input_audio',
      input_audio: {
        data: base64Audio,
        format: audioFormatLabel,
      },
    }
  }
  // Aliyun Bailian / DashScope variant: same `type: 'input_audio'` envelope,
  // but `data` is interpreted as a URL field — either http(s) or a `data:`
  // URI. Sending raw base64 here yields "The provided URL does not appear to
  // be valid." We prepend the data-URI prefix so the validator accepts it.
  if (format === 'input_audio_data_url') {
    return {
      type: 'input_audio',
      input_audio: {
        data: `data:audio/${audioFormatLabel};base64,${base64Audio}`,
        format: audioFormatLabel,
      },
    }
  }
  if (format === 'audio_url') {
    return {
      type: 'audio_url',
      audio_url: {
        url: `data:audio/${audioFormatLabel};base64,${base64Audio}`,
      },
    }
  }
  // Unknown / custom — fall back to input_audio so misconfigured servers at
  // least see a recognised content part instead of an empty body.
  return {
    type: 'input_audio',
    input_audio: {
      data: base64Audio,
      format: audioFormatLabel,
    },
  }
}

const extractTextFromChatCompletion = (payload: unknown): string => {
  if (!payload || typeof payload !== 'object') return ''
  const choices = (payload as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) return ''
  const first = choices[0]
  if (!first || typeof first !== 'object') return ''
  const message = (first as { message?: unknown }).message
  if (!message || typeof message !== 'object') return ''
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part && typeof part === 'object') {
          const partRecord = part as { type?: unknown; text?: unknown }
          if (
            partRecord.type === 'text' &&
            typeof partRecord.text === 'string'
          ) {
            return partRecord.text
          }
        }
        return ''
      })
      .join('')
  }
  return ''
}

/**
 * OpenAI-compatible chat-audio ASR.
 *
 * This is the other "OpenAI-compatible" path — audio embedded in a chat
 * message and submitted to `/v1/chat/completions`. Used by OpenAI
 * `gpt-4o-audio-preview`, Qwen3-ASR served via `qwen-asr-serve`,
 * FireRedASR2-LLM served via vLLM, and other multimodal-audio OpenAI-API
 * mimics. NOT interchangeable with `/v1/audio/transcriptions`.
 */
export class OpenAiCompatibleChatAudioAsrProvider extends BaseAsrProvider {
  readonly format = 'openai-compatible-chat-audio-asr'
  private readonly profile: ChatAudioProviderProfile

  constructor(profile: ChatAudioProviderProfile) {
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
      chatCompletionsPath,
      audioContentFormat,
      audioFormat,
      transportMode,
      language,
    } = this.profile
    if (!baseURL.trim()) {
      throw new Error('ASR provider is missing baseURL.')
    }
    if (!model.trim()) {
      throw new Error('ASR provider is missing model.')
    }

    const path =
      chatCompletionsPath && chatCompletionsPath.trim().length > 0
        ? chatCompletionsPath
        : DEFAULT_CHAT_COMPLETIONS_PATH
    const url = joinUrl(baseURL, path)

    // Some providers reject webm in chat-audio (e.g. Google Gemini: "Invalid
    // audio format 'webm'. Valid formats are: [wav, mp3]"). When the user
    // selects `wav` we decode the captured opus/webm via the host AudioContext
    // and re-pack it as 16-bit PCM WAV before upload. `auto` keeps the
    // captured container as-is.
    const effectiveInput =
      audioFormat === 'wav' ? await transcodeToWav(input) : input

    const audioFormatLabel = guessAudioFormatLabelFromMime(
      effectiveInput.mimeType || effectiveInput.blob.type || '',
    )
    const base64Audio = await blobToBase64(effectiveInput.blob)
    const audioPart = buildAudioContentPart(
      audioContentFormat,
      base64Audio,
      audioFormatLabel,
    )

    const langCandidate = (options?.language ?? language ?? '').trim()
    const promptText =
      options?.prompt && options.prompt.trim().length > 0
        ? options.prompt.trim()
        : `Transcribe the audio verbatim. Return only the spoken text, no commentary, no markdown. Preserve the original language${
            langCandidate && langCandidate !== 'auto'
              ? ` (${langCandidate})`
              : ''
          }.`

    // Aliyun Bailian's `qwen3-asr-flash` is a dedicated ASR task: the user
    // message MUST contain only the audio part — any text/prompt yields
    // "The dedicated task `asr` ... does not support this input." It also
    // ignores chat-completions-style fields like `modalities` and
    // `reasoning_effort`. We treat `input_audio_data_url` as the Bailian
    // shape today; if another provider later wants the data-URL carrier
    // but still accepts a text prompt, split this into its own knob.
    const isBailianAsrShape = audioContentFormat === 'input_audio_data_url'

    // ASR is transcription, not chain-of-thought. Some chat-audio backends
    // (notably Google Gemini 2.5+) default to "thinking" mode, which adds
    // tens of seconds of hidden reasoning for what should be a sub-second
    // audio → text job. We always send reasoning_effort: 'none' to disable
    // it; backends that don't know the field will ignore it.
    const body: Record<string, unknown> = isBailianAsrShape
      ? {
          model,
          messages: [
            {
              role: 'user',
              content: [audioPart],
            },
          ],
        }
      : {
          model,
          modalities: ['text'],
          messages: [
            {
              role: 'user',
              content: [{ type: 'text', text: promptText }, audioPart],
            },
          ],
          reasoning_effort: 'none',
        }

    if (options?.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError')
    }

    const startedAt = Date.now()
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (apiKey && apiKey.trim().length > 0) {
      headers.Authorization = `Bearer ${apiKey.trim()}`
    }

    const response = await sendAsrJsonRequest({
      url,
      body,
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
        `ASR chat-audio request failed: ${response.status}${truncated ? ` — ${truncated}` : ''}`,
      )
    }

    const text = extractTextFromChatCompletion(response.json)

    return {
      text,
      requestDurationMs: Date.now() - startedAt,
    }
  }
}
