import type { AsrConfig } from '../../settings/schema/setting.types'

export type AudioFileAsrCapability = {
  maxRequestBytes: number | null
  maxDurationMs: number | null
  supportsLocalFile: boolean
  supportsChunkedUpload: boolean
  supportsFileStreaming: boolean
}

const OPENAI_TRANSCRIPTION_MAX_BYTES = 25 * 1024 * 1024
// Chat-audio requests embed audio as data-uri base64. Providers such as
// Aliyun reject data-uri items over 20 MiB, so the raw blob cap needs room for
// base64 expansion plus the data-uri prefix.
const CHAT_AUDIO_MAX_BYTES = 14 * 1024 * 1024

/**
 * Conservative local capability hints for ordinary audio-file transcription.
 * Provider-specific limits can be added here without changing saved ASR
 * configs; the task planner only needs safe defaults for deciding whether to
 * upload as one file, split locally, or stream through WebSocket ASR.
 */
export function getAudioFileAsrCapability(
  config: AsrConfig,
): AudioFileAsrCapability {
  switch (config.format) {
    case 'openai-compatible-transcription':
      return {
        maxRequestBytes: OPENAI_TRANSCRIPTION_MAX_BYTES,
        maxDurationMs: null,
        supportsLocalFile: true,
        supportsChunkedUpload: true,
        supportsFileStreaming: false,
      }
    case 'openai-compatible-chat-audio-asr':
      return {
        maxRequestBytes: CHAT_AUDIO_MAX_BYTES,
        maxDurationMs: null,
        supportsLocalFile: true,
        supportsChunkedUpload: true,
        supportsFileStreaming: false,
      }
    case 'deepgram-compatible-websocket':
      return {
        maxRequestBytes: null,
        maxDurationMs: null,
        supportsLocalFile: true,
        supportsChunkedUpload: false,
        supportsFileStreaming: true,
      }
    default: {
      const exhaustive: never = config.format
      return exhaustive
    }
  }
}
