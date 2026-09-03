import type {
  AsrAudioInput,
  AsrOptions,
  AsrResult,
  AsrStreamingCallbacks,
  AsrStreamingOptions,
  AsrStreamingSession,
} from './types'

/**
 * Base class for ASR providers. Mirrors the BaseLLMProvider shape — a
 * concrete subclass holds its configuration (baseURL / apiKey / model) and
 * implements `transcribe`. Providers that can consume live audio chunks may
 * also implement `startStreaming`.
 */
export abstract class BaseAsrProvider {
  abstract readonly format: string

  abstract transcribe(
    input: AsrAudioInput,
    options?: AsrOptions,
  ): Promise<AsrResult>

  startStreaming?(
    options: AsrStreamingOptions,
    callbacks: AsrStreamingCallbacks,
  ): Promise<AsrStreamingSession>
}
