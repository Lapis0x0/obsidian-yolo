import { ModuleDeviceStateInstalledStateSource } from './moduleDeviceStateInstalledStateSource'

describe('ModuleDeviceStateInstalledStateSource', () => {
  test('projects pending activation without a downloaded candidate state', async () => {
    const source = new ModuleDeviceStateInstalledStateSource({
      store: {
        list: async () => [
          {
            moduleId: 'learning',
            platform: 'desktop' as const,
            activeVersion: '1.0.0',
            pendingVersion: '2.0.0',
            activationPhase: 'pending' as const,
            readyVersions: {},
          },
        ],
      },
      isActive: () => false,
    })
    await expect(source.load()).resolves.toEqual([
      {
        id: 'learning',
        version: '1.0.0',
        pendingVersion: '2.0.0',
        activationPhase: 'pending',
      },
    ])
  })

  test('projects a downloaded but disabled first installation as installed', async () => {
    const source = new ModuleDeviceStateInstalledStateSource({
      store: {
        list: async () => [
          {
            moduleId: 'learning',
            platform: 'desktop' as const,
            activeVersion: null,
            pendingVersion: null,
            activationPhase: null,
            readyVersions: {
              '1.0.0': {} as never,
            },
          },
        ],
      },
      isActive: () => false,
    })

    await expect(source.load()).resolves.toEqual([
      { id: 'learning', version: '1.0.0' },
    ])
  })
})
