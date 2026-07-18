import type { ModuleArtifactDescriptor } from './moduleArtifactVerifier'
import type {
  ModuleDeviceState,
  ModuleDeviceStateStore,
  ModuleDeviceStateTransaction,
} from './moduleDeviceStateStore'
import {
  ModuleInstallationCoordinator,
  type ModuleInstallationCoordinatorOptions,
} from './moduleInstallationCoordinator'
import type { ModuleArtifactManifest } from './moduleStore'

const HASH = 'a'.repeat(64)

function descriptor(
  id = 'learning',
  version = '2.0.0',
  patch: Partial<ModuleArtifactDescriptor> = {},
): ModuleArtifactDescriptor {
  return {
    id,
    version,
    hostApi: '>=1.0.0 <2.0.0',
    dataSchemas: { cards: { readMin: 1, readMax: 2, write: 2 } },
    platform: 'desktop',
    manifestUrl: `https://github.com/Lapis0x0/obsidian-yolo/releases/download/v${version}/${id}.json`,
    manifest: { byteSize: 100, sha256: HASH },
    ...patch,
  }
}

function manifest(id = 'learning', version = '2.0.0'): ModuleArtifactManifest {
  return {
    schemaVersion: 1,
    id,
    version,
    hostApi: '>=1.0.0 <2.0.0',
    dataSchemas: { cards: { readMin: 1, readMax: 2, write: 2 } },
    variants: [{ platform: 'desktop', entry: 'main.js', files: [] }],
  }
}

