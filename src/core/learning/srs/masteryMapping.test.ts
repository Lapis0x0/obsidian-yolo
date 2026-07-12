import { fsrsStateToMastery, isDue } from './masteryMapping'

describe('masteryMapping', () => {
  it('maps FSRS states to UI mastery', () => {
    expect(fsrsStateToMastery(0)).toBe('new')
    expect(fsrsStateToMastery(1)).toBe('learning')
    expect(fsrsStateToMastery(2)).toBe('mastered')
    expect(fsrsStateToMastery(3)).toBe('learning')
    expect(fsrsStateToMastery(99)).toBe('new')
  })

  it('treats a card due exactly now as due', () => {
    const now = new Date('2026-07-10T12:00:00.000Z')
    expect(isDue('2026-07-10T12:00:00.000Z', now)).toBe(true)
    expect(isDue('2026-07-10T12:00:01.000Z', now)).toBe(false)
  })
})
