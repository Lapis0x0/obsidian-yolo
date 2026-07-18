// eslint-disable-next-line import/no-nodejs-modules -- recovery integrity tests require Node's real Web Crypto implementation
import { webcrypto } from 'node:crypto'

import type { ModuleArtifactDescriptor } from './moduleArtifactVerifier'
import type {
  ModuleDeviceState,
  ModuleDeviceStateTransaction,
} from './moduleDeviceStateStore'
import {
  ModuleStartupTransitionRecovery,
  type ModuleStartupTransitionRecoveryOptions,
} from './moduleStartupTransitionRecovery'
import {
  type ModuleTransitionPhase,
  type ModuleTransitionSettingsSnapshot,
  hashModuleTransitionSettingsSnapshot,
  parseModuleTransitionJournal,
} from './moduleTransitionJournal'

const subtleCrypto = webcrypto.subtle as unknown as Pick<SubtleCrypto, 'digest'>
const MODULE_ID = 'learning'
const PREVIOUS_VERSION = '1.0.0'
const TARGET_VERSION = '2.0.0'
const LOCATION = Object.freeze({
  moduleId: MODULE_ID,
  storageRoot: 'YOLO/.yolo_json_db/module-settings',
  storagePath: 'YOLO/.yolo_json_db/module-settings/learning.json',
})
const SETTINGS_SNAPSHOT: ModuleTransitionSettingsSnapshot = Object.freeze({
  present: true,
  envelope: Object.freeze({
    schemaVersion: 1,
    data: Object.freeze({ enabled: true }),
  }),
})

function descriptor(
  version: string,
  stateful: boolean,
): ModuleArtifactDescriptor {
  const dataSchemas: ModuleArtifactDescriptor['dataSchemas'] = stateful
    ? { settings: Object.freeze({ readMin: 1, readMax: 1, write: 1 }) }
    : {}
  return Object.freeze({
    id: MODULE_ID,
    version,
    hostApi: '^1.0.0',
    dataSchemas: Object.freeze(dataSchemas),
    platform: 'desktop',
    manifestUrl: `https://github.com/Lapis0x0/obsidian-yolo/releases/download/learning-v${version}/module.json`,
    manifest: Object.freeze({
      byteSize: 100,
      sha256: version === TARGET_VERSION ? 'b'.repeat(64) : 'a'.repeat(64),
    }),
  })
}

async function transitioningState(
  phase: ModuleTransitionPhase,
  options: Readonly<{
    stateful?: boolean
    previousVersion?: string | null
    previousSha256?: string
    expectedPostSha256?: string
  }> = {},
): Promise<ModuleDeviceState> {
  const stateful = options.stateful ?? false
  const previousVersion =
    options.previousVersion === undefined
      ? PREVIOUS_VERSION
      : options.previousVersion
  const previous = descriptor(PREVIOUS_VERSION, stateful)
  const target = descriptor(TARGET_VERSION, stateful)
  const snapshotHash = await hashModuleTransitionSettingsSnapshot(
    SETTINGS_SNAPSHOT,
    subtleCrypto,
  )
  const committed = phase === 'committed'
  const rolledBack = phase === 'rollback-completed'
  const activeVersion = committed ? TARGET_VERSION : previousVersion
  const downloadedCandidate = rolledBack ? TARGET_VERSION : null
  const pendingVersion = committed || rolledBack ? null : TARGET_VERSION
  const readyVersions = Object.freeze({
    ...(previousVersion === null ? {} : { [PREVIOUS_VERSION]: previous }),
    [TARGET_VERSION]: target,
  })
  const journal = parseModuleTransitionJournal(
    {
      phase,
      moduleId: MODULE_ID,
      platform: 'desktop',
      previousActiveVersion: previousVersion,
      targetVersion: TARGET_VERSION,
      targetManifestSha256: target.manifest.sha256,
      settings: stateful
        ? {
            namespace: 'settings',
            location: LOCATION,
            sourceSchemaVersion: 1,
            targetSchemaVersion: 1,
            previous: SETTINGS_SNAPSHOT,
            previousSha256: options.previousSha256 ?? snapshotHash,
            expectedPostSha256: options.expectedPostSha256 ?? snapshotHash,
          }
        : null,
    },
    {
      moduleId: MODULE_ID,
      platform: 'desktop',
      activeVersion,
      downloadedCandidate,
      pendingVersion,
      readyVersions: Object.keys(readyVersions),
      targetDescriptor: target,
    },
  )
  return Object.freeze({
    moduleId: MODULE_ID,
    platform: 'desktop',
    activeVersion,
    downloadedCandidate,
    pendingVersion,
    readyVersions,
    transition: journal,
  })
}

