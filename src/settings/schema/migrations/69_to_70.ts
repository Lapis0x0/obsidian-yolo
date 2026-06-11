import type { SettingMigration } from '../setting.types'

const VOICE_MODE_IDS = [
  'toggle-listen',
  'hold-to-talk',
  'audio-file',
  'read-aloud',
] as const

type VoiceModeId = (typeof VOICE_MODE_IDS)[number]

const VOICE_POLISH_PROMPT_MODES = [
  'default',
  'translate',
  'expand',
  'polish',
  'custom',
] as const

type VoicePolishPromptMode = (typeof VOICE_POLISH_PROMPT_MODES)[number]

const DOCUMENT_SUMMARY_REFRESH_MODES = [
  'smart',
  'session',
  '15min',
  '1hour',
] as const

type DocumentSummaryRefreshMode =
  (typeof DOCUMENT_SUMMARY_REFRESH_MODES)[number]

const DEFAULT_AUDIO_FILE_FALLBACK_NOTE_PATH_TEMPLATE =
  'YOLO/transcriptions/{{date}} {{time}} {{basename}}.md'
const DEFAULT_READ_ALOUD_GENERATED_AUDIO_SAVE_DIR = 'YOLO/read_aloud'

/**
 * v69->v70: add the final context-aware voice-input settings shape after
 * upstream consumed v67->v69 for unrelated mainline migrations.
 *
 * Maintenance note: when this branch follows upstream again, first check the
 * mainline SETTINGS_SCHEMA_VERSION and occupied migration numbers. Voice
 * migrations must move after the newest mainline version; do not merge
 * unrelated mainline and voice logic into one numbered migration file.
 *
 * This migration preserves existing final-schema voice values whenever they
 * are valid. It only converts the legacy ASR profile shape that maps cleanly
 * to the final `asrConfigs` list, and deliberately does not preserve
 * cancelled development-only fields or modes.
 */
