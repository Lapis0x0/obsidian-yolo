import type { SettingMigration } from '../setting.types'

/**
 * v64→v65: introduce `contextVoiceInputOptions` for the context-aware voice
 * input feature. (Renumbered from 62→63 after upstream consumed 62→63 and
 * 63→64 for selection-highlight and history-archive cleanups respectively.)
 *
 * Storage shape:
 *   contextVoiceInputOptions: {
 *     asrConfigs: AsrConfig[]
 *     activeAsrConfigId: string
 *     autoRestartAfterAccept: boolean
 *     documentSummaryEnabled: boolean
 *     documentSummaryRefreshMode: 'smart' | 'session' | '15min' | '1hour'
 *     ...
 *   }
 *
 * Each `AsrConfig` is a flat entry holding every field for any supported
 * ASR API format plus the `audioFormat` knob (default 'auto'; switch to
 * 'wav' for endpoints that reject webm). The active config is referenced
 * by id so the user can drag-reorder configs without losing track of which
 * one is in use. Active-config selection now lives in Editor → Voice input
 * rather than as a radio button in the Models tab.
 *
 * Most v62 vaults never touched this section, so they end up with an empty
 * `asrConfigs: []`, default smart summaries, and the feature stays
 * inert until the user adds a config.
 *
 * Pre-list legacy shape (`selectedAsrApiFormat + asrProviderProfiles` from
 * the in-development branch) is converted to entries of the new list with
 * the matching active id. We deliberately keep the conversion folded into
 * this single migration — v63 was never released with the legacy shape, so
 * there is no need for an intermediate migration.
 */
export const migrateFrom64To65: SettingMigration['migrate'] = (data) => {
  const root = data ?? {}
  const voice = (root.contextVoiceInputOptions ?? {}) as Record<string, unknown>

  // Already in list shape (e.g. re-imported settings): leave alone, just bump.
  if (Array.isArray(voice.asrConfigs)) {
    return { ...data, version: 65 }
  }

  const profiles =
    (voice.asrProviderProfiles as Record<string, unknown> | undefined) ?? {}
  const selectedFormat =
    typeof voice.selectedAsrApiFormat === 'string'
      ? voice.selectedAsrApiFormat
      : 'openai-compatible-transcription'
  const topLevelLanguage =
    typeof voice.language === 'string' ? voice.language : 'auto'

  const configs: Array<Record<string, unknown>> = []

  const transcription = profiles['openai-compatible-transcription'] as
    | Record<string, unknown>
    | undefined
  if (transcription && hasMeaningfulField(transcription)) {
    configs.push({
      id: makeId(),
      name: 'Transcription',
      asrCategory: 'http-short-audio',
      asrProvider: 'openai-compatible-transcription',
      format: 'openai-compatible-transcription',
      baseURL: stringOr(transcription.baseURL, ''),
      apiKey: stringOr(transcription.apiKey, ''),
      model: stringOr(transcription.model, ''),
      transcriptionPath: stringOr(transcription.transcriptionPath, ''),
      chatCompletionsPath: '',
      audioContentFormat: 'input_audio',
      webSocketProtocol: 'deepgram-compatible',
      webSocketPunctuate: true,
      webSocketDiarizeMode: 'off',
      webSocketDictation: false,
      audioFormat: 'auto',
      transportMode: 'node',
      language: stringOr(transcription.language, topLevelLanguage),
    })
  }

  const chatAudio = profiles['openai-compatible-chat-audio-asr'] as
    | Record<string, unknown>
    | undefined
  if (chatAudio && hasMeaningfulField(chatAudio)) {
    configs.push({
      id: makeId(),
      name: 'Chat Audio',
      asrCategory: 'http-short-audio',
      asrProvider: 'openai-compatible-chat-audio-asr',
      format: 'openai-compatible-chat-audio-asr',
      baseURL: stringOr(chatAudio.baseURL, ''),
      apiKey: stringOr(chatAudio.apiKey, ''),
      model: stringOr(chatAudio.model, ''),
      transcriptionPath: '',
      chatCompletionsPath: stringOr(chatAudio.chatCompletionsPath, ''),
      audioContentFormat: stringOr(chatAudio.audioContentFormat, 'input_audio'),
      webSocketProtocol: 'deepgram-compatible',
      webSocketPunctuate: true,
      webSocketDiarizeMode: 'off',
      webSocketDictation: false,
      // Legacy chat-audio recordings were sent as wav for broad endpoint
      // compatibility (notably Gemini-compatible OpenAI facades).
      audioFormat: 'wav',
      transportMode: 'node',
      language: stringOr(chatAudio.language, topLevelLanguage),
    })
  }

  const activeAsrConfigId =
    configs.find((c) => c.format === selectedFormat)?.id ?? configs[0]?.id ?? ''

  // Drop pre-list fields so they don't get parsed back.
  const {
    selectedAsrApiFormat: _selectedAsrApiFormat,
    asrProviderProfiles: _asrProviderProfiles,
    language: _language,
    ...restVoice
  } = voice as {
    selectedAsrApiFormat?: unknown
    asrProviderProfiles?: unknown
    language?: unknown
    [key: string]: unknown
  }

  return {
    ...data,
    version: 65,
    contextVoiceInputOptions: {
      ...restVoice,
      asrConfigs: configs,
      activeAsrConfigId,
    },
  }
}

const stringOr = (value: unknown, fallback: string): string =>
  typeof value === 'string' && value.length > 0 ? value : fallback

const hasMeaningfulField = (profile: Record<string, unknown>): boolean => {
  const baseURL = typeof profile.baseURL === 'string' ? profile.baseURL : ''
  const model = typeof profile.model === 'string' ? profile.model : ''
  return baseURL.trim().length > 0 || model.trim().length > 0
}

let counter = 0
const makeId = (): string => {
  counter += 1
  return `asr-${Date.now().toString(36)}-${counter}`
}
