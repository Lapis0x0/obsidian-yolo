import { resolveDeepSeekAnthropicBaseUrl } from './deepseekAnthropicProvider'

describe('resolveDeepSeekAnthropicBaseUrl', () => {
  it('defaults to the official DeepSeek Anthropic-compatible endpoint', () => {
    expect(resolveDeepSeekAnthropicBaseUrl(undefined)).toBe(
      'https://api.deepseek.com/anthropic',
    )
  })

  it('maps the official OpenAI-compatible root to the Anthropic path', () => {
    expect(resolveDeepSeekAnthropicBaseUrl('https://api.deepseek.com')).toBe(
      'https://api.deepseek.com/anthropic',
    )
    expect(resolveDeepSeekAnthropicBaseUrl('https://api.deepseek.com/')).toBe(
      'https://api.deepseek.com/anthropic',
    )
  })

  it('keeps explicit Anthropic paths and custom gateways', () => {
    expect(
      resolveDeepSeekAnthropicBaseUrl('https://api.deepseek.com/anthropic/v1'),
    ).toBe('https://api.deepseek.com/anthropic')
    expect(resolveDeepSeekAnthropicBaseUrl('https://proxy.example/v1')).toBe(
      'https://proxy.example',
    )
  })
})