export const migrateFrom69To70: SettingMigration['migrate'] = (data) => {
  const voice = isRecord(data.contextVoiceInputOptions)
    ? data.contextVoiceInputOptions
    : {}
  const hasAsrList = Array.isArray(voice.asrConfigs)
  const asrConfigs = hasAsrList
    ? (voice.asrConfigs as unknown[])
    : buildLegacyAsrConfigs(voice)
  const interactionMode =
    normalizeVoiceMode(voice.interactionMode) ?? 'toggle-listen'

  const next: Record<string, unknown> = {
    ...data,
    version: 70,
    contextVoiceInputOptions: {
      floatingIslandEnabled: booleanOr(voice.floatingIslandEnabled, true),
      floatingIslandModeOrder: normalizeModeOrder(
        voice.floatingIslandModeOrder,
        interactionMode,
      ),
      floatingIslandHiddenModes: normalizeHiddenModes(
        voice.floatingIslandHiddenModes,
      ),
      enabled: booleanOr(voice.enabled, false),
      asrConfigs,
      activeAsrConfigId: hasAsrList
        ? stringOr(voice.activeAsrConfigId, '')
        : resolveLegacyActiveAsrConfigId(voice, asrConfigs),
      ttsConfigs: Array.isArray(voice.ttsConfigs) ? voice.ttsConfigs : [],
      activeTtsConfigId: stringOr(voice.activeTtsConfigId, ''),
      polishModelId: stringOr(voice.polishModelId, ''),
      polishTemperature: normalizePolishTemperature(voice.polishTemperature),
      systemPromptMode: normalizePromptMode(voice.systemPromptMode),
      customSystemPrompt: stringOr(voice.customSystemPrompt, ''),
      interactionMode,
      audioFileTranscriptionEnabled: booleanOr(
        voice.audioFileTranscriptionEnabled,
        false,
      ),
      voiceReadAloudEnabled: booleanOr(voice.voiceReadAloudEnabled, false),
      readAloudSourceMode: normalizeSourceMode(voice.readAloudSourceMode),
      readAloudChunkTargetChars: clampInt(
        voice.readAloudChunkTargetChars,
        200,
        6000,
        500,
      ),
      readAloudPreloadSegments: clampInt(
        voice.readAloudPreloadSegments,
        0,
        3,
        1,
      ),
      readAloudCacheEnabled: booleanOr(voice.readAloudCacheEnabled, true),
      readAloudGeneratedAudioAutoSaveEnabled: booleanOr(
        voice.readAloudGeneratedAudioAutoSaveEnabled,
        true,
      ),
      readAloudGeneratedAudioSaveDir: nonEmptyStringOr(
        voice.readAloudGeneratedAudioSaveDir,
        DEFAULT_READ_ALOUD_GENERATED_AUDIO_SAVE_DIR,
      ),
      readAloudMarkdownMode:
        voice.readAloudMarkdownMode === 'raw' ? 'raw' : 'readable',
      activeAudioFileAsrConfigId: stringOr(
        voice.activeAudioFileAsrConfigId,
        '',
      ),
      audioFileChunkHeaderMode:
        voice.audioFileChunkHeaderMode === 'local-start-time'
          ? 'local-start-time'
          : 'none',
      audioFileOutputMetadataMode: normalizeAudioFileOutputMetadataMode(
        voice.audioFileOutputMetadataMode,
      ),
      audioFileFallbackNotePathTemplate: nonEmptyStringOr(
        voice.audioFileFallbackNotePathTemplate,
        DEFAULT_AUDIO_FILE_FALLBACK_NOTE_PATH_TEMPLATE,
      ),
      audioFileChunkTargetDurationSec: clampInt(
        voice.audioFileChunkTargetDurationSec,
        15,
        600,
        120,
      ),
      audioFileWavMaxDurationSec: clampInt(
        voice.audioFileWavMaxDurationSec,
        30,
        2 * 60 * 60,
        60 * 60,
      ),
      audioFileMaxConcurrentChunks: clampInt(
        voice.audioFileMaxConcurrentChunks,
        1,
        5,
        5,
      ),
      audioFileChunkStartStaggerMs: clampInt(
        voice.audioFileChunkStartStaggerMs,
        1000,
        3000,
        1500,
      ),
      audioFileChunkOverlapMs: clampInt(
        voice.audioFileChunkOverlapMs,
        0,
        1500,
        500,
      ),
      contextRangeChars: clampIntMin(voice.contextRangeChars, 0, 2000),
      maxAfterContextChars: clampIntMin(voice.maxAfterContextChars, 0, 600),
      maxRecordingSeconds: clampInt(voice.maxRecordingSeconds, 5, 900, 120),
      vadSpeechStartDecibels: clampNumber(
        voice.vadSpeechStartDecibels,
        -50,
        -5,
        -40,
      ),
      vadSilenceDecibels: clampNumber(voice.vadSilenceDecibels, -50, -5, -36),
      vadSpeechRequiredMs: clampInt(voice.vadSpeechRequiredMs, 50, 2000, 200),
      vadSilenceHoldMs: clampInt(voice.vadSilenceHoldMs, 300, 5000, 1200),
      floatingIslandBottomOffsetVh: clampNumber(
        voice.floatingIslandBottomOffsetVh,
        0,
        50,
        9,
      ),
      microphoneDeviceId: stringOr(voice.microphoneDeviceId, ''),
      ttsOutputDeviceId: stringOr(voice.ttsOutputDeviceId, ''),
      autoRestartAfterAccept: booleanOr(voice.autoRestartAfterAccept, false),
      documentSummaryEnabled: booleanOr(voice.documentSummaryEnabled, true),
      documentSummaryRefreshMode: normalizeDocumentSummaryRefreshMode(
        voice.documentSummaryRefreshMode,
      ),
    },
  }

  backfillMainlineAssistantContextFields(next)
  return next
}

