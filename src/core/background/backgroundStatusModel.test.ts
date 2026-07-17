import type { BackgroundActivity } from './backgroundActivityRegistry'
import { buildBackgroundStatusModel } from './backgroundStatusModel'

function activity(
  id: string,
  status: BackgroundActivity['status'],
): BackgroundActivity {
  return {
    id,
    kind: 'agent',
    title: id,
    status,
    updatedAt: 0,
  }
}

describe('buildBackgroundStatusModel', () => {
  it('shows a static review state when only due cards exist', () => {
    expect(buildBackgroundStatusModel([], 3)).toEqual({
      activities: [],
      showReviewReminder: true,
      tone: 'review',
      visible: true,
    })
  })

  it('keeps activity priority and sorts the reminder outside activities', () => {
    const model = buildBackgroundStatusModel(
      [
        activity('failed', 'failed'),
        activity('running-b', 'running'),
        activity('waiting', 'waiting'),
        activity('running-a', 'running'),
      ],
      5,
    )

    expect(model.activities.map(({ id }) => id)).toEqual([
      'waiting',
      'running-a',
      'running-b',
      'failed',
    ])
    expect(model.showReviewReminder).toBe(true)
    expect(model.tone).toBe('running')
  })

  it('hides when there are no activities or due cards', () => {
    expect(buildBackgroundStatusModel([], 0)).toMatchObject({
      visible: false,
      tone: null,
      showReviewReminder: false,
    })
  })
})
