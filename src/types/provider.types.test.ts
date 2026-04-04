import {
  getDefaultRequestTransportModeForPresetType,
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
})

describe('getDefaultRequestTransportModeForPresetType', () => {
  it('defaults OAuth presets to node on desktop', () => {
    expect(
      getDefaultRequestTransportModeForPresetType('chatgpt-oauth', true),
    ).toBe('node')
    expect(
      getDefaultRequestTransportModeForPresetType('gemini-oauth', true),
    ).toBe('node')
  })

  it('does not force node for non-OAuth or mobile presets', () => {
    expect(
      getDefaultRequestTransportModeForPresetType('openai', true),
    ).toBeUndefined()
    expect(
      getDefaultRequestTransportModeForPresetType('chatgpt-oauth', false),
    ).toBeUndefined()
  })
})
