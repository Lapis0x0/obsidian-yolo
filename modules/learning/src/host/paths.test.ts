import {
  LEARNING_MANAGED_DATA_NAMESPACE,
  createHostLearningSettings,
  getBaseDirFromContentRoot,
  runWithLearningManagedDataLock,
} from './paths'

type HostPaths = YoloModuleHostApiV1['paths']
type HostSettings = YoloModuleHostApiV1['settings']
type HostConfig = YoloModuleHostApiV1['config']

describe('host Learning settings', () => {
  it('provides dynamic paths and models and cleans up both subscriptions', () => {
    let contentRoot = 'YOLO/learning'
    let modelSnapshot: YoloModuleHostModelSnapshotV1 = {
      defaultModelId: 'model-a',
      models: [{ id: 'model-a', name: 'A', providerId: 'provider' }],
    }
    let pathListener: (() => void) | undefined
    let modelListener: (() => void) | undefined
    let configListener: (() => void) | undefined
    let configSnapshot = { schemaVersion: 1, data: {} }
    const unsubscribePaths = jest.fn()
    const unsubscribeModels = jest.fn()
    const unsubscribeConfig = jest.fn()
    const paths = {
      getSnapshot: () => ({ contentRoot }),
      subscribe: (listener: () => void) => {
        pathListener = listener
        return unsubscribePaths
      },
      runExclusive: async <T>(
        _namespace: string,
        operation: () => T | PromiseLike<T>,
      ): Promise<T> => await operation(),
    } as HostPaths
    const settings = {
      getModelSnapshot: () => modelSnapshot,
      subscribeModels: (listener: () => void) => {
        modelListener = listener
        return unsubscribeModels
      },
    } as unknown as HostSettings
    const config = {
      getSnapshot: () => configSnapshot,
      subscribe: (listener: () => void) => {
        configListener = listener
        return unsubscribeConfig
      },
    } as unknown as HostConfig
    const adapter = createHostLearningSettings(paths, settings, config)
    const listener = jest.fn()
    const unsubscribe = adapter.subscribe(listener)

    expect(adapter.getSnapshot()).toMatchObject({
      baseDir: 'YOLO',
      learningBaseDir: 'YOLO/learning',
      config: configSnapshot,
      models: { defaultModelId: 'model-a' },
    })
    contentRoot = 'Knowledge/YOLO/learning'
    pathListener?.()
    modelSnapshot = {
      defaultModelId: 'model-b',
      models: [{ id: 'model-b', name: 'B', providerId: 'provider' }],
    }
    modelListener?.()
    configSnapshot = { schemaVersion: 1, data: { enabled: true } }
    configListener?.()
    expect(listener).toHaveBeenCalledTimes(3)
    expect(listener.mock.calls[0][0].baseDir).toBe('Knowledge/YOLO')
    expect(listener.mock.calls[1][0].models.defaultModelId).toBe('model-b')
    expect(listener.mock.calls[2][0].config.data).toEqual({ enabled: true })

    unsubscribe()
    unsubscribe()
    expect(unsubscribePaths).toHaveBeenCalledTimes(1)
    expect(unsubscribeModels).toHaveBeenCalledTimes(1)
    expect(unsubscribeConfig).toHaveBeenCalledTimes(1)
  })

  it('rejects a content root that cannot identify the shared baseDir', () => {
    expect(() => getBaseDirFromContentRoot('YOLO/other')).toThrow(
      'Invalid Learning content root',
    )
  })

  it('uses the single managed-data namespace for shared mutations', async () => {
    const calls = jest.fn()
    const runExclusive = async <T>(
      namespace: string,
      operation: () => T | PromiseLike<T>,
    ): Promise<T> => {
      calls(namespace, operation)
      return await operation()
    }

    await expect(
      runWithLearningManagedDataLock({ runExclusive }, () => 'result'),
    ).resolves.toBe('result')
    expect(calls).toHaveBeenCalledWith(
      LEARNING_MANAGED_DATA_NAMESPACE,
      expect.any(Function),
    )
    expect(LEARNING_MANAGED_DATA_NAMESPACE).toBe('managed-data')
  })
})
