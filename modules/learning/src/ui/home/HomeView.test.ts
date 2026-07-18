import type { LearningProjectStats } from '../../domain/stats/learningStats'

import { resolveSortValue } from './HomeView'

const stats = {
  createdAt: 10,
  lastActiveAt: 20,
  targetCardProgress: 30,
} as LearningProjectStats

describe('resolveSortValue', () => {
  it('selects the requested stable project metric', () => {
    expect(resolveSortValue('created', stats)).toBe(10)
    expect(resolveSortValue('recent', stats)).toBe(20)
    expect(resolveSortValue('progress', stats)).toBe(30)
    expect(resolveSortValue('recent')).toBe(Number.NEGATIVE_INFINITY)
  })
})
