import type { ModuleArtifactDescriptor } from './moduleArtifactVerifier'
import type {
  ModuleDeviceState,
  ModuleDeviceStateTransaction,
} from './moduleDeviceStateStore'
import {
  ModuleReadinessReconciler,
  type ModuleReadinessReconcilerOptions,
} from './moduleReadinessReconciler'
import { moduleReadyMarkerFileName } from './moduleStore'

const HASH = 'a'.repeat(64)

function descriptor(id: string, version: string): ModuleArtifactDescriptor {
  return {
    id,
    version,
    hostApi: '>=1.0.0 <2.0.0',
    dataSchemas: {},
    platform: 'desktop',
    manifestUrl: `https://github.com/Lapis0x0/obsidian-yolo/releases/download/v${version}/${id}.json`,
    manifest: { byteSize: 10, sha256: HASH },
  }
}

function state(
  id: string,
  versions: readonly string[],
  patch: Partial<ModuleDeviceState> = {},
): ModuleDeviceState {
  return {
    moduleId: id,
    platform: 'desktop',
    activeVersion: versions[0] ?? null,
    pendingVersion: versions[1] ?? null,
    downloadedCandidate: versions[2] ?? null,
    readyVersions: Object.fromEntries(
      versions.map((version) => [version, descriptor(id, version)]),
    ),
    transition: null,
    ...patch,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

async function nextMacrotask(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

function fixture(initial: Record<string, ModuleDeviceState | null> = {}) {
  const durable = new Map(Object.entries(initial))
  const tails = new Map<string, Promise<void>>()
  const runExclusive = async <T>(
    moduleId: string,
    operation: (transaction: ModuleDeviceStateTransaction) => Promise<T>,
  ): Promise<T> => {
    const previous = tails.get(moduleId) ?? Promise.resolve()
    const result = previous
      .catch(() => undefined)
      .then(() =>
        operation({
          read: async () => durable.get(moduleId) ?? null,
          write: async (next) => {
            durable.set(moduleId, next)
            return next
          },
          remove: async () => {
            durable.delete(moduleId)
          },
        }),
      )
    const tail = result.then(
      () => undefined,
      () => undefined,
    )
    tails.set(moduleId, tail)
    return result
  }
  const files = new Set<string>()
  const artifactStore = {
    readManifestBytes: jest.fn(async (id: string, version: string) => {
      if (!files.has(`${id}@${version}`)) throw new Error('missing')
      return new Uint8Array()
    }),
    readReadyMarkerBytes: jest.fn(async () => new Uint8Array()),
    readEntryBytes: jest.fn(async () => new Uint8Array()),
    listVersionFiles: jest.fn(async () => [] as string[]),
    removeVersionArtifacts: jest.fn(async (id: string, version: string) => {
      files.delete(`${id}@${version}`)
    }),
  }
  const install = async (
    value: ModuleArtifactDescriptor,
    _signal?: AbortSignal,
  ) => {
    files.add(`${value.id}@${value.version}`)
    return {} as never
  }
  const installer = { install: jest.fn(install) }
  const repair = jest.fn(install)
  const candidates = new Map<string, ModuleArtifactDescriptor>()
  const options: ModuleReadinessReconcilerOptions = {
    deviceStateStore: { runExclusive },
    intentStore: { get: jest.fn(async () => undefined) },
    catalogSource: {
      getResolvedVersion: jest.fn((id: string) => {
        const value = candidates.get(id)
        return value
          ? ({ version: value.version, manifest: value.manifest } as never)
          : undefined
      }),
      getResolvedArtifactDescriptor: jest.fn((id: string) =>
        candidates.get(id),
      ),
    },
    artifactStore,
    installer: { ...installer, repair },
    platform: 'desktop',
    subtleCrypto: { digest: jest.fn() },
  }
  return {
    durable,
    files,
    artifactStore,
    installer: { ...installer, repair },
    candidates,
    options,
    create: () => new ModuleReadinessReconciler(options),
  }
}

describe('ModuleReadinessReconciler', () => {
  it('preserves an active corrupted artifact when exact repair is offline', async () => {
    const existing = state('learning', ['1.0.0'])
    const value = fixture({ learning: existing })
    value.files.add('learning@1.0.0')
    value.artifactStore.readManifestBytes.mockResolvedValue(new Uint8Array())
    value.installer.repair.mockRejectedValue(new Error('offline'))

    await expect(value.create().ensureModuleReady('learning')).rejects.toThrow(
      'offline',
    )

    expect(value.durable.get('learning')).toBe(existing)
    expect(value.files.has('learning@1.0.0')).toBe(true)
    expect(value.artifactStore.removeVersionArtifacts).not.toHaveBeenCalled()
    expect(value.installer.repair).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'learning', version: '1.0.0' }),
      expect.any(AbortSignal),
    )
    expect(
      value.options.catalogSource.getResolvedVersion,
    ).not.toHaveBeenCalled()
    expect(value.options.intentStore.get).not.toHaveBeenCalled()
  })

  it('repairs an active corrupted artifact from its device-state descriptor', async () => {
    const existing = state('learning', ['1.0.0'])
    const value = fixture({ learning: existing })
    value.files.add('learning@1.0.0')
    value.artifactStore.readManifestBytes.mockResolvedValue(new Uint8Array())

    await expect(
      value.create().ensureModuleReady('learning'),
    ).resolves.toMatchObject({
      status: 'ready',
      repairedVersions: ['1.0.0'],
    })

    expect(value.durable.get('learning')).toBe(existing)
    expect(value.installer.repair).toHaveBeenCalledTimes(1)
    expect(
      value.options.catalogSource.getResolvedVersion,
    ).not.toHaveBeenCalled()
  })

  it('preserves a pending corrupted artifact when exact repair is offline', async () => {
    const existing = state('learning', ['1.1.0'], {
      activeVersion: null,
      pendingVersion: '1.1.0',
    })
    const value = fixture({ learning: existing })
    value.files.add('learning@1.1.0')
    value.artifactStore.readManifestBytes.mockResolvedValue(new Uint8Array())
    value.installer.repair.mockRejectedValue(new Error('offline'))

    await expect(value.create().ensureModuleReady('learning')).rejects.toThrow(
      'offline',
    )

    expect(value.durable.get('learning')).toBe(existing)
    expect(value.files.has('learning@1.1.0')).toBe(true)
    expect(value.artifactStore.removeVersionArtifacts).not.toHaveBeenCalled()
  })

  it('does not repair an active artifact after a transient read failure', async () => {
    const existing = state('learning', ['1.0.0'])
    const value = fixture({ learning: existing })
    value.files.add('learning@1.0.0')
    value.artifactStore.readManifestBytes.mockRejectedValue(
      new Error('storage temporarily unavailable'),
    )

    await expect(value.create().ensureModuleReady('learning')).rejects.toThrow(
      'storage temporarily unavailable',
    )

    expect(value.durable.get('learning')).toBe(existing)
    expect(value.installer.repair).not.toHaveBeenCalled()
    expect(value.artifactStore.removeVersionArtifacts).not.toHaveBeenCalled()
  })

  it('preserves a candidate after a transient read failure while installation is offline', async () => {
    const existing = state('learning', ['2.0.0'], {
      activeVersion: null,
      downloadedCandidate: '2.0.0',
    })
    const value = fixture({ learning: existing })
    value.files.add('learning@2.0.0')
    value.artifactStore.readManifestBytes.mockRejectedValue(
      new Error('storage temporarily unavailable'),
    )
    value.installer.repair.mockRejectedValue(new Error('offline'))

    await expect(value.create().ensureModuleReady('learning')).rejects.toThrow(
      'storage temporarily unavailable',
    )

    expect(value.durable.get('learning')).toBe(existing)
    expect(value.files.has('learning@2.0.0')).toBe(true)
    expect(value.artifactStore.removeVersionArtifacts).not.toHaveBeenCalled()
    expect(value.installer.repair).not.toHaveBeenCalled()
  })

  it('repairs a deterministically corrupted inactive candidate without deleting it first', async () => {
    const existing = state('learning', ['2.0.0'], {
      activeVersion: null,
      downloadedCandidate: '2.0.0',
    })
    const value = fixture({ learning: existing })
    value.files.add('learning@2.0.0')
    value.artifactStore.readManifestBytes.mockResolvedValue(new Uint8Array())

    await expect(
      value.create().ensureModuleReady('learning'),
    ).resolves.toMatchObject({
      status: 'ready',
      repairedVersions: ['2.0.0'],
    })

    expect(value.durable.get('learning')).toBe(existing)
    expect(value.artifactStore.removeVersionArtifacts).not.toHaveBeenCalled()
    expect(value.installer.repair).toHaveBeenCalledTimes(1)
    expect(value.files.has('learning@2.0.0')).toBe(true)
  })

  it('uses only the resolved exact catalog candidate for first desired installation and ignores enabled', async () => {
    const value = fixture()
    value.candidates.set('learning', descriptor('learning', '2.0.0'))
    value.options.intentStore.get = jest.fn(async () => ({
      desiredInstalled: true,
      enabled: false,
    }))

    const result = await value.create().ensureModuleReady('learning')

    expect(result.installedVersion).toBe('2.0.0')
    expect(value.durable.get('learning')).toMatchObject({
      activeVersion: null,
      pendingVersion: null,
      downloadedCandidate: '2.0.0',
    })
  })

  it('does not consult catalog or change versions when local state already exists', async () => {
    const existing = state('learning', ['1.0.0'])
    const value = fixture({ learning: existing })
    value.files.add('learning@1.0.0')
    value.artifactStore.readManifestBytes.mockResolvedValue(new Uint8Array())
    value.candidates.set('learning', descriptor('learning', '9.0.0'))
    value.options.intentStore.get = jest.fn(async () => ({
      desiredInstalled: true,
      enabled: true,
    }))

    await expect(
      value.create().ensureModuleReady('learning'),
    ).resolves.toMatchObject({
      repairedVersions: ['1.0.0'],
    })

    expect(value.durable.get('learning')).toBe(existing)
    expect(
      value.options.catalogSource.getResolvedVersion,
    ).not.toHaveBeenCalled()
  })

  it('reuses a complete exact artifact without removing or downloading it', async () => {
    const id = 'learning'
    const version = '1.0.0'
    const manifest = {
      schemaVersion: 1,
      id,
      version,
      hostApi: '>=1.0.0 <2.0.0',
      dataSchemas: {},
      variants: [
        {
          platform: 'desktop',
          entry: 'main.js',
          files: [
            {
              role: 'entry',
              name: 'main.js',
              path: 'main.js',
              url: `https://github.com/Lapis0x0/obsidian-yolo/releases/download/v${version}/main.js`,
              byteSize: 1,
              sha256: HASH,
              storage: 'module',
            },
          ],
        },
      ],
    }
    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest))
    const exact = descriptor(id, version)
    const exactDescriptor = {
      ...exact,
      manifest: { ...exact.manifest, byteSize: manifestBytes.byteLength },
    }
    const existing = state(id, [version], {
      readyVersions: { [version]: exactDescriptor },
    })
    const value = fixture({ learning: existing })
    const subtleCrypto = {
      digest: jest.fn(async () => new Uint8Array(32).fill(0xaa).buffer),
    }
    value.artifactStore.readManifestBytes.mockResolvedValue(manifestBytes)
    value.artifactStore.readReadyMarkerBytes.mockResolvedValue(
      new TextEncoder().encode(
        JSON.stringify({
          schemaVersion: 1,
          id,
          version,
          platform: 'desktop',
          manifestSha256: HASH,
        }),
      ),
    )
    value.artifactStore.readEntryBytes.mockResolvedValue(new Uint8Array([1]))
    value.artifactStore.listVersionFiles.mockResolvedValue([
      'module.json',
      moduleReadyMarkerFileName('desktop', HASH),
      'main.js',
    ])

    const result = await new ModuleReadinessReconciler({
      ...value.options,
      subtleCrypto,
    }).ensureModuleReady(id)

    expect(result.repairedVersions).toEqual([])
    expect(value.artifactStore.removeVersionArtifacts).not.toHaveBeenCalled()
    expect(value.installer.install).not.toHaveBeenCalled()
  })

  it('skips absent modules without desired installation', async () => {
    const value = fixture()
    value.options.intentStore.get = jest.fn(async () => ({
      desiredInstalled: false,
      enabled: true,
    }))

    await expect(
      value.create().ensureModuleReady('learning'),
    ).resolves.toMatchObject({
      status: 'skipped',
    })
    expect(value.installer.install).not.toHaveBeenCalled()
  })

  it('serializes one module while reconcile starts different modules concurrently', async () => {
    const value = fixture({
      learning: state('learning', ['1.0.0'], {
        activeVersion: null,
        downloadedCandidate: '1.0.0',
      }),
      writing: state('writing', ['1.0.0'], {
        activeVersion: null,
        downloadedCandidate: '1.0.0',
      }),
    })
    value.artifactStore.readManifestBytes.mockResolvedValue(new Uint8Array())
    const gates = [
      deferred<undefined>(),
      deferred<undefined>(),
      deferred<undefined>(),
    ]
    let calls = 0
    value.installer.repair.mockImplementation(
      async () => gates[calls++].promise as never,
    )
    const reconciler = value.create()

    const first = reconciler.ensureModuleReady('learning')
    const second = reconciler.ensureModuleReady('learning')
    const other = reconciler.ensureModuleReady('writing')
    await nextMacrotask()
    expect(value.installer.repair).toHaveBeenCalledTimes(2)

    gates[0].resolve(undefined)
    gates[1].resolve(undefined)
    await Promise.all([first, other])
    await nextMacrotask()
    expect(value.installer.repair).toHaveBeenCalledTimes(3)
    gates[2].resolve(undefined)
    await second
  })

  it('aborts in-flight work on dispose and rejects subsequent work', async () => {
    const value = fixture({
      learning: state('learning', ['1.0.0'], {
        activeVersion: null,
        downloadedCandidate: '1.0.0',
      }),
    })
    value.artifactStore.readManifestBytes.mockResolvedValue(new Uint8Array())
    const started = deferred<undefined>()
    value.installer.repair.mockImplementation(
      async (_descriptor: ModuleArtifactDescriptor, signal?: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          started.resolve(undefined)
          signal?.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    )
    const reconciler = value.create()
    const pending = reconciler.ensureModuleReady('learning')
    await started.promise

    reconciler.dispose()

    await expect(pending).rejects.toThrow('disposed')
    await expect(reconciler.ensureModuleReady('learning')).rejects.toThrow(
      'disposed',
    )
  })

  it('isolates failures in reconcile', async () => {
    const value = fixture({
      learning: state('learning', ['1.0.0'], {
        activeVersion: null,
        downloadedCandidate: '1.0.0',
      }),
    })
    value.artifactStore.readManifestBytes.mockResolvedValue(new Uint8Array())

    const results = await value.create().reconcile(['missing', 'learning'])

    expect(results.map(({ moduleId, status }) => [moduleId, status])).toEqual([
      ['learning', 'ready'],
      ['missing', 'skipped'],
    ])
  })
})
