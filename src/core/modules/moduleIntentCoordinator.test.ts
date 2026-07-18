import {
  ModuleIntentCoordinator,
  ModuleIntentOperationError,
} from './moduleIntentCoordinator'
import {
  type ModuleIntent,
  ModuleIntentWriteUncertainError,
} from './moduleIntentStore'

function createHarness(initial: Record<string, ModuleIntent> = {}) {
  const values = new Map(
    Object.entries(initial).map(([id, intent]) => [id, { ...intent }]),
  )
  const get = jest.fn(async (moduleId: string) => values.get(moduleId))
  const set = jest.fn(async (moduleId: string, intent: ModuleIntent) => {
    const persisted = Object.freeze({ ...intent })
    values.set(moduleId, persisted)
    return persisted
  })
  const refresh = jest.fn(async () => undefined)
  const store = { get, set }
  const coordinator = new ModuleIntentCoordinator({
    store,
    manager: { refresh },
  })
  return { coordinator, get, set, refresh, store, values }
}

describe('ModuleIntentCoordinator', () => {
  it('validates its dependencies', () => {
    expect(
      () =>
        new ModuleIntentCoordinator({
          store: {} as never,
          manager: { refresh: async () => undefined },
        }),
    ).toThrow('options are invalid')
  })

  it('changes only the product intent dimension owned by each operation', async () => {
    const harness = createHarness()

    await expect(harness.coordinator.install('notes')).resolves.toEqual({
      desiredInstalled: true,
      enabled: false,
    })
    await expect(harness.coordinator.enable('notes')).resolves.toEqual({
      desiredInstalled: true,
      enabled: true,
    })
    await expect(harness.coordinator.uninstall('notes')).resolves.toEqual({
      desiredInstalled: false,
      enabled: true,
    })
    await expect(harness.coordinator.disable('notes')).resolves.toEqual({
      desiredInstalled: false,
      enabled: false,
    })

    expect(harness.set.mock.calls).toEqual([
      ['notes', { desiredInstalled: true, enabled: false }],
      ['notes', { desiredInstalled: true, enabled: true }],
      ['notes', { desiredInstalled: false, enabled: true }],
      ['notes', { desiredInstalled: false, enabled: false }],
    ])
    expect(harness.refresh).toHaveBeenCalledTimes(4)
  })

  it('preserves an existing orthogonal value for every operation', async () => {
    const cases = [
      [
        'install',
        { desiredInstalled: false, enabled: true },
        { desiredInstalled: true, enabled: true },
      ],
      [
        'enable',
        { desiredInstalled: false, enabled: false },
        { desiredInstalled: false, enabled: true },
      ],
      [
        'disable',
        { desiredInstalled: true, enabled: true },
        { desiredInstalled: true, enabled: false },
      ],
      [
        'uninstall',
        { desiredInstalled: true, enabled: true },
        { desiredInstalled: false, enabled: true },
      ],
    ] as const

    for (const [method, initial, expected] of cases) {
      const harness = createHarness({ notes: initial })
      await expect(harness.coordinator[method]('notes')).resolves.toEqual(
        expected,
      )
    }
  })

  it('serializes the complete read, write, and refresh flow per module', async () => {
    const harness = createHarness()
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    let started!: () => void
    const writeStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    harness.set.mockImplementationOnce(async (_moduleId, intent) => {
      started()
      await blocked
      harness.values.set('notes', intent)
      return intent
    })

    const install = harness.coordinator.install('notes')
    await writeStarted
    const enable = harness.coordinator.enable('notes')
    await Promise.resolve()
    expect(harness.get).toHaveBeenCalledTimes(1)

    release()
    await expect(install).resolves.toEqual({
      desiredInstalled: true,
      enabled: false,
    })
    await expect(enable).resolves.toEqual({
      desiredInstalled: true,
      enabled: true,
    })
    expect(harness.get).toHaveBeenCalledTimes(2)
    expect(harness.refresh).toHaveBeenCalledTimes(2)
  })

  it('shares same-module serialization across coordinators using one store', async () => {
    const harness = createHarness()
    const secondCoordinator = new ModuleIntentCoordinator({
      store: harness.store,
      manager: { refresh: harness.refresh },
    })
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    let started!: () => void
    const writeStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    harness.set.mockImplementationOnce(async (_moduleId, intent) => {
      started()
      await blocked
      harness.values.set('notes', intent)
      return intent
    })

    const install = harness.coordinator.install('notes')
    await writeStarted
    const enable = secondCoordinator.enable('notes')
    await Promise.resolve()
    expect(harness.get).toHaveBeenCalledTimes(1)

    release()
    await Promise.all([install, enable])
    expect(harness.values.get('notes')).toEqual({
      desiredInstalled: true,
      enabled: true,
    })
  })

  it('allows different modules to reach the store independently', async () => {
    const harness = createHarness()
    const started = new Set<string>()
    let bothStarted!: () => void
    const both = new Promise<void>((resolve) => {
      bothStarted = resolve
    })
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    harness.get.mockImplementation(async (moduleId) => {
      started.add(moduleId)
      if (started.size === 2) bothStarted()
      await blocked
      return undefined
    })

    const notes = harness.coordinator.install('notes')
    const search = harness.coordinator.enable('search')
    await both
    expect(started).toEqual(new Set(['notes', 'search']))
    release()
    await Promise.all([notes, search])
  })

  it('continues a module queue after an operation failure', async () => {
    const harness = createHarness()
    const failure = new Error('read failed')
    harness.get.mockRejectedValueOnce(failure)

    const failed = harness.coordinator.install('notes')
    const next = harness.coordinator.enable('notes')

    await expect(failed).rejects.toBe(failure)
    await expect(next).resolves.toEqual({
      desiredInstalled: false,
      enabled: true,
    })
    expect(harness.refresh).toHaveBeenCalledTimes(2)
  })

  it('relies on the store readback result and does not retry uncertain writes', async () => {
    const harness = createHarness()
    const uncertain = new ModuleIntentWriteUncertainError(
      'notes',
      new Error('write failed'),
      new Error('readback failed'),
    )
    harness.set.mockRejectedValueOnce(uncertain)

    await expect(harness.coordinator.install('notes')).rejects.toBe(uncertain)
    expect(harness.get).toHaveBeenCalledTimes(1)
    expect(harness.set).toHaveBeenCalledTimes(1)
    expect(harness.refresh).toHaveBeenCalledTimes(1)
  })

  it('propagates refresh failure after a successful write', async () => {
    const harness = createHarness()
    const failure = new Error('refresh failed')
    harness.refresh.mockRejectedValueOnce(failure)

    await expect(harness.coordinator.install('notes')).rejects.toBe(failure)
    expect(harness.values.get('notes')).toEqual({
      desiredInstalled: true,
      enabled: false,
    })
  })

  it('retains write and refresh errors when both fail', async () => {
    const harness = createHarness()
    const writeFailure = new Error('write failed')
    const refreshFailure = new Error('refresh failed')
    harness.set.mockRejectedValueOnce(writeFailure)
    harness.refresh.mockRejectedValueOnce(refreshFailure)

    const operation = harness.coordinator.install('notes')
    await expect(operation).rejects.toBeInstanceOf(ModuleIntentOperationError)
    await expect(operation).rejects.toMatchObject({
      operationError: writeFailure,
      refreshError: refreshFailure,
    })
  })

  it('rejects calls and queued work that have not started after disposal', async () => {
    const harness = createHarness()
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    let started!: () => void
    const readStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    harness.get.mockImplementationOnce(async () => {
      started()
      await blocked
      return undefined
    })

    const active = harness.coordinator.install('notes')
    await readStarted
    const queued = harness.coordinator.enable('notes')
    harness.coordinator.dispose()
    const afterDispose = harness.coordinator.disable('search')
    release()

    await expect(active).resolves.toEqual({
      desiredInstalled: true,
      enabled: false,
    })
    await expect(queued).rejects.toThrow('coordinator is disposed')
    await expect(afterDispose).rejects.toThrow('coordinator is disposed')
    expect(harness.set).toHaveBeenCalledTimes(1)
  })

  it('rejects invalid module ids before touching dependencies', async () => {
    const harness = createHarness()

    await expect(harness.coordinator.install('../notes')).rejects.toThrow()
    expect(harness.get).not.toHaveBeenCalled()
    expect(harness.refresh).not.toHaveBeenCalled()
  })
})
