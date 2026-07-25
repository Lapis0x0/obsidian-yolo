import {
  MAX_AUTOMATIC_RETRIES,
  getNextAutomaticRetry,
} from './limitedAutomaticRetry'

describe('limited automatic retry policy', () => {
  const schedule = [10, 20, 30] as const

  it('allows exactly three retries after the initial attempt', () => {
    expect(getNextAutomaticRetry(0, schedule)).toEqual({
      retryCount: 1,
      delayMs: 10,
    })
    expect(getNextAutomaticRetry(1, schedule)).toEqual({
      retryCount: 2,
      delayMs: 20,
    })
    expect(getNextAutomaticRetry(2, schedule)).toEqual({
      retryCount: 3,
      delayMs: 30,
    })
    expect(getNextAutomaticRetry(MAX_AUTOMATIC_RETRIES, schedule)).toBeNull()
  })
})