function state(
  id = 'learning',
  patch: Partial<ModuleDeviceState> = {},
): ModuleDeviceState {
  return {
    moduleId: id,
    platform: 'desktop',
    activeVersion: null,
    downloadedCandidate: null,
    pendingVersion: null,
    readyVersions: {},
    ...patch,
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

function createExclusiveRunner(transaction: ModuleDeviceStateTransaction) {
  const queues = new Map<string, Promise<void>>()
  return async <T>(
    moduleId: string,
    operation: (transaction: ModuleDeviceStateTransaction) => Promise<T>,
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

type TestDeviceStateStore = Pick<
  ModuleDeviceStateStore,
  'read' | 'write' | 'runExclusive'
>

function transactionalStore(
  read: TestDeviceStateStore['read'],
  write: TestDeviceStateStore['write'],
): TestDeviceStateStore {
  const transaction: ModuleDeviceStateTransaction = Object.freeze({
    read: () => read('learning'),
    write,
    remove: async () => undefined,
  })
  return { read, write, runExclusive: createExclusiveRunner(transaction) }
}

type FixtureOverrides = Omit<
  Partial<ModuleInstallationCoordinatorOptions>,
  'deviceStateStore'
> &
  Readonly<{ deviceStateStore?: TestDeviceStateStore }>

function fixture(
  initial: ModuleDeviceState | null = null,
  overrides: FixtureOverrides = {},
) {
  let durable = initial
  const catalogSource = {
    getResolvedArtifactDescriptor: jest.fn(
      (id: string, version: string, platform: 'desktop' | 'mobile') =>
        descriptor(id, version, { platform }),
    ),
  }
  const installer = {
    install: jest.fn(async (value: ModuleArtifactDescriptor) =>
      manifest(value.id, value.version),
    ),
  }
  const read = jest.fn(async () => durable)
  const write = jest.fn(async (value: ModuleDeviceState) => {
    durable = value
    return value
  })
  const deviceStateStore = transactionalStore(read, write)
  const manager = { refresh: jest.fn(async () => undefined) }
  const { deviceStateStore: overriddenStore, ...otherOverrides } = overrides
  const options: ModuleInstallationCoordinatorOptions = {
    catalogSource,
    installer,
    deviceStateStore: overriddenStore ?? deviceStateStore,
    manager,
    platform: 'desktop',
    ...otherOverrides,
  }
  return {
    coordinator: new ModuleInstallationCoordinator(options),
    catalogSource,
    installer,
    deviceStateStore,
    manager,
    durable: () => durable,
  }
}

describe('ModuleInstallationCoordinator', () => {
  it.each([
    null,
    {},
    { moduleId: 'learning', expectedVersion: '2.0.0', extra: true },
    {
      moduleId: 'learning',
      expectedVersion: '2.0.0',
      expectedManifestSha256: 'invalid',
    },
    { moduleId: 'Learning', expectedVersion: '2.0.0' },
    { moduleId: 'learning', expectedVersion: 'v2' },
    Object.defineProperty({ expectedVersion: '2.0.0' }, 'moduleId', {
      enumerable: true,
      get: () => 'learning',
    }),
  ])('strictly rejects an invalid request %#', async (request) => {
    const value = fixture()

    await expect(
      value.coordinator.installConfirmedCandidate(request as never),
    ).rejects.toThrow()
    expect(value.deviceStateStore.read).not.toHaveBeenCalled()
    expect(value.installer.install).not.toHaveBeenCalled()
    expect(value.manager.refresh).not.toHaveBeenCalled()
  })

  it('installs an initial candidate, writes it durably, then refreshes', async () => {
    const events: string[] = []
    const value = fixture(null, {
      installer: {
        install: jest.fn(async () => {
          events.push('install')
          return manifest()
        }),
      },
      deviceStateStore: transactionalStore(
        jest.fn(async () => {
          events.push('read')
          return null
        }),
        jest.fn(async (next) => {
          events.push('write')
          return next
        }),
      ),
      manager: {
        refresh: jest.fn(async () => {
          events.push('refresh')
        }),
      },
    })

    const result = await value.coordinator.installConfirmedCandidate({
      moduleId: 'learning',
      expectedVersion: '2.0.0',
      expectedManifestSha256: HASH,
    })

    expect(events).toEqual(['read', 'install', 'write', 'refresh'])
    expect(result.state).toMatchObject({
      moduleId: 'learning',
      platform: 'desktop',
      activeVersion: null,
      downloadedCandidate: '2.0.0',
      pendingVersion: null,
    })
    expect(result.state.readyVersions['2.0.0']).toEqual(result.descriptor)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.descriptor.manifest)).toBe(true)
    expect(Object.isFrozen(result.descriptor.dataSchemas.cards)).toBe(true)
    expect(Object.isFrozen(result.manifest.variants[0].files)).toBe(true)
    expect(Object.isFrozen(result.state.readyVersions)).toBe(true)
  })

  it('preserves active, pending, and other ready versions without activation', async () => {
    const active = descriptor('learning', '1.0.0')
    const pending = descriptor('learning', '1.5.0')
    const value = fixture(
      state('learning', {
        activeVersion: '1.0.0',
        downloadedCandidate: '1.5.0',
        pendingVersion: '1.5.0',
        readyVersions: { '1.0.0': active, '1.5.0': pending },
      }),
    )

    const result = await value.coordinator.installConfirmedCandidate({
      moduleId: 'learning',
      expectedVersion: '2.0.0',
      expectedManifestSha256: HASH,
    })

    expect(result.state.activeVersion).toBe('1.0.0')
    expect(result.state.pendingVersion).toBe('1.5.0')
    expect(result.state.downloadedCandidate).toBe('2.0.0')
    expect(Object.keys(result.state.readyVersions).sort()).toEqual([
      '1.0.0',
      '1.5.0',
      '2.0.0',
    ])
  })

  it.each([
    ['unavailable', () => undefined],
    [
      'stale',
      () => {
        throw new Error('candidate changed')
      },
    ],
  ])('fails an %s candidate before mutation', async (_name, resolve) => {
    const value = fixture(null, {
      catalogSource: { getResolvedArtifactDescriptor: jest.fn(resolve) },
    })

    await expect(
      value.coordinator.installConfirmedCandidate({
        moduleId: 'learning',
        expectedVersion: '2.0.0',
        expectedManifestSha256: HASH,
      }),
    ).rejects.toThrow()
    expect(value.installer.install).not.toHaveBeenCalled()
    expect(value.deviceStateStore.write).not.toHaveBeenCalled()
    expect(value.manager.refresh).not.toHaveBeenCalled()
  })

  it('rejects a same-version candidate whose manifest changed after confirmation', async () => {
    const value = fixture(null, {
      catalogSource: {
        getResolvedArtifactDescriptor: jest.fn(() =>
          descriptor('learning', '2.0.0', {
            manifest: { byteSize: 100, sha256: 'b'.repeat(64) },
          }),
        ),
      },
    })

    await expect(
      value.coordinator.installConfirmedCandidate({
        moduleId: 'learning',
        expectedVersion: '2.0.0',
        expectedManifestSha256: HASH,
      }),
    ).rejects.toThrow('changed after confirmation')
    expect(value.installer.install).not.toHaveBeenCalled()
    expect(value.deviceStateStore.write).not.toHaveBeenCalled()
  })

  it('rejects an existing platform mismatch before resolution', async () => {
    const value = fixture(state('learning', { platform: 'mobile' }))

    await expect(
      value.coordinator.installConfirmedCandidate({
        moduleId: 'learning',
        expectedVersion: '2.0.0',
        expectedManifestSha256: HASH,
      }),
    ).rejects.toThrow('belongs to mobile')
    expect(
      value.catalogSource.getResolvedArtifactDescriptor,
    ).not.toHaveBeenCalled()
    expect(value.installer.install).not.toHaveBeenCalled()
  })

  it.each([
    ['host API', { hostApi: '>=2.0.0' }],
    ['platform', { platform: 'mobile' }],
    ['manifest URL', { manifestUrl: 'https://example.com/module.json' }],
    ['manifest size', { manifest: { byteSize: 101, sha256: HASH } }],
    ['manifest hash', { manifest: { byteSize: 100, sha256: 'b'.repeat(64) } }],
    [
      'schema map',
      { dataSchemas: { cards: { readMin: 1, readMax: 3, write: 2 } } },
    ],
  ])(
    'rejects an immutable %s conflict before installation',
    async (_name, patch) => {
      const existing = descriptor()
      const value = fixture(
        state('learning', {
          downloadedCandidate: '2.0.0',
          readyVersions: { '2.0.0': existing },
        }),
        {
          catalogSource: {
            getResolvedArtifactDescriptor: jest.fn(() =>
              descriptor('learning', '2.0.0', patch as never),
            ),
          },
        },
      )

      await expect(
        value.coordinator.installConfirmedCandidate({
          moduleId: 'learning',
          expectedVersion: '2.0.0',
          expectedManifestSha256: HASH,
        }),
      ).rejects.toThrow(
        _name === 'platform'
          ? 'mismatched artifact descriptor'
          : _name === 'manifest hash'
            ? 'changed after confirmation'
            : 'conflicting immutable descriptor',
      )
      expect(value.installer.install).not.toHaveBeenCalled()
      expect(value.deviceStateStore.write).not.toHaveBeenCalled()
      expect(value.manager.refresh).not.toHaveBeenCalled()
    },
  )

  it('re-runs installer verification for an exact existing descriptor', async () => {
    const existing = descriptor()
    const value = fixture(
      state('learning', {
        downloadedCandidate: '2.0.0',
        readyVersions: { '2.0.0': existing },
      }),
    )

    await value.coordinator.installConfirmedCandidate({
      moduleId: 'learning',
      expectedVersion: '2.0.0',
      expectedManifestSha256: HASH,
    })

    expect(value.installer.install).toHaveBeenCalledTimes(1)
    expect(value.deviceStateStore.write).toHaveBeenCalledTimes(1)
    expect(value.manager.refresh).toHaveBeenCalledTimes(1)
  })

  it.each(['read', 'install'] as const)(
    'does not refresh or claim the candidate after a %s failure',
    async (stage) => {
      const original = state()
      let durable = original
      const error = new Error(`${stage} failed`)
      const value = fixture(original, {
        installer: {
          install: jest.fn(async () => {
            if (stage === 'install') throw error
            return manifest()
          }),
        },
        deviceStateStore: transactionalStore(
          jest.fn(async () => {
            if (stage === 'read') throw error
            return durable
          }),
          jest.fn(async (next) => {
            durable = next
            return next
          }),
        ),
      })

      await expect(
        value.coordinator.installConfirmedCandidate({
          moduleId: 'learning',
          expectedVersion: '2.0.0',
          expectedManifestSha256: HASH,
        }),
      ).rejects.toBe(error)
      expect(value.manager.refresh).not.toHaveBeenCalled()
      expect(durable.downloadedCandidate).toBeNull()
    },
  )

  it('refreshes and rejects when a failed state write cannot be confirmed', async () => {
    const original = state()
    const writeError = new Error('write verification failed')
    const read = jest.fn(async () => original)
    const value = fixture(original, {
      deviceStateStore: transactionalStore(
        read,
        jest.fn(async () => Promise.reject(writeError)),
      ),
    })

    await expect(
      value.coordinator.installConfirmedCandidate({
        moduleId: 'learning',
        expectedVersion: '2.0.0',
        expectedManifestSha256: HASH,
      }),
    ).rejects.toBe(writeError)
    expect(read).toHaveBeenCalledTimes(2)
    expect(value.manager.refresh).toHaveBeenCalledTimes(1)
  })

  it('recovers a committed state when write verification fails afterward', async () => {
    let durable: ModuleDeviceState | null = null
    const writeError = new Error('verification read failed')
    const read = jest.fn(async () => durable)
    const value = fixture(null, {
      deviceStateStore: transactionalStore(
        read,
        jest.fn(async (next) => {
          durable = next
          throw writeError
        }),
      ),
    })

    await expect(
      value.coordinator.installConfirmedCandidate({
        moduleId: 'learning',
        expectedVersion: '2.0.0',
        expectedManifestSha256: HASH,
      }),
    ).resolves.toMatchObject({
      state: { downloadedCandidate: '2.0.0' },
    })
    expect(read).toHaveBeenCalledTimes(2)
    expect(value.manager.refresh).toHaveBeenCalledTimes(1)
  })

  it('serializes the full flow across coordinators sharing a store', async () => {
    const firstInstall = deferred<ModuleArtifactManifest>()
    let durable: ModuleDeviceState | null = null
    const events: string[] = []
    const store = transactionalStore(
      jest.fn(async () => {
        events.push('read')
        return durable
      }),
      jest.fn(async (next: ModuleDeviceState) => {
        events.push('write')
        durable = next
        return next
      }),
    )
    let installs = 0
    const installer = {
      install: jest.fn(async () => {
        events.push('install')
        installs += 1
        return installs === 1 ? firstInstall.promise : manifest()
      }),
    }
    const common = {
      catalogSource: {
        getResolvedArtifactDescriptor: () => descriptor(),
      },
      installer,
      deviceStateStore: store,
      manager: {
        refresh: async () => {
          events.push('refresh')
        },
      },
      platform: 'desktop' as const,
    }
    const first = new ModuleInstallationCoordinator(common)
    const second = new ModuleInstallationCoordinator(common)

    const firstPromise = first.installConfirmedCandidate({
      moduleId: 'learning',
      expectedVersion: '2.0.0',
      expectedManifestSha256: HASH,
    })
    await Promise.resolve()
    await Promise.resolve()
    const secondPromise = second.installConfirmedCandidate({
      moduleId: 'learning',
      expectedVersion: '2.0.0',
      expectedManifestSha256: HASH,
    })
    await Promise.resolve()
    expect(events).toEqual(['read', 'install'])

    firstInstall.resolve(manifest())
    await Promise.all([firstPromise, secondPromise])
    expect(events).toEqual([
      'read',
      'install',
      'write',
      'refresh',
      'read',
      'install',
      'write',
      'refresh',
    ])
  })

  it('allows different module IDs to install independently', async () => {
    const learningInstall = deferred<ModuleArtifactManifest>()
    const started: string[] = []
    const store = transactionalStore(
      jest.fn(async () => null),
      jest.fn(async (next: ModuleDeviceState) => next),
    )
    const coordinator = new ModuleInstallationCoordinator({
      catalogSource: {
        getResolvedArtifactDescriptor: (id, version) => descriptor(id, version),
      },
      installer: {
        install: jest.fn(async (value) => {
          started.push(value.id)
          return value.id === 'learning'
            ? learningInstall.promise
            : manifest(value.id, value.version)
        }),
      },
      deviceStateStore: store,
      manager: { refresh: async () => undefined },
      platform: 'desktop',
    })

    const learning = coordinator.installConfirmedCandidate({
      moduleId: 'learning',
      expectedVersion: '2.0.0',
      expectedManifestSha256: HASH,
    })
    const calendar = coordinator.installConfirmedCandidate({
      moduleId: 'calendar',
      expectedVersion: '2.0.0',
      expectedManifestSha256: HASH,
    })
    await expect(calendar).resolves.toMatchObject({
      state: { moduleId: 'calendar' },
    })
    expect(started).toEqual(expect.arrayContaining(['learning', 'calendar']))
    learningInstall.resolve(manifest())
    await learning
  })

  it('reports and swallows refresh failure after durable success', async () => {
    const refreshError = new Error('refresh failed')
    const reportRefreshError = jest.fn(() => {
      throw new Error('reporter failed')
    })
    const value = fixture(null, {
      manager: { refresh: jest.fn(async () => Promise.reject(refreshError)) },
      reportRefreshError,
    })

    await expect(
      value.coordinator.installConfirmedCandidate({
        moduleId: 'learning',
        expectedVersion: '2.0.0',
        expectedManifestSha256: HASH,
      }),
    ).resolves.toMatchObject({
      state: { downloadedCandidate: '2.0.0' },
    })
    expect(reportRefreshError).toHaveBeenCalledWith(refreshError)
    expect(value.deviceStateStore.write).toHaveBeenCalledTimes(1)
  })

  it('aborts an in-flight installation and prevents state commit on dispose', async () => {
    const installing = deferred<ModuleArtifactManifest>()
    const install = jest.fn(
      async (_descriptor: ModuleArtifactDescriptor, _signal?: AbortSignal) =>
        installing.promise,
    )
    const value = fixture(null, {
      installer: { install },
    })

    const result = value.coordinator.installConfirmedCandidate({
      moduleId: 'learning',
      expectedVersion: '2.0.0',
      expectedManifestSha256: HASH,
    })
    await Promise.resolve()
    await Promise.resolve()
    value.coordinator.dispose()
    installing.resolve(manifest())

    await expect(result).rejects.toThrow('disposed')
    expect(value.deviceStateStore.write).not.toHaveBeenCalled()
    expect(value.manager.refresh).not.toHaveBeenCalled()
    const signal = install.mock.calls[0]?.[1]
    expect(signal?.aborted).toBe(true)
    await expect(
      value.coordinator.installConfirmedCandidate({
        moduleId: 'learning',
        expectedVersion: '2.0.0',
        expectedManifestSha256: HASH,
      }),
    ).rejects.toThrow('disposed')
  })

  it('allows a state commit that reached its linearization point before dispose', async () => {
    const writing = deferred<ModuleDeviceState>()
    const write = jest.fn(async (_next: ModuleDeviceState) => writing.promise)
    const value = fixture(null, {
      deviceStateStore: transactionalStore(
        jest.fn(async () => null),
        write,
      ),
    })

    const result = value.coordinator.installConfirmedCandidate({
      moduleId: 'learning',
      expectedVersion: '2.0.0',
      expectedManifestSha256: HASH,
    })
    while (write.mock.calls.length === 0) await Promise.resolve()
    value.coordinator.dispose()
    const committed = write.mock.calls[0][0]
    writing.resolve(committed)

    await expect(result).resolves.toMatchObject({
      state: { downloadedCandidate: '2.0.0' },
    })
  })
})
