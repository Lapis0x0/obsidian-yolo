/**
 * Cross-provider ASR (automatic speech recognition) types.
 *
 * Voice input has very different transport shapes per provider — multipart
 * file upload for OpenAI-compatible `/v1/audio/transcriptions`, JSON message
 * with embedded audio content for OpenAI-compatible chat-audio ASR, and
 * binary PCM frames for WebSocket streaming ASR. The lowest common
 * denominator at the app layer is "give me audio, get me text".
 */

export type AsrAudioInput = {
  /** Recorded audio blob. Mime type is required so providers can pick the
   * right multipart filename / `format` field. */
  blob: Blob
  /** Original mime type the recorder produced (e.g. `audio/webm;codecs=opus`). */
  mimeType: string
  /** Duration of the recording in milliseconds, when known. */
  durationMs?: number
}

export type AsrOptions = {
  /** BCP47 language hint, or `'auto'` to defer to the provider. */
  language?: string
  /** Optional prompt to bias the recogniser (vocabulary, names). */
  prompt?: string
  /** Caller-supplied abort signal. Providers MUST honour it. */
  signal?: AbortSignal
}

export type AsrSegment = {
  startMs: number
  endMs: number
  text: string
}

export type AsrResult = {
  text: string
  language?: string
  segments?: AsrSegment[]
  /** Wall-clock duration of the request, useful for the settings test UI. */
  requestDurationMs?: number
}
