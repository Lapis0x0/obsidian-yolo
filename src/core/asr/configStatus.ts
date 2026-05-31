import type {
  AsrConfig,
  ContextVoiceInputOptions,
} from '../../settings/schema/setting.types'

import { isSupportedHttpLongAudioAsrConfig } from './capabilities'

/**
 * Lightweight ASR readiness checks for startup/settings UI.
 *
 * Keep this file free of provider imports: constructing real providers pulls
 * in upload/transcode/WebSocket adapters and should happen only when the user
 * actually records or explicitly runs the settings test.
 */
export function resolveConfiguredAsrConfig(
  options: ContextVoiceInputOptions,
): AsrConfig | null {
  const list = options.asrConfigs.filter(
    (config) => config.asrCategory !== 'http-long-audio',
  )
  if (!Array.isArray(list) || list.length === 0) return null

  const active =
    options.activeAsrConfigId.length > 0
      ? list.find((config) => config.id === options.activeAsrConfigId)
      : undefined
  const config = active ?? list[0] ?? null
  return config && isUsableAsrConfig(config) ? config : null
}

export function hasConfiguredAsrConfig(
  options: ContextVoiceInputOptions,
): boolean {
  return resolveConfiguredAsrConfig(options) !== null
}

export function resolveConfiguredAudioFileAsrConfig(
  options: ContextVoiceInputOptions,
): AsrConfig | null {
  const list = options.asrConfigs
  if (!Array.isArray(list) || list.length === 0) return null

  const activeAudioFileId = options.activeAudioFileAsrConfigId ?? ''
  const activeVoiceId = options.activeAsrConfigId ?? ''
  const activeAudioFile =
    activeAudioFileId.length > 0
      ? list.find((config) => config.id === activeAudioFileId)
      : undefined
  const activeVoice =
    activeVoiceId.length > 0
      ? list.find((config) => config.id === activeVoiceId)
      : undefined
  const config = activeAudioFile ?? activeVoice ?? list[0] ?? null
  return config && isUsableAudioFileAsrConfig(config) ? config : null
}

export function hasConfiguredAudioFileAsrConfig(
  options: ContextVoiceInputOptions,
): boolean {
  return resolveConfiguredAudioFileAsrConfig(options) !== null
}

export function isUsableAsrConfig(config: AsrConfig): boolean {
  switch (config.format) {
    case 'openai-compatible-transcription':
      if (config.asrProvider === 'funasr-local') {
        return config.baseURL.trim().length > 0
      }
      return config.baseURL.trim().length > 0 && config.model.trim().length > 0
    case 'openai-compatible-chat-audio-asr':
      return config.baseURL.trim().length > 0 && config.model.trim().length > 0
    case 'deepgram-compatible-websocket':
      return config.baseURL.trim().length > 0
    default:
      return false
  }
}

function isUsableAudioFileAsrConfig(config: AsrConfig): boolean {
  if (config.asrCategory === 'http-long-audio') {
    if (!isSupportedHttpLongAudioAsrConfig(config)) return false
    if (config.baseURL.trim().length === 0) return false
    if (config.asrProvider === 'deepgram-prerecorded') {
      return config.apiKey.trim().length > 0
    }
    if (config.asrProvider === 'tencent-flash') {
      return (
        config.appId.trim().length > 0 &&
        config.apiKey.trim().length > 0 &&
        config.apiSecret.trim().length > 0
      )
    }
    return true
  }
  return isUsableAsrConfig(config)
}
