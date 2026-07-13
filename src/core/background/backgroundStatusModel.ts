import type { BackgroundActivity } from './backgroundActivityRegistry'

export type BackgroundStatusTone = 'running' | 'waiting' | 'failed' | 'review'

export type BackgroundStatusModel = {
  activities: BackgroundActivity[]
  showReviewReminder: boolean
  tone: BackgroundStatusTone | null
  visible: boolean
}

export function buildBackgroundStatusModel(
  activities: Iterable<BackgroundActivity>,
  dueCards: number,
): BackgroundStatusModel {
  const visibleActivities = Array.from(activities)
    .filter(
      (activity) =>
        activity.status === 'running' ||
        activity.status === 'waiting' ||
        activity.status === 'failed',
    )
    .sort((left, right) => {
      const priorityDelta = priority(left) - priority(right)
      return priorityDelta || left.id.localeCompare(right.id)
    })
  const showReviewReminder = dueCards > 0
  let tone: BackgroundStatusTone | null = null
  if (visibleActivities.some((activity) => activity.status === 'running')) {
    tone = 'running'
  } else if (
    visibleActivities.some((activity) => activity.status === 'waiting')
  ) {
    tone = 'waiting'
  } else if (
    visibleActivities.some((activity) => activity.status === 'failed')
  ) {
    tone = 'failed'
  } else if (showReviewReminder) {
    tone = 'review'
  }

  return {
    activities: visibleActivities,
    showReviewReminder,
    tone,
    visible: visibleActivities.length > 0 || showReviewReminder,
  }
}

function priority(activity: BackgroundActivity): number {
  if (activity.status === 'waiting') return 0
  if (activity.status === 'running') return 1
  return 2
}
