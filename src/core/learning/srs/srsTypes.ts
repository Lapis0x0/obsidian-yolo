export type SrsCardState = {
  due: string
  stability: number
  difficulty: number
  elapsedDays: number
  scheduledDays: number
  learningSteps: number
  reps: number
  lapses: number
  state: number
  lastReview?: string
  introducedAt: string
}

export type SrsProjectState = {
  version: 2
  cards: Record<string, SrsCardState>
  suspended: string[]
}

export type Mastery = 'new' | 'learning' | 'mastered'

export type ReviewRating = 'again' | 'hard' | 'good' | 'easy'

export type CardScheduling = {
  due: Date
  scheduledDays: number
}

export type ReviewResult = {
  card: SrsCardState
  scheduling: Record<ReviewRating, CardScheduling>
}
