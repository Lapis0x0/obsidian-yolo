import type { ModuleArtifactDescriptor } from './moduleArtifactVerifier'
import type {
  ModuleDeviceState,
  ModuleDeviceStateTransaction,
} from './moduleDeviceStateStore'
import {
  ModuleUninstallCoordinator,
  type ModuleUninstallCoordinatorOptions,
} from './moduleUninstallCoordinator'

const HASH = 'a'.repeat(64)

function descriptor(
  id: string,
  version: string,
  platform: 'desktop' | 'mobile' = 'desktop',
): ModuleArtifactDescriptor {
  return {
    id,
    version,
    hostApi: '^1.0.0',
    dataSchemas: {},
    platform,
    manifestUrl: `https://github.com/Lapis0x0/obsidian-yolo/releases/download/${id}-v${version}/module.json`,
    manifest: { byteSize: 42, sha256: HASH },
  }
}

function state(
  id = 'learning',
  versions: readonly string[] = ['1.0.0'],
  patch: Partial<ModuleDeviceState> = {},
): ModuleDeviceState {
  return {
    moduleId: id,
    platform: 'desktop',
    activeVersion: versions[0] ?? null,
    downloadedCandidate: versions[1] ?? null,
    pendingVersion: null,
    readyVersions: Object.fromEntries(
      versions.map((version) => [version, descriptor(id, version)]),
    ),
    transition: null,
    ...patch,
  }
}

