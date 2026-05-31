import type { AsrConfig } from '../../settings/schema/setting.types'

export type AudioFileAsrCapability = {
  /** Raw request-size cap for direct uploads. */
  maxRequestBytes: number | null
  /** Provider cap for locally generated WAV chunks, including overlap. */
  maxDurationMs: number | null
  supportsLocalFile: boolean
  supportsChunkedUpload: boolean
  supportsFileStreaming: boolean
}

export type AudioFileChunkDurationAdvisory = {
  maxRequestBytes: number
  suggestedMaxDurationMs: number
}

export const SUPPORTED_HTTP_LONG_AUDIO_ASR_PROVIDERS = ['funasr-local'] as const

const OPENAI_TRANSCRIPTION_MAX_BYTES = 25 * 1024 * 1024
// Chat-audio requests embed audio as data-uri base64. Providers such as
// Aliyun reject data-uri items over 20 MiB, so the raw blob cap needs room for
// base64 expansion plus the data-uri prefix.
const CHAT_AUDIO_MAX_BYTES = 14 * 1024 * 1024
// Bailian / DashScope multimodal audio has a stricter algorithm-side limit
// than the generic data-uri gateway limit. Local chunks are always WAV, so use
// a duration cap here instead of another provider-specific byte constant.
const ALIYUN_CHAT_AUDIO_MAX_DURATION_MS = 30 * 1000

const KNOWN_AUDIO_FILE_REQUEST_LIMITS: Array<{
  format: AsrConfig['format']
  maxRequestBytes: number
  suggestedMaxDurationMs: number
}> = [
  {
    format: 'openai-compatible-transcription',
    maxRequestBytes: OPENAI_TRANSCRIPTION_MAX_BYTES,
    suggestedMaxDurationMs: 120 * 1000,
  },
  {
    format: 'openai-compatible-chat-audio-asr',
    maxRequestBytes: CHAT_AUDIO_MAX_BYTES,
    suggestedMaxDurationMs: 60 * 1000,
  },
]

/**
 * Conservative local capability hints for ordinary audio-file transcription.
 * Provider-specific limits can be added here without changing saved ASR
 * configs; the task planner only needs safe defaults for deciding whether to
 * upload as one file, split locally, or stream through WebSocket ASR.
 */
export function getAudioFileAsrCapability(
  config: AsrConfig,
): AudioFileAsrCapability {
  if (config.asrCategory === 'http-long-audio') {
    if (isSupportedHttpLongAudioAsrConfig(config)) {
      return {
        maxRequestBytes: null,
        maxDurationMs: null,
        supportsLocalFile: true,
        supportsChunkedUpload: false,
        supportsFileStreaming: false,
      }
    }
    return {
      maxRequestBytes: null,
      maxDurationMs: null,
      supportsLocalFile: false,
      supportsChunkedUpload: false,
      supportsFileStreaming: false,
    }
  }

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
        maxDurationMs: isAliyunChatAudioConfig(config)
          ? ALIYUN_CHAT_AUDIO_MAX_DURATION_MS
          : null,
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

export function isSupportedHttpLongAudioAsrConfig(config: AsrConfig): boolean {
  return (
    config.asrCategory === 'http-long-audio' &&
    SUPPORTED_HTTP_LONG_AUDIO_ASR_PROVIDERS.some(
      (provider) => provider === config.asrProvider,
    )
  )
}

/**
 * Advisory-only guard for the settings UI. Execution still follows
 * `maxDurationMs`; this helper only warns when a user-selected chunk duration
 * is longer than what our known request-size caps can comfortably carry after
 * local WAV chunking.
 */
export function getAudioFileChunkDurationAdvisory(input: {
  config: AsrConfig | null
  chunkDurationMs: number
}): AudioFileChunkDurationAdvisory | null {
  const config = input.config
  if (!config || config.asrCategory !== 'http-short-audio') return null
  const limit = KNOWN_AUDIO_FILE_REQUEST_LIMITS.find(
    (entry) => entry.format === config.format,
  )
  if (!limit) return null

  const capability = getAudioFileAsrCapability(config)
  const suggestedMaxDurationMs =
    capability.maxDurationMs === null
      ? limit.suggestedMaxDurationMs
      : Math.min(capability.maxDurationMs, limit.suggestedMaxDurationMs)

  if (input.chunkDurationMs <= suggestedMaxDurationMs) return null
  return {
    maxRequestBytes: limit.maxRequestBytes,
    suggestedMaxDurationMs,
  }
}

function isAliyunChatAudioConfig(config: AsrConfig): boolean {
  const baseURL = config.baseURL.toLowerCase()
  const audioContentFormat = config.audioContentFormat.toLowerCase()
  return (
    audioContentFormat === 'input_audio_data_url' ||
    baseURL.includes('dashscope.aliyuncs.com') ||
    baseURL.includes('dashscope-intl.aliyuncs.com') ||
    baseURL.includes('bailian') ||
    baseURL.includes('aliyun')
  )
}
