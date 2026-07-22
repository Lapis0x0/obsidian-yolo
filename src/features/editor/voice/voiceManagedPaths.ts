import { rebasePathWithinYoloBaseDir } from '../../../core/paths/yoloPaths'
import type { YoloSettings } from '../../../settings/schema/setting.types'

/**
 * The complete YOLO root moves atomically, so persisted voice destinations
 * beneath it must follow the same rename. Explicit destinations elsewhere in
 * the Vault remain user-owned and are intentionally left unchanged.
 */
export const rebaseVoiceManagedPaths = (
  settings: YoloSettings,
  sourceBaseDir: string,
  targetBaseDir: string,
  previousSettings?: YoloSettings,
): YoloSettings => {
  const voice = settings.contextVoiceInputOptions
  const previousVoice = previousSettings?.contextVoiceInputOptions
  // When callers change the root and a destination in the same settings
  // transaction, the explicitly changed destination wins over auto-rebasing.
  const readAloudGeneratedAudioSaveDir =
    previousVoice &&
    voice.readAloudGeneratedAudioSaveDir !==
      previousVoice.readAloudGeneratedAudioSaveDir
      ? voice.readAloudGeneratedAudioSaveDir
      : rebasePathWithinYoloBaseDir(
          voice.readAloudGeneratedAudioSaveDir,
          sourceBaseDir,
          targetBaseDir,
        )
  const audioFileFallbackNotePathTemplate =
    previousVoice &&
    voice.audioFileFallbackNotePathTemplate !==
      previousVoice.audioFileFallbackNotePathTemplate
      ? voice.audioFileFallbackNotePathTemplate
      : rebasePathWithinYoloBaseDir(
          voice.audioFileFallbackNotePathTemplate,
          sourceBaseDir,
          targetBaseDir,
        )

  if (
    readAloudGeneratedAudioSaveDir === voice.readAloudGeneratedAudioSaveDir &&
    audioFileFallbackNotePathTemplate ===
      voice.audioFileFallbackNotePathTemplate
  ) {
    return settings
  }

  return {
    ...settings,
    contextVoiceInputOptions: {
      ...voice,
      readAloudGeneratedAudioSaveDir,
      audioFileFallbackNotePathTemplate,
    },
  }
}