function transition(): NonNullable<ModuleDeviceState['transition']> {
  return {
    phase: 'prepared',
    moduleId: 'learning',
    platform: 'desktop',
    previousActiveVersion: '1.0.0',
    targetVersion: '2.0.0',
    targetManifestSha256: HASH,
    settings: null,
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

type FixtureOptions = Readonly<{
  states?: readonly ModuleDeviceState[]
  active?: readonly string[]
  activationPending?: ReadonlySet<string>
  authorizeArtifactRemoval?: (
    moduleId: string,
    versions: readonly string[],
  ) => Promise<boolean>
  removeArtifact?: (moduleId: string, version: string) => Promise<void>
  removeState?: (
    moduleId: string,
    states: Map<string, ModuleDeviceState>,
  ) => Promise<void>
}>

function fixture(options: FixtureOptions = {}) {
  const states = new Map(
    (options.states ?? [state()]).map((value) => [value.moduleId, value]),
  )
  const artifacts = new Map<string, Set<string>>()
  for (const current of states.values()) {
    artifacts.set(current.moduleId, new Set(Object.keys(current.readyVersions)))
  }
  const events: string[] = []
  const queues = new Map<string, Promise<void>>()
  const reservationQueues = new Map<string, Promise<void>>()
  const reserved = new Set<string>()
  const activationWaiters = new Map<string, Set<() => void>>()
  const read = jest.fn(async (moduleId: string) => {
    events.push(`read:${moduleId}`)
    return states.get(moduleId) ?? null
  })
  const removeState = jest.fn(async (moduleId: string) => {
    events.push(`state:${moduleId}`)
    if (options.removeState) await options.removeState(moduleId, states)
    else states.delete(moduleId)
  })
  const runExclusive: ModuleUninstallCoordinatorOptions['deviceStateStore']['runExclusive'] =
    async (moduleId, operation) => {
      const previous = queues.get(moduleId) ?? Promise.resolve()
      const transaction: ModuleDeviceStateTransaction = Object.freeze({
        read: () => read(moduleId),
        write: async (value) => value,
        remove: () => removeState(moduleId),
      })
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
  const removeVersionArtifacts = jest.fn(
    async (moduleId: string, version: string) => {
      events.push(`artifact:${moduleId}:${version}`)
      if (options.removeArtifact) {
        await options.removeArtifact(moduleId, version)
      }
      artifacts.get(moduleId)?.delete(version)
    },
  )
  const active = new Set(options.active ?? [])
  const runWithModuleQuiesced: ModuleUninstallCoordinatorOptions['runtime']['runWithModuleQuiesced'] =
    async (moduleId, operation) => {
      const previous = reservationQueues.get(moduleId) ?? Promise.resolve()
      const result = previous
        .catch(() => undefined)
        .then(async () => {
          if (active.has(moduleId)) {
            throw new Error(
              `Module "${moduleId}" is active and cannot be quiesced`,
            )
          }
          if (options.activationPending?.has(moduleId)) {
            throw new Error(
              `Module "${moduleId}" activation is pending and cannot be quiesced`,
            )
          }
          reserved.add(moduleId)
          try {
            return await operation()
          } finally {
            reserved.delete(moduleId)
            const waiters = activationWaiters.get(moduleId)
            activationWaiters.delete(moduleId)
            for (const release of waiters ?? []) release()
          }
        })
      const tail = result.then(
        () => undefined,
        () => undefined,
      )
      reservationQueues.set(moduleId, tail)
      void tail.then(() => {
        if (reservationQueues.get(moduleId) === tail) {
          reservationQueues.delete(moduleId)
        }
      })
      return result
    }
  const runtime: ModuleUninstallCoordinatorOptions['runtime'] = {
    runWithModuleQuiesced,
  }
  const attemptActivation = async <T>(
    moduleId: string,
    operation: () => T | Promise<T>,
  ): Promise<T> => {
    if (reserved.has(moduleId)) {
      await new Promise<void>((resolve) => {
        let waiters = activationWaiters.get(moduleId)
        if (!waiters) {
          waiters = new Set()
          activationWaiters.set(moduleId, waiters)
        }
        waiters.add(resolve)
      })
    }
    return operation()
  }
  const authorizeArtifactRemoval = jest.fn(
    options.authorizeArtifactRemoval ?? (async () => true),
  )
  const coordinator = new ModuleUninstallCoordinator({
    artifactStore: { removeVersionArtifacts },
    deviceStateStore: { runExclusive },
    runtime,
    authorizeArtifactRemoval,
    platform: 'desktop',
  })
  return {
    coordinator,
    states,
    artifacts,
    events,
    read,
    removeState,
    removeVersionArtifacts,
    runtime,
    reserved,
    attemptActivation,
    authorizeArtifactRemoval,
  }
}

describe('ModuleUninstallCoordinator', () => {
  it('removes an inactive installed module artifacts before device state', async () => {
    const value = fixture()

    await value.coordinator.uninstall('learning')

    expect(value.events).toEqual([
      'read:learning',
      'artifact:learning:1.0.0',
      'state:learning',
    ])
    expect(value.artifacts.get('learning')).toEqual(new Set())
    expect(value.states.has('learning')).toBe(false)
  })

  it('removes a first-install candidate without consulting a catalog', async () => {
    const candidate = state('learning', ['2.0.0'], {
      activeVersion: null,
      downloadedCandidate: '2.0.0',
    })
    const value = fixture({ states: [candidate] })

    await expect(
      value.coordinator.uninstall('learning'),
    ).resolves.toBeUndefined()
    expect(value.removeVersionArtifacts).toHaveBeenCalledWith(
      'learning',
      '2.0.0',
    )
  })

  it('rejects a runtime-active module before artifact mutation', async () => {
    const value = fixture({ active: ['learning'] })

    await expect(value.coordinator.uninstall('learning')).rejects.toThrow(
      'is active',
    )
    expect(value.removeVersionArtifacts).not.toHaveBeenCalled()
    expect(value.removeState).not.toHaveBeenCalled()
    expect(value.read).not.toHaveBeenCalled()
  })

  it('rejects runtime-pending activation before artifact mutation', async () => {
    const pending = new Set(['learning'])
    const value = fixture({ activationPending: pending })

    await expect(value.coordinator.uninstall('learning')).rejects.toThrow(
      'activation is pending',
    )
    expect(value.authorizeArtifactRemoval).not.toHaveBeenCalled()
    expect(value.removeVersionArtifacts).not.toHaveBeenCalled()
    expect(value.removeState).not.toHaveBeenCalled()
    expect(value.read).not.toHaveBeenCalled()
  })

  it('blocks activation after artifact deletion until uninstall settles', async () => {
    const stateRemovalEntered = deferred<undefined>()
    const releaseStateRemoval = deferred<undefined>()
    const value = fixture({
      removeState: async (moduleId, states) => {
        stateRemovalEntered.resolve(undefined)
        await releaseStateRemoval.promise
        states.delete(moduleId)
      },
    })
    const uninstall = value.coordinator.uninstall('learning')
    await stateRemovalEntered.promise
    const activationEntered = jest.fn()
    const activation = value.attemptActivation('learning', activationEntered)

    await Promise.resolve()
    expect(activationEntered).not.toHaveBeenCalled()
    expect(value.removeVersionArtifacts).toHaveBeenCalledTimes(1)
    expect(value.states.has('learning')).toBe(true)
    releaseStateRemoval.resolve(undefined)
    await uninstall
    await activation
    expect(activationEntered).toHaveBeenCalledTimes(1)
  })

  it('requires explicit product-policy authorization before mutation', async () => {
    const value = fixture({
      states: [state('learning', ['2.0.0', '1.0.0'])],
      authorizeArtifactRemoval: async () => false,
    })

    await expect(value.coordinator.uninstall('learning')).rejects.toThrow(
      'not authorized by product policy',
    )
    expect(value.authorizeArtifactRemoval).toHaveBeenCalledWith('learning', [
      '1.0.0',
      '2.0.0',
    ])
    expect(value.removeVersionArtifacts).not.toHaveBeenCalled()
    expect(value.removeState).not.toHaveBeenCalled()
  })

  it.each([
    ['transition', { transition: transition() }],
    ['pending version', { pendingVersion: '1.0.0' }],
  ])('rejects state with an unresolved %s', async (_label, patch) => {
    const value = fixture({ states: [state('learning', ['1.0.0'], patch)] })

    await expect(value.coordinator.uninstall('learning')).rejects.toThrow()
    expect(value.removeVersionArtifacts).not.toHaveBeenCalled()
    expect(value.removeState).not.toHaveBeenCalled()
  })

  it('rejects platform mismatch before artifact mutation', async () => {
    const mobile = state('learning', ['1.0.0'], {
      platform: 'mobile',
      readyVersions: { '1.0.0': descriptor('learning', '1.0.0', 'mobile') },
    })
    const value = fixture({ states: [mobile] })

    await expect(value.coordinator.uninstall('learning')).rejects.toThrow(
      'belongs to mobile',
    )
    expect(value.removeVersionArtifacts).not.toHaveBeenCalled()
  })

  it('removes active, downloaded, and every additional ready version', async () => {
    const value = fixture({
      states: [state('learning', ['1.0.0', '2.0.0', '1.5.0'])],
    })

    await value.coordinator.uninstall('learning')

    expect(value.removeVersionArtifacts.mock.calls).toEqual([
      ['learning', '1.0.0'],
      ['learning', '1.5.0'],
      ['learning', '2.0.0'],
    ])
  })

  it('retries after some artifact roots were already absent', async () => {
    const value = fixture({
      states: [state('learning', ['1.0.0', '2.0.0'])],
    })
    value.artifacts.get('learning')?.delete('1.0.0')

    await expect(
      value.coordinator.uninstall('learning'),
    ).resolves.toBeUndefined()
    expect(value.states.has('learning')).toBe(false)
  })

  it('leaves device state when an artifact removal fails', async () => {
    const value = fixture({
      removeArtifact: async () => {
        throw new Error('artifact removal failed')
      },
    })

    await expect(value.coordinator.uninstall('learning')).rejects.toThrow(
      'artifact removal failed',
    )
    expect(value.states.has('learning')).toBe(true)
    expect(value.removeState).not.toHaveBeenCalled()
  })

  it('leaves artifacts gone after state removal failure and succeeds on retry', async () => {
    let fail = true
    const value = fixture({
      removeState: async (moduleId, states) => {
        if (fail) {
          fail = false
          throw new Error('state removal failed')
        }
        states.delete(moduleId)
      },
    })

    await expect(value.coordinator.uninstall('learning')).rejects.toThrow(
      'state removal failed',
    )
    expect(value.artifacts.get('learning')).toEqual(new Set())
    expect(value.states.has('learning')).toBe(true)
    await expect(
      value.coordinator.uninstall('learning'),
    ).resolves.toBeUndefined()
    expect(value.states.has('learning')).toBe(false)
  })

  it('accepts state removal that committed before reporting failure', async () => {
    const value = fixture({
      removeState: async (moduleId, states) => {
        states.delete(moduleId)
        throw new Error('uncertain state removal')
      },
    })

    await expect(
      value.coordinator.uninstall('learning'),
    ).resolves.toBeUndefined()
  })

  it.each([
    {
      label: 'state validation',
      create: () =>
        fixture({
          states: [
            state('learning', ['1.0.0'], {
              platform: 'mobile',
              readyVersions: {
                '1.0.0': descriptor('learning', '1.0.0', 'mobile'),
              },
            }),
          ],
        }),
    },
    {
      label: 'policy authorization',
      create: () => fixture({ authorizeArtifactRemoval: async () => false }),
    },
    {
      label: 'artifact removal',
      create: () =>
        fixture({
          removeArtifact: async () => {
            throw new Error('artifact removal failed')
          },
        }),
    },
    {
      label: 'state removal',
      create: () =>
        fixture({
          removeState: async () => {
            throw new Error('state removal failed')
          },
        }),
    },
  ])(
    'releases the runtime reservation after $label failure',
    async ({ create }) => {
      const value = create()
      await expect(value.coordinator.uninstall('learning')).rejects.toThrow()
      expect(value.reserved.has('learning')).toBe(false)

      const activationEntered = jest.fn(() => 'entered')
      await expect(
        value.attemptActivation('learning', activationEntered),
      ).resolves.toBe('entered')
      expect(activationEntered).toHaveBeenCalledTimes(1)
    },
  )

  it('has no data, config, private storage, intent, or catalog dependency', async () => {
    const value = fixture()
    const options = Object.keys(
      (
        value.coordinator as unknown as {
          options: Record<string, unknown>
        }
      ).options,
    ).sort()

    expect(options).toEqual([
      'artifactStore',
      'authorizeArtifactRemoval',
      'deviceStateStore',
      'platform',
      'runtime',
    ])
    await expect(
      value.coordinator.uninstall('learning'),
    ).resolves.toBeUndefined()
  })

  it('serializes concurrent uninstall calls for the same module', async () => {
    const entered = deferred<undefined>()
    const release = deferred<undefined>()
    let calls = 0
    const value = fixture({
      removeArtifact: async () => {
        calls += 1
        if (calls === 1) {
          entered.resolve(undefined)
          await release.promise
        }
      },
    })

    const first = value.coordinator.uninstall('learning')
    await entered.promise
    const second = value.coordinator.uninstall('learning')
    await Promise.resolve()
    expect(value.read).toHaveBeenCalledTimes(1)
    release.resolve(undefined)
    await expect(Promise.all([first, second])).resolves.toEqual([
      undefined,
      undefined,
    ])
    expect(value.read).toHaveBeenCalledTimes(2)
    expect(value.removeState).toHaveBeenCalledTimes(1)
  })

  it('does not block a different module on artifact removal', async () => {
    const entered = deferred<undefined>()
    const release = deferred<undefined>()
    const value = fixture({
      states: [state('learning'), state('notes')],
      removeArtifact: async (moduleId) => {
        if (moduleId === 'learning') {
          entered.resolve(undefined)
          await release.promise
        }
      },
    })

    const learning = value.coordinator.uninstall('learning')
    await entered.promise
    await expect(value.coordinator.uninstall('notes')).resolves.toBeUndefined()
    expect(value.states.has('notes')).toBe(false)
    expect(value.states.has('learning')).toBe(true)
    release.resolve(undefined)
    await learning
  })

  it.each(['../learning', 'Learning', 'learning/other', 'CON'])(
    'rejects malformed module id %s without entering state storage',
    async (moduleId) => {
      const value = fixture()
      await expect(value.coordinator.uninstall(moduleId)).rejects.toThrow()
      expect(value.read).not.toHaveBeenCalled()
    },
  )

  it('prevalidates malformed and aliased versions before deleting anything', async () => {
    const malformed = state('learning', [], {
      readyVersions: {
        '../1.0.0': descriptor('learning', '../1.0.0'),
      },
    })
    const malformedFixture = fixture({ states: [malformed] })
    await expect(
      malformedFixture.coordinator.uninstall('learning'),
    ).rejects.toThrow('path segment')
    expect(malformedFixture.removeVersionArtifacts).not.toHaveBeenCalled()

    const aliased = state('learning', ['1.0.0-A', '1.0.0-a'])
    const aliasFixture = fixture({ states: [aliased] })
    await expect(
      aliasFixture.coordinator.uninstall('learning'),
    ).rejects.toThrow('path alias')
    expect(aliasFixture.removeVersionArtifacts).not.toHaveBeenCalled()
  })
})
