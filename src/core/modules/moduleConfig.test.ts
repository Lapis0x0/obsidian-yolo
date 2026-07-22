import { ModuleLifecycleScope } from './lifecycleScope'
import {
  ModuleConfigCapabilityProvider,
  type ModuleConfigSnapshot,
} from './moduleConfig'

type Config = { value: number; nested?: { enabled: boolean } }

function createHarness(initial: ModuleConfigSnapshot<Config>) {
  let stored = initial
  let backendListener: (() => void) | undefined
  const unsubscribeBackend = jest.fn()
  const writes: ModuleConfigSnapshot<Config>[] = []
  const provider = new ModuleConfigCapabilityProvider<Config>({
    createBackend: () => ({
      read: async () => stored,
      write: async (next) => {
        writes.push(next)
        stored = next
        return stored
      },
      subscribe: (listener) => {
        backendListener = listener
        return unsubscribeBackend
      },
    }),
  })
  const lifecycle = new ModuleLifecycleScope()
  const activation = provider.create('generic', lifecycle)
  return {
    activation,
    lifecycle,
    writes,
    unsubscribeBackend,
    updateExternally(next: ModuleConfigSnapshot<Config>) {
      stored = next
      backendListener?.()
    },
  }
}

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('ModuleConfigCapabilityProvider', () => {
  it('rejects path-like module ids', () => {
    const provider = new ModuleConfigCapabilityProvider({
      createBackend: () => ({
        read: async () => ({ schemaVersion: 1, data: {} }),
        write: async (next) => next,
        subscribe: () => () => undefined,
      }),
    })

    expect(() =>
      provider.create('../generic', new ModuleLifecycleScope()),
    ).toThrow('path segment')
  })

  it('serializes concurrent writes and publishes the persisted read-back', async () => {
    let stored: ModuleConfigSnapshot<Config> = {
      schemaVersion: 1,
      data: { value: 0 },
    }
    let releaseFirst!: () => void
    const blocked = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let writes = 0
    const lifecycle = new ModuleLifecycleScope()
    const activation = new ModuleConfigCapabilityProvider<Config>({
      createBackend: () => ({
        read: async () => stored,
        write: async (next) => {
          writes += 1
          if (writes === 1) await blocked
          stored = next
          return stored
        },
        subscribe: () => () => undefined,
      }),
    }).create('generic', lifecycle)
    await activation.activate()
    const listener = jest.fn()
    activation.api.subscribe(listener)

    const first = activation.api.replace({
      schemaVersion: 1,
      data: { value: 1 },
    })
    const second = activation.api.replace({
      schemaVersion: 2,
      data: { value: 2 },
    })
    await flush()
    expect(writes).toBe(1)
    releaseFirst()

    await expect(Promise.all([first, second])).resolves.toEqual([
      { schemaVersion: 1, data: { value: 1 } },
      { schemaVersion: 2, data: { value: 2 } },
    ])
    expect(activation.api.getSnapshot()).toEqual({
      schemaVersion: 2,
      data: { value: 2 },
    })
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('activates and replaces schema version zero snapshots', async () => {
    const harness = createHarness({ schemaVersion: 0, data: { value: 0 } })

    await harness.activation.activate()
    await expect(
      harness.activation.api.replace({
        schemaVersion: 0,
        data: { value: 1 },
      }),
    ).resolves.toEqual({ schemaVersion: 0, data: { value: 1 } })
    expect(harness.activation.api.getSnapshot()).toEqual({
      schemaVersion: 0,
      data: { value: 1 },
    })
  })

  it('publishes the snapshot returned by write without reading again', async () => {
    const persisted = { schemaVersion: 1, data: { value: 2 } } as const
    const read = jest.fn(async () => ({
      schemaVersion: 1,
      data: { value: 0 },
    }))
    const lifecycle = new ModuleLifecycleScope()
    const activation = new ModuleConfigCapabilityProvider<Config>({
      createBackend: () => ({
        read,
        write: async () => persisted,
        subscribe: () => () => undefined,
      }),
    }).create('generic', lifecycle)
    await activation.activate()

    await expect(
      activation.api.replace({ schemaVersion: 1, data: { value: 1 } }),
    ).resolves.toEqual(persisted)
    expect(read).toHaveBeenCalledTimes(1)
    expect(activation.api.getSnapshot()).toEqual(persisted)
  })

  it('deep-copies and freezes snapshots and publishes external updates', async () => {
    const initial = {
      schemaVersion: 1,
      data: { value: 1, nested: { enabled: true } },
    }
    const harness = createHarness(initial)
    expect(() => harness.activation.api.getSnapshot()).toThrow('unavailable')
    await harness.activation.activate()
    const listener = jest.fn()
    harness.activation.api.subscribe(listener)

    initial.data.nested.enabled = false
    expect(harness.activation.api.getSnapshot().data.nested?.enabled).toBe(true)
    expect(Object.isFrozen(harness.activation.api.getSnapshot())).toBe(true)
    expect(Object.isFrozen(harness.activation.api.getSnapshot().data)).toBe(
      true,
    )
    expect(
      Object.isFrozen(harness.activation.api.getSnapshot().data.nested),
    ).toBe(true)

    harness.updateExternally({ schemaVersion: 2, data: { value: 8 } })
    await flush()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(harness.activation.api.getSnapshot()).toEqual({
      schemaVersion: 2,
      data: { value: 8 },
    })
  })

  it('reads until backend notifications settle during activation', async () => {
    let backendListener: (() => void) | undefined
    let reads = 0
    let stored: ModuleConfigSnapshot<Config> = {
      schemaVersion: 1,
      data: { value: 0 },
    }
    const lifecycle = new ModuleLifecycleScope()
    const activation = new ModuleConfigCapabilityProvider<Config>({
      createBackend: () => ({
        read: async () => {
          reads += 1
          if (reads <= 3) {
            stored = { schemaVersion: 1, data: { value: reads } }
            backendListener?.()
          }
          return stored
        },
        write: async (next) => next,
        subscribe: (listener) => {
          backendListener = listener
          return () => undefined
        },
      }),
    }).create('generic', lifecycle)

    await activation.activate()

    expect(reads).toBe(4)
    expect(activation.api.getSnapshot().data.value).toBe(3)
  })

  it('fails activation when backend notifications never settle', async () => {
    let backendListener: (() => void) | undefined
    const unsubscribeBackend = jest.fn()
    const lifecycle = new ModuleLifecycleScope()
    const activation = new ModuleConfigCapabilityProvider<Config>({
      createBackend: () => ({
        read: async () => {
          backendListener?.()
          return { schemaVersion: 1, data: { value: 1 } }
        },
        write: async (next) => next,
        subscribe: (listener) => {
          backendListener = listener
          return unsubscribeBackend
        },
      }),
    }).create('generic', lifecycle)

    await expect(activation.activate()).rejects.toThrow(
      'did not stabilize during activation',
    )
    expect(unsubscribeBackend).toHaveBeenCalledTimes(1)
    expect(() => activation.api.getSnapshot()).toThrow('unavailable')
  })

  it('rejects activation promptly when disposed during a pending read', async () => {
    const unsubscribeBackend = jest.fn()
    const lifecycle = new ModuleLifecycleScope()
    const activation = new ModuleConfigCapabilityProvider<Config>({
      createBackend: () => ({
        read: () => new Promise<ModuleConfigSnapshot<Config>>(() => undefined),
        write: async (next) => next,
        subscribe: () => unsubscribeBackend,
      }),
    }).create('generic', lifecycle)

    const pending = activation.activate()
    lifecycle.dispose()

    await expect(pending).rejects.toThrow('unavailable')
    expect(unsubscribeBackend).toHaveBeenCalledTimes(1)
  })

  it('rejects an in-flight replace promptly when disposed', async () => {
    let settleWrite!: (value: ModuleConfigSnapshot<Config>) => void
    const write = jest.fn(
      () =>
        new Promise<ModuleConfigSnapshot<Config>>((resolve) => {
          settleWrite = resolve
        }),
    )
    const lifecycle = new ModuleLifecycleScope()
    const activation = new ModuleConfigCapabilityProvider<Config>({
      createBackend: () => ({
        read: async () => ({ schemaVersion: 1, data: { value: 0 } }),
        write,
        subscribe: () => () => undefined,
      }),
    }).create('generic', lifecycle)
    await activation.activate()

    const pending = activation.api.replace({
      schemaVersion: 1,
      data: { value: 1 },
    })
    await flush()
    lifecycle.dispose()

    await expect(pending).rejects.toThrow('unavailable')
    settleWrite({ schemaVersion: 1, data: { value: 1 } })
    await flush()
  })

  it('rejects sparse arrays and arrays with custom properties', async () => {
    const values: unknown[][] = []
    const sparseWithProperty = Array(2) as unknown[]
    sparseWithProperty[0] = 1
    Object.defineProperty(sparseWithProperty, 'extra', {
      enumerable: true,
      value: 2,
    })
    values.push(sparseWithProperty)

    const arrayWithProperty = [1] as unknown[]
    Object.defineProperty(arrayWithProperty, 'extra', {
      enumerable: true,
      value: 2,
    })
    values.push(arrayWithProperty)

    for (const value of values) {
      const activation = new ModuleConfigCapabilityProvider({
        createBackend: () => ({
          read: async () => ({ schemaVersion: 1, data: value }),
          write: async (next) => next,
          subscribe: () => () => undefined,
        }),
      }).create('generic', new ModuleLifecycleScope())

      await expect(activation.activate()).rejects.toThrow(
        'Config arrays must not be sparse or have properties',
      )
    }
  })

  it('rejects API access before activation and after disposal', async () => {
    const harness = createHarness({ schemaVersion: 1, data: { value: 1 } })
    expect(() => harness.activation.api.subscribe(() => undefined)).toThrow(
      'unavailable',
    )
    expect(() =>
      harness.activation.api.replace({
        schemaVersion: 1,
        data: { value: 2 },
      }),
    ).toThrow('unavailable')

    await harness.activation.activate()
    harness.lifecycle.dispose()
    expect(harness.unsubscribeBackend).toHaveBeenCalledTimes(1)
    expect(() => harness.activation.api.getSnapshot()).toThrow('unavailable')
    expect(() =>
      harness.activation.api.replace({
        schemaVersion: 1,
        data: { value: 2 },
      }),
    ).toThrow('unavailable')
    harness.updateExternally({ schemaVersion: 1, data: { value: 3 } })
    await flush()
  })

  it('isolates listener failures and supports listener reentry', async () => {
    const reported = jest.fn()
    const provider = new ModuleConfigCapabilityProvider<Config>({
      createBackend: () => {
        let stored: ModuleConfigSnapshot<Config> = {
          schemaVersion: 1,
          data: { value: 0 },
        }
        return {
          read: async () => stored,
          write: async (next) => {
            stored = next
            return stored
          },
          subscribe: () => () => undefined,
        }
      },
      reportCallbackError: reported,
    })
    const lifecycle = new ModuleLifecycleScope()
    const activation = provider.create('generic', lifecycle)
    await activation.activate()
    const failure = new Error('listener failed')
    let reentered: Promise<ModuleConfigSnapshot<Config>> | undefined
    activation.api.subscribe(() => {
      if (activation.api.getSnapshot().data.value === 1) {
        reentered = activation.api.replace({
          schemaVersion: 1,
          data: { value: 2 },
        })
      }
    })
    activation.api.subscribe(() => {
      throw failure
    })
    const finalListener = jest.fn()
    activation.api.subscribe(finalListener)

    await activation.api.replace({ schemaVersion: 1, data: { value: 1 } })
    await reentered
    expect(activation.api.getSnapshot().data.value).toBe(2)
    expect(finalListener).toHaveBeenCalledTimes(2)
    expect(reported).toHaveBeenCalledWith('generic', failure)
    lifecycle.dispose()
  })

  it('stops publishing callbacks immediately when a listener disposes', async () => {
    const harness = createHarness({ schemaVersion: 1, data: { value: 1 } })
    await harness.activation.activate()
    const laterListener = jest.fn()
    harness.activation.api.subscribe(() => harness.lifecycle.dispose())
    harness.activation.api.subscribe(laterListener)

    harness.updateExternally({ schemaVersion: 1, data: { value: 2 } })
    await flush()

    expect(laterListener).not.toHaveBeenCalled()
    expect(harness.unsubscribeBackend).toHaveBeenCalledTimes(1)
  })
})
