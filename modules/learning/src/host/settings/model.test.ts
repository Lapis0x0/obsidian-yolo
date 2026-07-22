import {
  LEARNING_SETTINGS_SCHEMA_VERSION,
  createLearningSettingsModel,
} from './model'

type ConfigSnapshot = ReturnType<YoloModuleHostApiV1['config']['getSnapshot']>

function createHarness(
  initial: ConfigSnapshot = { schemaVersion: 1, data: {} },
  initialModels: YoloModuleHostModelSnapshotV1 = {
    defaultModelId: 'provider/default',
    models: [
      { id: 'provider/default', name: 'Default', providerId: 'provider' },
      { id: 'provider/other', name: 'Other', providerId: 'provider' },
    ],
  },
) {
  let stored = initial
  let models = initialModels
  const configListeners = new Set<() => void>()
  const modelListeners = new Set<() => void>()
  const replace = jest.fn(async (next: ConfigSnapshot) => {
    stored = next
    for (const listener of configListeners) listener()
    return stored
  })
  const unsubscribeConfig = jest.fn()
  const unsubscribeModels = jest.fn()
  const config = {
    getSnapshot: jest.fn(() => stored),
    replace,
    subscribe: jest.fn((listener: () => void) => {
      configListeners.add(listener)
      return () => {
        configListeners.delete(listener)
        unsubscribeConfig()
      }
    }),
  } as YoloModuleHostApiV1['config']
  const settings = {
    getModelSnapshot: jest.fn(() => models),
    subscribeModels: jest.fn((listener: () => void) => {
      modelListeners.add(listener)
      return () => {
        modelListeners.delete(listener)
        unsubscribeModels()
      }
    }),
  } as unknown as YoloModuleHostApiV1['settings']
  return {
    config,
    settings,
    replace,
    unsubscribeConfig,
    unsubscribeModels,
    updateConfig(next: ConfigSnapshot) {
      stored = next
      for (const listener of configListeners) listener()
    },
    updateModels(next: YoloModuleHostModelSnapshotV1) {
      models = next
      for (const listener of modelListeners) listener()
    },
  }
}

