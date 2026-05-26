import type {
  AsrApiFormat,
  ContextVoiceInputOptions,
} from '../../settings/schema/setting.types'

import type { BaseAsrProvider } from './base'
import { OpenAiCompatibleChatAudioAsrProvider } from './openAiCompatibleChatAudio'
import { OpenAiCompatibleTranscriptionProvider } from './openAiCompatibleTranscription'

export class AsrConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AsrConfigError'
  }
}

/**
 * Build an ASR provider client from the current voice-input settings.
 * Throws `AsrConfigError` when the selected profile is missing or
 * incomplete; callers should surface the message to the user and route them
 * back to the Models tab.
 */
export function getAsrProvider(
  options: ContextVoiceInputOptions,
): BaseAsrProvider {
  const format = options.selectedAsrApiFormat
  const profiles = options.asrProviderProfiles
  return buildAsrProviderForFormat(format, profiles)
}

export function buildAsrProviderForFormat(
  format: AsrApiFormat,
  profiles: ContextVoiceInputOptions['asrProviderProfiles'],
): BaseAsrProvider {
  switch (format) {
    case 'openai-compatible-transcription': {
      const profile = profiles['openai-compatible-transcription']
      if (!profile) {
        throw new AsrConfigError(
          'OpenAI-compatible transcription profile is not configured.',
        )
      }
      if (!profile.baseURL.trim() || !profile.model.trim()) {
        throw new AsrConfigError(
          'OpenAI-compatible transcription profile needs both baseURL and model.',
        )
      }
      return new OpenAiCompatibleTranscriptionProvider(profile)
    }
    case 'openai-compatible-chat-audio-asr': {
      const profile = profiles['openai-compatible-chat-audio-asr']
      if (!profile) {
        throw new AsrConfigError(
          'OpenAI-compatible chat-audio ASR profile is not configured.',
        )
      }
      if (!profile.baseURL.trim() || !profile.model.trim()) {
        throw new AsrConfigError(
          'OpenAI-compatible chat-audio ASR profile needs both baseURL and model.',
        )
      }
      return new OpenAiCompatibleChatAudioAsrProvider(profile)
    }
    default: {
      const exhaustive: never = format
      throw new AsrConfigError(
        `Unsupported ASR API format: ${String(exhaustive)}`,
      )
    }
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
