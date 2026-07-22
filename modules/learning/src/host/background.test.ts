import type { LearningReminderActivity } from '../domain/runtime/ports'

import { createHostLearningBackgroundPort } from './background'

describe('host Learning background port', () => {
  it('maps reminder callbacks to the Host 1.1 activity shape', () => {
    const upsert = jest.fn()
    const remove = jest.fn()
    const port = createHostLearningBackgroundPort({ upsert, remove })
    const run = jest.fn()
    const activity: LearningReminderActivity = {
      id: 'reminder:learning-review',
      kind: 'learning-review',
      title: 'Learning',
      detail: '2 cards',
      summary: '2 cards due',
      icon: 'graduation-cap',
      status: 'reminder',
      updatedAt: 123,
      action: { type: 'callback', run },
    }

    port.upsert(activity)
    expect(upsert).toHaveBeenCalledWith({
      id: activity.id,
      title: activity.title,
      detail: activity.detail,
      summary: activity.summary,
      icon: activity.icon,
      status: activity.status,
      onOpen: run,
    })
    port.remove(activity.id)
    expect(remove).toHaveBeenCalledWith(activity.id)
  })
})
