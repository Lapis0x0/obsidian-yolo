import { SynchronizedModuleIntentStateSource } from './moduleIntentStateSource'
import type { ModuleIntent } from './moduleIntentStore'

describe('SynchronizedModuleIntentStateSource', () => {
  it('reads sorted unique IDs and omits missing intent', async () => {
    const get = jest.fn(
      async (id: string): Promise<ModuleIntent | undefined> =>
        id === 'catalog' ? 'disabled' : undefined,
    )
    const source = new SynchronizedModuleIntentStateSource({ store: { get } })

    const result = await source.load(['device', 'catalog', 'device'])

    expect(get.mock.calls.map(([id]) => id)).toEqual(['catalog', 'device'])
    expect(result).toEqual([{ id: 'catalog', state: 'disabled' }])
    expect(Object.isFrozen(result)).toBe(true)
    expect(result.every(Object.isFrozen)).toBe(true)
  })

  it('projects all three states without coercion', async () => {
    const states: ModuleIntent[] = ['uninstalled', 'disabled', 'enabled']
    const source = new SynchronizedModuleIntentStateSource({
      store: { get: async (id: string) => states[Number(id)] },
    })

    await expect(source.load(['0', '1', '2'])).resolves.toEqual(
      states.map((state, id) => ({ id: String(id), state })),
    )
  })
})
