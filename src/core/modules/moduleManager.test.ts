import { ModuleManager } from './moduleManager'
import type {
  InstalledModuleState,
  ModuleCatalogEntry,
  ModuleCatalogSource,
} from './types'

describe('ModuleManager', () => {
  it('publishes immutable snapshots and all module statuses', async () => {
    const catalog: ModuleCatalogEntry[] = [
      { id: 'available', version: '1.0.0' },
      { id: 'installed', version: '1.0.0' },
      { id: 'update', version: '2.0.0' },
      { id: 'candidate', version: '2.0.0' },
      { id: 'pending', version: '2.0.0' },
    ]
    const installed: InstalledModuleState[] = [
      { id: 'installed', version: '1.0.0' },
      { id: 'active', version: '1.0.0', active: true },
      { id: 'disabled', version: '1.0.0', disabled: true },
      { id: 'update', version: '1.0.0' },
      {
        id: 'candidate',
        version: '1.0.0',
        candidateVersion: '2.0.0',
        active: true,
        error: 'old version failed',
      },
      {
        id: 'pending',
        version: '1.0.0',
        pendingVersion: '2.0.0',
        transitionPhase: 'prepared',
        active: true,
      },
      { id: 'failed', version: '1.0.0', error: 'activation failed' },
    ]
    const manager = new ModuleManager({
      catalogSource: { load: async () => catalog },
      installedStateSource: { load: async () => installed },
    })

    await manager.refresh()
    const snapshot = manager.getSnapshot()
    expect(snapshot.status).toBe('ready')
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.modules)).toBe(true)
    expect(snapshot.modules.every(Object.isFrozen)).toBe(true)
    expect(snapshot.modules.map(({ id, status }) => [id, status])).toEqual([
      ['active', 'active'],
      ['available', 'available'],
      ['candidate', 'ready-to-apply'],
      ['disabled', 'disabled'],
      ['failed', 'failed'],
      ['installed', 'installed'],
      ['pending', 'activation-pending'],
      ['update', 'update-available'],
    ])
    const candidate = snapshot.modules.find(({ id }) => id === 'candidate')
    const pending = snapshot.modules.find(({ id }) => id === 'pending')
    expect(candidate).toMatchObject({
      version: '1.0.0',
      candidateVersion: '2.0.0',
      error: 'old version failed',
    })
    expect(candidate).not.toHaveProperty('availableVersion')
    expect(pending).toMatchObject({
      version: '1.0.0',
      pendingVersion: '2.0.0',
      transitionPhase: 'prepared',
    })
    expect(pending).not.toHaveProperty('availableVersion')
    expect(manager.getSnapshot()).toBe(snapshot)
  })

  it('projects initial candidates and pending activation without false updates', async () => {
    const manager = new ModuleManager({
      catalogSource: {
        load: async () => [
          { id: 'candidate', version: '3.0.0' },
          { id: 'pending', version: '3.0.0' },
          { id: 'failed', version: '3.0.0' },
        ],
      },
      installedStateSource: {
        load: async () => [
          {
            id: 'candidate',
            version: '2.0.0',
            candidateVersion: '2.0.0',
          },
          {
            id: 'pending',
            version: '2.0.0',
            pendingVersion: '2.0.0',
            transitionPhase: 'prepared',
          },
          {
            id: 'failed',
            version: '1.0.0',
            candidateVersion: '2.0.0',
            pendingVersion: '2.0.0',
            transitionPhase: 'prepared',
            error: 'activation failed',
          },
        ],
      },
    })

    await manager.refresh()

    expect(manager.getSnapshot().modules).toMatchObject([
      {
        id: 'candidate',
        version: '2.0.0',
        candidateVersion: '2.0.0',
        status: 'ready-to-apply',
      },
      {
        id: 'failed',
        version: '1.0.0',
        candidateVersion: '2.0.0',
        pendingVersion: '2.0.0',
        transitionPhase: 'prepared',
        status: 'activation-pending',
        error: 'activation failed',
      },
      {
        id: 'pending',
        version: '2.0.0',
        pendingVersion: '2.0.0',
        transitionPhase: 'prepared',
        status: 'activation-pending',
      },
    ])
    expect(
      manager
        .getSnapshot()
        .modules.every((module) => module.availableVersion === undefined),
    ).toBe(true)
  })

  it('keeps active and catalog-withdrawn semantics without staged state', async () => {
    const manager = new ModuleManager({
      catalogSource: { load: async () => [] },
      installedStateSource: {
        load: async () => [
          { id: 'withdrawn-active', version: '1.0.0', active: true },
          { id: 'withdrawn-installed', version: '1.0.0' },
        ],
      },
    })

    await manager.refresh()

    expect(
      manager.getSnapshot().modules.map(({ id, status }) => [id, status]),
    ).toEqual([
      ['withdrawn-active', 'active'],
      ['withdrawn-installed', 'installed'],
    ])
  })

  it('projects synchronized intent without changing actual status or visibility', async () => {
    const manager = new ModuleManager({
      catalogSource: {
        load: async () => [
          { id: 'active', version: '1.0.0' },
          { id: 'catalog-only', version: '1.0.0' },
          { id: 'missing-intent', version: '1.0.0' },
        ],
      },
      installedStateSource: {
        load: async () => [
          { id: 'active', version: '1.0.0', active: true },
          { id: 'withdrawn', version: '1.0.0' },
        ],
      },
      intentStateSource: {
        load: async (ids) => {
          expect(ids).toEqual([
            'active',
            'catalog-only',
            'missing-intent',
            'withdrawn',
          ])
          return [
            { id: 'active', desiredInstalled: true, enabled: false },
            {
              id: 'catalog-only',
              desiredInstalled: true,
              enabled: true,
            },
            { id: 'withdrawn', desiredInstalled: false, enabled: false },
          ]
        },
      },
    })

    await manager.refresh()

    const byId = Object.fromEntries(
      manager.getSnapshot().modules.map((module) => [module.id, module]),
    )
    expect(byId.active).toMatchObject({
      status: 'active',
      desiredInstalled: true,
      enabled: false,
    })
    expect(byId['catalog-only']).toMatchObject({
      status: 'available',
      desiredInstalled: true,
      enabled: true,
    })
    expect(byId.withdrawn).toMatchObject({
      status: 'installed',
      desiredInstalled: false,
      enabled: false,
    })
    expect(byId['missing-intent']).not.toHaveProperty('desiredInstalled')
    expect(byId['missing-intent']).not.toHaveProperty('enabled')
    expect(Object.isFrozen(byId.active)).toBe(true)
  })

  it('isolates intent failures and retains the last good intent snapshot', async () => {
    let failIntent = false
    let catalogVersion = '1.0.0'
    const manager = new ModuleManager({
      catalogSource: {
        load: async () => [{ id: 'module', version: catalogVersion }],
      },
      installedStateSource: {
        load: async () => [{ id: 'module', version: '1.0.0' }],
      },
      intentStateSource: {
        load: async () => {
          if (failIntent) throw new Error('intent unavailable')
          return [{ id: 'module', desiredInstalled: true, enabled: false }]
        },
      },
    })
    await manager.refresh()

    failIntent = true
    catalogVersion = '2.0.0'
    await expect(manager.refresh()).resolves.toBeUndefined()

    expect(manager.getSnapshot()).toMatchObject({
      status: 'error',
      errors: { intent: 'intent unavailable' },
      error: 'intent unavailable',
      modules: [
        {
          id: 'module',
          status: 'update-available',
          availableVersion: '2.0.0',
          desiredInstalled: true,
          enabled: false,
        },
      ],
    })
  })

  it('publishes loading immediately and suppresses stale refresh completion', async () => {
    const resolvers: Array<
      (
        value: Array<{
          id: string
          desiredInstalled: boolean
          enabled: boolean
        }>,
      ) => void
    > = []
    const manager = new ModuleManager({
      catalogSource: {
        load: async () => [{ id: 'module', version: '1.0.0' }],
      },
      installedStateSource: { load: async () => [] },
      intentStateSource: {
        load: () =>
          new Promise((resolve) => {
            resolvers.push(resolve)
          }),
      },
    })
    const snapshots: string[] = []
    manager.subscribe(() => snapshots.push(manager.getSnapshot().status))

    const first = manager.refresh()
    await Promise.resolve()
    await Promise.resolve()
    const second = manager.refresh()
    expect(manager.getSnapshot().status).toBe('loading')

    while (!resolvers[0]) await Promise.resolve()
    resolvers[0]([{ id: 'module', desiredInstalled: false, enabled: false }])
    await first
    expect(manager.getSnapshot().status).toBe('loading')

    while (!resolvers[1]) await Promise.resolve()
    resolvers[1]([{ id: 'module', desiredInstalled: true, enabled: true }])
    await second

    expect(snapshots).toEqual(['loading', 'loading', 'ready'])
    expect(manager.getSnapshot().modules[0]).toMatchObject({
      desiredInstalled: true,
      enabled: true,
    })
  })

  it('does not retain stale intent when the current generation rejects', async () => {
    let loadCount = 0
    let resolveStale!: (
      value: Array<{
        id: string
        desiredInstalled: boolean
        enabled: boolean
      }>,
    ) => void
    let markStaleStarted!: () => void
    const staleStarted = new Promise<void>((resolve) => {
      markStaleStarted = resolve
    })
    const manager = new ModuleManager({
      catalogSource: {
        load: async () => [{ id: 'module', version: '1.0.0' }],
      },
      installedStateSource: { load: async () => [] },
      intentStateSource: {
        load: () => {
          loadCount += 1
          if (loadCount === 1) {
            return Promise.resolve([
              { id: 'module', desiredInstalled: true, enabled: false },
            ])
          }
          if (loadCount === 2) {
            markStaleStarted()
            return new Promise((resolve) => {
              resolveStale = resolve
            })
          }
          return Promise.reject(new Error('current intent unavailable'))
        },
      },
    })
    await manager.refresh()

    const staleRefresh = manager.refresh()
    await staleStarted
    const currentRefresh = manager.refresh()
    resolveStale([{ id: 'module', desiredInstalled: false, enabled: true }])
    await staleRefresh
    await currentRefresh

    expect(manager.getSnapshot()).toMatchObject({
      status: 'error',
      errors: { intent: 'current intent unavailable' },
      modules: [
        {
          id: 'module',
          desiredInstalled: true,
          enabled: false,
        },
      ],
    })
  })

  it.each(['fulfills', 'rejects'] as const)(
    'keeps the disposed snapshot stable when a pending intent load %s',
    async (outcome) => {
      let resolveLoad!: (
        value: Array<{
          id: string
          desiredInstalled: boolean
          enabled: boolean
        }>,
      ) => void
      let rejectLoad!: (reason: unknown) => void
      let markStarted!: () => void
      const started = new Promise<void>((resolve) => {
        markStarted = resolve
      })
      const manager = new ModuleManager({
        catalogSource: {
          load: async () => [{ id: 'module', version: '1.0.0' }],
        },
        installedStateSource: { load: async () => [] },
        intentStateSource: {
          load: () => {
            markStarted()
            return new Promise((resolve, reject) => {
              resolveLoad = resolve
              rejectLoad = reject
            })
          },
        },
      })
      const listener = jest.fn()
      manager.subscribe(listener)

      const refresh = manager.refresh()
      await started
      manager.dispose()
      const disposedSnapshot = manager.getSnapshot()
      listener.mockClear()

      if (outcome === 'fulfills') {
        resolveLoad([{ id: 'module', desiredInstalled: true, enabled: true }])
      } else {
        rejectLoad(new Error('intent unavailable'))
      }
      await expect(refresh).resolves.toBeUndefined()

      expect(manager.getSnapshot()).toBe(disposedSnapshot)
      expect(disposedSnapshot).toMatchObject({
        status: 'loading',
        modules: [],
        errors: {},
      })
      expect(disposedSnapshot).not.toHaveProperty('error')
      expect(listener).not.toHaveBeenCalled()
    },
  )

  it('isolates source failures and retains the last good side', async () => {
    let failCatalog = false
    let installed: InstalledModuleState[] = []
    const catalogSource: ModuleCatalogSource = {
      load: async () => {
        if (failCatalog) throw new Error('catalog unavailable')
        return [{ id: 'catalog-module', version: '1.0.0' }]
      },
    }
    const manager = new ModuleManager({
      catalogSource,
      installedStateSource: { load: async () => installed },
    })
    await manager.refresh()

    failCatalog = true
    installed = [{ id: 'local-module', version: '1.0.0', active: true }]
    await expect(manager.refresh()).resolves.toBeUndefined()
    expect(manager.getSnapshot()).toMatchObject({
      status: 'error',
      errors: { catalog: 'catalog unavailable' },
    })
    expect(manager.getSnapshot().modules.map(({ id }) => id)).toEqual([
      'catalog-module',
      'local-module',
    ])
  })

  it('uses semantic version precedence for update availability', async () => {
    const manager = new ModuleManager({
      catalogSource: {
        load: async () => [
          { id: 'prerelease', version: '1.0.0' },
          { id: 'equivalent', version: '1.0.0' },
          { id: 'build-only', version: '1.0.0+catalog' },
          { id: 'numeric-prerelease', version: '1.0.0-beta.11' },
          {
            id: 'large-numeric-prerelease',
            version: '1.0.0-beta.9007199254740993',
          },
        ],
      },
      installedStateSource: {
        load: async () => [
          { id: 'prerelease', version: '1.0.0-beta' },
          { id: 'equivalent', version: '1.0' },
          { id: 'build-only', version: '1.0.0+installed' },
          { id: 'numeric-prerelease', version: '1.0.0-beta.2' },
          {
            id: 'large-numeric-prerelease',
            version: '1.0.0-beta.9007199254740992',
          },
        ],
      },
    })

    await manager.refresh()

    expect(
      Object.fromEntries(
        manager.getSnapshot().modules.map(({ id, status }) => [id, status]),
      ),
    ).toEqual({
      'build-only': 'installed',
      equivalent: 'installed',
      'large-numeric-prerelease': 'update-available',
      'numeric-prerelease': 'update-available',
      prerelease: 'update-available',
    })
  })

  it('notifies active subscriptions and stops after unsubscribe or dispose', async () => {
    const manager = new ModuleManager({
      catalogSource: { load: async () => [] },
      installedStateSource: { load: async () => [] },
    })
    const listener = jest.fn()
    const unsubscribe = manager.subscribe(listener)
    await manager.refresh()
    expect(listener).toHaveBeenCalledTimes(2)

    unsubscribe()
    await manager.refresh()
    expect(listener).toHaveBeenCalledTimes(2)
    manager.dispose()
    expect(manager.getSnapshot().modules).toEqual([])
  })
})
