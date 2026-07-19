import type { ModuleActivationResult } from './moduleActivationCoordinator'
import type { ModuleIntent } from './moduleIntentStore'
import type { ModuleReadinessResult } from './moduleReadinessReconciler'
import {
  type ModuleStartupReconcileSource,
  ModuleStartupReconciler,
} from './moduleStartupReconciler'

function ready(moduleId: string): ModuleReadinessResult {
  return Object.freeze({
    moduleId,
    status: 'ready',
    versions: Object.freeze(['1.0.0']),
    repairedVersions: Object.freeze([]),
  })
}

function createHarness(
  initial: Record<string, ModuleIntent | undefined>,
  listed = Object.keys(initial),
) {
  const intents = new Map(Object.entries(initial))
  const listeners = new Set<(moduleId: string) => void>()
  const log: string[] = []
  const listKnownModuleIds = jest.fn(async () => {
    log.push('list')
    return listed
  })
  const source: ModuleStartupReconcileSource = {
    listKnownModuleIds,
    subscribe: jest.fn((listener) => {
      log.push('subscribe')
      listeners.add(listener)
      return () => {
        log.push('unsubscribe')
        listeners.delete(listener)
      }
    }),
  }
  const ensureModuleReady = jest.fn(async (moduleId: string) => {
    log.push(`ready:${moduleId}`)
    return ready(moduleId)
  })
  const activatePersistedModules = jest.fn(
    async (): Promise<readonly ModuleActivationResult[]> => {
      log.push('activate')
      return Object.freeze([])
    },
  )
  const refresh = jest.fn(async () => {
    log.push('refresh')
  })
  const scheduleSafeUninstall = jest.fn(async (moduleId: string) => {
    log.push(`uninstall:${moduleId}`)
  })
  const requestReload = jest.fn((moduleId: string) => {
    log.push(`reload:${moduleId}`)
  })
  const reportError = jest.fn()
  const reconciler = new ModuleStartupReconciler({
    source,
    intentStore: {
      get: jest.fn(async (moduleId: string) => {
        log.push(`intent:${moduleId}`)
        return intents.get(moduleId)
      }),
    },
    readinessReconciler: { ensureModuleReady },
    activationCoordinator: { activatePersistedModules },
    manager: { refresh },
    scheduleSafeUninstall,
    requestReload,
    reportError,
  })
  return {
    reconciler,
    intents,
    log,
    listKnownModuleIds,
    ensureModuleReady,
    activatePersistedModules,
    refresh,
    scheduleSafeUninstall,
    requestReload,
    reportError,
    emit(moduleId: string) {
      for (const listener of [...listeners]) listener(moduleId)
    },
    listenerCount: () => listeners.size,
  }
}

