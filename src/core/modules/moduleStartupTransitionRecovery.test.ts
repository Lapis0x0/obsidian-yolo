import type { ModuleArtifactDescriptor } from './moduleArtifactVerifier'
import type { ModuleDeviceState } from './moduleDeviceStateStore'
import { ModuleStartupTransitionRecovery } from './moduleStartupTransitionRecovery'

const HASH = 'a'.repeat(64)

function descriptor(version: string, readMin = 1): ModuleArtifactDescriptor {
  return {
    id: 'learning',
    version,
    hostApi: '^1.0.0',
    platform: 'desktop',
    dataSchemas: { settings: { readMin, readMax: 2, write: 2 } },
    manifestUrl: `https://github.com/Lapis0x0/obsidian-yolo/releases/download/learning-v${version}/module.json`,
    manifest: { byteSize: 1, sha256: HASH },
  }
}

function state(
  phase: ModuleDeviceState['activationPhase'],
  previous = descriptor('1.0.0'),
): ModuleDeviceState {
  return {
    moduleId: 'learning',
    platform: 'desktop',
    activeVersion: '1.0.0',
    pendingVersion: phase === null ? null : '2.0.0',
    activationPhase: phase,
    readyVersions: { '1.0.0': previous, '2.0.0': descriptor('2.0.0') },
  }
}

function harness(initial: ModuleDeviceState, activateError?: Error) {
  let durable = initial
  let schema = 1
  const writes: ModuleDeviceState[] = []
  const activations: string[] = []
  const recovery =
    new ModuleStartupTransitionRecovery<ModuleArtifactDescriptor>({
      realmToken: {},
      deviceStateStore: {
        runExclusive: async (_moduleId, operation) =>
          operation({
            read: async () => durable,
            write: async (next) => {
              durable = next
              writes.push(next)
              return next
            },
            remove: async () => undefined,
          }),
      },
      readCurrentSchemaVersion: async () => schema,
      verifyArtifact: async (value) => value,
      activateVerifiedArtifact: async (_verified, value) => {
        activations.push(value.version)
        if (value.version === '2.0.0' && activateError) throw activateError
        if (value.version === '2.0.0') schema = 2
      },
    })
  return {
    recovery,
    writes,
    activations,
    durable: () => durable,
    setSchema: (v: number) => {
      schema = v
    },
  }
}

describe('ModuleStartupTransitionRecovery', () => {
  test('durably fences target execution and commits only after schema postcheck', async () => {
    const test = harness(state('pending'))
    await expect(
      test.recovery.recover('learning', new AbortController().signal),
    ).resolves.toMatchObject({ status: 'activated', version: '2.0.0' })
    expect(test.writes.map((value) => value.activationPhase)).toEqual([
      'activation-started',
      null,
    ])
    expect(test.activations).toEqual(['2.0.0'])
    expect(test.durable()).toMatchObject({
      activeVersion: '2.0.0',
      pendingVersion: null,
      activationPhase: null,
    })
  })

  test('poisons the realm after target failure and leaves fallback for reload', async () => {
    const test = harness(state('pending'), new Error('boom'))
    await expect(
      test.recovery.recover('learning', new AbortController().signal),
    ).resolves.toMatchObject({
      status: 'failed',
      processPoisoned: true,
      reloadRequired: true,
    })
    expect(test.activations).toEqual(['2.0.0'])
    expect(test.durable()).toMatchObject({
      activeVersion: '1.0.0',
      pendingVersion: null,
      activationPhase: null,
    })
  })

  test('never retries an interrupted target and restores a compatible previous version', async () => {
    const test = harness(state('activation-started'))
    await expect(
      test.recovery.recover('learning', new AbortController().signal),
    ).resolves.toMatchObject({
      status: 'activated',
      version: '1.0.0',
      recoveredVersion: '1.0.0',
    })
    expect(test.activations).toEqual(['1.0.0'])
    expect(test.durable().activationPhase).toBeNull()
  })

  test('keeps an interrupted activation blocked when previous schema is incompatible', async () => {
    const test = harness(state('activation-started', descriptor('1.0.0', 1)))
    test.setSchema(3)
    await expect(
      test.recovery.recover('learning', new AbortController().signal),
    ).resolves.toMatchObject({ status: 'failed', processPoisoned: false })
    expect(test.activations).toEqual([])
    expect(test.durable().activationPhase).toBe('activation-started')
  })

  test('cancels an unstarted pending activation when intent is not live', async () => {
    const test = harness(state('pending'))
    await expect(
      test.recovery.recover('learning', new AbortController().signal, false),
    ).resolves.toMatchObject({ status: 'skipped' })
    expect(test.activations).toEqual([])
    expect(test.durable().activationPhase).toBeNull()
  })
})
