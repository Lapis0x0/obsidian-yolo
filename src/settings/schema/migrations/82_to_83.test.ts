import { migrateFrom82To83 } from './82_to_83'

const baseData = () => ({
  version: 82,
  providers: [
    { id: 'openai', presetType: 'openai', apiType: 'openai-responses' },
    {
      id: 'xiaomimimo',
      presetType: 'xiaomimimo',
      apiType: 'openai-compatible',
    },
  ],
  chatModels: [
    { id: 'openai/gpt-5', providerId: 'openai', model: 'gpt-5' },
    {
      id: 'xiaomimimo/mimo-v2.5',
      providerId: 'xiaomimimo',
      model: 'mimo-v2.5',
    },
  ],
})

describe('migrateFrom82To83', () => {
  it('drops the untouched MiMo provider and its models', () => {
    const result = migrateFrom82To83(baseData())

    expect(result.version).toBe(83)
    expect(result.providers).toEqual([
      { id: 'openai', presetType: 'openai', apiType: 'openai-responses' },
    ])
    expect(result.chatModels).toEqual([
      { id: 'openai/gpt-5', providerId: 'openai', model: 'gpt-5' },
    ])
  })

  it('keeps MiMo when the user configured an API key', () => {
    const data = baseData()
    data.providers[1] = { ...data.providers[1], apiKey: 'sk-mimo' } as never

    const result = migrateFrom82To83(data)

    expect(result.providers).toHaveLength(2)
    expect(result.chatModels).toHaveLength(2)
  })

  it('leaves gemini-oauth alone', () => {
    const data = {
      ...baseData(),
      providers: [
        { id: 'gemini-oauth', presetType: 'gemini-oauth', apiType: 'gemini' },
      ],
    }

    const result = migrateFrom82To83(data)

    expect(result.providers).toEqual(data.providers)
  })
})
