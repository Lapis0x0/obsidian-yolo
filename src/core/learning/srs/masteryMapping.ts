import type { Mastery } from './srsTypes'

export function fsrsStateToMastery(state: number): Mastery {
  switch (state) {
    case 0:
      return 'new'
    case 1:
      return 'learning'
    case 3:
      return 'learning'
    case 2:
      return 'mastered'
    default:
      return 'new'
  }
}

export function isDue(dueIso: string, now: Date): boolean {
  return new Date(dueIso).getTime() <= now.getTime()
}
