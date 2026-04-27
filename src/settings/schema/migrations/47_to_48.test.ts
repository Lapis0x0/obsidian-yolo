import { migrateFrom47To48 } from './47_to_48'

describe('migrateFrom47To48', () => {
  it('strips legacy reasoning/thinking fields and normalizes generic reasoningType', () => {
    const result = migrateFrom47To48({
      version: 47,
      chatModels: [
        {
          providerId: 'p',
          id: 'm1',
          model: 'gpt-5',
          reasoningType: 'openai',
          reasoning: { enabled: true, reasoning_effort: 'high' },
        },
        {
          providerId: 'p',
          id: 'm2',
          model: 'gemini-pro',
          reasoningType: 'generic',
          thinking: { enabled: true, thinking_budget: -1 },
        },
      ],
      chatOptions: {
        reasoningLevelByModelId: { 'mid-1': 'on' as const },
      },
    })

    expect(result.version).toBe(48)
    const models = result.chatModels as Record<string, unknown>[]
    expect(models[0].reasoning).toBeUndefined()
    expect(models[0].defaultReasoningLevel).toBeUndefined()
    expect(models[1].reasoningType).toBe('gemini')
    expect(models[1].thinking).toBeUndefined()
    expect(models[1].defaultReasoningLevel).toBeUndefined()

    const opts = result.chatOptions as {
      reasoningLevelByModelId: Record<string, string>
    }
    expect(opts.reasoningLevelByModelId['mid-1']).toBe('medium')
  })
})
