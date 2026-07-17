import {
  buildInitialReviewQueue,
  getExtremeGradeThreshold,
  keyboardToGrade,
  resolveSwipeGrade,
  updateReviewQueue,
} from './reviewInteractions'

describe('review card interactions', () => {
  test('builds the study queue from due cards and the remaining daily new-card allowance', () => {
    const now = new Date('2026-07-13T12:00:00.000Z')
    const dueCards = Array.from({ length: 15 }, (_, index) => ({
      id: `due-${index}`,
      dueAt: '2026-07-13T11:00:00.000Z',
      srsState: {},
    }))
    const newCards = Array.from({ length: 8 }, (_, index) => ({
      id: `new-${index}`,
      dueAt: null,
      srsState: null,
    }))

    const queue = buildInitialReviewQueue([...dueCards, ...newCards], now, 17)

    expect(queue).toHaveLength(18)
    expect(queue.slice(15).map((card) => card.id)).toEqual([
      'new-0',
      'new-1',
      'new-2',
    ])
  })

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

  test('moves a card to the end after every again grade', () => {
    const card = { id: 'a' }
    let queue = [{ id: 'b' }]

    queue = updateReviewQueue(queue, card, 'again')
    queue = updateReviewQueue(queue, card, 'again')

    expect(queue.map((item) => item.id)).toEqual(['b', 'a', 'a'])
    expect(updateReviewQueue(queue, card, 'hard')).toBe(queue)
  })
})
