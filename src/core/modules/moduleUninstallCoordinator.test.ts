import type { ModuleDeviceState } from './moduleDeviceStateStore'
import { ModuleUninstallCoordinator } from './moduleUninstallCoordinator'

describe('ModuleUninstallCoordinator pending activation guard', () => {
  test('does not remove artifacts while activation is pending', async () => {
    const state: ModuleDeviceState = {
      moduleId: 'learning',
      platform: 'desktop',
      activeVersion: null,
      pendingVersion: '1.0.0',
      activationPhase: 'pending',
      readyVersions: {
        '1.0.0': {
          id: 'learning',
          version: '1.0.0',
          hostApi: '^1.0.0',
          platform: 'desktop',
          dataSchemas: {},
          manifestUrl:
            'https://github.com/Lapis0x0/obsidian-yolo/releases/download/learning-v1.0.0/module.json',
          manifest: { byteSize: 1, sha256: 'a'.repeat(64) },
        },
      },
    }
    const remove = jest.fn(async () => undefined)
    const coordinator = new ModuleUninstallCoordinator({
      artifactStore: { removeVersionArtifacts: remove },
      deviceStateStore: {
        runExclusive: async (_id, operation) =>
          operation({
            read: async () => state,
            write: async (next) => next,
            remove: async () => undefined,
          }),
      },
      intentStore: {
        get: async () => ({ desiredInstalled: false, enabled: false }),
      },
      manager: { refresh: async () => undefined },
      runtime: { runWithModuleQuiesced: async (_id, operation) => operation() },
      authorizeArtifactRemoval: async () => true,
      platform: 'desktop',
    })
    await expect(coordinator.uninstall('learning')).rejects.toThrow(
      'blocked by a pending activation',
    )
    expect(remove).not.toHaveBeenCalled()
  })
})
