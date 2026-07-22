import { ModuleLifecycleScope } from './lifecycleScope'
import {
  ModuleSettingsCapabilityProvider,
  ModuleSettingsContributionRegistry,
  resolveSettingsContribution,
} from './moduleSettingsContributions'

describe('ModuleSettingsCapabilityProvider', () => {
  it('stages immutable declarations, publishes by module, and cleans them up', () => {
    const add = jest.fn()
    const remove = jest.fn()
    const lifecycle = new ModuleLifecycleScope()
    const activation = new ModuleSettingsCapabilityProvider({
      sink: { add, remove },
      getModelSnapshot: () => ({ defaultModelId: '', models: [] }),
      subscribeModels: () => () => undefined,
    }).create('learning', lifecycle)
    const declaration = {
      id: 'learning',
      title: 'Learning',
      fields: [{ key: 'modelId', type: 'model' as const, name: 'Model' }],
    }

    activation.api.contribute(declaration)
    declaration.fields[0].name = 'Changed'
    expect(add).not.toHaveBeenCalled()
    activation.activate()
    activation.commit()

    expect(add).toHaveBeenCalledWith(
      'learning',
      {
        id: 'learning',
        title: 'Learning',
        fields: [{ key: 'modelId', type: 'model', name: 'Model' }],
      },
      expect.any(Object),
    )
    expect(Object.isFrozen(add.mock.calls[0][1].fields)).toBe(true)
    lifecycle.dispose()
    expect(remove).toHaveBeenCalledWith('learning', 'learning')
  })

  it('returns only copied model DTOs and revokes subscriptions on disposal', () => {
    let hostListener: (() => void) | undefined
    const unsubscribe = jest.fn()
    const models = [
      {
        id: 'provider/model',
        name: 'Model',
        providerId: 'provider',
        secret: 'hidden',
      },
    ]
    const lifecycle = new ModuleLifecycleScope()
    const activation = new ModuleSettingsCapabilityProvider({
      sink: { add: jest.fn(), remove: jest.fn() },
      getModelSnapshot: () => ({ defaultModelId: 'provider/model', models }),
      subscribeModels: (listener) => {
        hostListener = listener
        return unsubscribe
      },
    }).create('learning', lifecycle)
    activation.activate()
    const listener = jest.fn()
    activation.api.subscribeModels(listener)

    expect(activation.api.getModelSnapshot()).toEqual({
      defaultModelId: 'provider/model',
      models: [{ id: 'provider/model', name: 'Model', providerId: 'provider' }],
    })
    expect(activation.api.getModelSnapshot().models[0]).not.toBe(models[0])
    hostListener?.()
    expect(listener).toHaveBeenCalledTimes(1)

    lifecycle.dispose()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    hostListener?.()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(() => activation.api.getModelSnapshot()).toThrow('not active')
  })

  it('rejects duplicate fields and malformed model snapshots', () => {
    const lifecycle = new ModuleLifecycleScope()
    const activation = new ModuleSettingsCapabilityProvider({
      sink: { add: jest.fn(), remove: jest.fn() },
      getModelSnapshot: () => ({
        defaultModelId: '',
        models: [{ id: '', name: 'x', providerId: 'p' }],
      }),
      subscribeModels: () => () => undefined,
    }).create('learning', lifecycle)
    expect(() =>
      activation.api.contribute({
        id: 'settings',
        title: 'Settings',
        fields: [
          { key: 'same', type: 'text', name: 'First' },
          { key: 'same', type: 'toggle', name: 'Second' },
        ],
      }),
    ).toThrow('Duplicate settings field')
    activation.activate()
    expect(() => activation.api.getModelSnapshot()).toThrow('Model id')
    lifecycle.dispose()
  })

  it('copies, freezes, validates, and resolves localized declarations', () => {
    const lifecycle = new ModuleLifecycleScope()
    const add = jest.fn()
    const activation = new ModuleSettingsCapabilityProvider({
      sink: { add, remove: jest.fn() },
      getModelSnapshot: () => ({ defaultModelId: '', models: [] }),
      subscribeModels: () => () => undefined,
    }).create('learning', lifecycle)
    const localizations = {
      en: {
        title: 'Generation',
        fields: { modelId: { name: 'Model', description: 'Generate content' } },
      },
      zh: {
        title: '内容生成',
        fields: { modelId: { name: '模型', description: '生成内容' } },
      },
    }
    activation.api.contribute({
      id: 'generation',
      icon: 'graduation-cap',
      title: 'Generation',
      fields: [
        {
          key: 'modelId',
          type: 'model',
          name: 'Model',
          description: 'Generate content',
        },
      ],
      localizations,
    })
    localizations.zh.title = 'Changed'
    activation.activate()
    activation.commit()
    const contribution = add.mock.calls[0]?.[1]

    expect(resolveSettingsContribution(contribution, 'zh-CN')).toEqual({
      title: '内容生成',
      fields: [
        {
          key: 'modelId',
          type: 'model',
          name: '模型',
          description: '生成内容',
        },
      ],
    })
    expect(Object.isFrozen(contribution.localizations.zh.fields)).toBe(true)

    expect(() =>
      activation.api.contribute({
        id: 'late',
        title: 'Late',
        fields: [],
      }),
    ).toThrow('already committed')
    lifecycle.dispose()
  })

  it('rejects missing and unknown localized fields', () => {
    const lifecycle = new ModuleLifecycleScope()
    const activation = new ModuleSettingsCapabilityProvider({
      sink: { add: jest.fn(), remove: jest.fn() },
      getModelSnapshot: () => ({ defaultModelId: '', models: [] }),
      subscribeModels: () => () => undefined,
    }).create('learning', lifecycle)
    expect(() =>
      activation.api.contribute({
        id: 'generation',
        title: 'Generation',
        fields: [{ key: 'modelId', type: 'model', name: 'Model' }],
        localizations: {
          en: { title: 'Generation', fields: { other: { name: 'Other' } } },
        },
      }),
    ).toThrow('unknown field')
    lifecycle.dispose()
  })

  it('writes a model field to schema-one module config and reads it back', async () => {
    let config = {
      schemaVersion: 0,
      data: { modelId: 'old/model', betaNoticeAcknowledged: true },
    }
    const configListeners = new Set<() => void>()
    const registry = new ModuleSettingsContributionRegistry()
    const lifecycle = new ModuleLifecycleScope()
    const activation = new ModuleSettingsCapabilityProvider({
      sink: registry,
      getModelSnapshot: () => ({
        defaultModelId: 'provider/default',
        models: [
          { id: 'provider/default', name: 'Default', providerId: 'provider' },
          { id: 'provider/other', name: 'Other', providerId: 'provider' },
        ],
      }),
      subscribeModels: () => () => undefined,
      createConfigAdapter: () => ({
        read: async () => config,
        replace: async (next) => {
          config = next as typeof config
          for (const listener of configListeners) listener()
          return config
        },
        subscribe: (listener) => {
          configListeners.add(listener)
          return () => configListeners.delete(listener)
        },
      }),
    }).create('learning', lifecycle)
    activation.api.contribute({
      id: 'learning',
      title: 'Generation',
      fields: [{ key: 'modelId', type: 'model', name: 'Model' }],
    })
    activation.activate()
    activation.commit()

    const registration = registry.getSnapshot()[0]
    await registration.fields.write('modelId', 'provider/other')

    expect(config).toEqual({
      schemaVersion: 1,
      data: { modelId: 'provider/other', betaNoticeAcknowledged: true },
    })
    expect(await registration.fields.getSnapshot()).toEqual({
      values: { modelId: 'provider/other' },
      models: {
        defaultModelId: 'provider/default',
        models: [
          { id: 'provider/default', name: 'Default', providerId: 'provider' },
          { id: 'provider/other', name: 'Other', providerId: 'provider' },
        ],
      },
    })

    lifecycle.dispose()
    expect(registry.getSnapshot()).toEqual([])
  })
})

