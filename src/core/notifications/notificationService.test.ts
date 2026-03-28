import { NotificationEvent, NotificationService } from './notificationService'

const createEvent = (
  overrides?: Partial<NotificationEvent>,
): NotificationEvent => ({
  type: 'approval_required',
  dedupeKey: 'tool-1',
  title: 'Approval required',
  ...overrides,
})

describe('NotificationService', () => {
  it('does not notify when notifications are disabled', async () => {
    const soundNotify = jest.fn<Promise<void>, [NotificationEvent]>()
    const service = new NotificationService({
      getOptions: () => ({
        enabled: false,
        channel: 'sound',
      }),
      soundNotifier: { notify: soundNotify },
    })

    await service.notify(createEvent())

    expect(soundNotify).not.toHaveBeenCalled()
  })

  it('does not notify when timing is unfocused-only and window is focused', async () => {
    const soundNotify = jest.fn<Promise<void>, [NotificationEvent]>()
    const service = new NotificationService({
      getOptions: () => ({
        enabled: true,
        channel: 'sound',
        timing: 'when-unfocused',
        notifyOnApprovalRequired: true,
      }),
      getIsWindowFocused: () => true,
      soundNotifier: { notify: soundNotify },
    })

    await service.notify(createEvent())

    expect(soundNotify).not.toHaveBeenCalled()
  })

  it('notifies when timing is unfocused-only and window is unfocused', async () => {
    const soundNotify = jest.fn<Promise<void>, [NotificationEvent]>()
    const service = new NotificationService({
      getOptions: () => ({
        enabled: true,
        channel: 'sound',
        timing: 'when-unfocused',
        notifyOnApprovalRequired: true,
      }),
      getIsWindowFocused: () => false,
      soundNotifier: { notify: soundNotify },
    })

    await service.notify(createEvent())

    expect(soundNotify).toHaveBeenCalledTimes(1)
  })

  it('deduplicates approval notifications by key', async () => {
    const soundNotify = jest.fn<Promise<void>, [NotificationEvent]>()
    const service = new NotificationService({
      getOptions: () => ({
        enabled: true,
        channel: 'sound',
        notifyOnApprovalRequired: true,
      }),
      soundNotifier: { notify: soundNotify },
    })

    const event = createEvent()
    await service.notify(event)
    await service.notify(event)

    expect(soundNotify).toHaveBeenCalledTimes(1)
  })

  it('can seed approval keys without notifying', async () => {
    const soundNotify = jest.fn<Promise<void>, [NotificationEvent]>()
    const service = new NotificationService({
      getOptions: () => ({
        enabled: true,
        channel: 'sound',
        notifyOnApprovalRequired: true,
      }),
      soundNotifier: { notify: soundNotify },
    })

    service.markApprovalKeysAsSeen(['tool-1'])
    await service.notify(createEvent())

    expect(soundNotify).not.toHaveBeenCalled()
  })

  it('notifies both channels when configured', async () => {
    const soundNotify = jest.fn<Promise<void>, [NotificationEvent]>()
    const systemNotify = jest.fn<Promise<void>, [NotificationEvent]>()
    const service = new NotificationService({
      getOptions: () => ({
        enabled: true,
        channel: 'both',
        notifyOnTaskCompleted: true,
      }),
      soundNotifier: { notify: soundNotify },
      systemNotifier: { notify: systemNotify },
    })

    await service.notify(
      createEvent({
        type: 'task_completed',
        dedupeKey: 'task-1',
        title: 'Task finished',
      }),
    )

    expect(soundNotify).toHaveBeenCalledTimes(1)
    expect(systemNotify).toHaveBeenCalledTimes(1)
  })
})
