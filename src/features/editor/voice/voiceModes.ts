export const VOICE_MODE_IDS = [
  'toggle-listen',
  'hold-to-talk',
  'audio-file',
  'read-aloud',
] as const

export type VoiceModeId = (typeof VOICE_MODE_IDS)[number]

// TTS/read-aloud is planned but not wired yet. Current runtime surfaces only
// the modes that already have complete workflow implementations.
export type ActiveVoiceModeId = Exclude<VoiceModeId, 'read-aloud'>

export const CONTEXT_INPUT_VOICE_MODES = [
  'toggle-listen',
  'hold-to-talk',
] as const satisfies readonly ActiveVoiceModeId[]

export const CURRENT_FLOATING_VOICE_MODES = [
  'toggle-listen',
  'hold-to-talk',
  'audio-file',
] as const satisfies readonly ActiveVoiceModeId[]
