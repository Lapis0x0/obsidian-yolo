/**
 * Cross-provider ASR (automatic speech recognition) types.
 *
 * Voice input has very different transport shapes per provider — multipart
 * file upload for OpenAI-compatible `/v1/audio/transcriptions`, JSON message
 * with embedded audio content for OpenAI-compatible Chat Audio, and
 * binary PCM frames for WebSocket streaming ASR. The lowest common
 * denominator at the app layer is "give me audio, get me text".
 */

import type { UploadProgress, UploadProgressCallback } from '../llm/fetchTypes'

export type AsrAudioInput = {
  /** Recorded audio blob. Mime type is required so providers can pick the
   * right multipart filename / `format` field. */
  blob: Blob
  /** Original mime type the recorder produced (e.g. `audio/webm;codecs=opus`). */
  mimeType: string
  /** Duration of the recording in milliseconds, when known. */
  durationMs?: number
}

export type AsrUploadProgress = UploadProgress
export type AsrUploadProgressCallback = UploadProgressCallback

export type AsrOptions = {
  /** BCP47 language hint, or `'auto'` to defer to the provider. */
  language?: string
  /** Optional prompt to bias the recogniser (vocabulary, names). */
  prompt?: string
  /** Caller-supplied abort signal. Providers MUST honour it. */
  signal?: AbortSignal
  /** Upload progress for large audio-file submissions. Best effort per transport. */
  onUploadProgress?: AsrUploadProgressCallback
  /** Caller context for ASR options whose "auto" value differs by workflow. */
  purpose?: 'context-voice-input' | 'audio-file-transcription' | 'settings-test'
}

export type AsrStreamingOptions = AsrOptions & {
  /** Mime type of chunks that will be sent through `sendAudioChunk`. */
  mimeType?: string
}

export type AsrStreamingCallbacks = {
  /** Interim transcript, expected to be replaced by later ASR events. */
  onPartial?: (text: string) => void
  /** Finalized transcript chunk from the ASR server. */
  onFinal?: (text: string) => void
}

export type AsrStreamingSession = {
  sendAudioChunk(chunk: Blob | ArrayBuffer): void
  keepAlive?(): void
  finish(): Promise<AsrResult>
  cancel(): void
}

export type AsrSegment = {
  startMs: number
  endMs: number
  text: string
  /** Stable provider speaker id when the ASR backend returns diarization. */
  speakerId?: string
  /** Display label derived from the provider speaker id. */
  speakerLabel?: string
}

export type AsrResult = {
  text: string
  language?: string
  segments?: AsrSegment[]
  /** Wall-clock duration of the request, useful for the settings test UI. */
  requestDurationMs?: number
}
