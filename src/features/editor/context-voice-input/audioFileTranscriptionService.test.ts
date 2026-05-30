import type {
  AsrConfig,
  ContextVoiceInputOptions,
} from '../../../settings/schema/setting.types'

import {
  type AudioFileSource,
  createBlobAudioFileSource,
} from './audioFileSource'
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
    audioFileWavMaxDurationSec: 600,
    audioFileChunkOverlapMs: 500,
    audioFileMaxConcurrentChunks: 5,
    audioFileChunkStartStaggerMs: 1500,
    ...overrides,
  }) as ContextVoiceInputOptions

const source = (overrides: Partial<AudioFileSource> = {}): AudioFileSource => ({
  kind: 'blob',
  name: 'meeting.m4a',
  size: 100 * 1024 * 1024,
  type: 'audio/mp4',
  lastModified: 0,
  getFile: jest.fn(async () => {
    throw new Error('should not materialize')
  }),
  readSlice: jest.fn(async () => new Blob(['audio'], { type: 'audio/mp4' })),
  createObjectUrl: jest.fn(async () => null),
  ...overrides,
})

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
        source: createBlobAudioFileSource(
          new File(['audio'], 'meeting.wav', { type: 'audio/wav' }),
        ),
        options: options({
          asrConfigs: [longConfig],
          activeAudioFileAsrConfigId: 'long',
        }),
      }),
    ).rejects.toThrow('Long-audio ASR provider adapters are not implemented')
  })

  it('plans WebSocket auto streaming for large files without materializing them', async () => {
    const getFile = jest.fn(async () => {
      throw new Error('should not materialize')
    })
    const wsConfig: AsrConfig = {
      ...baseConfig,
      id: 'ws',
      asrCategory: 'websocket',
      format: 'deepgram-compatible-websocket',
      audioFormat: 'auto',
    }

    const plan = await inspectAndPlanAudioFileTranscription({
      source: source({ getFile }),
      options: options({
        asrConfigs: [wsConfig],
        activeAudioFileAsrConfigId: 'ws',
      }),
    })

    expect(plan.mode).toBe('websocket-stream')
    expect(getFile).not.toHaveBeenCalled()
  })

  it('rejects large short-HTTP files before local decode is attempted', async () => {
    const getFile = jest.fn(async () => {
      throw new Error('should not materialize')
    })

    await expect(
      inspectAndPlanAudioFileTranscription({
        source: source({ getFile }),
        options: options({
          asrConfigs: [baseConfig],
          activeAudioFileAsrConfigId: baseConfig.id,
        }),
      }),
    ).rejects.toThrow('too large for local processing')
    expect(getFile).not.toHaveBeenCalled()
  })

  it('rejects large WebSocket WAV streams before local PCM conversion', async () => {
    const getFile = jest.fn(async () => {
      throw new Error('should not materialize')
    })
    const wsConfig: AsrConfig = {
      ...baseConfig,
      id: 'ws-wav',
      asrCategory: 'websocket',
      format: 'deepgram-compatible-websocket',
      audioFormat: 'wav',
    }

    await expect(
      inspectAndPlanAudioFileTranscription({
        source: source({ getFile }),
        options: options({
          asrConfigs: [wsConfig],
          activeAudioFileAsrConfigId: 'ws-wav',
        }),
      }),
    ).rejects.toThrow('Large files cannot be streamed as WAV/PCM')
    expect(getFile).not.toHaveBeenCalled()
  })

  it('rejects WAV-like sources using the upload-size-derived duration limit', async () => {
    const getFile = jest.fn(async () => {
      throw new Error('should not materialize')
    })
    const wsConfig: AsrConfig = {
      ...baseConfig,
      id: 'ws-auto',
      asrCategory: 'websocket',
      format: 'deepgram-compatible-websocket',
      audioFormat: 'auto',
    }

    await expect(
      inspectAndPlanAudioFileTranscription({
        source: source({
          getFile,
          name: 'meeting.wav',
          type: 'audio/wav',
          size: 200 * 1024 * 1024,
        }),
        options: options({
          asrConfigs: [wsConfig],
          activeAudioFileAsrConfigId: 'ws-auto',
          audioFileWavMaxDurationSec: 600,
        }),
      }),
    ).rejects.toThrow('WAV/PCM upload is limited to 10 minutes')
    expect(getFile).not.toHaveBeenCalled()
  })

  it('estimates WebSocket auto upload size for WAV-like sources without reading them', async () => {
    const getFile = jest.fn(async () => {
      throw new Error('should not materialize')
    })
    const wsConfig: AsrConfig = {
      ...baseConfig,
      id: 'ws-auto-wav',
      asrCategory: 'websocket',
      format: 'deepgram-compatible-websocket',
      audioFormat: 'auto',
    }
    const wavSize = 50 * 1024 * 1024

    const plan = await inspectAndPlanAudioFileTranscription({
      source: source({
        getFile,
        name: 'meeting.wav',
        type: 'audio/wav',
        size: wavSize,
      }),
      options: options({
        asrConfigs: [wsConfig],
        activeAudioFileAsrConfigId: 'ws-auto-wav',
        audioFileWavMaxDurationSec: 60 * 60,
      }),
    })

    expect(plan.mode).toBe('websocket-stream')
    expect(plan.wavPcmUploadEstimateBytes).toBe(wavSize)
    expect(getFile).not.toHaveBeenCalled()
  })
})
