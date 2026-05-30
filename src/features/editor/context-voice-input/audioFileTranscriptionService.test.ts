import type {
  AsrConfig,
  ContextVoiceInputOptions,
} from '../../../settings/schema/setting.types'

import {
  inspectAndPlanAudioFileTranscription,
  trimDuplicateChunkBoundary,
} from './audioFileTranscriptionService'

const baseConfig: AsrConfig = {
  id: 'asr',
  name: 'ASR',
  asrCategory: 'http-short-audio',
  asrProvider: 'openai-compatible-transcription',
  format: 'openai-compatible-transcription',
  baseURL: 'https://example.com/v1',
  apiKey: '',
  model: 'whisper-1',
  transcriptionPath: '/audio/transcriptions',
  chatCompletionsPath: '/chat/completions',
  audioContentFormat: 'input_audio',
  webSocketProtocol: 'deepgram-compatible',
  webSocketPunctuate: true,
  webSocketDiarizeMode: 'off',
  webSocketDictation: false,
  audioFormat: 'auto',
  transportMode: 'node',
  language: 'auto',
}

const options = (
  overrides: Partial<ContextVoiceInputOptions> = {},
): ContextVoiceInputOptions =>
  ({
    asrConfigs: [],
    activeAsrConfigId: '',
    activeAudioFileAsrConfigId: '',
    audioFileChunkTargetDurationSec: 120,
    audioFileChunkOverlapMs: 500,
    audioFileMaxConcurrentChunks: 5,
    audioFileChunkStartStaggerMs: 1500,
    ...overrides,
  }) as ContextVoiceInputOptions

describe('trimDuplicateChunkBoundary', () => {
  it('removes an exact short phrase repeated across chunk overlap', () => {
    expect(
      trimDuplicateChunkBoundary(
        'We should ship the audio plan after review',
        'after review and then update the checklist',
      ),
    ).toBe('and then update the checklist')
  })

  it('leaves non-identical overlap candidates untouched', () => {
    expect(
      trimDuplicateChunkBoundary(
        'We should ship the audio plan after review',
        'after reviewing the checklist',
      ),
    ).toBe('after reviewing the checklist')
  })
})

describe('inspectAndPlanAudioFileTranscription', () => {
  it('rejects long-audio placeholders before local short-audio planning', async () => {
    const longConfig: AsrConfig = {
      ...baseConfig,
      id: 'long',
      asrCategory: 'http-long-audio',
      asrProvider: 'funasr-local',
      model: 'paraformer-zh',
    }

    await expect(
      inspectAndPlanAudioFileTranscription({
        file: new File(['audio'], 'meeting.wav', { type: 'audio/wav' }),
        options: options({
          asrConfigs: [longConfig],
          activeAudioFileAsrConfigId: 'long',
        }),
      }),
    ).rejects.toThrow('Long-audio ASR provider adapters are not implemented')
  })
})
