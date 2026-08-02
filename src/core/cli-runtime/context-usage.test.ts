import {
  mapClaudeGetContextUsage,
  mapClaudeResultContextUsage,
  mapClaudeResultResponseUsage,
  mapCodexTokenUsageUpdated,
  mapCodexTurnResponseUsage,
  resolveClaudeContextUsageBucket,
} from './context-usage'

describe('mapClaudeResultContextUsage', () => {
  it('sums input and cache tokens and reads contextWindow from modelUsage', () => {
    expect(
      mapClaudeResultContextUsage({
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_read_input_tokens: 30,
          cache_creation_input_tokens: 5,
        },
        modelUsage: {
          'claude-opus': { contextWindow: 200_000 },
        },
      }),
    ).toEqual({
      promptTokens: 135,
      maxContextTokens: 200_000,
      cacheHitRate: 30 / 135,
    })
  })

  it('returns null when usage is missing input_tokens', () => {
    expect(
      mapClaudeResultContextUsage({
        usage: { output_tokens: 1 },
        modelUsage: {},
      }),
    ).toBeNull()
  })

  it('allows unknown max when modelUsage has no contextWindow', () => {
    expect(
      mapClaudeResultContextUsage({
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        modelUsage: {},
      }),
    ).toEqual({
      promptTokens: 10,
      maxContextTokens: null,
      cacheHitRate: 0,
    })
  })
})

describe('turn response usage', () => {
  it('maps Claude cache and output tokens', () => {
    expect(
      mapClaudeResultResponseUsage({
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_read_input_tokens: 30,
          cache_creation_input_tokens: 5,
        },
      }),
    ).toEqual({
      prompt_tokens: 135,
      completion_tokens: 20,
      total_tokens: 155,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 5,
    })
  })

  it('maps Codex last-turn usage', () => {
    expect(
      mapCodexTurnResponseUsage({
        tokenUsage: {
          last: {
            inputTokens: 5152,
            outputTokens: 16,
            cachedInputTokens: 3072,
          },
        },
      }),
    ).toEqual({
      prompt_tokens: 5152,
      completion_tokens: 16,
      total_tokens: 5168,
      cache_read_input_tokens: 3072,
    })
  })
})

describe('mapClaudeGetContextUsage', () => {
  it('maps totals and categories onto native swatch buckets', () => {
    expect(
      mapClaudeGetContextUsage({
        totalTokens: 5333,
        maxTokens: 200_000,
        categories: [
          { name: 'System prompt', tokens: 345, color: '#888888' },
          { name: 'Tools', tokens: 4700, color: '#4C6EF5' },
          { name: 'Skills', tokens: 200, color: '#fd7e14' },
          { name: 'Messages', tokens: 88, color: '#74C0FC' },
          { name: 'Free space', tokens: 194_667, color: '#ced4da' },
        ],
      }),
    ).toEqual({
      promptTokens: 5333,
      maxContextTokens: 200_000,
      categories: [
        { name: 'System prompt', tokens: 345, bucket: 'system' },
        { name: 'Tools', tokens: 4700, bucket: 'tools' },
        { name: 'Skills', tokens: 200, bucket: 'skills' },
        { name: 'Messages', tokens: 88, bucket: 'conversation' },
      ],
    })
  })

  it('returns null without totalTokens', () => {
    expect(mapClaudeGetContextUsage({ maxTokens: 100 })).toBeNull()
  })
})

describe('resolveClaudeContextUsageBucket', () => {
  it('maps custom agents onto the tools swatch', () => {
    expect(resolveClaudeContextUsageBucket('Custom agents')).toBe('tools')
  })
})

describe('mapCodexTokenUsageUpdated', () => {
  it('maps last.totalTokens and modelContextWindow', () => {
    expect(
      mapCodexTokenUsageUpdated({
        threadId: 'thr_1',
        turnId: 'turn_1',
        tokenUsage: {
          last: {
            cachedInputTokens: 3072,
            inputTokens: 5152,
            outputTokens: 16,
            reasoningOutputTokens: 0,
            totalTokens: 5168,
          },
          total: {
            cachedInputTokens: 3072,
            inputTokens: 5152,
            outputTokens: 16,
            reasoningOutputTokens: 0,
            totalTokens: 5168,
          },
          modelContextWindow: 258_400,
        },
      }),
    ).toEqual({
      promptTokens: 5168,
      maxContextTokens: 258_400,
      cacheHitRate: 3072 / 5152,
    })
  })

  it('returns null when last.totalTokens is missing', () => {
    expect(
      mapCodexTokenUsageUpdated({
        tokenUsage: { last: { inputTokens: 1 }, modelContextWindow: 100 },
      }),
    ).toBeNull()
  })
})