describe('ModuleStartupReconciler', () => {
  test('subscribes and makes desired modules ready before startup activation', async () => {
    const harness = createHarness(
      {
        disabled: 'disabled',
        enabled: 'enabled',
        absent: 'uninstalled',
      },
      ['enabled', 'absent', 'disabled'],
    )

    await harness.reconciler.start()

    expect(harness.log[0]).toBe('subscribe')
    expect(harness.log[1]).toBe('list')
    expect(harness.ensureModuleReady.mock.calls).toEqual([['enabled']])
    expect(harness.log.indexOf('activate')).toBeGreaterThan(
      harness.log.indexOf('ready:enabled'),
    )
    expect(harness.log.indexOf('activate')).toBeGreaterThan(
      harness.log.indexOf('refresh'),
    )
    expect(harness.scheduleSafeUninstall).toHaveBeenCalledWith('absent')
    expect(harness.requestReload).not.toHaveBeenCalled()
  })

  test('calls the activation owner seam for a disabled transition', async () => {
    const harness = createHarness({
      notes: 'disabled',
    })
    const restoredOwners: string[] = []
    harness.activatePersistedModules.mockImplementation(async () => {
      restoredOwners.push('notes')
      return Object.freeze([
        Object.freeze({
          moduleId: 'notes',
          status: 'activated' as const,
          recoveredVersion: '1.0.0',
        }),
      ])
    })

    await harness.reconciler.start()

    expect(harness.activatePersistedModules).toHaveBeenCalledTimes(1)
    expect(restoredOwners).toEqual(['notes'])
    expect(harness.requestReload).not.toHaveBeenCalled()
  })

  test('calls activation when there are no known or live modules', async () => {
    const harness = createHarness({}, [])

    await harness.reconciler.start()

    expect(harness.refresh).not.toHaveBeenCalled()
    expect(harness.activatePersistedModules).toHaveBeenCalledTimes(1)
  })

  test('coalesces synchronized updates and runs them serially', async () => {
    const harness = createHarness({
      notes: 'uninstalled',
    })
    await harness.reconciler.start()
    harness.ensureModuleReady.mockClear()
    harness.refresh.mockClear()

    let release: (() => void) | undefined
    let markStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    let active = 0
    let maximumActive = 0
    harness.ensureModuleReady.mockImplementation(async (moduleId: string) => {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      markStarted?.()
      await new Promise<void>((resolve) => {
        release = resolve
      })
      active -= 1
      return ready(moduleId)
    })
    harness.intents.set('notes', 'enabled')
    harness.emit('notes')
    harness.emit('notes')
    harness.emit('notes')
    await started
    expect(harness.ensureModuleReady).toHaveBeenCalledTimes(1)

    release?.()
    await harness.reconciler.whenIdle()

    expect(harness.ensureModuleReady).toHaveBeenCalledTimes(1)
    expect(harness.refresh).toHaveBeenCalledTimes(1)
    expect(maximumActive).toBe(1)
    expect(harness.requestReload).toHaveBeenCalledWith('notes')
  })

  test('isolates module failures and continues startup', async () => {
    const harness = createHarness({
      broken: 'enabled',
      healthy: 'enabled',
    })
    harness.ensureModuleReady.mockImplementation(async (moduleId: string) => {
      if (moduleId === 'broken') throw new Error('download failed')
      return ready(moduleId)
    })

    await expect(harness.reconciler.start()).resolves.toBeUndefined()

    expect(harness.ensureModuleReady).toHaveBeenCalledWith('healthy')
    expect(harness.activatePersistedModules).toHaveBeenCalledTimes(1)
    expect(harness.refresh).toHaveBeenCalledTimes(1)
    expect(harness.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'download failed' }),
      'broken',
    )
  })

  test('finishes isolated readiness and refresh before transition recovery', async () => {
    const harness = createHarness({
      broken: 'enabled',
      transition: 'enabled',
    })
    harness.ensureModuleReady.mockImplementation(async (moduleId: string) => {
      harness.log.push(`custom-ready:${moduleId}`)
      if (moduleId === 'broken') {
        return Object.freeze({
          moduleId,
          status: 'failed' as const,
          error: 'readiness poison',
          versions: Object.freeze([]),
          repairedVersions: Object.freeze([]),
        })
      }
      return ready(moduleId)
    })

    await expect(harness.reconciler.start()).resolves.toBeUndefined()

    expect(harness.ensureModuleReady.mock.calls).toEqual([
      ['broken'],
      ['transition'],
    ])
    expect(harness.log.indexOf('refresh')).toBeGreaterThan(
      harness.log.indexOf('custom-ready:transition'),
    )
    expect(harness.log.indexOf('activate')).toBeGreaterThan(
      harness.log.indexOf('refresh'),
    )
    expect(harness.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'readiness poison' }),
      'broken',
    )
    expect(harness.activatePersistedModules).toHaveBeenCalledTimes(1)
  })

  test('reports poisoned activation results without directly reloading', async () => {
    const harness = createHarness({
      notes: 'disabled',
    })
    harness.activatePersistedModules.mockResolvedValue(
      Object.freeze([
        Object.freeze({
          moduleId: 'notes',
          status: 'failed' as const,
          error: 'transition recovery poisoned the process',
        }),
      ]),
    )

    await expect(harness.reconciler.start()).resolves.toBeUndefined()

    expect(harness.reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'transition recovery poisoned the process',
      }),
      'notes',
    )
    expect(harness.requestReload).not.toHaveBeenCalled()
  })

  test('unsubscribes when startup fails', async () => {
    const harness = createHarness({})
    harness.listKnownModuleIds.mockRejectedValue(new Error('listing failed'))

    await expect(harness.reconciler.start()).rejects.toThrow('listing failed')

    expect(harness.listenerCount()).toBe(0)
    expect(harness.activatePersistedModules).not.toHaveBeenCalled()
    await expect(harness.reconciler.whenIdle()).rejects.toThrow(
      'listing failed',
    )
  })

  test('unsubscribes and rejects operations after disposal', async () => {
    const harness = createHarness({
      notes: 'uninstalled',
    })
    await harness.reconciler.start()
    harness.reconciler.dispose()

    expect(harness.listenerCount()).toBe(0)
    harness.emit('notes')
    await expect(harness.reconciler.start()).rejects.toThrow('disposed')
    await expect(harness.reconciler.whenIdle()).rejects.toThrow('disposed')
  })

  test.each([
    {
      state: 'uninstalled' as const,
      readiness: 0,
      activation: 1,
      uninstall: 1,
    },
    {
      state: 'disabled' as const,
      readiness: 0,
      activation: 1,
      uninstall: 0,
    },
    {
      state: 'enabled' as const,
      readiness: 1,
      activation: 1,
      uninstall: 0,
    },
  ])(
    'enforces $state intent',
    async ({ state, readiness, activation, uninstall }) => {
      const harness = createHarness({
        notes: state,
      })

      await harness.reconciler.start()

      expect(harness.ensureModuleReady).toHaveBeenCalledTimes(readiness)
      expect(harness.activatePersistedModules).toHaveBeenCalledTimes(activation)
      expect(harness.scheduleSafeUninstall).toHaveBeenCalledTimes(uninstall)
      expect(harness.requestReload).not.toHaveBeenCalled()
    },
  )

  test('refreshes and explicitly requests reload when live eligibility changes', async () => {
    const harness = createHarness({
      notes: 'enabled',
    })
    await harness.reconciler.start()
    harness.log.length = 0
    harness.intents.set('notes', 'disabled')

    harness.emit('notes')
    await harness.reconciler.whenIdle()

    expect(harness.requestReload).toHaveBeenCalledWith('notes')
    expect(harness.log.indexOf('reload:notes')).toBeGreaterThan(
      harness.log.indexOf('refresh'),
    )
  })

  test('requests reload for an eligibility update during startup', async () => {
    const harness = createHarness({
      notes: 'enabled',
    })
    let release: (() => void) | undefined
    let markStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    harness.ensureModuleReady.mockImplementationOnce(async (moduleId) => {
      markStarted?.()
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return ready(moduleId)
    })

    const startup = harness.reconciler.start()
    await started
    harness.intents.set('notes', 'disabled')
    harness.emit('notes')
    release?.()
    await startup

    expect(harness.ensureModuleReady).toHaveBeenCalledTimes(1)
    expect(harness.requestReload).toHaveBeenCalledWith('notes')
    expect(harness.log.indexOf('reload:notes')).toBeLessThan(
      harness.log.indexOf('activate'),
    )
  })

  test('deduplicates repeated source ids', async () => {
    const harness = createHarness({ notes: 'enabled' }, [
      'notes',
      'notes',
      'notes',
    ])

    await harness.reconciler.start()

    expect(harness.ensureModuleReady).toHaveBeenCalledTimes(1)
    expect(harness.refresh).toHaveBeenCalledTimes(1)
    expect(harness.activatePersistedModules).toHaveBeenCalledTimes(1)
  })
})
