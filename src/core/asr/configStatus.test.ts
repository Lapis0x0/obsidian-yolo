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
  model: 'whisper-1',
  transcriptionPath: '/audio/transcriptions',
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

  it('ignores long-audio provider placeholders for runtime ASR readiness', () => {
    const longOnly = config({
      id: 'long',
      asrCategory: 'http-long-audio',
      asrProvider: 'funasr-local',
      model: 'paraformer-zh',
    })
    const short = config({ id: 'short' })

    expect(
      resolveConfiguredAsrConfig(options({ asrConfigs: [longOnly] })),
    ).toBeNull()
    expect(
      resolveConfiguredAsrConfig(options({ asrConfigs: [longOnly, short] })),
    ).toBe(short)
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

  it('does not mark long-audio placeholders ready for audio-file transcription', () => {
    const long = config({
      id: 'long',
      asrCategory: 'http-long-audio',
      asrProvider: 'funasr-local',
      baseURL: 'http://127.0.0.1:8001',
      model: '',
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
  })
})
