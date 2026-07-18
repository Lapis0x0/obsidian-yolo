// eslint-disable-next-line import/no-nodejs-modules -- transition integrity tests require Node's real Web Crypto implementation
import { webcrypto } from 'node:crypto'

import type { ModuleArtifactDescriptor } from './moduleArtifactVerifier'
import type {
  ModuleDeviceState,
  ModuleDeviceStateTransaction,
} from './moduleDeviceStateStore'
import {
  ModuleTransitionCoordinator,
  type ModuleTransitionCoordinatorOptions,
} from './moduleTransitionCoordinator'
import type { CapturedModuleTransitionSettings } from './obsidianModuleConfigBackend'

const HASH = 'a'.repeat(64)
const subtleCrypto = webcrypto.subtle as unknown as Pick<SubtleCrypto, 'digest'>

function descriptor(
  version = '2.0.0',
  patch: Partial<ModuleArtifactDescriptor> = {},
): ModuleArtifactDescriptor {
  return {
    id: 'learning',
    version,
    hostApi: '^1.0.0',
    dataSchemas: { settings: { readMin: 0, readMax: 2, write: 1 } },
    platform: 'desktop',
    manifestUrl: `https://github.com/Lapis0x0/obsidian-yolo/releases/download/learning-v${version}/module.json`,
    manifest: { byteSize: 42, sha256: HASH },
    ...patch,
  }
}

function state(patch: Partial<ModuleDeviceState> = {}): ModuleDeviceState {
  return {
    moduleId: 'learning',
    platform: 'desktop',
    activeVersion: '1.0.0',
    downloadedCandidate: '2.0.0',
    pendingVersion: null,
    readyVersions: {
      '1.0.0': descriptor('1.0.0'),
      '2.0.0': descriptor(),
    },
    transition: null,
    ...patch,
  }
}

