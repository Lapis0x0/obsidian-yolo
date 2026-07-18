// eslint-disable-next-line import/no-nodejs-modules -- activation integrity tests use Node's SHA-256 implementation
import { createHash, webcrypto } from 'node:crypto'

import {
  ModuleActivationCoordinator,
  type ModuleActivationCoordinatorOptions,
} from './moduleActivationCoordinator'
import type {
  ModuleArtifactDescriptor,
  ModuleArtifactReadStore,
} from './moduleArtifactVerifier'
import type {
  ModuleDeviceState,
  ModuleDeviceStateTransaction,
} from './moduleDeviceStateStore'
import { parseModuleTransitionJournal } from './moduleTransitionJournal'

const encode = (value: unknown): Uint8Array =>
  new TextEncoder().encode(
    typeof value === 'string' ? value : JSON.stringify(value),
  )
const hash = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex')

type Artifact = ReturnType<typeof artifact>

function artifact(
  id: string,
  version: string,
  patch: Partial<ModuleArtifactDescriptor> = {},
) {
  const entryBytes = encode(`${id}:${version}`)
  const hostApi = patch.hostApi ?? '^1.0.0'
  const dataSchemas = patch.dataSchemas ?? {
    settings: { readMin: 0, readMax: 2, write: 1 },
  }
  const platform = patch.platform ?? ('desktop' as const)
  const entry = {
    role: 'entry' as const,
    name: 'entry.js',
    path: 'entry.js',
    byteSize: entryBytes.byteLength,
    sha256: hash(entryBytes),
    url: `https://github.com/Lapis0x0/obsidian-yolo/releases/download/${id}-v${version}/entry.js`,
    storage: 'module' as const,
  }
  const manifestBytes = encode({
    schemaVersion: 1,
    id,
    version,
    hostApi,
    dataSchemas,
    variants: [{ platform, entry: entry.path, files: [entry] }],
  })
  const descriptor: ModuleArtifactDescriptor = {
    id,
    version,
    hostApi,
    dataSchemas,
    platform,
    manifestUrl: `https://github.com/Lapis0x0/obsidian-yolo/releases/download/${id}-v${version}/module.json`,
    manifest: {
      byteSize: manifestBytes.byteLength,
      sha256: hash(manifestBytes),
    },
    ...patch,
  }
  return { descriptor, entry, entryBytes, manifestBytes }
}

function state(
  id: string,
  artifacts: readonly Artifact[],
  patch: Partial<ModuleDeviceState> = {},
): ModuleDeviceState {
  return {
    moduleId: id,
    platform: 'desktop',
    activeVersion: null,
    downloadedCandidate: null,
    pendingVersion: null,
    readyVersions: Object.fromEntries(
      artifacts.map((item) => [item.descriptor.version, item.descriptor]),
    ),
    transition: null,
    ...patch,
  }
}

function transition(
  target: Artifact,
  phase: NonNullable<ModuleDeviceState['transition']>['phase'] = 'prepared',
): NonNullable<ModuleDeviceState['transition']> {
  const committed = phase === 'committed'
  const rolledBack = phase === 'rollback-completed'
  return parseModuleTransitionJournal(
    {
      phase,
      moduleId: target.descriptor.id,
      platform: target.descriptor.platform,
      previousActiveVersion: '1.0.0',
      targetVersion: target.descriptor.version,
      targetManifestSha256: target.descriptor.manifest.sha256,
      settings: {
        namespace: 'settings',
        sourceSchemaVersion: 1,
        targetSchemaVersion: 1,
        previous: {
          present: true,
          envelope: { schemaVersion: 1, data: { enabled: true } },
        },
        previousSha256: hash(
          encode(
            '{"envelope":{"data":{"enabled":true},"schemaVersion":1},"present":true}',
          ),
        ),
        expectedPostSha256: 'b'.repeat(64),
      },
    },
    {
      moduleId: target.descriptor.id,
      platform: target.descriptor.platform,
      activeVersion: committed ? target.descriptor.version : '1.0.0',
      downloadedCandidate: rolledBack ? target.descriptor.version : null,
      pendingVersion:
        committed || rolledBack ? null : target.descriptor.version,
      readyVersions: ['1.0.0', target.descriptor.version],
      targetDescriptor: target.descriptor,
    },
  )
}

