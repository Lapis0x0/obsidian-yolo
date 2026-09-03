import type { AuthMethod } from '@agentclientprotocol/sdk'

import { selectGrokSubscriptionAuthMethod } from './auth'

const method = (id: string): AuthMethod => ({ id, name: id })

describe('selectGrokSubscriptionAuthMethod', () => {
  it('selects the cached subscription token even when interactive OAuth is also advertised', () => {
    expect(
      selectGrokSubscriptionAuthMethod([
        method('grok.com'),
        method('cached_token'),
      ]),
    ).toBe('cached_token')
  })

  it('selects cached_token when it is the only supported method', () => {
    expect(selectGrokSubscriptionAuthMethod([method('cached_token')])).toBe(
      'cached_token',
    )
  })

  it.each([
    ['interactive OAuth only', [method('grok.com')]],
    ['API key only', [method('xai.api_key')]],
    ['unknown methods', [method('future-auth')]],
    ['no methods', []],
  ])('requires a prior grok login for %s', (_label, methods) => {
    expect(() => selectGrokSubscriptionAuthMethod(methods)).toThrow(
      'Run `grok login` (or `grok login --device-auth`) in a terminal, then retry.',
    )
  })
})
