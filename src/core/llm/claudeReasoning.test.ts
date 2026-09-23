import {
  claudeAcceptsSamplingParams,
  resolveClaudeReasoningRequest,
} from './claudeReasoning'

const BUDGET_IDS = [
  'claude-haiku-4-5',
  'claude-haiku-4-5-20251001',
  'claude-sonnet-4-5-20250929',
  'claude-opus-4-1',
  'claude-sonnet-4-20250514',
  'claude-3-5-sonnet-20240620',
  'claude-3-opus-20240229',
  'anthropic.claude-3-7-sonnet-20250219-v1:0',
  'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
  'anthropic/claude-sonnet-4.5',
]

const ADAPTIVE_IDS = [
  'claude-sonnet-4-6',
  'claude-opus-4-8',
  'claude-sonnet-5',
  'claude-opus-5',
  'claude-opus-5-5',
  'claude-fable-5-1',
  'anthropic.claude-opus-5',
  'us.anthropic.claude-opus-4-7-v1:0',
  'anthropic/claude-opus-4.7',
]

describe('resolveClaudeReasoningRequest', () => {
  it.each(BUDGET_IDS)('gives %s a fixed thinking budget', (id) => {
    expect(resolveClaudeReasoningRequest(id, 'high')).toEqual({
      thinking: { type: 'enabled', budget_tokens: 16384 },
      thinkingTokens: 16384,
    })
    expect(resolveClaudeReasoningRequest(id, 'off')).toEqual({
      thinkingTokens: 0,
    })
  })

  it.each(ADAPTIVE_IDS)('gives %s adaptive thinking with effort', (id) => {
    expect(resolveClaudeReasoningRequest(id, 'max')).toEqual({
      thinking: { type: 'adaptive', display: 'summarized' },
      effort: 'max',
      thinkingTokens: 65536,
    })
  })

  it('maps off to the lowest effort instead of disabling thinking', () => {
    expect(resolveClaudeReasoningRequest('claude-opus-5-5', 'off')).toEqual({
      thinking: { type: 'adaptive', display: 'summarized' },
      effort: 'low',
      thinkingTokens: 4096,
    })
  })

  it('leaves effort to the model on auto and reserves a high budget', () => {
    expect(resolveClaudeReasoningRequest('claude-opus-5', 'auto')).toEqual({
      thinking: { type: 'adaptive', display: 'summarized' },
      thinkingTokens: 16384,
    })
  })

  it('caps xhigh at high on 4.6, which predates it', () => {
    expect(
      resolveClaudeReasoningRequest('claude-sonnet-4-6', 'xhigh')?.effort,
    ).toBe('high')
    expect(
      resolveClaudeReasoningRequest('claude-opus-4-7', 'xhigh')?.effort,
    ).toBe('xhigh')
  })

  it('treats an unrecognized Claude id as the adaptive generation', () => {
    expect(
      resolveClaudeReasoningRequest('claude-next-preview', 'low')?.thinking,
    ).toEqual({ type: 'adaptive', display: 'summarized' })
  })

  it('returns null for a non-Claude model behind an Anthropic endpoint', () => {
    expect(resolveClaudeReasoningRequest('kimi-k2.5', 'high')).toBeNull()
    expect(resolveClaudeReasoningRequest('deepseek-chat', 'off')).toBeNull()
  })
})

describe('claudeAcceptsSamplingParams', () => {
  it.each(BUDGET_IDS)('keeps sampling params for %s', (id) => {
    expect(claudeAcceptsSamplingParams(id)).toBe(true)
  })

  it.each(ADAPTIVE_IDS)('drops sampling params for %s', (id) => {
    expect(claudeAcceptsSamplingParams(id)).toBe(false)
  })

  it('keeps sampling params for non-Claude models', () => {
    expect(claudeAcceptsSamplingParams('kimi-k2.5')).toBe(true)
  })
})
