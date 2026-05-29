import type {
  AsrConfig,
  ContextVoiceInputOptions,
} from '../../settings/schema/setting.types'

import {
  hasConfiguredAsrConfig,
  resolveConfiguredAsrConfig,
} from './configStatus'

const config = (overrides: Partial<AsrConfig> = {}): AsrConfig => ({
  id: 'asr-1',
  name: 'ASR',
  format: 'openai-compatible-transcription',
  baseURL: 'https://example.com/v1',
  apiKey: '',
  model: 'whisper-1',
  transcriptionPath: '/audio/transcriptions',
  chatCompletionsPath: '/chat/completions',
  audioContentFormat: 'input_audio',
  webSocketProtocol: 'deepgram-compatible',
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
})
