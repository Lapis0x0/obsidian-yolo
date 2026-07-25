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

describe('ModuleReadinessReconciler synchronized artifact arrival', () => {
  it('adopts a verified synchronized artifact without downloading it', async () => {
    const harness = createHarness(true)

    await expect(
      harness.reconciler.ensureModuleReady('learning', {
        waitForSynchronizedArtifact: true,
      }),
    ).resolves.toMatchObject({ status: 'ready', installedVersion: '1.0.0' })

    expect(harness.waitForArtifact).toHaveBeenCalledWith(
      'learning',
      '1.0.0',
      expect.any(Function),
      expect.any(AbortSignal),
    )
    expect(harness.install).not.toHaveBeenCalled()
    expect(harness.getState()).toMatchObject({
      active: null,
      pending: { descriptor: { version: '1.0.0' } },
    })
  })

  it('bypasses the grace period for a direct readiness request', async () => {
    const harness = createHarness(false)

    await harness.reconciler.ensureModuleReady('learning')

    expect(harness.waitForArtifact).not.toHaveBeenCalled()
    expect(harness.install).toHaveBeenCalledWith(
      descriptor,
      expect.any(AbortSignal),
    )
  })

  it('cancels an in-flight background grace when readiness is requested directly', async () => {
    const harness = createHarness(false, true)
    const background = harness.reconciler.ensureModuleReady('learning', {
      waitForSynchronizedArtifact: true,
    })
    await harness.graceStarted

    await expect(
      harness.reconciler.ensureModuleReady('learning'),
    ).resolves.toMatchObject({ status: 'ready' })
    await expect(background).resolves.toMatchObject({ status: 'skipped' })
    expect(harness.install).toHaveBeenCalledTimes(1)
  })
})

function createHarness(
  synchronizedArtifactReady: boolean,
  waitUntilCancelled = false,
) {
  let state: ModuleDeviceState | null = null
  let markGraceStarted: (() => void) | undefined
  const graceStarted = new Promise<void>((resolve) => {
    markGraceStarted = resolve
  })
  const waitForArtifact = jest.fn(
    async (
      _moduleId: string,
      _version: string,
      _isReady: () => Promise<boolean>,
      signal: AbortSignal,
    ) => {
      markGraceStarted?.()
      if (!waitUntilCancelled) return synchronizedArtifactReady
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true })
      })
      return false
    },
  )
  const install = jest.fn(async () => ({
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
  }))
  const reconciler = new ModuleReadinessReconciler({
    deviceStateStore: {
      runExclusive: async (_moduleId, operation) =>
        operation({
          read: async () => state,
          write: async (next) => {
            state = next
            return next
          },
          remove: async () => {
            state = null
          },
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
        throw new Error('not used')
      },
      readEntryBytes: async () => {
        throw new Error('not used')
      },
      listVersionFiles: async () => {
        throw new Error('not used')
      },
      removeVersionArtifacts: async () => undefined,
    },
    installer: {
      install,
      repair: async () => {
        throw new Error('not used')
      },
    },
    artifactArrivalGrace: { waitForArtifact },
    platform: 'desktop',
    subtleCrypto: { digest: async () => new ArrayBuffer(32) },
  })
  return {
    getState: () => state,
    graceStarted,
    install,
    reconciler,
    waitForArtifact,
  }
}
