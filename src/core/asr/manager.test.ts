import type {
  AsrConfig,
  ContextVoiceInputOptions,
} from '../../settings/schema/setting.types'

import {
  AsrConfigError,
  getAsrProvider,
  isAsrConfigured,
  resolveActiveAsrConfig,
} from './manager'

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
