import type {
  AsrConfig,
  ContextVoiceInputOptions,
} from '../../settings/schema/setting.types'

import type { BaseAsrProvider } from './base'
import { isSupportedHttpLongAudioAsrConfig } from './capabilities'
import {
  DeepgramPreRecordedProvider,
  FunAsrLocalProvider,
  OpenAiCompatibleChatAudioAsrProvider,
  OpenAiCompatibleTranscriptionProvider,
  TencentFlashProvider,
} from './httpAsr'
import { WebSocketAsrProvider } from './webSocketAsr'

export class AsrConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AsrConfigError'
  }
}

/**
 * Resolve the active ASR config from the user's settings.
 *
 * Selection rule:
 *   - If `activeAsrConfigId` matches an entry in `asrConfigs`, use it.
 *   - Otherwise fall back to the first entry in the list.
 *   - If the list is empty, return null (caller surfaces the "configure ASR
 *     first" hint).
 */
export function resolveActiveAsrConfig(
  options: ContextVoiceInputOptions,
): AsrConfig | null {
  const list = options.asrConfigs.filter(isContextVoiceRuntimeAsrConfig)
  if (!Array.isArray(list) || list.length === 0) return null
  if (options.activeAsrConfigId) {
    const match = list.find((c) => c.id === options.activeAsrConfigId)
    if (match) return match
  }
  return list[0] ?? null
}

export function resolveActiveAudioFileAsrConfig(
  options: ContextVoiceInputOptions,
): AsrConfig | null {
  const list = options.asrConfigs
  if (!Array.isArray(list) || list.length === 0) return null
  if (options.activeAudioFileAsrConfigId) {
    const match = list.find((c) => c.id === options.activeAudioFileAsrConfigId)
    if (match) return match
  }
  if (options.activeAsrConfigId) {
    const match = list.find((c) => c.id === options.activeAsrConfigId)
    if (match) return match
  }
  return list[0] ?? null
}

const isContextVoiceRuntimeAsrConfig = (config: AsrConfig): boolean =>
  config.asrCategory !== 'http-long-audio'

/**
 * Build an ASR provider client from the currently-active config.
 * Throws `AsrConfigError` when no config is configured or the active one is
 * incomplete; callers should surface the message to the user and route them
 * back to the Models tab.
 */
export function getAsrProvider(
  options: ContextVoiceInputOptions,
): BaseAsrProvider {
  const config = resolveActiveAsrConfig(options)
  if (!config) {
    throw new AsrConfigError(
      'No ASR provider is configured. Add one under Models → Voice recognition.',
    )
  }
  return buildAsrProviderForConfig(config)
}

/**
 * Build a provider for an arbitrary config (used by the settings page test
 * button to validate a specific entry without activating it).
 */
export function buildAsrProviderForConfig(config: AsrConfig): BaseAsrProvider {
  if (config.asrCategory === 'http-long-audio') {
    if (isSupportedHttpLongAudioAsrConfig(config)) {
      if (!config.baseURL.trim()) {
        throw new AsrConfigError('ASR provider is missing baseURL.')
      }
      return buildHttpLongAudioProvider(config)
    }
    throw new AsrConfigError(
      'Long-audio ASR provider adapters are not implemented yet.',
    )
  }

  if (config.asrProvider === 'funasr-local') {
    if (!config.baseURL.trim()) {
      throw new AsrConfigError('ASR provider is missing baseURL.')
    }
    return new FunAsrLocalProvider({
      baseURL: config.baseURL,
      apiKey: config.apiKey,
      model: config.model,
      transcriptionPath: config.transcriptionPath,
      transportMode: config.transportMode,
      language: config.language,
    })
  }

  switch (config.format) {
    case 'openai-compatible-transcription': {
      if (!config.baseURL.trim() || !config.model.trim()) {
        throw new AsrConfigError(
          'Transcription ASR config needs both baseURL and model.',
        )
      }
      return new OpenAiCompatibleTranscriptionProvider({
        baseURL: config.baseURL,
        apiKey: config.apiKey,
        model: config.model,
        transcriptionPath: config.transcriptionPath,
        transportMode: config.transportMode,
        audioFormat: config.audioFormat,
        language: config.language,
      })
    }
    case 'openai-compatible-chat-audio-asr': {
      if (!config.baseURL.trim() || !config.model.trim()) {
        throw new AsrConfigError(
          'Chat-audio ASR config needs both baseURL and model.',
        )
      }
      return new OpenAiCompatibleChatAudioAsrProvider({
        baseURL: config.baseURL,
        apiKey: config.apiKey,
        model: config.model,
        chatCompletionsPath: config.chatCompletionsPath,
        audioContentFormat: config.audioContentFormat,
        audioFormat: config.audioFormat,
        transportMode: config.transportMode,
        language: config.language,
      })
    }
    case 'deepgram-compatible-websocket': {
      if (!config.baseURL.trim()) {
        throw new AsrConfigError('WebSocket ASR config needs a baseURL.')
      }
      return new WebSocketAsrProvider({
        baseURL: config.baseURL,
        apiKey: config.apiKey,
        model: config.model,
        listenPath: config.transcriptionPath,
        webSocketProtocol: config.webSocketProtocol,
        webSocketPunctuate: config.webSocketPunctuate,
        webSocketDiarizeMode: config.webSocketDiarizeMode,
        webSocketDictation: config.webSocketDictation,
        audioFormat: config.audioFormat,
        language: config.language,
      })
    }
    default: {
      const exhaustive: never = config.format
      throw new AsrConfigError(
        `Unsupported ASR API format: ${String(exhaustive)}`,
      )
    }
  }
}

function buildHttpLongAudioProvider(config: AsrConfig): BaseAsrProvider {
  switch (config.asrProvider) {
    case 'funasr-local':
      return new FunAsrLocalProvider({
        baseURL: config.baseURL,
        apiKey: config.apiKey,
        model: config.model,
        transcriptionPath: config.transcriptionPath,
        transportMode: config.transportMode,
        language: config.language,
      })
    case 'deepgram-prerecorded':
      return new DeepgramPreRecordedProvider({
        baseURL: config.baseURL,
        apiKey: config.apiKey,
        model: config.model,
        transcriptionPath: config.transcriptionPath,
        transportMode: config.transportMode,
        language: config.language,
        diarization: config.longAudioDiarization,
        timestamps: config.longAudioTimestamps,
      })
    case 'tencent-flash':
      return new TencentFlashProvider({
        baseURL: config.baseURL,
        appId: config.appId,
        secretId: config.apiKey,
        secretKey: config.apiSecret,
        engineType: config.model,
        transcriptionPath: config.transcriptionPath,
        transportMode: config.transportMode,
        diarization: config.longAudioDiarization,
        timestamps: config.longAudioTimestamps,
      })
    default:
      throw new AsrConfigError(
        'Long-audio ASR provider adapters are not implemented yet.',
      )
  }
}

export function isAsrConfigured(options: ContextVoiceInputOptions): boolean {
  try {
    getAsrProvider(options)
    return true
  } catch {
    return false
  }
}