const backfillMainlineAssistantContextFields = (
  next: Record<string, unknown>,
): void => {
  const chatOptions = isRecord(next.chatOptions) ? next.chatOptions : {}
  const includeCurrentFileContent =
    chatOptions.includeCurrentFileContent !== undefined
      ? Boolean(chatOptions.includeCurrentFileContent)
      : true
  const timeContextEnabled =
    next.timeContextEnabled !== undefined
      ? Boolean(next.timeContextEnabled)
      : true

  if (!Array.isArray(next.assistants)) {
    return
  }

  // Branch users may already have a temporary voice v68, which means the
  // mainline v67->v68 migration would be skipped. Fill only missing fields so
  // normal mainline users keep their per-agent choices.
  next.assistants = next.assistants.map((assistant) => {
    if (!isRecord(assistant)) {
      return assistant
    }

    return {
      ...assistant,
      includeCurrentFileContent:
        assistant.includeCurrentFileContent ?? includeCurrentFileContent,
      timeContextEnabled: assistant.timeContextEnabled ?? timeContextEnabled,
    }
  })
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const booleanOr = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback

const stringOr = (value: unknown, fallback: string): string =>
  typeof value === 'string' ? value : fallback

const nonEmptyStringOr = (value: unknown, fallback: string): string =>
  typeof value === 'string' && value.trim().length > 0 ? value : fallback

const normalizePolishTemperature = (value: unknown): number | null => {
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0.2
  return Math.min(2, Math.max(0, value))
}

const normalizePromptMode = (value: unknown): VoicePolishPromptMode =>
  VOICE_POLISH_PROMPT_MODES.includes(value as VoicePolishPromptMode)
    ? (value as VoicePolishPromptMode)
    : 'default'

const normalizeAudioFileOutputMetadataMode = (value: unknown): string => {
  if (value === 'none') return 'none'
  if (value === 'title' || value === 'full' || value === 'metadata') {
    return 'metadata'
  }
  if (value === 'metadata-timestamps') return 'metadata-timestamps'
  return 'metadata-timestamps'
}

const normalizeVoiceMode = (value: unknown): VoiceModeId | null =>
  VOICE_MODE_IDS.includes(value as VoiceModeId) ? (value as VoiceModeId) : null

const normalizeModeOrder = (
  value: unknown,
  interactionMode: VoiceModeId,
): VoiceModeId[] => {
  const out: VoiceModeId[] = []
  const raw = Array.isArray(value) ? value : VOICE_MODE_IDS
  for (const item of raw) {
    const mode = normalizeVoiceMode(item)
    if (mode && !out.includes(mode)) out.push(mode)
  }
  for (const mode of VOICE_MODE_IDS) {
    if (!out.includes(mode)) out.push(mode)
  }

  // Keep the existing active mode first so the floating island does not jump
  // to another mode immediately after upgrading.
  return [interactionMode, ...out.filter((mode) => mode !== interactionMode)]
}

const normalizeHiddenModes = (value: unknown): VoiceModeId[] => {
  if (!Array.isArray(value)) return []
  const out: VoiceModeId[] = []
  for (const item of value) {
    const mode = normalizeVoiceMode(item)
    if (mode && !out.includes(mode)) out.push(mode)
  }
  return out
}

const normalizeSourceMode = (value: unknown): string => {
  if (value === 'selection' || value === 'document') return value
  return 'selection-or-document'
}

const normalizeDocumentSummaryRefreshMode = (
  value: unknown,
): DocumentSummaryRefreshMode =>
  DOCUMENT_SUMMARY_REFRESH_MODES.includes(value as DocumentSummaryRefreshMode)
    ? (value as DocumentSummaryRefreshMode)
    : 'smart'

const clampInt = (
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const rounded = Math.round(value)
  return Math.min(max, Math.max(min, rounded))
}

const clampIntMin = (value: unknown, min: number, fallback: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(min, Math.round(value))
}

const clampNumber = (
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

const buildLegacyAsrConfigs = (
  voice: Record<string, unknown>,
): Array<Record<string, unknown>> => {
  const profiles = isRecord(voice.asrProviderProfiles)
    ? voice.asrProviderProfiles
    : {}
  const topLevelLanguage = stringOr(voice.language, 'auto')
  const configs: Array<Record<string, unknown>> = []

  const transcription = profiles['openai-compatible-transcription']
  if (isRecord(transcription) && hasMeaningfulAsrProfile(transcription)) {
    configs.push({
      id: makeId(),
      name: 'Transcription',
      asrCategory: 'http-short-audio',
      asrProvider: 'openai-compatible-transcription',
      format: 'openai-compatible-transcription',
      baseURL: stringOr(transcription.baseURL, ''),
      apiKey: stringOr(transcription.apiKey, ''),
      apiSecret: '',
      appId: '',
      model: stringOr(transcription.model, ''),
      transcriptionPath: stringOr(transcription.transcriptionPath, ''),
      jobPath: '',
      resultPath: '',
      chatCompletionsPath: '',
      audioContentFormat: 'input_audio',
      webSocketProtocol: 'deepgram-compatible',
      webSocketPunctuate: true,
      webSocketDiarizeMode: 'off',
      webSocketDictation: false,
      webSocketFileStreamingRate: 2,
      audioFormat: 'auto',
      transportMode: 'node',
      language: stringOr(transcription.language, topLevelLanguage),
      longAudioPunctuation: true,
      longAudioDiarization: true,
      longAudioSpeakerCount: 0,
      longAudioTimestamps: true,
    })
  }

  const chatAudio = profiles['openai-compatible-chat-audio-asr']
  if (isRecord(chatAudio) && hasMeaningfulAsrProfile(chatAudio)) {
    configs.push({
      id: makeId(),
      name: 'Chat Audio',
      asrCategory: 'http-short-audio',
      asrProvider: 'openai-compatible-chat-audio-asr',
      format: 'openai-compatible-chat-audio-asr',
      baseURL: stringOr(chatAudio.baseURL, ''),
      apiKey: stringOr(chatAudio.apiKey, ''),
      apiSecret: '',
      appId: '',
      model: stringOr(chatAudio.model, ''),
      transcriptionPath: '',
      jobPath: '',
      resultPath: '',
      chatCompletionsPath: stringOr(chatAudio.chatCompletionsPath, ''),
      audioContentFormat: stringOr(chatAudio.audioContentFormat, 'input_audio'),
      webSocketProtocol: 'deepgram-compatible',
      webSocketPunctuate: true,
      webSocketDiarizeMode: 'off',
      webSocketDictation: false,
      webSocketFileStreamingRate: 2,
      // Legacy chat-audio recordings were sent as wav for broad endpoint
      // compatibility, notably Gemini-compatible OpenAI facades.
      audioFormat: 'wav',
      transportMode: 'node',
      language: stringOr(chatAudio.language, topLevelLanguage),
      longAudioPunctuation: true,
      longAudioDiarization: true,
      longAudioSpeakerCount: 0,
      longAudioTimestamps: true,
    })
  }

  return configs
}

const resolveLegacyActiveAsrConfigId = (
  voice: Record<string, unknown>,
  configs: unknown[],
): string => {
  if (typeof voice.activeAsrConfigId === 'string')
    return voice.activeAsrConfigId
  const selectedFormat = stringOr(
    voice.selectedAsrApiFormat,
    'openai-compatible-transcription',
  )
  const selected = configs.find(
    (config): config is Record<string, unknown> =>
      isRecord(config) && config.format === selectedFormat,
  )
  const first = configs.find(isRecord)
  return stringOr(selected?.id, stringOr(first?.id, ''))
}

const hasMeaningfulAsrProfile = (profile: Record<string, unknown>): boolean => {
  const baseURL = stringOr(profile.baseURL, '')
  const model = stringOr(profile.model, '')
  return baseURL.trim().length > 0 || model.trim().length > 0
}

let counter = 0
const makeId = (): string => {
  counter += 1
  return `asr-${Date.now().toString(36)}-${counter}`
}