type Verified = Readonly<{ version: string }>
type WriteOverride = (
  next: ModuleDeviceState,
  setDurable: (state: ModuleDeviceState) => void,
) => Promise<ModuleDeviceState>

function harness(
  initial: ModuleDeviceState,
  options: Readonly<{
    settingsSnapshot?: ModuleTransitionSettingsSnapshot
    withSettingsBackend?: boolean
    verifyError?: string
    activationError?: string
    activation?: (
      verified: Verified,
      descriptor: ModuleArtifactDescriptor,
      signal?: AbortSignal,
    ) => Promise<void>
    write?: WriteOverride
  }> = {},
) {
  let durable = initial
  const events: string[] = []
  const writes: (ModuleTransitionPhase | null)[] = []
  const readAtCapturedLocation = jest.fn(async () => {
    events.push('settings-read')
    return options.settingsSnapshot ?? SETTINGS_SNAPSHOT
  })
  const verifyArtifact = jest.fn(async (item: ModuleArtifactDescriptor) => {
    events.push(`verify:${item.version}`)
    if (options.verifyError) throw new Error(options.verifyError)
    return Object.freeze({ version: item.version })
  })
  const activateVerifiedArtifact = jest.fn(
    async (
      _verified: Verified,
      item: ModuleArtifactDescriptor,
      signal?: AbortSignal,
    ) => {
      events.push(`activate:${item.version}`)
      if (options.activationError) throw new Error(options.activationError)
      if (options.activation) {
        await options.activation(_verified, item, signal)
      }
    },
  )
  const write = jest.fn(async (next: ModuleDeviceState) => {
    writes.push(next.transition?.phase ?? null)
    events.push(`write:${next.transition?.phase ?? 'clean'}`)
    if (options.write) {
      return options.write(next, (state) => {
        durable = state
      })
    }
    durable = next
    return next
  })
  const runExclusive = async <T>(
    moduleId: string,
    operation: (transaction: ModuleDeviceStateTransaction) => Promise<T>,
  ): Promise<T> => {
    expect(moduleId).toBe(MODULE_ID)
    return operation(
      Object.freeze({
        read: async () => durable,
        write,
        remove: async () => undefined,
      }),
    )
  }
  const recoveryOptions: ModuleStartupTransitionRecoveryOptions<Verified> = {
    deviceStateStore: { runExclusive },
    subtleCrypto,
    verifyArtifact,
    activateVerifiedArtifact,
    realmToken: {},
    ...(options.withSettingsBackend === false
      ? {}
      : { settingsBackend: { readAtCapturedLocation } }),
  }
  const recovery = new ModuleStartupTransitionRecovery(recoveryOptions)
  return {
    recovery,
    events,
    writes,
    write,
    verifyArtifact,
    activateVerifiedArtifact,
    readAtCapturedLocation,
    recoveryOptions,
    setDurable: (state: ModuleDeviceState) => {
      durable = state
    },
    durable: () => durable,
  }
}

