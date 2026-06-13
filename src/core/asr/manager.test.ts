import type {
  AsrConfig,
  ContextVoiceInputOptions,
} from '../../settings/schema/setting.types'

import {
  AsrConfigError,
  buildAsrProviderForConfig,
  getAsrProvider,
  isAsrConfigured,
  resolveActiveAsrConfig,
  resolveActiveAudioFileAsrConfig,
} from './manager'

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
    ...overrides,
  }) as ContextVoiceInputOptions

describe('ASR manager config resolution', () => {
  it('resolves the selected config, falling back to first entry', () => {
    const first = config({ id: 'first' })
    const selected = config({ id: 'selected' })

    expect(
      resolveActiveAsrConfig(
        options({
          asrConfigs: [first, selected],
          activeAsrConfigId: 'selected',
        }),
      ),
    ).toBe(selected)
    expect(
      resolveActiveAsrConfig(
        options({
          asrConfigs: [first, selected],
          activeAsrConfigId: 'missing',
        }),
      ),
    ).toBe(first)
  })

  it('allows context voice ASR to select long-audio configs', () => {
    const longOnly = config({
      id: 'long',
      asrCategory: 'http-long-audio',
      asrProvider: 'funasr-local',
      model: 'paraformer-zh',
    })
    const short = config({ id: 'short' })

    expect(resolveActiveAsrConfig(options({ asrConfigs: [longOnly] }))).toBe(
      longOnly,
    )
    expect(
      resolveActiveAsrConfig(
        options({
          asrConfigs: [short, longOnly],
          activeAsrConfigId: 'long',
        }),
      ),
    ).toBe(longOnly)
  })

  it('allows audio-file transcription to select long-audio configs', () => {
    const long = config({
      id: 'long',
      asrCategory: 'http-long-audio',
      asrProvider: 'funasr-local',
      model: 'paraformer-zh',
    })
    const short = config({ id: 'short' })

    expect(
      resolveActiveAudioFileAsrConfig(
        options({
          asrConfigs: [short, long],
          activeAudioFileAsrConfigId: 'long',
        }),
      ),
    ).toBe(long)
  })

  it('builds the FunASR local adapter for long-audio configs', () => {
    const provider = buildAsrProviderForConfig(
      config({
        asrCategory: 'http-long-audio',
        asrProvider: 'funasr-local',
        baseURL: 'http://127.0.0.1:8001/v1',
        model: '',
      }),
    )

    expect(provider.format).toBe('funasr-local')
  })

  it('builds the FunASR local adapter for short-audio configs too', () => {
    const provider = buildAsrProviderForConfig(
      config({
        asrCategory: 'http-short-audio',
        asrProvider: 'funasr-local',
        baseURL: 'http://127.0.0.1:8001/v1',
        model: '',
      }),
    )

    expect(provider.format).toBe('funasr-local')
  })

  it('builds the implemented cloud long-audio adapters', () => {
    expect(
      buildAsrProviderForConfig(
        config({
          asrCategory: 'http-long-audio',
          asrProvider: 'deepgram-prerecorded',
          baseURL: 'https://api.deepgram.com',
          apiKey: 'dg-key',
          model: 'nova-3',
        }),
      ).format,
    ).toBe('deepgram-prerecorded')
    expect(
      buildAsrProviderForConfig(
        config({
          asrCategory: 'http-long-audio',
          asrProvider: 'tencent-flash',
          baseURL: 'https://asr.cloud.tencent.com',
          apiKey: 'secret-id',
          apiSecret: 'secret-key',
          appId: '1250000000',
          model: '16k_zh',
        }),
      ).format,
    ).toBe('tencent-flash')
  })

  it('blocks unknown long-audio configs until their native adapters are implemented', () => {
    expect(() =>
      buildAsrProviderForConfig(
        config({
          asrCategory: 'http-long-audio',
          asrProvider: 'speechmatics-batch',
          model: '',
        }),
      ),
    ).toThrow(AsrConfigError)
  })

  it('reports configured only when the active config can build a provider', () => {
    expect(isAsrConfigured(options())).toBe(false)
    expect(
      isAsrConfigured(
        options({ asrConfigs: [config({ baseURL: '', model: 'whisper-1' })] }),
      ),
    ).toBe(false)
    expect(
      isAsrConfigured(
        options({ asrConfigs: [config({ baseURL: 'https://x', model: '' })] }),
      ),
    ).toBe(false)
    expect(isAsrConfigured(options({ asrConfigs: [config()] }))).toBe(true)
  })

  it('throws a user-facing config error when no provider is configured', () => {
    expect(() => resolveActiveAsrConfig(options())).not.toThrow()
    expect(() => getAsrProvider(options())).toThrow(AsrConfigError)
  })
})