type HarnessOptions = Readonly<{
  states?: readonly ModuleDeviceState[]
  artifacts?: readonly Artifact[]
  hangList?: boolean
  hangVerifier?: ReadonlySet<string>
  corrupt?: ReadonlySet<string>
  failLoader?: ReadonlySet<string>
  hangLoader?: ReadonlySet<string>
  failRuntime?: ReadonlySet<string>
  hangRuntime?: ReadonlySet<string>
  write?: (
    next: ModuleDeviceState,
    durable: Map<string, ModuleDeviceState>,
  ) => Promise<ModuleDeviceState>
  supportedDataNamespaces?: readonly string[]
  readCurrentSchemaVersion?: ModuleActivationCoordinatorOptions['readCurrentSchemaVersion']
  platform?: 'desktop' | 'mobile'
  hostApi?: string
  subtleCrypto?: Pick<SubtleCrypto, 'digest'>
  provideCrypto?: boolean
  reportActivationError?: (moduleId: string, error: unknown) => void
  activationTimeoutMs?: number
  startupTimeoutMs?: number
}>

function harness(options: HarnessOptions = {}) {
  const artifacts = new Map(
    (options.artifacts ?? []).map((item) => [
      `${item.descriptor.id}@${item.descriptor.version}`,
      item,
    ]),
  )
  const durable = new Map(
    (options.states ?? []).map((item) => [item.moduleId, item]),
  )
  const calls: string[] = []
  const artifactFor = (id: string, version: string): Artifact => {
    const item = artifacts.get(`${id}@${version}`)
    if (!item) throw new Error(`missing test artifact ${id}@${version}`)
    return item
  }
  const artifactStore: ModuleArtifactReadStore = {
    readManifestBytes: async (id, version) => {
      calls.push(`verify:${id}@${version}`)
      if (options.hangVerifier?.has(id)) {
        await new Promise<never>(() => undefined)
      }
      if (options.corrupt?.has(id)) return encode('corrupt')
      return artifactFor(id, version).manifestBytes
    },
    readReadyMarkerBytes: async (id, version, platform) => {
      const item = artifactFor(id, version)
      return encode({
        schemaVersion: 1,
        id,
        version,
        platform,
        manifestSha256: item.descriptor.manifest.sha256,
      })
    },
    readEntryBytes: async (id, version) => artifactFor(id, version).entryBytes,
    listVersionFiles: async (id, version) => {
      const item = artifactFor(id, version)
      return [
        'module.json',
        'entry.js',
        `ready.${item.descriptor.platform}.${item.descriptor.manifest.sha256}.json`,
      ]
    },
  }
  const list = jest.fn(async () => {
    if (options.hangList) await new Promise<never>(() => undefined)
    return [...durable.values()]
  })
  const write = jest.fn(
    async (next: ModuleDeviceState): Promise<ModuleDeviceState> => {
      if (options.write) return options.write(next, durable)
      durable.set(next.moduleId, next)
      return next
    },
  )
  const runExclusive = async <T>(
    moduleId: string,
    operation: (transaction: ModuleDeviceStateTransaction) => Promise<T>,
  ): Promise<T> =>
    operation(
      Object.freeze({
        read: async () => durable.get(moduleId) ?? null,
        write,
        remove: async () => undefined,
      }),
    )
  const load = jest.fn(
    async (entry, bytes: Uint8Array, signal?: AbortSignal) => {
      calls.push(`load:${new TextDecoder().decode(bytes)}`)
      if (options.failLoader?.has(entry.id)) throw new Error('loader exploded')
      if (options.hangLoader?.has(entry.id)) {
        await rejectOnAbort(signal)
      }
      return { id: entry.id, activate: () => undefined }
    },
  )
  const activate = jest.fn(
    async (definition, version: string, signal?: AbortSignal) => {
      calls.push(`activate:${definition.id}@${version}`)
      if (options.failRuntime?.has(`${definition.id}@${version}`)) {
        throw new Error('runtime exploded')
      }
      if (options.hangRuntime?.has(`${definition.id}@${version}`)) {
        await rejectOnAbort(signal)
      }
    },
  )
  const coordinator = new ModuleActivationCoordinator({
    deviceStateStore: { list, runExclusive },
    artifactStore,
    platform: options.platform ?? 'desktop',
    hostApi: options.hostApi ?? '1.1.0',
    supportedDataNamespaces: options.supportedDataNamespaces ?? ['settings'],
    readCurrentSchemaVersion:
      options.readCurrentSchemaVersion ?? (async () => 1),
    loader: { load },
    runtime: { activate },
    activationTimeoutMs: options.activationTimeoutMs,
    startupTimeoutMs: options.startupTimeoutMs,
    ...(options.provideCrypto === false
      ? {}
      : {
          subtleCrypto:
            options.subtleCrypto ??
            (webcrypto.subtle as unknown as Pick<SubtleCrypto, 'digest'>),
        }),
    reportActivationError: options.reportActivationError,
  })
  return { coordinator, durable, calls, list, write, load, activate }
}

