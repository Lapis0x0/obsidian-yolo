import type { AudioFilePlanSummary } from './audio-file-transcription/audioFileTranscriptionController'

export type VoiceInputState =
  | 'idle'
  | 'recording'
  | 'checking'
  | 'confirm-plan'
  | 'preparing'
  | 'uploading'
  | 'transcribing'
  | 'inserting'
  | 'polishing'
  | 'ready'

export type VoiceInputStatus = {
  state: VoiceInputState
  error?: string
  overlayState?: Exclude<VoiceInputState, 'idle' | 'recording'>
  recordingStartedAt: number | null
  mediaStream: MediaStream | null
  canCancel: boolean
  asrDurationMs?: number
  polishDurationMs?: number
  message?: string
  progressLabel?: string
  audioFilePlan?: AudioFilePlanSummary
}

export type VoiceInputStateListener = (status: VoiceInputStatus) => void

export const IDLE_VOICE_INPUT_STATUS: VoiceInputStatus = {
  state: 'idle',
  recordingStartedAt: null,
  mediaStream: null,
  canCancel: false,
  asrDurationMs: undefined,
  polishDurationMs: undefined,
}
