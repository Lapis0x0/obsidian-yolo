import type { ModuleArtifactDescriptor } from './moduleArtifactVerifier'
import type { ModuleDeviceState } from './moduleDeviceStateStore'
import { ModuleReadinessReconciler } from './moduleReadinessReconciler'

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
        get: async () => ({ desiredInstalled: true, enabled: true }),
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
        readReadyMarkerBytes: async () => {
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
      pendingVersion: '1.0.0',
      activationPhase: 'pending',
    })
  })
})
