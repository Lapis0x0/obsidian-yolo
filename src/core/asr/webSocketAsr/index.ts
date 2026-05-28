import type { AsrApiFormat } from '../../../settings/schema/setting.types'
import { transcodeToPcm16 } from '../audioTranscode'
import { BaseAsrProvider } from '../base'
import type {
  AsrAudioInput,
  AsrOptions,
  AsrResult,
  AsrStreamingCallbacks,
  AsrStreamingOptions,
  AsrStreamingSession,
} from '../types'

import {
  DEFAULT_LISTEN_PATH,
  LINEAR16_SAMPLE_RATE,
  type WebSocketAsrProfile,
  appendQuery,
  joinUrl,
} from './common'
import {
  openDeepgramCompatibleStream,
  sendDeepgramCompatibleClip,
} from './deepgramAdapter'
import { openWhisperLiveKitNativeStream } from './whisperLiveKitAdapter'

export type { WebSocketAsrProfile } from './common'

/**
 * Router over the WebSocket ASR adapters. Profile selection by
 * `webSocketProtocol`; per-protocol framing lives in its sibling adapter
 * file. Adding a new WebSocket-based protocol (e.g. FunASR runtime) means
 * adding another adapter file + branching here, not modifying existing
 * adapters.
 *
 * `transcribe` is kept for settings tests and one-shot callers — it currently
 * routes through the Deepgram clip path because that is the only protocol
 * we have a one-shot upload variant for.
 */
export class WebSocketAsrProvider extends BaseAsrProvider {
  readonly format: AsrApiFormat = 'deepgram-compatible-websocket'
  private readonly profile: WebSocketAsrProfile

  constructor(profile: WebSocketAsrProfile) {
    super()
    this.profile = profile
  }

  async transcribe(
    input: AsrAudioInput,
    options?: AsrOptions,
  ): Promise<AsrResult> {
    const { baseURL, apiKey, model, listenPath, audioFormat, language } =
      this.profile
    if (!baseURL.trim()) {
      throw new Error('ASR provider is missing baseURL.')
    }
    if (options?.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError')
    }

    const path =
      listenPath && listenPath.trim().length > 0
        ? listenPath
        : DEFAULT_LISTEN_PATH
    const langCandidate = (options?.language ?? language ?? '').trim()
    const url = appendQuery(joinUrl(baseURL, path), {
      model,
      language:
        langCandidate && langCandidate !== 'auto' ? langCandidate : undefined,
      smart_format: 'true',
      ...(audioFormat === 'wav'
        ? {
            encoding: 'linear16',
            sample_rate: String(LINEAR16_SAMPLE_RATE),
            channels: '1',
          }
        : {}),
    })

    const audioBytes =
      audioFormat === 'wav'
        ? (await transcodeToPcm16(input, LINEAR16_SAMPLE_RATE)).audio
        : await input.blob.arrayBuffer()
    const startedAt = Date.now()
    const text = await sendDeepgramCompatibleClip({
      url,
      apiKey,
      audioBytes,
      signal: options?.signal,
    })

    return {
      text,
      requestDurationMs: Date.now() - startedAt,
    }
  }

  async startStreaming(
    options: AsrStreamingOptions,
    callbacks: AsrStreamingCallbacks,
  ): Promise<AsrStreamingSession> {
    const {
      baseURL,
      apiKey,
      model,
      listenPath,
      language,
      audioFormat,
      webSocketProtocol,
    } = this.profile
    if (!baseURL.trim()) {
      throw new Error('ASR provider is missing baseURL.')
    }
    if (options.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError')
    }

    const path =
      listenPath && listenPath.trim().length > 0
        ? listenPath
        : DEFAULT_LISTEN_PATH
    const langCandidate = (options.language ?? language ?? '').trim()
    const languageParam =
      langCandidate && langCandidate !== 'auto' ? langCandidate : undefined
    const baseWsUrl = joinUrl(baseURL, path)
    const url = appendQuery(baseWsUrl, {
      model,
      language: languageParam,
      smart_format: 'true',
      interim_results: 'true',
      ...(audioFormat === 'wav'
        ? {
            encoding: 'linear16',
            sample_rate: String(LINEAR16_SAMPLE_RATE),
            channels: '1',
          }
        : {}),
    })

    const streamArgs = {
      url,
      apiKey,
      signal: options.signal,
      callbacks,
    }
    if (webSocketProtocol === 'whisperlivekit-native') {
      return openWhisperLiveKitNativeStream(streamArgs)
    }
    return openDeepgramCompatibleStream(streamArgs)
  }
}
