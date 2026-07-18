import { ModuleLifecycleScope } from './lifecycleScope'
import {
  ModuleSettingsCapabilityProvider,
  ModuleSettingsContributionRegistry,
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

    expect(add).toHaveBeenCalledWith('learning', {
      id: 'learning',
      title: 'Learning',
      fields: [{ key: 'modelId', type: 'model', name: 'Model' }],
    })
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
    expect(registry.getSnapshot()).toEqual([
      { moduleId: 'learning', contribution: learning },
      { moduleId: 'notes', contribution: notes },
    ])

    registry.remove('learning', 'missing')
    expect(listener).toHaveBeenCalledTimes(2)
    registry.remove('learning', 'general')
    expect(registry.getSnapshot()).toEqual([
      { moduleId: 'notes', contribution: notes },
    ])
    expect(listener).toHaveBeenCalledTimes(3)

    unsubscribe()
    registry.clear()
    expect(listener).toHaveBeenCalledTimes(3)
  })
})
