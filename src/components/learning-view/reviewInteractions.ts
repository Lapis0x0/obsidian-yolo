import { isDue } from '../../core/learning/srs/masteryMapping'
import type { ReviewRating } from '../../core/learning/srs/srsTypes'

const DRAG_GRADE_THRESHOLD = 0.15
const MOUSE_EXTREME_GRADE_THRESHOLD = 0.9
const TOUCH_EXTREME_GRADE_THRESHOLD = 0.6
const DAILY_NEW_CARD_LIMIT = 20

type QueueCard = {
  dueAt: string | null
  srsState: object | null
}

export function buildInitialReviewQueue<T extends QueueCard>(
  cards: T[],
  now: Date,
  todayIntroducedCount: number,
): T[] {
  const due = cards
    .filter((card) => card.srsState && card.dueAt && isDue(card.dueAt, now))
    .sort(
      (left, right) =>
        new Date(left.dueAt ?? 0).getTime() -
        new Date(right.dueAt ?? 0).getTime(),
    )
  const newCardLimit = Math.max(0, DAILY_NEW_CARD_LIMIT - todayIntroducedCount)
  const newCards = cards.filter((card) => !card.srsState).slice(0, newCardLimit)
  return [...due, ...newCards]
}

export function getExtremeGradeThreshold(pointerType: string): number {
  return pointerType === 'touch' || pointerType === 'pen'
    ? TOUCH_EXTREME_GRADE_THRESHOLD
    : MOUSE_EXTREME_GRADE_THRESHOLD
}

export function resolveSwipeGrade(
  dx: number,
  cardWidth: number,
  extremeGradeThreshold: number,
): ReviewRating | null {
  const distanceRatio = Math.abs(dx) / Math.max(cardWidth, 1)
  if (distanceRatio < DRAG_GRADE_THRESHOLD) return null

  if (dx < 0) {
    return distanceRatio >= extremeGradeThreshold ? 'again' : 'hard'
  }
  return distanceRatio >= extremeGradeThreshold ? 'easy' : 'good'
}

export function keyboardToGrade(key: string): ReviewRating | null {
  if (key === '1') return 'again'
  if (key === '2') return 'hard'
  if (key === '3') return 'good'
  if (key === '4') return 'easy'
  return null
}

export function updateReviewQueue<T>(
  queue: T[],
  reviewedCard: T,
  grade: ReviewRating,
): T[] {
  return grade === 'again' ? [...queue, reviewedCard] : queue
}
