import { migrateFrom88To89 } from './88_to_89'

describe('migrateFrom88To89', () => {
  it('turns an APIMart provider into a custom one with its default URL', () => {
    expect(
      migrateFrom88To89({
        version: 88,
        providers: [
          {
            id: 'apimart',
            presetType: 'apimart',
            apiType: 'openai-compatible',
            apiKey: 'key',
            baseUrl: '',
          },
        ],
      }),
    ).toEqual({
      version: 89,
      providers: [
        {
          id: 'apimart',
          presetType: 'openai-compatible',
          apiType: 'openai-compatible',
          apiKey: 'key',
          baseUrl: 'https://api.apimart.ai/v1',
        },
      ],
    })
  })

  it('keeps a Base URL the user set', () => {
    const [provider] = migrateFrom88To89({
      version: 88,
      providers: [
        { id: 'am', presetType: 'apimart', baseUrl: 'https://proxy.test/v1' },
      ],
    }).providers as Record<string, unknown>[]
    expect(provider).toEqual({
      id: 'am',
      presetType: 'openai-compatible',
      baseUrl: 'https://proxy.test/v1',
    })
  })

  it('leaves other providers untouched', () => {
    const openrouter = { id: 'openrouter', presetType: 'openrouter' }
    const result = migrateFrom88To89({ version: 88, providers: [openrouter] })
    expect((result.providers as unknown[])[0]).toBe(openrouter)
  })
})
