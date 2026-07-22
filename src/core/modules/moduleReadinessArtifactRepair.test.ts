import type { ModuleArtifactDescriptor } from './moduleArtifactVerifier'
import type { ModuleDeviceState } from './moduleDeviceStateStore'
import { ModuleReadinessReconciler } from './moduleReadinessReconciler'
import { ModuleArtifactMissingError } from './moduleStore'

const descriptor: ModuleArtifactDescriptor = {
  id: 'learning',
  version: '1.0.0',
  hostApi: '^1.0.0',
  platform: 'desktop',
  dataSchemas: {},
  manifestUrl:
    'https://github.com/Lapis0x0/obsidian-yolo/releases/download/learning-v1.0.0/module.json',
  manifest: { byteSize: 1, sha256: 'a'.repeat(64) },
}

describe('ModuleReadinessReconciler persisted artifact repair', () => {
  it('automatically reinstalls a persisted version whose files are missing', async () => {
    const harness = createHarness(
      new ModuleArtifactMissingError(
        'config/plugins/yolo/modules/learning/1.0.0/module.json',
      ),
    )

    await expect(
      harness.reconciler.ensureModuleReady('learning'),
    ).resolves.toMatchObject({
      status: 'ready',
      repairedVersions: ['1.0.0'],
    })
    expect(harness.install).toHaveBeenCalledWith(
      descriptor,
      expect.any(AbortSignal),
    )
    expect(harness.repair).not.toHaveBeenCalled()
  })

  it('does not overwrite artifacts after an unclassified storage failure', async () => {
    const harness = createHarness(new Error('permission denied'))

    await expect(
      harness.reconciler.ensureModuleReady('learning'),
    ).rejects.toThrow('permission denied')
    expect(harness.install).not.toHaveBeenCalled()
    expect(harness.repair).not.toHaveBeenCalled()
  })
})

function createHarness(readError: Error) {
  const state: ModuleDeviceState = {
    moduleId: 'learning',
    platform: 'desktop',
    active: descriptor,
    pending: null,
  }
  const install = jest.fn(async () => installedManifest())
  const repair = jest.fn(async () => installedManifest())
  const reconciler = new ModuleReadinessReconciler({
    deviceStateStore: {
      runExclusive: async (_moduleId, operation) =>
        operation({
          read: async () => state,
          write: async (next) => next,
          remove: async () => undefined,
        }),
    },
    intentStore: { get: async () => 'enabled' },
    catalogSource: {
      getResolvedVersion: () => ({
        version: descriptor.version,
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
        throw readError
      },
      readEntryBytes: async () => {
        throw readError
      },
      listVersionFiles: async () => {
        throw readError
      },
      removeVersionArtifacts: async () => undefined,
    },
    installer: { install, repair },
    platform: 'desktop',
    subtleCrypto: { digest: async () => new ArrayBuffer(32) },
  })
  return { install, reconciler, repair }
}

function installedManifest() {
  return {
    schemaVersion: 1 as const,
    id: 'learning',
    version: '1.0.0',
    hostApi: '^1.0.0',
    dataSchemas: {},
    variants: [
      {
        platform: 'desktop' as const,
        entry: 'main.js',
        files: [],
      },
    ],
  }
}