function rejectOnAbort(signal?: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'))
      return
    }
    signal?.addEventListener('abort', () => reject(new Error('aborted')), {
      once: true,
    })
  })
}

describe('ModuleActivationCoordinator', () => {
  it('skips downloaded-only state and does not require crypto', async () => {
    const item = artifact('downloaded', '1.0.0')
    const fixture = harness({
      artifacts: [item],
      states: [state('downloaded', [item], { downloadedCandidate: '1.0.0' })],
      subtleCrypto: undefined,
    })

    await expect(
      fixture.coordinator.activatePersistedModules(),
    ).resolves.toEqual([{ moduleId: 'downloaded', status: 'skipped' }])
    expect(fixture.calls).toEqual([])
  })

  it('activates an active version offline from its exact stored descriptor', async () => {
    const active = artifact('learning', '1.0.0')
    const downloaded = artifact('learning', '2.0.0')
    const fixture = harness({
      artifacts: [active, downloaded],
      states: [
        state('learning', [active, downloaded], {
          activeVersion: '1.0.0',
          downloadedCandidate: '2.0.0',
        }),
      ],
    })

    const results = await fixture.coordinator.activatePersistedModules()

    expect(fixture.calls).toEqual([
      'verify:learning@1.0.0',
      'load:learning:1.0.0',
      'activate:learning@1.0.0',
    ])
    expect(fixture.write).not.toHaveBeenCalled()
    expect(results).toEqual([
      { moduleId: 'learning', status: 'activated', version: '1.0.0' },
    ])
    expect(Object.isFrozen(results)).toBe(true)
    expect(Object.isFrozen(results[0])).toBe(true)
  })

  it('does not read undeclared data namespaces', async () => {
    const item = artifact('stateless', '1.0.0', { dataSchemas: {} })
    const readCurrentSchemaVersion = jest.fn(async () => 7)
    const fixture = harness({
      artifacts: [item],
      states: [state('stateless', [item], { activeVersion: '1.0.0' })],
      readCurrentSchemaVersion,
    })

    await expect(
      fixture.coordinator.activatePersistedModules(),
    ).resolves.toMatchObject([{ status: 'activated', version: '1.0.0' }])
    expect(readCurrentSchemaVersion).not.toHaveBeenCalled()
  })

  it('treats a missing declared namespace as schema zero', async () => {
    const item = artifact('new-settings', '1.0.0', {
      dataSchemas: { settings: { readMin: 0, readMax: 1, write: 1 } },
    })
    const fixture = harness({
      artifacts: [item],
      states: [state('new-settings', [item], { activeVersion: '1.0.0' })],
      readCurrentSchemaVersion: async () => null,
    })

    await fixture.coordinator.activatePersistedModules()

    expect(fixture.coordinator.getError('new-settings')).toContain(
      'transition journal',
    )
    expect(fixture.calls).toEqual([])
  })

  it('fails pending closed and restores the previous active version', async () => {
    const old = artifact('learning', '1.0.0')
    const pending = artifact('learning', '2.0.0')
    const fixture = harness({
      artifacts: [old, pending],
      states: [
        state('learning', [old, pending], {
          activeVersion: '1.0.0',
          pendingVersion: '2.0.0',
          downloadedCandidate: '2.0.0',
        }),
      ],
    })

    await fixture.coordinator.activatePersistedModules()

    expect(fixture.durable.get('learning')).toMatchObject({
      activeVersion: '1.0.0',
      pendingVersion: null,
      downloadedCandidate: '2.0.0',
    })
    expect(fixture.calls).not.toContain('activate:learning@2.0.0')
    expect(fixture.coordinator.getError('learning')).toContain(
      'transition journal',
    )
  })

  it.each(['prepared', 'committed', 'rollback-completed'] as const)(
    'fails closed without mutation or code execution for a %s transition journal',
    async (phase) => {
      const old = artifact('learning', '1.0.0')
      const target = artifact('learning', '2.0.0', {
        dataSchemas: { settings: { readMin: 1, readMax: 1, write: 1 } },
      })
      const committed = phase === 'committed'
      const rolledBack = phase === 'rollback-completed'
      const initial = state('learning', [old, target], {
        activeVersion: committed ? '2.0.0' : '1.0.0',
        pendingVersion: committed || rolledBack ? null : '2.0.0',
        downloadedCandidate: rolledBack ? '2.0.0' : null,
        transition: transition(target, phase),
      })
      const fixture = harness({ artifacts: [old, target], states: [initial] })

      const results = await fixture.coordinator.activatePersistedModules()

      expect(results).toEqual([
        {
          moduleId: 'learning',
          status: 'failed',
          error: expect.stringContaining(
            'transition recovery is not implemented',
          ),
        },
      ])
      expect(fixture.durable.get('learning')).toBe(initial)
      expect(fixture.write).not.toHaveBeenCalled()
      expect(fixture.calls).toEqual([])
      expect(fixture.load).not.toHaveBeenCalled()
      expect(fixture.activate).not.toHaveBeenCalled()
    },
  )

  it('isolates verifier, loader, runtime, and reporter failures in module order', async () => {
    const verifier = artifact('a-verifier', '1.0.0')
    const loader = artifact('b-loader', '1.0.0')
    const runtime = artifact('c-runtime', '1.0.0')
    const healthy = artifact('d-healthy', '1.0.0')
    const reporter = jest.fn(() => {
      throw new Error('reporter exploded')
    })
    const fixture = harness({
      artifacts: [verifier, loader, runtime, healthy],
      states: [healthy, runtime, loader, verifier].map((item) =>
        state(item.descriptor.id, [item], { activeVersion: '1.0.0' }),
      ),
      corrupt: new Set(['a-verifier']),
      failLoader: new Set(['b-loader']),
      failRuntime: new Set(['c-runtime@1.0.0']),
      reportActivationError: reporter,
    })

    const results = await fixture.coordinator.activatePersistedModules()

    expect(results.map((item) => [item.moduleId, item.status])).toEqual([
      ['a-verifier', 'failed'],
      ['b-loader', 'failed'],
      ['c-runtime', 'failed'],
      ['d-healthy', 'activated'],
    ])
    expect(fixture.coordinator.getError('a-verifier')).toContain('manifest')
    expect(fixture.coordinator.getError('d-healthy')).toBeUndefined()
    expect(reporter).toHaveBeenCalledTimes(3)
  })

  it('rolls back a failed pending target and independently activates old active', async () => {
    const old = artifact('learning', '1.0.0')
    const pending = artifact('learning', '2.0.0')
    const reporter = jest.fn()
    const fixture = harness({
      artifacts: [old, pending],
      states: [
        state('learning', [old, pending], {
          activeVersion: '1.0.0',
          pendingVersion: '2.0.0',
        }),
      ],
      reportActivationError: reporter,
    })

    const results = await fixture.coordinator.activatePersistedModules()

    expect(results).toEqual([
      {
        moduleId: 'learning',
        status: 'activated',
        version: '1.0.0',
        recoveredVersion: '1.0.0',
        error: expect.stringContaining('transition journal'),
      },
    ])
    expect(fixture.durable.get('learning')).toMatchObject({
      activeVersion: '1.0.0',
      pendingVersion: null,
      downloadedCandidate: '2.0.0',
    })
    expect(fixture.coordinator.getError('learning')).toContain(
      'transition journal',
    )
    expect(reporter).toHaveBeenCalledWith('learning', expect.any(Error))
  })

  it('exposes a combined error when pending and fallback both fail', async () => {
    const old = artifact('learning', '1.0.0')
    const pending = artifact('learning', '2.0.0')
    const fixture = harness({
      artifacts: [old, pending],
      states: [
        state('learning', [old, pending], {
          activeVersion: '1.0.0',
          pendingVersion: '2.0.0',
        }),
      ],
      failRuntime: new Set(['learning@1.0.0']),
    })

    await fixture.coordinator.activatePersistedModules()

    expect(fixture.coordinator.getError('learning')).toContain(
      'pending activation and fallback failed',
    )
  })

  it('accepts an uncertain pending rollback after exact readback', async () => {
    const old = artifact('learning', '1.0.0')
    const pending = artifact('learning', '2.0.0')
    const fixture = harness({
      artifacts: [old, pending],
      states: [
        state('learning', [old, pending], {
          activeVersion: '1.0.0',
          pendingVersion: '2.0.0',
        }),
      ],
      write: async (next, durable) => {
        durable.set(next.moduleId, next)
        throw new Error('uncertain rollback')
      },
    })

    const results = await fixture.coordinator.activatePersistedModules()

    expect(results[0]).toMatchObject({
      status: 'activated',
      recoveredVersion: '1.0.0',
    })
    expect(fixture.coordinator.getError('learning')).toContain(
      'transition journal',
    )
  })

  it.each([
    ['platform', { platform: 'mobile' as const }, {}, 'requires mobile'],
    ['Host API', {}, { hostApi: '2.0.0' }, 'incompatible'],
    [
      'unsupported namespace',
      { dataSchemas: { private: { readMin: 0, readMax: 1, write: 1 } } },
      {},
      'unsupported',
    ],
    [
      'schema read range',
      { dataSchemas: { settings: { readMin: 0, readMax: 1, write: 1 } } },
      { readCurrentSchemaVersion: async () => 2 },
      'incompatible',
    ],
    [
      'schema migration',
      { dataSchemas: { settings: { readMin: 0, readMax: 2, write: 2 } } },
      {},
      'transition journal',
    ],
  ])(
    'rejects incompatible %s before verification',
    async (_, patch, options, error) => {
      const item = artifact('learning', '1.0.0', patch)
      const fixture = harness({
        artifacts: [item],
        states: [state('learning', [item], { activeVersion: '1.0.0' })],
        ...options,
      })

      await fixture.coordinator.activatePersistedModules()

      expect(fixture.coordinator.getError('learning')).toContain(error)
      expect(fixture.calls).toEqual([])
    },
  )

  it('accepts an uncertain pending rollback after exact readback without fallback', async () => {
    const item = artifact('learning', '2.0.0')
    const fixture = harness({
      artifacts: [item],
      states: [
        state('learning', [item], {
          pendingVersion: '2.0.0',
          downloadedCandidate: '2.0.0',
        }),
      ],
      write: async (next, durable) => {
        durable.set(next.moduleId, next)
        throw new Error('uncertain write')
      },
    })

    const results = await fixture.coordinator.activatePersistedModules()

    expect(results[0]?.status).toBe('failed')
    expect(fixture.durable.get('learning')).toMatchObject({
      activeVersion: null,
      pendingVersion: null,
      downloadedCandidate: '2.0.0',
    })
    expect(fixture.coordinator.getError('learning')).toContain(
      'transition journal',
    )
  })

  it('reports a definite pending rollback failure while restoring old runtime', async () => {
    const old = artifact('learning', '1.0.0')
    const pending = artifact('learning', '2.0.0')
    const fixture = harness({
      artifacts: [old, pending],
      states: [
        state('learning', [old, pending], {
          activeVersion: '1.0.0',
          pendingVersion: '2.0.0',
        }),
      ],
      write: async () => {
        throw new Error('definite commit failure')
      },
    })

    await fixture.coordinator.activatePersistedModules()

    expect(fixture.activate.mock.calls.map(([, version]) => version)).toEqual([
      '1.0.0',
    ])
    expect(fixture.coordinator.getError('learning')).toContain(
      'state rollback failed',
    )
  })

  it('rejects uncertain rollback readback with a changed descriptor', async () => {
    const pending = artifact('learning', '2.0.0')
    const fixture = harness({
      artifacts: [pending],
      states: [
        state('learning', [pending], {
          pendingVersion: '2.0.0',
          downloadedCandidate: '2.0.0',
        }),
      ],
      write: async (next, durable) => {
        durable.set(next.moduleId, {
          ...next,
          readyVersions: {
            ...next.readyVersions,
            '2.0.0': {
              ...pending.descriptor,
              manifest: {
                ...pending.descriptor.manifest,
                sha256: 'f'.repeat(64),
              },
            },
          },
        })
        throw new Error('uncertain divergent write')
      },
    })

    await fixture.coordinator.activatePersistedModules()

    expect(fixture.coordinator.getError('learning')).toContain(
      'state rollback failed',
    )
  })

  it('times out a hanging module without blocking healthy modules', async () => {
    const hanging = artifact('a-hanging', '1.0.0')
    const healthy = artifact('b-healthy', '1.0.0')
    const fixture = harness({
      artifacts: [hanging, healthy],
      states: [
        state('a-hanging', [hanging], { activeVersion: '1.0.0' }),
        state('b-healthy', [healthy], { activeVersion: '1.0.0' }),
      ],
      hangRuntime: new Set(['a-hanging@1.0.0']),
      activationTimeoutMs: 5,
    })

    const results = await fixture.coordinator.activatePersistedModules()

    expect(results.map(({ moduleId, status }) => [moduleId, status])).toEqual([
      ['a-hanging', 'failed'],
      ['b-healthy', 'activated'],
    ])
    expect(fixture.coordinator.getError('a-hanging')).toContain('timed out')
  })

  it.each([
    ['state enumeration', { hangList: true }],
    ['artifact verification', { hangVerifier: new Set(['learning']) }],
  ])('bounds hanging %s during startup', async (_, options) => {
    const item = artifact('learning', '1.0.0')
    const fixture = harness({
      artifacts: [item],
      states: [state('learning', [item], { activeVersion: '1.0.0' })],
      activationTimeoutMs: 5,
      startupTimeoutMs: 5,
      ...options,
    })

    await expect(
      fixture.coordinator.activatePersistedModules(),
    ).rejects.toThrow('timed out')
    expect(fixture.activate).not.toHaveBeenCalled()
  })

  it('aborts a pending loader when disposed', async () => {
    const item = artifact('learning', '1.0.0')
    const fixture = harness({
      artifacts: [item],
      states: [state('learning', [item], { activeVersion: '1.0.0' })],
      hangLoader: new Set(['learning']),
    })
    const activation = fixture.coordinator.activatePersistedModules()
    for (
      let attempt = 0;
      attempt < 20 && fixture.load.mock.calls.length === 0;
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    expect(fixture.load).toHaveBeenCalledTimes(1)

    fixture.coordinator.dispose()

    await expect(activation).rejects.toThrow('aborted')
    expect(fixture.activate).not.toHaveBeenCalled()
  })

  it('rereads transactional state and snapshots mutable compatibility input', async () => {
    const downloaded = artifact('learning', '2.0.0')
    const active = artifact('learning', '1.0.0')
    const supported = ['settings']
    const listed = state('learning', [downloaded], {
      downloadedCandidate: '2.0.0',
    })
    const current = state('learning', [active], { activeVersion: '1.0.0' })
    const fixture = harness({
      artifacts: [active, downloaded],
      states: [listed],
      supportedDataNamespaces: supported,
    })
    fixture.durable.set('learning', current)
    supported.splice(0)

    await fixture.coordinator.activatePersistedModules()

    expect(fixture.calls).toContain('activate:learning@1.0.0')
    expect(fixture.calls).not.toContain('activate:learning@2.0.0')
  })

  it('guards disposal and allows an empty startup without Web Crypto', async () => {
    const cryptoDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      'crypto',
    )
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: undefined,
    })
    try {
      const empty = harness({ states: [], artifacts: [], provideCrypto: false })
      await expect(
        empty.coordinator.activatePersistedModules(),
      ).resolves.toEqual([])
    } finally {
      if (cryptoDescriptor) {
        Object.defineProperty(globalThis, 'crypto', cryptoDescriptor)
      } else {
        delete (globalThis as { crypto?: Crypto }).crypto
      }
    }

    const disposed = harness()
    disposed.coordinator.dispose()
    await expect(
      disposed.coordinator.activatePersistedModules(),
    ).rejects.toThrow('disposed')
  })
})
