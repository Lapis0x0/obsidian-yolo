import type { ModuleDeviceState } from './moduleDeviceStateStore'
import { ModuleUninstallCoordinator } from './moduleUninstallCoordinator'

describe('ModuleUninstallCoordinator', () => {
  test('discards a pending installation before removing local state', async () => {
    const state: ModuleDeviceState = {
      moduleId: 'learning',
      platform: 'desktop',
      active: null,
      pending: {
        descriptor: {
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
    const write = jest.fn(async (next: ModuleDeviceState) => next)
    const removeState = jest.fn(async () => undefined)
    const coordinator = new ModuleUninstallCoordinator({
      artifactStore: { removeVersionArtifacts: remove },
      deviceStateStore: {
        runExclusive: async (_id, operation) =>
          operation({
            read: async () => state,
            write,
            remove: removeState,
          }),
      },
      intentStore: {
        get: async () => 'uninstalled',
      },
      manager: { refresh: async () => undefined },
      runtime: {
        deactivate: async () => undefined,
        runWithModuleQuiesced: async (_id, operation) => operation(),
      },
      authorizeArtifactRemoval: async () => true,
      platform: 'desktop',
    })
    await expect(coordinator.uninstall('learning')).resolves.toBeUndefined()
    expect(write).toHaveBeenCalledWith({ ...state, pending: null })
    expect(removeState).toHaveBeenCalledTimes(1)
    expect(remove).toHaveBeenCalledWith('learning', '1.0.0')
  })
})
