import { anchorBreakdownToServerTotal } from './ContextUsagePopover'
import type { ContextBreakdownState } from './useContextBreakdown'

const ready = (buckets: [string, number][]): ContextBreakdownState => ({
  status: 'ready',
  data: {
    buckets: buckets.map(([bucket, tokens]) => ({
      bucket: bucket as never,
      tokens,
    })),
    total: buckets.reduce((sum, [, tokens]) => sum + tokens, 0),
    max: 262_144,
    computedAt: 0,
  },
})

describe('anchorBreakdownToServerTotal', () => {
  it('keeps the local split but takes the total from the server', () => {
    const anchored = anchorBreakdownToServerTotal(
      ready([
        ['system', 40_000],
        ['conversation', 360_000],
      ]),
      200_000,
    )
    expect(anchored).toEqual(
      expect.objectContaining({
        status: 'ready',
        data: expect.objectContaining({
          total: 200_000,
          buckets: [
            { bucket: 'system', tokens: 20_000 },
            { bucket: 'conversation', tokens: 180_000 },
          ],
        }),
      }),
    )
  })

  it('falls back to the local estimate before the server has reported usage', () => {
    const local = ready([['system', 1_000]])
    expect(anchorBreakdownToServerTotal(local, 0)).toBe(local)
  })
})
