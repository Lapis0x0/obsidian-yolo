import { ModuleDeviceStateInstalledStateSource } from './moduleDeviceStateInstalledStateSource'

const descriptor = (version: string) =>
  ({
    id: 'learning',
    version,
    hostApi: '^1.0.0',
    dataSchemas: {},
    platform: 'desktop' as const,
    manifestUrl: `https://github.com/Lapis0x0/obsidian-yolo/releases/download/learning-v${version}/module.json`,
    manifest: { byteSize: 42, sha256: 'a'.repeat(64) },
  }) as const

describe('ModuleDeviceStateInstalledStateSource', () => {
  test('projects pending activation without a downloaded candidate state', async () => {
    const source = new ModuleDeviceStateInstalledStateSource({
      store: {
        list: async () => [
          {
            moduleId: 'learning',
            platform: 'desktop' as const,
            active: descriptor('1.0.0'),
            pending: {
              descriptor: descriptor('2.0.0'),
            },
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
      },
    ])
  })

  test('projects a pending but disabled first installation as installed', async () => {
    const source = new ModuleDeviceStateInstalledStateSource({
      store: {
        list: async () => [
          {
            moduleId: 'learning',
            platform: 'desktop' as const,
            active: null,
            pending: {
              descriptor: descriptor('1.0.0'),
            },
          },
        ],
      },
      isActive: () => false,
    })

    await expect(source.load()).resolves.toEqual([
      {
        id: 'learning',
        version: '1.0.0',
        pendingVersion: '1.0.0',
      },
    ])
  })
})
