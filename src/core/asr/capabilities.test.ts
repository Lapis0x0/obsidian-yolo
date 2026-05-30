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
  model: 'model',
  transcriptionPath: '',
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

  it('does not expose short-audio upload capabilities for long-audio placeholders', () => {
    const capability = getAudioFileAsrCapability({
      ...baseConfig,
      asrCategory: 'http-long-audio',
      asrProvider: 'funasr-local',
    })

    expect(capability.supportsLocalFile).toBe(false)
    expect(capability.supportsChunkedUpload).toBe(false)
    expect(capability.supportsFileStreaming).toBe(false)
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
