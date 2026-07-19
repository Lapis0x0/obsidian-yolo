import { ModuleManager } from './moduleManager'

describe('ModuleManager pending activation projection', () => {
  test('projects pending and gives a recovery error precedence', async () => {
    const installed = {
      id: 'learning',
      version: '1.0.0',
      pendingVersion: '2.0.0',
      activationPhase: 'activation-started' as const,
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
      activationPhase: 'activation-started',
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
})