describe('Learning settings model', () => {
  it('migrates the explicit schema-zero handoff and normalizes an invalid legacy model', async () => {
    const harness = createHarness({
      schemaVersion: 0,
      data: {
        modelId: 'disabled/model',
        betaNoticeAcknowledged: true,
      },
    })

    const model = await createLearningSettingsModel(harness)

    expect(model.getSnapshot()).toEqual({
      modelId: 'provider/default',
      betaNoticeAcknowledged: true,
    })
    expect(harness.replace).toHaveBeenCalledWith({
      schemaVersion: LEARNING_SETTINGS_SCHEMA_VERSION,
      data: {
        modelId: 'provider/default',
        betaNoticeAcknowledged: true,
      },
    })
  })

  it('rejects malformed legacy field types in favor of safe defaults', async () => {
    const harness = createHarness({
      schemaVersion: 0,
      data: { modelId: 42, betaNoticeAcknowledged: 'yes' },
    })

    const model = await createLearningSettingsModel(harness)

    expect(model.getSnapshot()).toEqual({
      modelId: 'provider/default',
      betaNoticeAcknowledged: false,
    })
    expect(harness.replace).toHaveBeenCalledWith({
      schemaVersion: 1,
      data: {
        modelId: 'provider/default',
        betaNoticeAcknowledged: false,
      },
    })
  })

  it('falls back to the first enabled model when the host default is unavailable', async () => {
    const harness = createHarness(
      { schemaVersion: 1, data: { modelId: 'missing' } },
      {
        defaultModelId: 'disabled/default',
        models: [{ id: 'enabled/first', name: 'First', providerId: 'enabled' }],
      },
    )

    const model = await createLearningSettingsModel(harness)

    expect(model.getSnapshot().modelId).toBe('enabled/first')
  })

  it('publishes config updates and persists beta acknowledgement', async () => {
    const harness = createHarness({
      schemaVersion: 1,
      data: { modelId: 'provider/other', betaNoticeAcknowledged: false },
    })
    const model = await createLearningSettingsModel(harness)
    const listener = jest.fn()
    model.subscribe(listener)

    harness.updateConfig({
      schemaVersion: 1,
      data: { modelId: 'provider/default', betaNoticeAcknowledged: false },
    })
    await model.acknowledgeBetaNotice()

    expect(model.getSnapshot()).toEqual({
      modelId: 'provider/default',
      betaNoticeAcknowledged: true,
    })
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('repairs a schema-zero handoff received through the config subscription', async () => {
    const harness = createHarness({
      schemaVersion: 1,
      data: { modelId: 'provider/default', betaNoticeAcknowledged: false },
    })
    const model = await createLearningSettingsModel(harness)

    harness.updateConfig({
      schemaVersion: 0,
      data: { modelId: 'provider/other', betaNoticeAcknowledged: true },
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(model.getSnapshot()).toEqual({
      modelId: 'provider/other',
      betaNoticeAcknowledged: true,
    })
    expect(harness.replace).toHaveBeenLastCalledWith({
      schemaVersion: 1,
      data: { modelId: 'provider/other', betaNoticeAcknowledged: true },
    })
  })

  it('falls back and persists when the selected model disappears', async () => {
    const harness = createHarness({
      schemaVersion: 1,
      data: { modelId: 'provider/other', betaNoticeAcknowledged: false },
    })
    const model = await createLearningSettingsModel(harness)
    const listener = jest.fn()
    model.subscribe(listener)

    harness.updateModels({
      defaultModelId: 'provider/default',
      models: [
        { id: 'provider/default', name: 'Default', providerId: 'provider' },
      ],
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(model.getSnapshot().modelId).toBe('provider/default')
    expect(listener).toHaveBeenCalledTimes(1)
    expect(harness.replace).toHaveBeenLastCalledWith({
      schemaVersion: 1,
      data: { modelId: 'provider/default', betaNoticeAcknowledged: false },
    })
  })

  it('keeps the published value unchanged when an explicit write fails', async () => {
    const harness = createHarness({
      schemaVersion: 1,
      data: { modelId: 'provider/default', betaNoticeAcknowledged: false },
    })
    const model = await createLearningSettingsModel(harness)
    harness.replace.mockRejectedValueOnce(new Error('disk full'))

    await expect(model.setModelId('provider/other')).rejects.toThrow(
      'disk full',
    )
    expect(model.getSnapshot().modelId).toBe('provider/default')
  })

  it('does not leave subscriptions behind when the initial migration write fails', async () => {
    const harness = createHarness({ schemaVersion: 0, data: {} })
    harness.replace.mockRejectedValueOnce(new Error('read only'))

    await expect(createLearningSettingsModel(harness)).rejects.toThrow(
      'read only',
    )
    expect(harness.config.subscribe).not.toHaveBeenCalled()
    expect(harness.settings.subscribeModels).not.toHaveBeenCalled()
  })

  it('unsubscribes once and stops publishing after disposal', async () => {
    const harness = createHarness({
      schemaVersion: 1,
      data: { modelId: 'provider/default', betaNoticeAcknowledged: false },
    })
    const model = await createLearningSettingsModel(harness)
    const listener = jest.fn()
    model.subscribe(listener)

    model.dispose()
    model.dispose()
    harness.updateConfig({
      schemaVersion: 1,
      data: { modelId: 'provider/other', betaNoticeAcknowledged: true },
    })
    harness.updateModels({ defaultModelId: '', models: [] })

    expect(listener).not.toHaveBeenCalled()
    expect(harness.unsubscribeConfig).toHaveBeenCalledTimes(1)
    expect(harness.unsubscribeModels).toHaveBeenCalledTimes(1)
    await expect(model.setModelId('provider/other')).rejects.toThrow('disposed')
  })
})
