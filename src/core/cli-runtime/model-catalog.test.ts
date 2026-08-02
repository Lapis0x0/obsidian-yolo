import {
  CliModelCatalogService,
  type CliModelCatalogStore,
} from './model-catalog'

const models = [{ id: 'one', label: 'One', reasoningEfforts: [] }]

describe('CliModelCatalogService', () => {
  it('publishes persisted models immediately and only publishes changed refreshes', async () => {
    const write = jest.fn(async () => undefined)
    const store: CliModelCatalogStore = {
      read: async () => new Map([['codex', models]]),
      write,
    }
    const service = new CliModelCatalogService(store)
    const listener = jest.fn()
    service.subscribe(listener)

    await service.load()
    expect(service.getSnapshot().get('codex')).toEqual(models)
    expect(listener).toHaveBeenCalledTimes(1)

    await service.refresh('codex', async () => models)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(write).not.toHaveBeenCalled()

    await service.refresh('codex', async () => [
      ...models,
      { id: 'two', label: 'Two', reasoningEfforts: [] },
    ])
    expect(listener).toHaveBeenCalledTimes(2)
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('deduplicates concurrent provider refreshes and keeps cached data on failure', async () => {
    const store: CliModelCatalogStore = {
      read: async () => new Map([['codex', models]]),
      write: async () => undefined,
    }
    const service = new CliModelCatalogService(store)
    const loader = jest.fn(async () => {
      throw new Error('offline')
    })

    const first = service.refresh('codex', loader)
    const second = service.refresh('codex', loader)
    expect(second).toBe(first)
    await expect(first).rejects.toThrow('offline')
    expect(loader).toHaveBeenCalledTimes(1)
    expect(service.getSnapshot().get('codex')).toEqual(models)
  })
})
