import type {
  ContextVoiceInputOptions,
  TtsConfig,
} from '../../settings/schema/setting.types'

import { DashScopeCosyVoiceProvider } from './dashscopeCosyVoice'
import { MimoChatAudioTtsProvider } from './mimoChatAudioTts'
import { OpenAiCompatibleSpeechProvider } from './openAiCompatibleSpeech'
import type { TtsProvider, TtsProviderProfile } from './types'

export class TtsConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TtsConfigError'
  }
}

export function resolveActiveTtsConfig(
  options: ContextVoiceInputOptions,
): TtsConfig | null {
  const list = options.ttsConfigs ?? []
  if (!Array.isArray(list) || list.length === 0) return null
  if (options.activeTtsConfigId) {
    const match = list.find((config) => config.id === options.activeTtsConfigId)
    if (match) return match
  }
  return list[0] ?? null
}

export function getTtsProvider(options: ContextVoiceInputOptions): TtsProvider {
  const config = resolveActiveTtsConfig(options)
  if (!config) {
    throw new TtsConfigError('No TTS provider is configured.')
  }
  return buildTtsProviderForConfig(config)
}

export function buildTtsProviderForConfig(config: TtsConfig): TtsProvider {
  assertConfigComplete(config)
  const profile = toProviderProfile(config)
  switch (config.format) {
    case 'openai-compatible-speech':
      return new OpenAiCompatibleSpeechProvider(profile)
    case 'mimo-chat-audio-tts':
      return new MimoChatAudioTtsProvider(profile)
    case 'dashscope-cosyvoice':
      return new DashScopeCosyVoiceProvider(profile)
    default: {
      const exhaustive: never = config.format
      throw new TtsConfigError(
        `Unsupported TTS API format: ${String(exhaustive)}`,
      )
    }
  }
}

const assertConfigComplete = (config: TtsConfig): void => {
  if (!config.baseURL.trim()) {
    throw new TtsConfigError('TTS provider is missing baseURL.')
  }
  if (!config.model.trim()) {
    throw new TtsConfigError('TTS provider is missing model.')
  }
  if (!config.voice.trim()) {
    throw new TtsConfigError('TTS provider is missing voice.')
  }
  if (
    config.format === 'dashscope-cosyvoice' &&
    config.apiKey.trim().length === 0
  ) {
    throw new TtsConfigError('DashScope CosyVoice provider needs an API key.')
  }
}

const toProviderProfile = (config: TtsConfig): TtsProviderProfile => ({
  baseURL: config.baseURL,
  apiKey: config.apiKey,
  model: config.model,
  voice: config.voice,
  outputFormat: config.outputFormat,
  sampleRate: config.sampleRate,
  speed: config.speed,
  pitch: config.pitch,
  volume: config.volume,
  language: config.language,
  styleInstruction: config.styleInstruction,
  transportMode: config.transportMode,
  requestPath: config.requestPath,
})
