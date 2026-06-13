import type { AsrConfig } from '../../settings/schema/setting.types'

import {
  getAudioFileAsrCapability,
  getAudioFileChunkDurationAdvisory,
} from './capabilities'

const baseConfig: AsrConfig = {
  id: 'asr',
  name: 'ASR',
  asrCategory: 'http-short-audio',
  asrProvider: 'openai-compatible-chat-audio-asr',
  format: 'openai-compatible-chat-audio-asr',
  baseURL: 'https://example.com/v1',
  apiKey: '',
  apiSecret: '',
  appId: '',
  model: 'model',
  transcriptionPath: '',
  jobPath: '',
  resultPath: '',
  chatCompletionsPath: '/chat/completions',
  audioContentFormat: 'input_audio',
  webSocketProtocol: 'deepgram-compatible',
  webSocketPunctuate: true,
  webSocketDiarizeMode: 'off',
  webSocketDictation: false,
  webSocketFileStreamingRate: 2,
  audioFormat: 'auto',
  transportMode: 'node',
  language: 'auto',
  longAudioPunctuation: true,
  longAudioDiarizeMode: 'auto',
  longAudioSpeakerCount: 0,
  longAudioTimestamps: true,
}

describe('getAudioFileAsrCapability', () => {
  it('uses a stricter WAV chunk duration for Aliyun chat-audio data-url input', () => {
    const capability = getAudioFileAsrCapability({
      ...baseConfig,
      baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      audioContentFormat: 'input_audio_data_url',
    })

    expect(capability.maxRequestBytes).toBe(14 * 1024 * 1024)
    expect(capability.maxDurationMs).toBe(30 * 1000)
  })

  it('keeps the generic chat-audio cap for non-Aliyun providers', () => {
    const capability = getAudioFileAsrCapability(baseConfig)

    expect(capability.maxRequestBytes).toBe(14 * 1024 * 1024)
    expect(capability.maxDurationMs).toBeNull()
  })

  it('uses the stricter MiMo chat-audio data URI request cap', () => {
    const capability = getAudioFileAsrCapability({
      ...baseConfig,
      asrProvider: 'xiaomimimo-asr',
      baseURL: 'https://api.xiaomimimo.com/v1',
      audioContentFormat: 'input_audio_data_url',
    })

    expect(capability.maxRequestBytes).toBe(7 * 1024 * 1024)
    expect(capability.supportsChunkedUpload).toBe(true)
  })

  it('exposes direct local-file support for implemented long-audio providers', () => {
    const capability = getAudioFileAsrCapability({
      ...baseConfig,
      asrCategory: 'http-long-audio',
      asrProvider: 'funasr-local',
    })

    expect(capability.supportsLocalFile).toBe(true)
    expect(capability.supportsChunkedUpload).toBe(false)
    expect(capability.supportsFileStreaming).toBe(false)
  })

  it('exposes provider limits for implemented cloud long-audio providers', () => {
    const capability = getAudioFileAsrCapability({
      ...baseConfig,
      asrCategory: 'http-long-audio',
      asrProvider: 'deepgram-prerecorded',
    })

    expect(capability.maxRequestBytes).toBe(2 * 1024 * 1024 * 1024)
    expect(capability.supportsLocalFile).toBe(true)
    expect(capability.supportsChunkedUpload).toBe(false)
    expect(capability.supportsFileStreaming).toBe(false)
  })

  it('exposes Volcengine flash as an implemented direct long-audio provider', () => {
    const capability = getAudioFileAsrCapability({
      ...baseConfig,
      asrCategory: 'http-long-audio',
      asrProvider: 'volcengine-auc-flash',
    })

    expect(capability.maxRequestBytes).toBe(100 * 1024 * 1024)
    expect(capability.maxDurationMs).toBe(2 * 60 * 60 * 1000)
    expect(capability.supportsLocalFile).toBe(true)
  })

  it('advises a shorter chunk duration when known request-size caps conflict', () => {
    expect(
      getAudioFileChunkDurationAdvisory({
        config: baseConfig,
        chunkDurationMs: 120_000,
      }),
    ).toMatchObject({
      maxRequestBytes: 14 * 1024 * 1024,
      suggestedMaxDurationMs: 60_000,
    })
  })

  it('folds provider duration caps into request-size advisories', () => {
    expect(
      getAudioFileChunkDurationAdvisory({
        config: {
          ...baseConfig,
          baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          audioContentFormat: 'input_audio_data_url',
        },
        chunkDurationMs: 60_000,
      }),
    ).toMatchObject({
      suggestedMaxDurationMs: 30_000,
    })
  })
})
