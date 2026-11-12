import { classifyProviderError } from './providerErrorClassification'

describe('classifyProviderError', () => {
  it('classifies from the raw body when no message could be extracted', () => {
    expect(
      classifyProviderError({
        status: 400,
        responseBody: JSON.stringify({
          detail: { reason: { code: 'insufficient_balance' } },
        }),
      }),
    ).toBe('quota')
  })

  it('prefers explicit billing signals over the 429 default', () => {
    expect(
      classifyProviderError({ status: 429, message: 'insufficient credit' }),
    ).toBe('quota')
    expect(classifyProviderError({ status: 429 })).toBe('rateLimit')
  })

  it('prefers a geo-block over the 403 auth default', () => {
    expect(
      classifyProviderError({
        status: 403,
        message: 'Country, region, or territory not supported',
      }),
    ).toBe('region')
    expect(classifyProviderError({ status: 403 })).toBe('auth')
  })

  it('recognizes an interrupted stream as a transport failure', () => {
    expect(classifyProviderError({ message: 'Premature close' })).toBe('stream')
    expect(classifyProviderError({ message: 'socket hang up' })).toBe('stream')
  })

  it('classifies "timed out" phrasings as a network timeout (#646)', () => {
    // The OpenAI SDK surfaces its client timeout as "Request timed out."; the
    // request policy raises "Model request timed out after Nms.". Neither
    // contains "timeout", so before #646 both fell through to `unknown`.
    expect(classifyProviderError({ message: 'Request timed out.' })).toBe(
      'network',
    )
    expect(
      classifyProviderError({
        message: 'Model request timed out after 60000ms.',
      }),
    ).toBe('network')
  })

  it('does not read a deprecated parameter as a retired model', () => {
    expect(
      classifyProviderError({
        status: 400,
        message: 'the "logprobs" parameter is deprecated',
      }),
    ).toBe('unknown')
    expect(
      classifyProviderError({ message: 'this model has been retired' }),
    ).toBe('deprecated')
  })

  it('falls back to unknown when there is nothing to go on', () => {
    expect(classifyProviderError({})).toBe('unknown')
    expect(classifyProviderError({ message: 'something went sideways' })).toBe(
      'unknown',
    )
  })
})