describe('ModuleSettingsContributionRegistry', () => {
  it('publishes deterministic snapshots and removes owned contributions', () => {
    const registry = new ModuleSettingsContributionRegistry()
    const listener = jest.fn()
    const unsubscribe = registry.subscribe(listener)
    const learning = Object.freeze({
      id: 'general',
      title: 'Learning',
      fields: Object.freeze([]),
    })
    const notes = Object.freeze({
      id: 'general',
      title: 'Notes',
      fields: Object.freeze([]),
    })

    registry.add('notes', notes)
    registry.add('learning', learning)
    const sorted = registry.getSnapshot()
    expect(registry.getSnapshot()).toBe(sorted)
    expect(sorted).toEqual([
      {
        moduleId: 'learning',
        contribution: learning,
        fields: expect.any(Object),
      },
      { moduleId: 'notes', contribution: notes, fields: expect.any(Object) },
    ])

    registry.remove('learning', 'missing')
    expect(listener).toHaveBeenCalledTimes(2)
    registry.remove('learning', 'general')
    expect(registry.getSnapshot()).toEqual([
      { moduleId: 'notes', contribution: notes, fields: expect.any(Object) },
    ])
    expect(listener).toHaveBeenCalledTimes(3)

    registry.add('learning', learning)
    expect(
      registry.getSnapshot().some(({ moduleId }) => moduleId === 'learning'),
    ).toBe(true)
    registry.remove('learning', 'general')
    expect(
      registry.getSnapshot().some(({ moduleId }) => moduleId === 'learning'),
    ).toBe(false)

    unsubscribe()
    registry.clear()
    expect(listener).toHaveBeenCalledTimes(5)
  })

  it('rejects conflicting icons for one module', () => {
    const registry = new ModuleSettingsContributionRegistry()
    registry.add('learning', {
      id: 'general',
      icon: 'graduation-cap',
      title: 'General',
      fields: [],
    })
    expect(() =>
      registry.add('learning', {
        id: 'advanced',
        icon: 'brain',
        title: 'Advanced',
        fields: [],
      }),
    ).toThrow('conflicting icons')
  })
})
