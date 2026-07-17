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
    ]
    const installed: InstalledModuleState[] = [
      { id: 'installed', version: '1.0.0' },
      { id: 'active', version: '1.0.0', active: true },
      { id: 'disabled', version: '1.0.0', disabled: true },
      { id: 'update', version: '1.0.0' },
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
      ['disabled', 'disabled'],
      ['failed', 'failed'],
      ['installed', 'installed'],
      ['update', 'update-available'],
    ])
    expect(manager.getSnapshot()).toBe(snapshot)
  })

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
