import type { SettingMigration } from '../setting.types'

/**
 * v62→v63: introduce `contextVoiceInputOptions` for the context-aware voice
 * input feature.
 *
 * Storage shape:
 *   contextVoiceInputOptions: {
 *     asrConfigs: AsrConfig[]
 *     activeAsrConfigId: string
 *     ...
 *   }
 *
 * Where each `AsrConfig` is a flat entry holding all fields for any of the
 * supported ASR API formats plus the `audioFormat` knob (defaults to 'auto';
 * set to 'wav' for Google Gemini which rejects webm). The active config is
 * referenced by id so the user can drag-reorder configs in the settings UI
 * without losing track of which one is in use.
 *
 * Most v62 vaults never touched this section, so they end up with an empty
 * `asrConfigs: []` and the feature stays inert until the user adds a config.
 *
 * For users who already had data under the *pre-list* voice schema (a
 * `selectedAsrApiFormat + asrProviderProfiles` pair that briefly existed
 * during feature development), we convert each non-empty legacy profile into
 * its own AsrConfig and pick the entry matching `selectedAsrApiFormat` as
 * active. The conversion is folded into this single migration on purpose —
 * we don't ship a separate "list refactor" migration since v63 was never
 * released with the legacy shape.
 */
export const migrateFrom62To63: SettingMigration['migrate'] = (data) => {
  const root = data ?? {}
  const voice = (root.contextVoiceInputOptions ?? {}) as Record<string, unknown>

  // Already in list shape (e.g. re-imported settings): leave alone, just bump.
  if (Array.isArray(voice.asrConfigs)) {
    return { ...data, version: 63 }
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
      format: 'openai-compatible-transcription',
      baseURL: stringOr(transcription.baseURL, ''),
      apiKey: stringOr(transcription.apiKey, ''),
      model: stringOr(transcription.model, ''),
      transcriptionPath: stringOr(transcription.transcriptionPath, ''),
      chatCompletionsPath: '',
      audioContentFormat: 'input_audio',
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
      name: 'Chat audio ASR',
      format: 'openai-compatible-chat-audio-asr',
      baseURL: stringOr(chatAudio.baseURL, ''),
      apiKey: stringOr(chatAudio.apiKey, ''),
      model: stringOr(chatAudio.model, ''),
      transcriptionPath: '',
      chatCompletionsPath: stringOr(chatAudio.chatCompletionsPath, ''),
      audioContentFormat: stringOr(chatAudio.audioContentFormat, 'input_audio'),
      audioFormat: 'auto',
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
    version: 63,
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
