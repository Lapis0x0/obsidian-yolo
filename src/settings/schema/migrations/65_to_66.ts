import type { SettingMigration } from '../setting.types'

/**
 * v65->v66: add ordinary audio-file transcription settings under the
 * context voice input options. The feature stays disabled by default so
 * existing users do not accidentally upload a long dropped file.
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
      audioFileOutputMetadataMode:
        voice.audioFileOutputMetadataMode === 'title' ||
        voice.audioFileOutputMetadataMode === 'full'
          ? voice.audioFileOutputMetadataMode
          : 'none',
      audioFileFallbackNotePathTemplate:
        typeof voice.audioFileFallbackNotePathTemplate === 'string' &&
        voice.audioFileFallbackNotePathTemplate.trim().length > 0
          ? voice.audioFileFallbackNotePathTemplate
          : 'Transcriptions/{{date}} {{time}} {{basename}}.md',
      audioFileChunkTargetDurationSec: clampInt(
        voice.audioFileChunkTargetDurationSec,
        60,
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
    },
  }
}

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
