import {
  estimateJsonTokens,
  estimateTextTokens,
  formatTokenCount,
} from './contextTokenEstimate'

describe('contextTokenEstimate', () => {
  it('returns stable json token counts regardless of object key order', () => {
    const left = estimateJsonTokens({
      name: 'demo',
      inputSchema: {
        properties: {
          b: { type: 'string' },
          a: { type: 'number' },
        },
      },
    })
    const right = estimateJsonTokens({
      inputSchema: {
        properties: {
          a: { type: 'number' },
          b: { type: 'string' },
        },
      },
      name: 'demo',
    })

    expect(left).toBe(right)
  })

  it('counts more tokens for longer text', () => {
    expect(estimateTextTokens('short')).toBeLessThan(
      estimateTextTokens('short text with more details'),
    )
  })

  it('formats compact token counts for display', () => {
    expect(formatTokenCount(512)).toBe('512')
    expect(formatTokenCount(1200)).toBe('1.2k')
    expect(formatTokenCount(12600)).toBe('13k')
  })
})
