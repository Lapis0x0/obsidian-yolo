import { type ActionToastOptions, ActionToastStore } from './ActionToast'

const toast = (id: string, title = id): ActionToastOptions => ({
  id,
  tone: 'success',
  title,
  message: 'Complete',
  actionLabel: 'Open',
  dismissLabel: 'Dismiss',
  onAction: () => undefined,
})

describe('ActionToastStore', () => {
  test('keeps results for different projects', () => {
    const store = new ActionToastStore()
    store.show(toast('project-a'))
    store.show(toast('project-b'))

    expect(store.getSnapshot().map((item) => item.id)).toEqual([
      'project-a',
      'project-b',
    ])
  })

  test('replaces the same project with a new isolated instance', () => {
    const store = new ActionToastStore()
    store.show(toast('project-a', 'First'))
    const firstInstance = store.getSnapshot()[0].instanceId

    store.show(toast('project-a', 'Second'))
    const replacement = store.getSnapshot()[0]
    store.dismissInstance(firstInstance)

    expect(replacement.instanceId).not.toBe(firstInstance)
    expect(store.getSnapshot()).toEqual([replacement])
  })

  test('dismisses only the requested notification', () => {
    const store = new ActionToastStore()
    store.show(toast('project-a'))
    store.show(toast('project-b'))

    store.dismiss('project-a')

    expect(store.getSnapshot().map((item) => item.id)).toEqual(['project-b'])
  })
})
