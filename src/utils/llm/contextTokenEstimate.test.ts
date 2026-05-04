import {
  estimateJsonTokens,
  estimateTextTokens,
} from './contextTokenEstimate'
import { formatTokenCount } from './formatTokenCount'

describe('contextTokenEstimate', () => {
  it('returns stable json token counts regardless of object key order', async () => {
    const left = await estimateJsonTokens({
      name: 'demo',
      inputSchema: {
        properties: {
          b: { type: 'string' },
          a: { type: 'number' },
        },
      },
    })
    const right = await estimateJsonTokens({
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

  it('counts more tokens for longer text', async () => {
    expect(await estimateTextTokens('short')).toBeLessThan(
      await estimateTextTokens('short text with more details'),
    )
  })
})

describe('formatTokenCount', () => {
  it('formats compact token counts for display', () => {
    expect(formatTokenCount(512)).toBe('512')
    expect(formatTokenCount(1200)).toBe('1.2k')
    expect(formatTokenCount(12600)).toBe('13k')
  })
})
