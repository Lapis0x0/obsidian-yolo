import { ModuleManager } from './moduleManager'

describe('ModuleManager pending activation projection', () => {
  test('projects pending and gives a recovery error precedence', async () => {
    const installed = {
      id: 'learning',
      version: '1.0.0',
      pendingVersion: '2.0.0',
      error: 'incompatible fallback',
    }
    const manager = new ModuleManager({
      catalogSource: { load: async () => [] },
      installedStateSource: { load: async () => [installed] },
    })
    await manager.refresh()
    expect(manager.getSnapshot().modules[0]).toMatchObject({
      status: 'failed',
      pendingVersion: '2.0.0',
      error: 'incompatible fallback',
    })
  })

  test('projects synchronized disabled intent without local artifacts', async () => {
    const manager = new ModuleManager({
      catalogSource: {
        load: async () => [{ id: 'learning', version: '1.0.0' }],
      },
      installedStateSource: { load: async () => [] },
      intentStateSource: {
        load: async () => [{ id: 'learning', state: 'disabled' }],
      },
    })

    await manager.refresh()

    expect(manager.getSnapshot().modules[0]).toMatchObject({
      status: 'disabled',
      desiredInstalled: true,
      enabled: false,
      version: '1.0.0',
    })
  })

  test('projects a readiness failure without pretending artifacts are installed', async () => {
    const manager = new ModuleManager({
      catalogSource: {
        load: async () => [{ id: 'learning', version: '1.0.0' }],
      },
      installedStateSource: { load: async () => [] },
      intentStateSource: {
        load: async () => [{ id: 'learning', state: 'enabled' }],
      },
      getModuleFailure: () => ({
        kind: 'download-timeout',
        detail: 'both sources timed out',
      }),
    })

    await manager.refresh()

    expect(manager.getSnapshot().modules[0]).toMatchObject({
      status: 'failed',
      desiredInstalled: true,
      enabled: true,
      error: 'both sources timed out',
      failure: {
        kind: 'download-timeout',
        detail: 'both sources timed out',
      },
    })
    expect(manager.getSnapshot().modules[0]?.installed).toBeUndefined()
  })
})
