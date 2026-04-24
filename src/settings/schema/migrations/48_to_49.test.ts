import { migrateFrom48To49 } from './48_to_49'

describe('migrateFrom48To49', () => {
  it('prefers the capability registry over provider fallback when the model id is known', () => {
    const result = migrateFrom48To49({
      version: 48,
      providers: [
        // Even though apiType=openai-compatible would default to text-only,
        // the registry knows gemini-2.5-flash is vision.
        { id: 'custom', apiType: 'openai-compatible' },
      ],
      chatModels: [
        { providerId: 'custom', id: 'a', model: 'gemini-2.5-flash' },
        { providerId: 'custom', id: 'b', model: 'deepseek-chat' },
      ],
    }) as Record<string, unknown>

    const models = result.chatModels as Record<string, unknown>[]
    expect(models[0].modalities).toEqual(
      expect.arrayContaining(['text', 'vision']),
    )
    expect(models[1].modalities).toEqual(['text'])
  })

  it('backfills modalities from provider apiType when missing', () => {
    const result = migrateFrom48To49({
      version: 48,
      providers: [
        { id: 'deepseek', apiType: 'openai-compatible' },
        { id: 'anthropic', apiType: 'anthropic' },
        { id: 'gemini', apiType: 'gemini' },
        { id: 'openai', apiType: 'openai-responses' },
        { id: 'bedrock', apiType: 'amazon-bedrock' },
      ],
      chatModels: [
        { providerId: 'deepseek', id: 'a', model: 'deepseek-chat' },
        { providerId: 'anthropic', id: 'b', model: 'claude' },
        { providerId: 'gemini', id: 'c', model: 'gemini-pro' },
        { providerId: 'openai', id: 'd', model: 'gpt-5' },
        { providerId: 'bedrock', id: 'e', model: 'bedrock-claude' },
      ],
    }) as Record<string, unknown>

    expect(result.version).toBe(49)
    const models = result.chatModels as Record<string, unknown>[]
    expect(models[0].modalities).toEqual(['text'])
    expect(models[1].modalities).toEqual(['text', 'vision'])
    expect(models[2].modalities).toEqual(['text', 'vision'])
    expect(models[3].modalities).toEqual(['text', 'vision'])
    expect(models[4].modalities).toEqual(['text', 'vision'])
  })

  it('leaves explicit modalities untouched', () => {
    const result = migrateFrom48To49({
      version: 48,
      providers: [{ id: 'deepseek', apiType: 'openai-compatible' }],
      chatModels: [
        {
          providerId: 'deepseek',
          id: 'a',
          model: 'deepseek-chat',
          modalities: ['text', 'vision'],
        },
      ],
    }) as Record<string, unknown>

    const models = result.chatModels as Record<string, unknown>[]
    expect(models[0].modalities).toEqual(['text', 'vision'])
  })

  it('defaults to text-only when the provider is unknown', () => {
    const result = migrateFrom48To49({
      version: 48,
      providers: [],
      chatModels: [
        { providerId: 'ghost', id: 'a', model: 'x' },
      ],
    }) as Record<string, unknown>

    const models = result.chatModels as Record<string, unknown>[]
    expect(models[0].modalities).toEqual(['text'])
  })
})
