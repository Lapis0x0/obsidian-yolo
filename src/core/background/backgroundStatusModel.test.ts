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
  it('shows a passive reminder when no task is active', () => {
    const reminder = activity('review', 'reminder')

    expect(buildBackgroundStatusModel([reminder])).toEqual({
      activities: [reminder],
      tone: 'reminder',
      visible: true,
    })
  })

  it('keeps activity priority and sorts reminders last', () => {
    const model = buildBackgroundStatusModel([
      activity('review', 'reminder'),
      activity('failed', 'failed'),
      activity('running-b', 'running'),
      activity('waiting', 'waiting'),
      activity('running-a', 'running'),
    ])

    expect(model.activities.map(({ id }) => id)).toEqual([
      'waiting',
      'running-a',
      'running-b',
      'failed',
      'review',
    ])
    expect(model.tone).toBe('running')
  })

  it('hides when there are no activities', () => {
    expect(buildBackgroundStatusModel([])).toMatchObject({
      visible: false,
      tone: null,
    })
  })
})
