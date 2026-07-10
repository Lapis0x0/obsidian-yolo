import {
  getExtremeGradeThreshold,
  keyboardToGrade,
  resolveSwipeGrade,
} from './reviewInteractions'

describe('review card interactions', () => {
  test('maps horizontal drag distance onto the four ordered grades', () => {
    const cardWidth = 300
    const mouseThreshold = getExtremeGradeThreshold('mouse')

    expect(resolveSwipeGrade(-44, cardWidth, mouseThreshold)).toBeNull()
    expect(resolveSwipeGrade(44, cardWidth, mouseThreshold)).toBeNull()
    expect(resolveSwipeGrade(-45, cardWidth, mouseThreshold)).toBe('hard')
    expect(resolveSwipeGrade(-269, cardWidth, mouseThreshold)).toBe('hard')
    expect(resolveSwipeGrade(-270, cardWidth, mouseThreshold)).toBe('again')
    expect(resolveSwipeGrade(45, cardWidth, mouseThreshold)).toBe('good')
    expect(resolveSwipeGrade(269, cardWidth, mouseThreshold)).toBe('good')
    expect(resolveSwipeGrade(270, cardWidth, mouseThreshold)).toBe('easy')
  })

  test('keeps extreme grades reachable with touch and pen input', () => {
    const cardWidth = 300

    for (const pointerType of ['touch', 'pen']) {
      const threshold = getExtremeGradeThreshold(pointerType)
      expect(resolveSwipeGrade(-179, cardWidth, threshold)).toBe('hard')
      expect(resolveSwipeGrade(-180, cardWidth, threshold)).toBe('again')
      expect(resolveSwipeGrade(179, cardWidth, threshold)).toBe('good')
      expect(resolveSwipeGrade(180, cardWidth, threshold)).toBe('easy')
    }
  })

  test('only maps number keys onto review grades', () => {
    expect(keyboardToGrade('1')).toBe('again')
    expect(keyboardToGrade('2')).toBe('hard')
    expect(keyboardToGrade('3')).toBe('good')
    expect(keyboardToGrade('4')).toBe('easy')
    expect(keyboardToGrade('ArrowLeft')).toBeNull()
    expect(keyboardToGrade('ArrowUp')).toBeNull()
    expect(keyboardToGrade('ArrowRight')).toBeNull()
    expect(keyboardToGrade('ArrowDown')).toBeNull()
  })
})
