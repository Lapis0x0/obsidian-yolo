import type { ReviewRating } from '../../core/learning/srs/srsTypes'

const DRAG_GRADE_THRESHOLD = 0.15
const MOUSE_EXTREME_GRADE_THRESHOLD = 0.9
const TOUCH_EXTREME_GRADE_THRESHOLD = 0.6

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
