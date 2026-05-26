import type { AsrAudioInput, AsrOptions, AsrResult } from './types'

/**
 * Base class for ASR providers. Mirrors the BaseLLMProvider shape — a
 * concrete subclass holds its configuration (baseURL / apiKey / model) and
 * implements `transcribe`. Streaming partial transcription is reserved for a
 * future `streamTranscribe` method when persistent listening lands.
 */
export abstract class BaseAsrProvider {
  abstract readonly format: string

  abstract transcribe(
    input: AsrAudioInput,
    options?: AsrOptions,
  ): Promise<AsrResult>
}
