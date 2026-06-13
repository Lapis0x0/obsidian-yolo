import type { AsrWebSocketFeatureMode } from '../../settings/schema/setting.types'

import type { AsrOptions } from './types'

export const resolveAsrFeatureMode = (
  mode: AsrWebSocketFeatureMode,
  purpose: AsrOptions['purpose'] | undefined,
): boolean => {
  if (mode === 'on') return true
  if (mode === 'off') return false
  return purpose === 'audio-file-transcription'
}

export const shouldIncludeAsrSpeakerLabels = (
  mode: AsrWebSocketFeatureMode,
  purpose: AsrOptions['purpose'] | undefined,
): boolean =>
  resolveAsrFeatureMode(mode, purpose) && purpose === 'audio-file-transcription'
