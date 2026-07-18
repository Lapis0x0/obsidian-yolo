import { SynchronizedModuleIntentStateSource } from './moduleIntentStateSource'
import type { ModuleIntent } from './moduleIntentStore'

describe('SynchronizedModuleIntentStateSource', () => {
  it('reads only sorted unique union IDs and omits missing intent', async () => {
    const get = jest.fn(
      async (id: string): Promise<ModuleIntent | undefined> =>
        id === 'catalog'
          ? Object.freeze({ desiredInstalled: true, enabled: false })
          : undefined,
    )
    const source = new SynchronizedModuleIntentStateSource({ store: { get } })

    const result = await source.load(['device', 'catalog', 'device'])

    expect(get.mock.calls.map(([id]) => id)).toEqual(['catalog', 'device'])
    expect(result).toEqual([
      { id: 'catalog', desiredInstalled: true, enabled: false },
    ])
    expect(Object.isFrozen(result)).toBe(true)
    expect(result.every(Object.isFrozen)).toBe(true)
    expect(get).not.toHaveBeenCalledWith('unknown')
  })

  it('projects all four boolean combinations without coercion', async () => {
    const combinations: ModuleIntent[] = [
      { desiredInstalled: false, enabled: false },
      { desiredInstalled: false, enabled: true },
      { desiredInstalled: true, enabled: false },
      { desiredInstalled: true, enabled: true },
    ]
    const source = new SynchronizedModuleIntentStateSource({
      store: { get: async (id: string) => combinations[Number(id)] },
    })

    await expect(source.load(['0', '1', '2', '3'])).resolves.toEqual(
      combinations.map((intent, id) => ({ id: String(id), ...intent })),
    )
  })
})
