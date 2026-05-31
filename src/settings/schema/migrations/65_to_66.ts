import {
  DEFAULT_READ_ALOUD_GENERATED_AUDIO_SAVE_DIR,
  type SettingMigration,
} from '../setting.types'

const VOICE_MODE_IDS = [
  'toggle-listen',
  'hold-to-talk',
  'audio-file',
  'read-aloud',
] as const

type VoiceModeId = (typeof VOICE_MODE_IDS)[number]

/**
 * v65->v66: add ordinary audio-file transcription, floating island mode
 * ordering, and read-aloud/TTS settings under context voice input options.
 * Uploading files and read aloud both stay disabled by default so existing
 * voice users keep their current behavior after migration.
 */
export const migrateFrom65To66: SettingMigration['migrate'] = (data) => {
  const voice =
    data.contextVoiceInputOptions &&
    typeof data.contextVoiceInputOptions === 'object' &&
    !Array.isArray(data.contextVoiceInputOptions)
      ? (data.contextVoiceInputOptions as Record<string, unknown>)
      : {}

  return {
    ...data,
    version: 66,
    contextVoiceInputOptions: {
      ...voice,
      floatingIslandEnabled:
        typeof voice.floatingIslandEnabled === 'boolean'
          ? voice.floatingIslandEnabled
          : true,
      floatingIslandModeOrder: normalizeModeOrder(
        voice.floatingIslandModeOrder,
        voice.interactionMode,
      ),
      floatingIslandHiddenModes: normalizeHiddenModes(
        voice.floatingIslandHiddenModes,
      ),
      audioFileTranscriptionEnabled:
        typeof voice.audioFileTranscriptionEnabled === 'boolean'
          ? voice.audioFileTranscriptionEnabled
          : false,
      activeAudioFileAsrConfigId:
        typeof voice.activeAudioFileAsrConfigId === 'string'
          ? voice.activeAudioFileAsrConfigId
          : '',
      audioFileChunkHeaderMode:
        voice.audioFileChunkHeaderMode === 'local-start-time'
          ? 'local-start-time'
          : 'none',
      audioFileOutputMetadataMode: normalizeAudioFileOutputMetadataMode(
        voice.audioFileOutputMetadataMode,
      ),
      audioFileFallbackNotePathTemplate:
        typeof voice.audioFileFallbackNotePathTemplate === 'string' &&
        voice.audioFileFallbackNotePathTemplate.trim().length > 0
          ? voice.audioFileFallbackNotePathTemplate
          : 'Transcriptions/{{date}} {{time}} {{basename}}.md',
      audioFileChunkTargetDurationSec: clampInt(
        voice.audioFileChunkTargetDurationSec,
        15,
        600,
        120,
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
      ttsConfigs: Array.isArray(voice.ttsConfigs) ? voice.ttsConfigs : [],
      activeTtsConfigId:
        typeof voice.activeTtsConfigId === 'string'
          ? voice.activeTtsConfigId
          : '',
      voiceReadAloudEnabled:
        typeof voice.voiceReadAloudEnabled === 'boolean'
          ? voice.voiceReadAloudEnabled
          : false,
      readAloudSourceMode: normalizeSourceMode(voice.readAloudSourceMode),
      readAloudChunkTargetChars: clampInt(
        voice.readAloudChunkTargetChars,
        200,
        6000,
        1000,
      ),
      readAloudPreloadSegments: clampInt(
        voice.readAloudPreloadSegments,
        0,
        3,
        1,
      ),
      readAloudCacheEnabled:
        typeof voice.readAloudCacheEnabled === 'boolean'
          ? voice.readAloudCacheEnabled
          : true,
      readAloudGeneratedAudioAutoSaveEnabled:
        typeof voice.readAloudGeneratedAudioAutoSaveEnabled === 'boolean'
          ? voice.readAloudGeneratedAudioAutoSaveEnabled
          : true,
      readAloudGeneratedAudioSaveDir: normalizeGeneratedAudioSaveDir(
        voice.readAloudGeneratedAudioSaveDir,
      ),
      readAloudMarkdownMode:
        voice.readAloudMarkdownMode === 'raw' ? 'raw' : 'readable',
      ttsOutputDeviceId:
        typeof voice.ttsOutputDeviceId === 'string'
          ? voice.ttsOutputDeviceId
          : '',
    },
  }
}

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
  interactionMode: unknown,
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

  // Keep the pre-migration active mode first so users do not see the floating
  // island switch to another mode immediately after upgrading.
  const existingMode = normalizeVoiceMode(interactionMode)
  return existingMode && out.includes(existingMode)
    ? [existingMode, ...out.filter((mode) => mode !== existingMode)]
    : out
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

const normalizeGeneratedAudioSaveDir = (value: unknown): string =>
  typeof value === 'string' && value.trim()
    ? value
    : DEFAULT_READ_ALOUD_GENERATED_AUDIO_SAVE_DIR

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