describe('ModuleStartupTransitionRecovery', () => {
  it.each([
    {
      phase: 'prepared',
      activated: TARGET_VERSION,
      writes: ['settings-committed', 'activation-started', 'committed', null],
    },
    {
      phase: 'settings-committed',
      activated: TARGET_VERSION,
      writes: ['activation-started', 'committed', null],
    },
    {
      phase: 'activation-started',
      activated: PREVIOUS_VERSION,
      writes: ['rollback-completed', null],
    },
    { phase: 'committed', activated: TARGET_VERSION, writes: [null] },
    {
      phase: 'rollback-completed',
      activated: PREVIOUS_VERSION,
      writes: [null],
    },
  ] as const)(
    'recovers a stateless $phase journal',
    async ({ phase, activated, writes }) => {
      const test = harness(await transitioningState(phase))

      const recovered = await test.recovery.recover(
        MODULE_ID,
        new AbortController().signal,
      )

      expect(recovered).toMatchObject({
        status: 'activated',
        version: activated,
        reloadRequired: false,
        processPoisoned: false,
      })
      expect(test.writes).toEqual(writes)
      expect(test.events).toContain(`activate:${activated}`)
      expect(test.events).not.toContain(
        `activate:${activated === TARGET_VERSION ? PREVIOUS_VERSION : TARGET_VERSION}`,
      )
      expect(test.durable().transition).toBeNull()
    },
  )

  it('checks the full stateful snapshot at only the captured location', async () => {
    const test = harness(
      await transitioningState('prepared', { stateful: true }),
    )

    await expect(
      test.recovery.recover(MODULE_ID, new AbortController().signal),
    ).resolves.toMatchObject({ status: 'activated', version: TARGET_VERSION })

    expect(test.readAtCapturedLocation).toHaveBeenCalledTimes(2)
    expect(test.readAtCapturedLocation).toHaveBeenNthCalledWith(1, LOCATION)
    expect(test.readAtCapturedLocation).toHaveBeenNthCalledWith(2, LOCATION)
    expect(test.events.slice(0, 3)).toEqual([
      `verify:${TARGET_VERSION}`,
      'settings-read',
      'write:settings-committed',
    ])
  })

  it('fails a bad journal snapshot hash before settings, state, or code actions', async () => {
    const test = harness(
      await transitioningState('prepared', {
        stateful: true,
        previousSha256: 'c'.repeat(64),
        expectedPostSha256: 'c'.repeat(64),
      }),
    )

    const recovered = await test.recovery.recover(
      MODULE_ID,
      new AbortController().signal,
    )

    expect(recovered).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('previous settings SHA-256 mismatch'),
      processPoisoned: false,
    })
    expect(test.events).toEqual([])
  })

  it('fails closed when current settings conflict with the journal', async () => {
    const conflicting: ModuleTransitionSettingsSnapshot = Object.freeze({
      present: true,
      envelope: Object.freeze({
        schemaVersion: 1,
        data: Object.freeze({ enabled: false }),
      }),
    })
    const test = harness(
      await transitioningState('prepared', { stateful: true }),
      { settingsSnapshot: conflicting },
    )

    const recovered = await test.recovery.recover(
      MODULE_ID,
      new AbortController().signal,
    )

    expect(recovered).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('current settings SHA-256 mismatch'),
      processPoisoned: false,
    })
    expect(test.writes).toEqual([])
    expect(test.activateVerifiedArtifact).not.toHaveBeenCalled()
  })

  it('requires a settings backend for stateful recovery', async () => {
    const test = harness(
      await transitioningState('prepared', { stateful: true }),
      { withSettingsBackend: false },
    )

    await expect(
      test.recovery.recover(MODULE_ID, new AbortController().signal),
    ).resolves.toMatchObject({
      status: 'failed',
      error: 'Transition settings backend is unavailable',
      processPoisoned: false,
    })
    expect(test.writes).toEqual([])
  })

  it('verifies the target before any phase write and leaves prepared on failure', async () => {
    const test = harness(await transitioningState('prepared'), {
      verifyError: 'artifact corrupt',
    })

    const recovered = await test.recovery.recover(
      MODULE_ID,
      new AbortController().signal,
    )

    expect(recovered).toMatchObject({
      status: 'failed',
      error: 'artifact corrupt',
      processPoisoned: false,
    })
    expect(test.events).toEqual([`verify:${TARGET_VERSION}`])
    expect(test.durable().transition?.phase).toBe('prepared')
  })

  it('never verifies or executes target code from activation-started', async () => {
    const test = harness(await transitioningState('activation-started'))

    await test.recovery.recover(MODULE_ID, new AbortController().signal)

    expect(test.verifyArtifact).toHaveBeenCalledTimes(1)
    expect(test.verifyArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ version: PREVIOUS_VERSION }),
      expect.any(AbortSignal),
    )
    expect(test.events).not.toContain(`verify:${TARGET_VERSION}`)
    expect(test.events).not.toContain(`activate:${TARGET_VERSION}`)
    expect(test.events).toEqual([
      'write:rollback-completed',
      `verify:${PREVIOUS_VERSION}`,
      `activate:${PREVIOUS_VERSION}`,
      'write:clean',
    ])
  })

  it('poisons the process and leaves activation-started after target failure', async () => {
    const test = harness(await transitioningState('prepared'), {
      activationError: 'target exploded',
    })

    const recovered = await test.recovery.recover(
      MODULE_ID,
      new AbortController().signal,
    )

    expect(recovered).toEqual({
      moduleId: MODULE_ID,
      status: 'failed',
      error: 'target exploded',
      reloadRequired: true,
      processPoisoned: true,
    })
    expect(test.durable().transition?.phase).toBe('activation-started')
    expect(test.events).not.toContain(`activate:${PREVIOUS_VERSION}`)

    const retried = await test.recovery.recover(
      MODULE_ID,
      new AbortController().signal,
    )
    expect(retried).toMatchObject({
      status: 'failed',
      reloadRequired: true,
      processPoisoned: true,
      error: expect.stringContaining('requires a fresh process'),
    })
    expect(test.events).not.toContain(`activate:${PREVIOUS_VERSION}`)

    const replacement = new ModuleStartupTransitionRecovery(
      test.recoveryOptions,
    )
    await expect(
      replacement.recover(MODULE_ID, new AbortController().signal),
    ).resolves.toMatchObject({
      status: 'failed',
      processPoisoned: true,
      error: expect.stringContaining('requires a fresh process'),
    })
    expect(test.events).not.toContain(`activate:${PREVIOUS_VERSION}`)
  })

  it('poisons the process when previous-version activation was attempted and failed', async () => {
    const initial = await transitioningState('rollback-completed')
    const test = harness(initial, { activationError: 'previous exploded' })

    const recovered = await test.recovery.recover(
      MODULE_ID,
      new AbortController().signal,
    )

    expect(recovered).toEqual({
      moduleId: MODULE_ID,
      status: 'failed',
      error: 'previous exploded',
      reloadRequired: false,
      processPoisoned: true,
    })
    expect(test.durable().transition?.phase).toBe('rollback-completed')
  })

  it('rechecks settings after activation-started is durable and never starts target after a conflict', async () => {
    const conflicting: ModuleTransitionSettingsSnapshot = Object.freeze({
      present: true,
      envelope: Object.freeze({
        schemaVersion: 1,
        data: Object.freeze({ enabled: false }),
      }),
    })
    let reads = 0
    const initial = await transitioningState('prepared', { stateful: true })
    const test = harness(initial)
    test.readAtCapturedLocation.mockImplementation(async () => {
      reads += 1
      return reads === 1 ? SETTINGS_SNAPSHOT : conflicting
    })

    const recovered = await test.recovery.recover(
      MODULE_ID,
      new AbortController().signal,
    )

    expect(recovered).toMatchObject({
      status: 'failed',
      processPoisoned: false,
      error: expect.stringContaining('current settings SHA-256 mismatch'),
    })
    expect(test.durable().transition?.phase).toBe('activation-started')
    expect(test.activateVerifiedArtifact).not.toHaveBeenCalled()
  })

  it('accepts a committed write that throws after the exact state is durable', async () => {
    const test = harness(await transitioningState('prepared'), {
      write: async (next, setDurable) => {
        setDurable(next)
        if (next.transition?.phase === 'committed') {
          throw new Error('late write failure')
        }
        return next
      },
    })

    const recovered = await test.recovery.recover(
      MODULE_ID,
      new AbortController().signal,
    )

    expect(recovered).toMatchObject({
      status: 'activated',
      version: TARGET_VERSION,
      processPoisoned: false,
    })
    expect(test.durable().transition).toBeNull()
  })

  it('returns activated with a diagnostic when committed cleanup is uncertain', async () => {
    const test = harness(await transitioningState('committed'), {
      write: async (next, setDurable) => {
        if (next.transition !== null) {
          setDurable(next)
          return next
        }
        throw new Error('cleanup storage unavailable')
      },
    })

    const recovered = await test.recovery.recover(
      MODULE_ID,
      new AbortController().signal,
    )

    expect(recovered).toMatchObject({
      status: 'activated',
      version: TARGET_VERSION,
      error: expect.stringContaining('cleanup is unresolved'),
      reloadRequired: false,
      processPoisoned: false,
    })
    expect(test.durable().transition?.phase).toBe('committed')

    const retried = await test.recovery.recover(
      MODULE_ID,
      new AbortController().signal,
    )
    expect(retried).toBe(recovered)
    expect(test.activateVerifiedArtifact).toHaveBeenCalledTimes(1)

    test.setDurable(await transitioningState('prepared'))
    const distinct = await test.recovery.recover(
      MODULE_ID,
      new AbortController().signal,
    )
    expect(distinct).toMatchObject({
      status: 'activated',
      version: TARGET_VERSION,
    })
    expect(test.activateVerifiedArtifact).toHaveBeenCalledTimes(2)
  })

  it('poisons after target activation when committed write readback diverges', async () => {
    const test = harness(await transitioningState('prepared'), {
      write: async (next, setDurable) => {
        if (next.transition?.phase === 'committed') {
          setDurable(
            Object.freeze({
              ...next,
              readyVersions: Object.freeze({
                ...next.readyVersions,
                [TARGET_VERSION]: Object.freeze({
                  ...next.readyVersions[TARGET_VERSION],
                  manifest: Object.freeze({
                    ...next.readyVersions[TARGET_VERSION].manifest,
                    byteSize: 101,
                  }),
                }),
              }),
            }),
          )
          throw new Error('commit uncertain')
        }
        setDurable(next)
        return next
      },
    })

    const recovered = await test.recovery.recover(
      MODULE_ID,
      new AbortController().signal,
    )

    expect(recovered).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('readback diverged'),
      reloadRequired: true,
      processPoisoned: true,
    })
    expect(test.writes).not.toContain(null)
  })

  it('does not roll back a committed journal when startup activation fails', async () => {
    const test = harness(await transitioningState('committed'), {
      activationError: 'committed activation failed',
    })

    const recovered = await test.recovery.recover(
      MODULE_ID,
      new AbortController().signal,
    )

    expect(recovered).toMatchObject({
      status: 'failed',
      reloadRequired: false,
      processPoisoned: true,
    })
    expect(test.writes).toEqual([])
    expect(test.durable().transition?.phase).toBe('committed')
    expect(test.events).not.toContain(`activate:${PREVIOUS_VERSION}`)
  })

  it('restores the previous active version and cleans rollback-completed', async () => {
    const test = harness(await transitioningState('rollback-completed'))

    const recovered = await test.recovery.recover(
      MODULE_ID,
      new AbortController().signal,
    )

    expect(recovered).toMatchObject({
      status: 'activated',
      version: PREVIOUS_VERSION,
      recoveredVersion: PREVIOUS_VERSION,
    })
    expect(test.writes).toEqual([null])
  })

  it('cleans a first-install rollback while retaining the candidate', async () => {
    const test = harness(
      await transitioningState('activation-started', {
        previousVersion: null,
      }),
    )

    const recovered = await test.recovery.recover(
      MODULE_ID,
      new AbortController().signal,
    )

    expect(recovered).toMatchObject({
      status: 'failed',
      error: 'Transition has no previous active version',
      reloadRequired: false,
      processPoisoned: false,
    })
    expect(test.durable()).toMatchObject({
      activeVersion: null,
      downloadedCandidate: TARGET_VERSION,
      pendingVersion: null,
      transition: null,
    })
    expect(test.activateVerifiedArtifact).not.toHaveBeenCalled()
  })

  it('awaits an invoked state write to settle even when recovery is aborted', async () => {
    let settleWrite: (() => void) | undefined
    const writeStarted = new Promise<void>((resolve) => {
      settleWrite = resolve
    })
    let releaseWrite: (() => void) | undefined
    const blockedWrite = new Promise<void>((resolve) => {
      releaseWrite = resolve
    })
    const test = harness(await transitioningState('settings-committed'), {
      write: async (next, setDurable) => {
        settleWrite?.()
        await blockedWrite
        setDurable(next)
        return next
      },
    })
    const controller = new AbortController()
    let settled = false
    const recovery = test.recovery
      .recover(MODULE_ID, controller.signal)
      .finally(() => {
        settled = true
      })
    await writeStarted

    controller.abort()
    await Promise.resolve()
    expect(settled).toBe(false)
    releaseWrite?.()

    await expect(recovery).resolves.toMatchObject({
      status: 'failed',
      processPoisoned: false,
    })
    expect(test.durable().transition?.phase).toBe('activation-started')
    expect(test.activateVerifiedArtifact).not.toHaveBeenCalled()
  })

  it('does not release recovery while invoked module code ignores abort', async () => {
    let activationStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      activationStarted = resolve
    })
    let releaseActivation: (() => void) | undefined
    const blocked = new Promise<void>((resolve) => {
      releaseActivation = resolve
    })
    const test = harness(await transitioningState('prepared'), {
      activation: async () => {
        activationStarted?.()
        await blocked
      },
    })
    const controller = new AbortController()
    let settled = false
    const recovery = test.recovery
      .recover(MODULE_ID, controller.signal)
      .finally(() => {
        settled = true
      })
    await started

    controller.abort()
    await Promise.resolve()
    expect(settled).toBe(false)
    releaseActivation?.()

    await expect(recovery).resolves.toMatchObject({
      status: 'failed',
      reloadRequired: true,
      processPoisoned: true,
    })
    expect(test.durable().transition?.phase).toBe('activation-started')
  })

  it('returns immutable deterministic results', async () => {
    const test = harness(await transitioningState('prepared'), {
      verifyError: 'fixed failure',
    })

    const recovered = await test.recovery.recover(
      MODULE_ID,
      new AbortController().signal,
    )

    expect(Object.isFrozen(recovered)).toBe(true)
    expect(recovered).toEqual({
      moduleId: MODULE_ID,
      status: 'failed',
      error: 'fixed failure',
      reloadRequired: false,
      processPoisoned: false,
    })
  })
})
