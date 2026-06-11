import {
  getDefaultRequestTransportModeForPresetType,
  getSupportedApiTypesForPresetType,
  llmProviderSchema,
} from './provider.types'

describe('llmProviderSchema', () => {
  it('normalizes legacy kimi presetType to moonshot', () => {
    expect(
      llmProviderSchema.parse({
        id: 'moonshot',
        presetType: 'kimi',
        apiKey: 'token',
      }),
    ).toMatchObject({
      id: 'moonshot',
      presetType: 'moonshot',
      apiType: 'openai-compatible',
      apiKey: 'token',
    })
  })

  it('normalizes legacy kimi type to moonshot', () => {
    expect(
      llmProviderSchema.parse({
        id: 'moonshot',
        type: 'kimi',
        apiKey: 'token',
      }),
    ).toMatchObject({
      id: 'moonshot',
      presetType: 'moonshot',
      apiType: 'openai-compatible',
      apiKey: 'token',
    })
  })

  // Regression: providers synced from a newer plugin version (with a
  // presetType the local enum doesn't know) used to fail safeParse and get
  // silently dropped by `resilientArraySchema`, wiping the user's provider
  // list across devices. Unknown values must now degrade to
  // `openai-compatible` instead of dropping the whole entry.
  it('coerces unknown presetType to openai-compatible instead of failing', () => {
    expect(
      llmProviderSchema.parse({
        id: 'future',
        presetType: 'some-future-preset',
        apiKey: 'token',
      }),
    ).toMatchObject({
      id: 'future',
      presetType: 'openai-compatible',
      apiType: 'openai-compatible',
      apiKey: 'token',
    })
  })

  it('coerces unknown apiType to the preset default', () => {
    expect(
      llmProviderSchema.parse({
        id: 'anthropic',
        presetType: 'anthropic',
        apiType: 'something-new',
      }),
    ).toMatchObject({
      id: 'anthropic',
      presetType: 'anthropic',
      apiType: 'anthropic',
    })
  })

  it('drops malformed customHeaders entries instead of failing the provider', () => {
    const parsed = llmProviderSchema.parse({
      id: 'openai',
      presetType: 'openai',
      customHeaders: [
        { key: 'X-Good', value: 'ok' },
        { key: '', value: 'bad' },
        { value: 'no-key' },
      ],
    })
    expect(parsed.id).toBe('openai')
    expect(parsed.customHeaders).toEqual([{ key: 'X-Good', value: 'ok' }])
  })
})

describe('getDefaultRequestTransportModeForPresetType', () => {
  it('defaults desktop providers to node', () => {
    expect(
      getDefaultRequestTransportModeForPresetType('chatgpt-oauth', true),
    ).toBe('node')
    expect(getDefaultRequestTransportModeForPresetType('openai', true)).toBe(
      'node',
    )
  })

  it('defaults mobile providers to browser', () => {
    expect(getDefaultRequestTransportModeForPresetType('openai', false)).toBe(
      'browser',
    )
  })
})

describe('getSupportedApiTypesForPresetType', () => {
  it('limits DeepSeek to its official OpenAI-compatible and Anthropic APIs', () => {
    expect(getSupportedApiTypesForPresetType('deepseek')).toEqual([
      'openai-compatible',
      'anthropic',
    ])
  })
})
