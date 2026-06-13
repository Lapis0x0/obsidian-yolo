import type {
  AsrConfig,
  ContextVoiceInputOptions,
} from '../../settings/schema/setting.types'

import {
  hasConfiguredAsrConfig,
  hasConfiguredAudioFileAsrConfig,
  resolveConfiguredAsrConfig,
  resolveConfiguredAudioFileAsrConfig,
} from './configStatus'

const config = (overrides: Partial<AsrConfig> = {}): AsrConfig => ({
  id: 'asr-1',
  name: 'ASR',
  asrCategory: 'http-short-audio',
  asrProvider: 'openai-compatible-transcription',
  format: 'openai-compatible-transcription',
  baseURL: 'https://example.com/v1',
  apiKey: '',
  apiSecret: '',
  appId: '',
  model: 'whisper-1',
  transcriptionPath: '/audio/transcriptions',
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
  ...overrides,
})

const options = (
  overrides: Partial<ContextVoiceInputOptions> = {},
): ContextVoiceInputOptions =>
  ({
    asrConfigs: [],
    activeAsrConfigId: '',
    activeAudioFileAsrConfigId: '',
    ...overrides,
  }) as ContextVoiceInputOptions

describe('ASR config status', () => {
  it('returns false when no configs exist', () => {
    expect(hasConfiguredAsrConfig(options())).toBe(false)
    expect(resolveConfiguredAsrConfig(options())).toBeNull()
  })

  it('uses the active config when it is present and complete', () => {
    const first = config({ id: 'first', model: 'whisper-1' })
    const active = config({
      id: 'active',
      format: 'openai-compatible-chat-audio-asr',
      model: 'gemini-3.1-flash-lite',
    })

    expect(
      resolveConfiguredAsrConfig(
        options({ asrConfigs: [first, active], activeAsrConfigId: 'active' }),
      ),
    ).toBe(active)
  })

  it('falls back to the first config when active id is stale', () => {
    const first = config({ id: 'first' })

    expect(
      resolveConfiguredAsrConfig(
        options({ asrConfigs: [first], activeAsrConfigId: 'missing' }),
      ),
    ).toBe(first)
  })

  it('marks implemented long-audio providers ready for runtime ASR readiness', () => {
    const longOnly = config({
      id: 'long',
      asrCategory: 'http-long-audio',
      asrProvider: 'funasr-local',
      model: 'paraformer-zh',
    })
    const short = config({ id: 'short' })

    expect(
      resolveConfiguredAsrConfig(options({ asrConfigs: [longOnly] })),
    ).toBe(longOnly)
    expect(
      resolveConfiguredAsrConfig(
        options({
          asrConfigs: [short, longOnly],
          activeAsrConfigId: 'long',
        }),
      ),
    ).toBe(longOnly)
  })

  it('does not fall back when the active config exists but is incomplete', () => {
    const first = config({ id: 'first' })
    const active = config({ id: 'active', baseURL: '' })

    expect(
      resolveConfiguredAsrConfig(
        options({ asrConfigs: [first, active], activeAsrConfigId: 'active' }),
      ),
    ).toBeNull()
  })

  it('requires baseURL and model for HTTP ASR configs', () => {
    expect(
      hasConfiguredAsrConfig(
        options({ asrConfigs: [config({ baseURL: ' ', model: 'whisper-1' })] }),
      ),
    ).toBe(false)
    expect(
      hasConfiguredAsrConfig(
        options({ asrConfigs: [config({ baseURL: 'https://x', model: ' ' })] }),
      ),
    ).toBe(false)
  })

  it('allows FunASR short-audio configs to use the server default model', () => {
    expect(
      hasConfiguredAsrConfig(
        options({
          asrConfigs: [
            config({
              asrProvider: 'funasr-local',
              baseURL: 'http://127.0.0.1:8001/v1',
              model: '',
            }),
          ],
        }),
      ),
    ).toBe(true)
  })

  it('requires only baseURL for WebSocket ASR configs', () => {
    expect(
      hasConfiguredAsrConfig(
        options({
          asrConfigs: [
            config({
              format: 'deepgram-compatible-websocket',
              baseURL: 'wss://api.deepgram.com/v1',
              model: '',
            }),
          ],
        }),
      ),
    ).toBe(true)
  })

  it('checks audio-file ASR readiness against the audio-file provider', () => {
    const voiceOnly = config({ id: 'voice', baseURL: '' })
    const audioFile = config({
      id: 'audio-file',
      format: 'deepgram-compatible-websocket',
      baseURL: 'wss://api.deepgram.com/v1',
      model: '',
    })

    expect(
      resolveConfiguredAudioFileAsrConfig(
        options({
          asrConfigs: [voiceOnly, audioFile],
          activeAsrConfigId: 'voice',
          activeAudioFileAsrConfigId: 'audio-file',
        }),
      ),
    ).toBe(audioFile)
    expect(
      hasConfiguredAudioFileAsrConfig(
        options({
          asrConfigs: [voiceOnly, audioFile],
          activeAsrConfigId: 'voice',
          activeAudioFileAsrConfigId: 'audio-file',
        }),
      ),
    ).toBe(true)
  })

  it('marks implemented long-audio providers ready for audio-file transcription', () => {
    const long = config({
      id: 'long',
      asrCategory: 'http-long-audio',
      asrProvider: 'funasr-local',
      baseURL: 'http://127.0.0.1:8001/v1',
      model: '',
    })

    expect(
      resolveConfiguredAudioFileAsrConfig(
        options({
          asrConfigs: [long],
          activeAudioFileAsrConfigId: 'long',
        }),
      ),
    ).toBe(long)
    expect(
      hasConfiguredAudioFileAsrConfig(
        options({
          asrConfigs: [long],
          activeAudioFileAsrConfigId: 'long',
        }),
      ),
    ).toBe(true)
  })

  it('marks cloud long-audio providers ready only when credentials exist', () => {
    const long = config({
      id: 'long',
      asrCategory: 'http-long-audio',
      asrProvider: 'deepgram-prerecorded',
      baseURL: 'https://api.deepgram.com',
      model: 'nova-3',
    })

    expect(
      resolveConfiguredAudioFileAsrConfig(
        options({
          asrConfigs: [long],
          activeAudioFileAsrConfigId: 'long',
        }),
      ),
    ).toBeNull()
    expect(
      hasConfiguredAudioFileAsrConfig(
        options({
          asrConfigs: [long],
          activeAudioFileAsrConfigId: 'long',
        }),
      ),
    ).toBe(false)

    const ready = { ...long, apiKey: 'dg-key' }
    expect(
      hasConfiguredAudioFileAsrConfig(
        options({
          asrConfigs: [ready],
          activeAudioFileAsrConfigId: 'long',
        }),
      ),
    ).toBe(true)
  })

  it('does not mark unknown long-audio providers ready for audio-file transcription', () => {
    const long = config({
      id: 'long',
      asrCategory: 'http-long-audio',
      asrProvider: 'speechmatics-batch',
      baseURL: 'https://asr.api.speechmatics.com/v2',
      model: '',
    })

    expect(
      hasConfiguredAudioFileAsrConfig(
        options({
          asrConfigs: [long],
          activeAudioFileAsrConfigId: 'long',
        }),
      ),
    ).toBe(false)
  })
})
