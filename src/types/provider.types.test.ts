import { llmProviderSchema } from './provider.types'

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