function capture(
  snapshot: CapturedModuleTransitionSettings['snapshot'] = {
    present: true,
    envelope: { schemaVersion: 1, data: { z: 1, a: [true] } },
  },
): CapturedModuleTransitionSettings {
  return {
    location: {
      moduleId: 'learning',
      storageRoot: 'Current/.yolo_json_db/module-settings',
      storagePath: 'Current/.yolo_json_db/module-settings/learning.json',
    },
    snapshot,
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function queuedRunner() {
  const queues = new Map<string, Promise<void>>()
  return <T>(
    moduleId: string,
    operation: (transaction: ModuleDeviceStateTransaction) => Promise<T>,
    transaction: ModuleDeviceStateTransaction,
  ): Promise<T> => {
    const previous = queues.get(moduleId) ?? Promise.resolve()
    const result = previous
      .catch(() => undefined)
      .then(() => operation(transaction))
    const tail = result.then(
      () => undefined,
      () => undefined,
    )
    queues.set(moduleId, tail)
    void tail.then(() => {
      if (queues.get(moduleId) === tail) queues.delete(moduleId)
    })
    return result
  }
}

type Overrides = Omit<
  Partial<ModuleTransitionCoordinatorOptions>,
  'settingsBackend'
> & {
  settingsBackend?: Partial<
    ModuleTransitionCoordinatorOptions['settingsBackend']
  >
  initial?: ModuleDeviceState | null
  write?: (next: ModuleDeviceState) => Promise<ModuleDeviceState>
  read?: () => Promise<ModuleDeviceState | null>
}

function fixture(overrides: Overrides = {}) {
  let durable = overrides.initial === undefined ? state() : overrides.initial
  let captured: CapturedModuleTransitionSettings | undefined
  const configuredCapture =
    overrides.settingsBackend?.capture ?? (async () => capture())
  const captureSettings = jest.fn(async (moduleId: string) => {
    captured = await configuredCapture(moduleId)
    return captured
  })
  const readCapturedSettings = jest.fn(
    overrides.settingsBackend?.readAtCapturedLocation ??
      (async () => {
        if (!captured) throw new Error('Settings have not been captured')
        return captured.snapshot
      }),
  )
  const read = jest.fn(overrides.read ?? (async () => durable))
  const write = jest.fn(
    overrides.write ??
      (async (next: ModuleDeviceState) => {
        durable = next
        return next
      }),
  )
  const transaction: ModuleDeviceStateTransaction = {
    read,
    write,
    remove: async () => undefined,
  }
  const run = queuedRunner()
  const deviceStateStore = {
    runExclusive: <T>(
      moduleId: string,
      operation: (value: ModuleDeviceStateTransaction) => Promise<T>,
    ) => run(moduleId, operation, transaction),
  }
  const manager = { refresh: jest.fn(async () => undefined) }
  const { settingsBackend: _settingsBackend, ...optionOverrides } = overrides
  const options: ModuleTransitionCoordinatorOptions = {
    deviceStateStore,
    settingsBackend: {
      capture: captureSettings,
      readAtCapturedLocation: readCapturedSettings,
    },
    manager,
    platform: 'desktop',
    subtleCrypto,
    ...optionOverrides,
  }
  return {
    coordinator: new ModuleTransitionCoordinator(options),
    captureSettings,
    readCapturedSettings,
    deviceStateStore,
    read,
    write,
    manager,
    durable: () => durable,
  }
}

const request = Object.freeze({
  moduleId: 'learning',
  expectedVersion: '2.0.0',
  expectedManifestSha256: HASH,
})

describe('ModuleTransitionCoordinator', () => {
  it('requires exact-location reread support', () => {
    expect(
      () =>
        new ModuleTransitionCoordinator({
          deviceStateStore: { runExclusive: jest.fn() },
          settingsBackend: { capture: jest.fn() } as never,
          manager: { refresh: jest.fn() },
          platform: 'desktop',
        }),
    ).toThrow('options are invalid')
  })

  it.each([
    null,
    {},
    { ...request, extra: true },
    { ...request, moduleId: 'Learning' },
    { ...request, expectedVersion: 'v2' },
    { ...request, expectedManifestSha256: HASH.toUpperCase() },
    Object.defineProperty({ ...request }, 'moduleId', {
      enumerable: true,
      get: () => 'learning',
    }),
  ])('strictly rejects invalid requests %#', async (value) => {
    const harness = fixture()
    await expect(
      harness.coordinator.prepareConfirmedCandidate(value as never),
    ).rejects.toThrow()
    expect(harness.read).not.toHaveBeenCalled()
  })

  it.each([
    ['active update', state()],
    [
      'first install',
      state({
        activeVersion: null,
        readyVersions: { '2.0.0': descriptor() },
      }),
    ],
  ] as const)(
    'prepares a stateful %s without changing settings',
    async (_label, initial) => {
      const harness = fixture({ initial })
      const result =
        await harness.coordinator.prepareConfirmedCandidate(request)

      expect(result.state).toMatchObject({
        activeVersion: initial.activeVersion,
        downloadedCandidate: null,
        pendingVersion: '2.0.0',
        transition: {
          phase: 'prepared',
          previousActiveVersion: initial.activeVersion,
        },
      })
      expect(result.journal.settings).toMatchObject({
        location: capture().location,
        sourceSchemaVersion: 1,
        targetSchemaVersion: 1,
      })
      expect(result.journal.settings?.previousSha256).toBe(
        result.journal.settings?.expectedPostSha256,
      )
      expect(harness.captureSettings).toHaveBeenCalledTimes(1)
      expect(harness.readCapturedSettings).toHaveBeenCalledTimes(1)
      expect(harness.manager.refresh).toHaveBeenCalledTimes(1)
      expect(Object.isFrozen(result.journal)).toBe(true)
    },
  )

  it('preserves absent settings distinctly and hashes the full canonical snapshot', async () => {
    const absent = capture({ present: false, envelope: null })
    const schemaZero = descriptor('2.0.0', {
      dataSchemas: { settings: { readMin: 0, readMax: 1, write: 0 } },
    })
    const first = fixture({
      initial: state({
        readyVersions: {
          '1.0.0': descriptor('1.0.0'),
          '2.0.0': schemaZero,
        },
      }),
      settingsBackend: { capture: jest.fn(async () => absent) },
    })
    const reordered = fixture({
      settingsBackend: {
        capture: jest.fn(async () =>
          capture({
            present: true,
            envelope: { data: { a: [true], z: 1 }, schemaVersion: 1 },
          }),
        ),
      },
    })
    const normal = fixture()

    const absentResult =
      await first.coordinator.prepareConfirmedCandidate(request)
    const left = await normal.coordinator.prepareConfirmedCandidate(request)
    const right = await reordered.coordinator.prepareConfirmedCandidate(request)

    expect(absentResult.journal.settings?.previous).toEqual(absent.snapshot)
    expect(left.journal.settings?.previousSha256).toBe(
      right.journal.settings?.previousSha256,
    )
  })

  it('does not capture settings or require crypto for a stateless module', async () => {
    const target = descriptor('2.0.0', { dataSchemas: {} })
    const harness = fixture({
      initial: state({
        readyVersions: { '1.0.0': descriptor('1.0.0'), '2.0.0': target },
      }),
      subtleCrypto: undefined,
    })

    const result = await harness.coordinator.prepareConfirmedCandidate(request)

    expect(result.journal.settings).toBeNull()
    expect(harness.captureSettings).not.toHaveBeenCalled()
    expect(harness.readCapturedSettings).not.toHaveBeenCalled()
  })

  it('rejects a local settings change between capture and admission', async () => {
    const harness = fixture({
      settingsBackend: {
        readAtCapturedLocation: jest.fn(async () => ({
          present: true as const,
          envelope: { schemaVersion: 1, data: { changed: true } },
        })),
      },
    })

    await expect(
      harness.coordinator.prepareConfirmedCandidate(request),
    ).rejects.toThrow('SHA-256 mismatch')
    expect(harness.write).not.toHaveBeenCalled()
    expect(harness.manager.refresh).not.toHaveBeenCalled()
  })

  it('rechecks the captured location after the dynamic base directory changes', async () => {
    let activeRoot = 'Old/.yolo_json_db/module-settings'
    const captured = capture()
    const readAtCapturedLocation = jest.fn(async (location) => {
      expect(activeRoot).toBe('New/.yolo_json_db/module-settings')
      expect(location).toEqual(captured.location)
      return captured.snapshot
    })
    const harness = fixture({
      settingsBackend: {
        capture: jest.fn(async () => {
          activeRoot = 'New/.yolo_json_db/module-settings'
          return captured
        }),
        readAtCapturedLocation,
      },
    })

    await expect(
      harness.coordinator.prepareConfirmedCandidate(request),
    ).resolves.toBeDefined()
    expect(readAtCapturedLocation).toHaveBeenCalledWith(captured.location)
  })

  it('rejects schema-changing, oversized, corrupt, and location-mismatched captures without mutation', async () => {
    const cases: CapturedModuleTransitionSettings[] = [
      capture({ present: true, envelope: { schemaVersion: 0, data: {} } }),
      capture({
        present: true,
        envelope: { schemaVersion: 1, data: 'x'.repeat(256 * 1024) },
      }),
      capture({
        present: true,
        envelope: { schemaVersion: 1, data: { invalid: undefined } },
      }),
      { ...capture(), location: { ...capture().location, moduleId: 'other' } },
    ]
    for (const captured of cases) {
      const harness = fixture({
        settingsBackend: { capture: jest.fn(async () => captured) },
      })
      await expect(
        harness.coordinator.prepareConfirmedCandidate(request),
      ).rejects.toThrow()
      expect(harness.write).not.toHaveBeenCalled()
      expect(harness.durable()).toEqual(state())
    }
  })

  it.each([
    ['missing state', null],
    ['platform', state({ platform: 'mobile' })],
    ['candidate', state({ downloadedCandidate: '1.0.0' })],
    ['pending', state({ pendingVersion: '1.0.0' })],
    ['active target', state({ activeVersion: '2.0.0' })],
    [
      'descriptor id',
      state({
        readyVersions: {
          '1.0.0': descriptor('1.0.0'),
          '2.0.0': descriptor('2.0.0', { id: 'other' }),
        },
      }),
    ],
    [
      'descriptor version',
      state({
        readyVersions: {
          '1.0.0': descriptor('1.0.0'),
          '2.0.0': descriptor('3.0.0'),
        },
      }),
    ],
    [
      'descriptor platform',
      state({
        readyVersions: {
          '1.0.0': descriptor('1.0.0'),
          '2.0.0': descriptor('2.0.0', { platform: 'mobile' }),
        },
      }),
    ],
    [
      'descriptor hash',
      state({
        readyVersions: {
          '1.0.0': descriptor('1.0.0'),
          '2.0.0': descriptor('2.0.0', {
            manifest: { byteSize: 42, sha256: 'b'.repeat(64) },
          }),
        },
      }),
    ],
  ] as const)(
    'rejects a %s mismatch before capture',
    async (_label, initial) => {
      const harness = fixture({ initial })
      await expect(
        harness.coordinator.prepareConfirmedCandidate(request),
      ).rejects.toThrow()
      expect(harness.captureSettings).not.toHaveBeenCalled()
      expect(harness.write).not.toHaveBeenCalled()
    },
  )

  it('rejects existing pending and journal state', async () => {
    const prepared =
      await fixture().coordinator.prepareConfirmedCandidate(request)
    for (const initial of [
      state({ pendingVersion: '1.0.0' }),
      prepared.state,
    ]) {
      const harness = fixture({ initial })
      await expect(
        harness.coordinator.prepareConfirmedCandidate(request),
      ).rejects.toThrow()
      expect(harness.write).not.toHaveBeenCalled()
    }
  })

  it.each(['before', 'after'] as const)(
    'uses exact readback for an uncertain write %s commit',
    async (timing) => {
      let durable = state()
      const writeError = new Error('uncertain write')
      const harness = fixture({
        read: async () => durable,
        write: async (next) => {
          if (timing === 'after') durable = next
          throw writeError
        },
      })

      const operation = harness.coordinator.prepareConfirmedCandidate(request)
      if (timing === 'after') {
        await expect(operation).resolves.toMatchObject({
          state: { pendingVersion: '2.0.0' },
        })
      } else {
        await expect(operation).rejects.toBe(writeError)
      }
      expect(harness.read).toHaveBeenCalledTimes(2)
      expect(harness.manager.refresh).toHaveBeenCalledTimes(1)
    },
  )

  it('refreshes before rethrow when uncertain write readback is unreadable', async () => {
    let reads = 0
    const writeError = new Error('uncertain write')
    const harness = fixture({
      read: async () => {
        reads += 1
        if (reads === 1) return state()
        throw new Error('readback unavailable')
      },
      write: async () => Promise.reject(writeError),
    })

    await expect(
      harness.coordinator.prepareConfirmedCandidate(request),
    ).rejects.toBe(writeError)
    expect(harness.manager.refresh).toHaveBeenCalledTimes(1)
  })

  it('serializes preparation across coordinators sharing the state lock', async () => {
    const blocked = deferred<CapturedModuleTransitionSettings>()
    const captureStarted = deferred<undefined>()
    const events: string[] = []
    const first = fixture({
      settingsBackend: {
        capture: jest.fn(async () => {
          events.push('first-capture')
          captureStarted.resolve(undefined)
          return blocked.promise
        }),
      },
    })
    const second = new ModuleTransitionCoordinator({
      deviceStateStore: first.deviceStateStore,
      settingsBackend: {
        capture: jest.fn(async () => {
          events.push('second-capture')
          return capture()
        }),
        readAtCapturedLocation: jest.fn(async () => capture().snapshot),
      },
      manager: { refresh: async () => undefined },
      platform: 'desktop',
      subtleCrypto,
    })

    const firstOperation = first.coordinator.prepareConfirmedCandidate(request)
    await captureStarted.promise
    const secondOperation = second.prepareConfirmedCandidate(request)
    await Promise.resolve()
    expect(events).toEqual(['first-capture'])
    blocked.resolve(capture())
    await expect(firstOperation).resolves.toBeDefined()
    await expect(secondOperation).rejects.toThrow()
    expect(events).toEqual(['first-capture'])
  })

  it('cancels before lock, during capture, and immediately before write', async () => {
    const locked = deferred<undefined>()
    const queued = fixture({
      deviceStateStore: {
        runExclusive: async (_moduleId, operation) => {
          await locked.promise
          return operation({
            read: async () => state(),
            write: async (next) => next,
            remove: async () => undefined,
          })
        },
      },
    })
    const queuedOperation =
      queued.coordinator.prepareConfirmedCandidate(request)
    queued.coordinator.dispose()
    locked.resolve(undefined)
    await expect(queuedOperation).rejects.toThrow('disposed')

    const pendingCapture = deferred<CapturedModuleTransitionSettings>()
    const capturing = fixture({
      settingsBackend: { capture: jest.fn(() => pendingCapture.promise) },
    })
    const captureOperation =
      capturing.coordinator.prepareConfirmedCandidate(request)
    await Promise.resolve()
    capturing.coordinator.dispose()
    await expect(captureOperation).rejects.toThrow('disposed')
    pendingCapture.resolve(capture())

    const beforeWriteCapture = deferred<CapturedModuleTransitionSettings>()
    const beforeWrite = fixture({
      settingsBackend: { capture: jest.fn(() => beforeWriteCapture.promise) },
    })
    const beforeWriteOperation =
      beforeWrite.coordinator.prepareConfirmedCandidate(request)
    await Promise.resolve()
    beforeWriteCapture.resolve(capture())
    beforeWrite.coordinator.dispose()
    await expect(beforeWriteOperation).rejects.toThrow('disposed')
    expect(beforeWrite.write).not.toHaveBeenCalled()
  })

  it('allows a linearized write to settle when disposed', async () => {
    const writing = deferred<ModuleDeviceState>()
    const writeStarted = deferred<undefined>()
    let intended: ModuleDeviceState | undefined
    const harness = fixture({
      write: async (next) => {
        intended = next
        writeStarted.resolve(undefined)
        return writing.promise
      },
    })
    const operation = harness.coordinator.prepareConfirmedCandidate(request)
    await writeStarted.promise
    harness.coordinator.dispose()
    writing.resolve(intended!)

    await expect(operation).resolves.toMatchObject({
      state: { pendingVersion: '2.0.0' },
    })
    await expect(
      harness.coordinator.prepareConfirmedCandidate(request),
    ).rejects.toThrow('disposed')
  })

  it('reports refresh failure without failing durable preparation', async () => {
    const refreshError = new Error('refresh failed')
    const reportRefreshError = jest.fn(() => {
      throw new Error('diagnostic failed')
    })
    const harness = fixture({
      manager: { refresh: jest.fn(async () => Promise.reject(refreshError)) },
      reportRefreshError,
    })

    await expect(
      harness.coordinator.prepareConfirmedCandidate(request),
    ).resolves.toBeDefined()
    expect(reportRefreshError).toHaveBeenCalledWith(refreshError)
  })
})
