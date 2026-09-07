import type { ModuleArtifactDescriptor } from './moduleArtifactVerifier'
import type { ModuleDeviceState } from './moduleDeviceStateStore'
import { ModuleReadinessReconciler } from './moduleReadinessReconciler'
import type { OfficialModuleCatalogV1 } from './officialModuleCatalog'
import { OfficialModuleCatalogSource } from './officialModuleCatalogSource'

const HASH = 'a'.repeat(64)
const descriptor: ModuleArtifactDescriptor = {
  id: 'learning',
  version: '1.0.0',
  hostApi: '^1.0.0',
  platform: 'desktop',
  dataSchemas: {},
  manifestUrl:
    'https://github.com/Lapis0x0/obsidian-yolo/releases/download/learning-v1.0.0/module.json',
  manifest: { byteSize: 1, sha256: HASH },
}

describe('ModuleReadinessReconciler', () => {
  test('a synchronized install intent creates a pending activation directly', async () => {
    let durable: ModuleDeviceState | null = null
    const reconciler = new ModuleReadinessReconciler({
      deviceStateStore: {
        runExclusive: async (_moduleId, operation) =>
          operation({
            read: async () => durable,
            write: async (next) => {
              durable = next
              return next
            },
            remove: async () => {
              durable = null
            },
          }),
      },
      intentStore: {
        get: async () => 'enabled',
      },
      catalogSource: {
        getResolvedVersion: () => ({
          version: '1.0.0',
          hostApi: descriptor.hostApi,
          platforms: ['desktop'],
          dataSchemas: descriptor.dataSchemas,
          manifestUrl: descriptor.manifestUrl,
          manifest: descriptor.manifest,
        }),
        getResolvedArtifactDescriptor: () => descriptor,
      },
      artifactStore: {
        readManifestBytes: async () => {
          throw new Error('not installed')
        },
        readEntryBytes: async () => {
          throw new Error('not installed')
        },
        listVersionFiles: async () => {
          throw new Error('not installed')
        },
        removeVersionArtifacts: async () => undefined,
      },
      installer: {
        install: async () => ({
          schemaVersion: 1,
          id: 'learning',
          version: '1.0.0',
          hostApi: '^1.0.0',
          dataSchemas: {},
          variants: [{ platform: 'desktop', entry: 'main.js', files: [] }],
        }),
        repair: async () => {
          throw new Error('not used')
        },
      },
      platform: 'desktop',
      subtleCrypto: { digest: async () => new ArrayBuffer(32) },
    })
    await expect(
      reconciler.ensureModuleReady('learning'),
    ).resolves.toMatchObject({
      status: 'ready',
      installedVersion: '1.0.0',
    })
    expect(durable).toMatchObject({
      active: null,
      pending: {
        descriptor: { version: '1.0.0' },
      },
    })
  })

  test('adopts a rebuilt descriptor with the same semantic version', async () => {
    let durable: ModuleDeviceState | null = {
      moduleId: 'learning',
      platform: 'desktop',
      active: descriptor,
      pending: null,
    }
    const rebuilt: ModuleArtifactDescriptor = {
      ...descriptor,
      manifest: { ...descriptor.manifest, sha256: 'b'.repeat(64) },
    }
    const repair = jest.fn(async () => ({
      schemaVersion: 1 as const,
      id: 'learning',
      version: '1.0.0',
      hostApi: '^1.0.0',
      dataSchemas: {},
      variants: [{ platform: 'desktop' as const, entry: 'main.js', files: [] }],
    }))
    const reconciler = new ModuleReadinessReconciler({
      deviceStateStore: {
        runExclusive: async (_moduleId, operation) =>
          operation({
            read: async () => durable,
            write: async (next) => {
              durable = next
              return next
            },
            remove: async () => {
              durable = null
            },
          }),
      },
      intentStore: { get: async () => 'enabled' },
      catalogSource: {
        getResolvedVersion: () => ({
          version: rebuilt.version,
          hostApi: rebuilt.hostApi,
          platforms: ['desktop'],
          dataSchemas: rebuilt.dataSchemas,
          manifestUrl: rebuilt.manifestUrl,
          manifest: rebuilt.manifest,
        }),
        getResolvedArtifactDescriptor: () => rebuilt,
      },
      artifactStore: {
        readManifestBytes: async () => new Uint8Array([0]),
        readEntryBytes: async () => new Uint8Array([0]),
        listVersionFiles: async () => [],
        removeVersionArtifacts: async () => undefined,
      },
      installer: {
        install: async () => {
          throw new Error('not used')
        },
        repair,
      },
      platform: 'desktop',
      subtleCrypto: { digest: async () => new ArrayBuffer(32) },
    })

    await expect(
      reconciler.ensureModuleReady('learning'),
    ).resolves.toMatchObject({ status: 'ready', installedVersion: '1.0.0' })
    expect(repair).toHaveBeenCalledWith(rebuilt, expect.any(AbortSignal))
    expect(durable).toMatchObject({
      active: descriptor,
      pending: { descriptor: rebuilt },
    })
  })

  test('repairs a same-version rebuild resolved through the real catalog source', async () => {
    const rebuiltManifest = { byteSize: 2, sha256: 'b'.repeat(64) }
    let durable: ModuleDeviceState | null = {
      moduleId: 'learning',
      platform: 'desktop',
      active: descriptor,
      pending: null,
    }
    const catalog = {
      schemaVersion: 1,
      modules: [
        {
          id: 'learning',
          icon: 'graduation-cap',
          localizations: {
            en: { name: 'Learning', description: 'Spaced repetition' },
            zh: { name: '学习', description: '间隔重复' },
            it: { name: 'Apprendimento', description: 'Ripetizione' },
          },
          versions: [
            {
              version: '1.0.0',
              hostApi: '^1.1.0',
              platforms: ['desktop', 'mobile'],
              dataSchemas: {},
              manifestUrl: descriptor.manifestUrl,
              manifest: rebuiltManifest,
            },
          ],
        },
      ],
    } as unknown as OfficialModuleCatalogV1
    const catalogSource = new OfficialModuleCatalogSource({
      client: { load: async () => catalog, loadFresh: async () => catalog },
      locale: 'en',
      getCompatibility: async () => ({
        hostApi: '1.1.0',
        platform: 'desktop' as const,
        // The device already runs this exact version — only the artifact
        // behind it was rebuilt locally.
        activeVersion: '1.0.0',
      }),
    })
    await catalogSource.load()

    const repair = jest.fn(async () => ({
      schemaVersion: 1 as const,
      id: 'learning',
      version: '1.0.0',
      hostApi: '^1.1.0',
      dataSchemas: {},
      variants: [{ platform: 'desktop' as const, entry: 'main.js', files: [] }],
    }))
    const reconciler = new ModuleReadinessReconciler({
      deviceStateStore: {
        runExclusive: async (_moduleId, operation) =>
          operation({
            read: async () => durable,
            write: async (next) => {
              durable = next
              return next
            },
            remove: async () => {
              durable = null
            },
          }),
      },
      intentStore: { get: async () => 'enabled' },
      catalogSource,
      artifactStore: {
        readManifestBytes: async () => new Uint8Array([0]),
        readEntryBytes: async () => new Uint8Array([0]),
        listVersionFiles: async () => [],
        removeVersionArtifacts: async () => undefined,
      },
      installer: {
        install: async () => {
          throw new Error('not used')
        },
        repair,
      },
      platform: 'desktop',
      subtleCrypto: { digest: async () => new ArrayBuffer(32) },
    })

    await expect(
      reconciler.ensureModuleReady('learning'),
    ).resolves.toMatchObject({
      status: 'ready',
      installedVersion: '1.0.0',
      repairedVersions: ['1.0.0'],
    })
    expect(repair).toHaveBeenCalledWith(
      expect.objectContaining({
        version: '1.0.0',
        hostApi: '^1.1.0',
        manifest: rebuiltManifest,
      }),
      expect.any(AbortSignal),
    )
    expect(durable).toMatchObject({
      active: descriptor,
      pending: { descriptor: { manifest: rebuiltManifest } },
    })
  })
})
