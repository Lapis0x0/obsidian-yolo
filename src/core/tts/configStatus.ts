import type {
  ContextVoiceInputOptions,
  TtsConfig,
} from '../../settings/schema/setting.types'

import { resolveActiveTtsConfig } from './manager'

/**
 * Lightweight TTS readiness checks for startup/settings UI.
 *
 * Keep provider construction out of this file so the floating island can
 * decide whether read-aloud is available without pulling in HTTP adapters.
 */
export function resolveConfiguredTtsConfig(
  options: ContextVoiceInputOptions,
): TtsConfig | null {
  const config = resolveActiveTtsConfig(options)
  return config && isUsableTtsConfig(config) ? config : null
}

export function hasConfiguredTtsConfig(
  options: ContextVoiceInputOptions,
): boolean {
  return resolveConfiguredTtsConfig(options) !== null
}

export function isUsableTtsConfig(config: TtsConfig): boolean {
  if (config.baseURL.trim().length === 0) return false
  if (config.voice.trim().length === 0) return false
  if (config.model.trim().length === 0) return false
  if (
    config.format === 'dashscope-cosyvoice' &&
    config.apiKey.trim().length === 0
  ) {
    return false
  }
  return true
}
