export const VOICE_MODE_IDS = [
  'toggle-listen',
  'hold-to-talk',
  'audio-file',
  'read-aloud',
] as const

export type VoiceModeId = (typeof VOICE_MODE_IDS)[number]

export type ActiveVoiceModeId = VoiceModeId

export const CONTEXT_INPUT_VOICE_MODES = [
  'toggle-listen',
  'hold-to-talk',
] as const satisfies readonly ActiveVoiceModeId[]

export const CURRENT_FLOATING_VOICE_MODES = [
  'toggle-listen',
  'hold-to-talk',
  'audio-file',
  'read-aloud',
] as const satisfies readonly ActiveVoiceModeId[]
