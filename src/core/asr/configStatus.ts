import type {
  AsrConfig,
  ContextVoiceInputOptions,
} from '../../settings/schema/setting.types'

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
  const list = options.asrConfigs
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

export function isUsableAsrConfig(config: AsrConfig): boolean {
  switch (config.format) {
    case 'openai-compatible-transcription':
    case 'openai-compatible-chat-audio-asr':
      return config.baseURL.trim().length > 0 && config.model.trim().length > 0
    case 'deepgram-compatible-websocket':
      return config.baseURL.trim().length > 0
    default:
      return false
  }
}
