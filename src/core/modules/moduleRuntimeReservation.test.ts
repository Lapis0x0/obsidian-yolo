import { ModuleRuntimeReservation } from './moduleRuntimeReservation'
import type { YoloModuleDefinition } from './types'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function definition(id: string): YoloModuleDefinition {
  return { id, activate: () => undefined }
}

function fixture(activeIds: readonly string[] = []) {
  const active = new Set(activeIds)
  const activate = jest.fn(async (module: YoloModuleDefinition) => {
    active.add(module.id)
  })
  const runtime = {
    isActive: jest.fn((moduleId: string) => active.has(moduleId)),
    activate,
  }
  return {
    active,
    activate,
    runtime,
    reservation: new ModuleRuntimeReservation({ runtime }),
  }
}

describe('ModuleRuntimeReservation', () => {
  it('provides the narrow quiescence API expected by uninstall', async () => {
    const value = fixture()
    const runtime: Readonly<{
      runWithModuleQuiesced<T>(
        moduleId: string,
        operation: () => Promise<T>,
      ): Promise<T>
    }> = value.reservation

    await expect(
      runtime.runWithModuleQuiesced('learning', async () => 'removed'),
    ).resolves.toBe('removed')
  })

  it('rejects active modules before entering the quiesced operation', async () => {
    const value = fixture(['learning'])
    const operation = jest.fn(async () => undefined)

    await expect(
      value.reservation.runWithModuleQuiesced('learning', operation),
    ).rejects.toThrow('is active')
    expect(operation).not.toHaveBeenCalled()
  })

  it('rejects an activation-pending module without waiting for activation', async () => {
    const entered = deferred<undefined>()
    const release = deferred<undefined>()
    const value = fixture()
    value.activate.mockImplementationOnce(async (module) => {
      entered.resolve(undefined)
      await release.promise
      value.active.add(module.id)
    })
    const activation = value.reservation.activate(definition('learning'))
    await entered.promise
    const operation = jest.fn(async () => undefined)

    await expect(
      value.reservation.runWithModuleQuiesced('learning', operation),
    ).rejects.toThrow('activation is pending')
    expect(operation).not.toHaveBeenCalled()
    release.resolve(undefined)
    await activation
  })

  it('holds activation until an earlier quiesced operation settles', async () => {
    const entered = deferred<undefined>()
    const release = deferred<undefined>()
    const value = fixture()
    const quiesced = value.reservation.runWithModuleQuiesced(
      'learning',
      async () => {
        entered.resolve(undefined)
        await release.promise
      },
    )
    await entered.promise

    const activation = value.reservation.activate(
      definition('learning'),
      '1.0.0',
    )
    await Promise.resolve()
    expect(value.activate).not.toHaveBeenCalled()
    release.resolve(undefined)
    await quiesced
    await activation
    expect(value.activate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'learning' }),
      '1.0.0',
      undefined,
    )
  })

  it('serializes quiesced operations for one module', async () => {
    const entered = deferred<undefined>()
    const release = deferred<undefined>()
    const value = fixture()
    const events: string[] = []
    const first = value.reservation.runWithModuleQuiesced(
      'learning',
      async () => {
        events.push('first-enter')
        entered.resolve(undefined)
        await release.promise
        events.push('first-exit')
      },
    )
    await entered.promise
    const second = value.reservation.runWithModuleQuiesced(
      'learning',
      async () => {
        events.push('second')
      },
    )

    await Promise.resolve()
    expect(events).toEqual(['first-enter'])
    release.resolve(undefined)
    await Promise.all([first, second])
    expect(events).toEqual(['first-enter', 'first-exit', 'second'])
  })

  it('does not serialize different modules', async () => {
    const release = deferred<undefined>()
    const value = fixture()
    const learning = value.reservation.runWithModuleQuiesced(
      'learning',
      () => release.promise,
    )
    const notesOperation = jest.fn(async () => 'notes-removed')

    await expect(
      value.reservation.runWithModuleQuiesced('notes', notesOperation),
    ).resolves.toBe('notes-removed')
    expect(notesOperation).toHaveBeenCalledTimes(1)
    release.resolve(undefined)
    await learning
  })

  it('releases a reservation when the quiesced callback fails', async () => {
    const value = fixture()
    await expect(
      value.reservation.runWithModuleQuiesced('learning', async () => {
        throw new Error('removal failed')
      }),
    ).rejects.toThrow('removal failed')

    await expect(
      value.reservation.runWithModuleQuiesced('learning', async () => 'retry'),
    ).resolves.toBe('retry')
  })

  it('releases a failed activation so an inactive module can be removed', async () => {
    const value = fixture()
    value.activate.mockRejectedValueOnce(new Error('activation failed'))

    await expect(
      value.reservation.activate(definition('learning')),
    ).rejects.toThrow('activation failed')
    await expect(
      value.reservation.runWithModuleQuiesced(
        'learning',
        async () => 'removed',
      ),
    ).resolves.toBe('removed')
  })

  it('allows uninstall against a fresh inactive runtime after full reload', async () => {
    const oldRuntime = fixture(['learning'])
    await expect(
      oldRuntime.reservation.runWithModuleQuiesced(
        'learning',
        async () => undefined,
      ),
    ).rejects.toThrow('is active')

    const reloadedRuntime = fixture()
    await expect(
      reloadedRuntime.reservation.runWithModuleQuiesced(
        'learning',
        async () => 'removed',
      ),
    ).resolves.toBe('removed')
  })

  it('passes activation arguments through unchanged', async () => {
    const value = fixture()
    const module = definition('learning')
    const controller = new AbortController()

    await value.reservation.activate(module, '2.0.0', controller.signal)

    expect(value.activate).toHaveBeenCalledWith(
      module,
      '2.0.0',
      controller.signal,
    )
  })

  it('rejects queued and new work on dispose while allowing entered work to settle', async () => {
    const entered = deferred<undefined>()
    const release = deferred<undefined>()
    const value = fixture()
    const first = value.reservation.runWithModuleQuiesced(
      'learning',
      async () => {
        entered.resolve(undefined)
        await release.promise
        return 'settled'
      },
    )
    await entered.promise
    const queuedOperation = jest.fn(async () => 'queued')
    const queued = value.reservation.runWithModuleQuiesced(
      'learning',
      queuedOperation,
    )

    value.reservation.dispose()
    await expect(
      value.reservation.runWithModuleQuiesced('notes', async () => undefined),
    ).rejects.toThrow('is disposed')
    await expect(
      value.reservation.activate(definition('notes')),
    ).rejects.toThrow('is disposed')
    release.resolve(undefined)
    await expect(first).resolves.toBe('settled')
    await expect(queued).rejects.toThrow('is disposed')
    expect(queuedOperation).not.toHaveBeenCalled()
  })

  it('validates construction and callback inputs', async () => {
    expect(
      () =>
        new ModuleRuntimeReservation({
          runtime: {} as never,
        }),
    ).toThrow('options are invalid')
    const value = fixture()
    await expect(
      value.reservation.runWithModuleQuiesced('learning', undefined as never),
    ).rejects.toThrow('must be a function')
  })
})
