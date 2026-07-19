import { ModuleActivationCoordinator } from './moduleActivationCoordinator'
import type { ModuleDeviceState } from './moduleDeviceStateStore'

const HASH = 'a'.repeat(64)

function pendingState(): ModuleDeviceState {
  return {
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
        manifest: { byteSize: 1, sha256: HASH },
      },
    },
  }
}

function coordinator(states: ModuleDeviceState[], enabled: boolean) {
  const durable = new Map(states.map((state) => [state.moduleId, state]))
  return {
    durable,
    value: new ModuleActivationCoordinator({
      deviceStateStore: {
        list: async () => [...durable.values()],
        runExclusive: async (moduleId, operation) =>
          operation({
            read: async () => durable.get(moduleId) ?? null,
            write: async (next) => {
              durable.set(moduleId, next)
              return next
            },
            remove: async () => {
              durable.delete(moduleId)
            },
          }),
      },
      intentStateSource: {
        load: async (ids) =>
          ids.map((id) => ({
            id,
            state: enabled ? ('enabled' as const) : ('disabled' as const),
          })),
      },
      artifactStore: {} as never,
      platform: 'desktop',
      hostApi: '1.0.0',
      loader: {
        load: async () => {
          throw new Error('not used')
        },
      },
      runtime: { activate: async () => undefined },
    }),
  }
}

describe('ModuleActivationCoordinator minimal state integration', () => {
  test('returns no results for an empty device state', async () => {
    const test = coordinator([], true)
    await expect(test.value.activatePersistedModules()).resolves.toEqual([])
  })

  test('leaves the target pending without executing code when intent is disabled', async () => {
    const test = coordinator([pendingState()], false)
    await expect(test.value.activatePersistedModules()).resolves.toEqual([
      expect.objectContaining({ moduleId: 'learning', status: 'skipped' }),
    ])
    expect(test.durable.get('learning')).toMatchObject({
      active: null,
      pending: expect.objectContaining({
        descriptor: expect.objectContaining({ version: '1.0.0' }),
      }),
    })
  })
})
