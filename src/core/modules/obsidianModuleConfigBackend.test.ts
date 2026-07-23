import type { App, DataAdapter, EventRef, Vault } from 'obsidian'

import {
  createObsidianModuleConfigBackendFactory,
  readObsidianModuleConfigEnvelopes,
  writeObsidianModuleConfigEnvelopes,
} from './obsidianModuleConfigBackend'

class MemoryAdapter {
  readonly files = new Map<string, string>()
  readonly folders = new Set<string>()
  async exists(path: string) {
    return this.files.has(path) || this.folders.has(path)
  }
  async mkdir(path: string) {
    this.folders.add(path)
  }
  async read(path: string) {
    const value = this.files.get(path)
    if (value === undefined) throw new Error('missing')
    return value
  }
  async write(path: string, data: string) {
    this.files.set(path, data)
  }
  async create(path: string, data: string) {
    this.files.set(path, data)
  }
  async remove(path: string) {
    this.files.delete(path)
  }
  async list(path: string) {
    const prefix = `${path}/`
    return {
      files: [...this.files.keys()].filter((file) => file.startsWith(prefix)),
      folders: [],
    }
  }
}

describe('createObsidianModuleConfigBackendFactory', () => {
  test('reads and writes module settings under the current managed root', async () => {
    const adapter = new MemoryAdapter()
    const handlers = new Map<EventRef, (...args: never[]) => void>()
    const vault = {
      adapter: adapter as unknown as DataAdapter,
      create: (path: string, data: string) => adapter.create(path, data),
      on: (_event: string, handler: (...args: never[]) => void) => {
        const ref = {} as EventRef
        handlers.set(ref, handler)
        return ref
      },
      offref: (ref: EventRef) => {
        handlers.delete(ref)
      },
    } as unknown as Vault
    const factory = createObsidianModuleConfigBackendFactory<{
      enabled: boolean
    }>({
      app: { vault } as App,
      getSettings: () => ({ yolo: { baseDir: 'YOLO' } }),
      subscribeSettingsChange: () => () => undefined,
    })
    const backend = factory('notes')
    await backend.write({ schemaVersion: 1, data: { enabled: true } })
    await expect(backend.read()).resolves.toEqual({
      schemaVersion: 1,
      data: { enabled: true },
    })
  })

  test('rejects unsafe module ids', () => {
    const factory = createObsidianModuleConfigBackendFactory({
      app: { vault: {} as Vault } as App,
      getSettings: () => ({ yolo: { baseDir: 'YOLO' } }),
      subscribeSettingsChange: () => () => undefined,
    })
    expect(() => factory('../notes')).toThrow('path segment')
  })

  test('transfers generic module settings at the supplied final baseDir', async () => {
    const adapter = new MemoryAdapter()
    const app = { vault: { adapter } } as unknown as App
    await writeObsidianModuleConfigEnvelopes(
      app,
      { yolo: { baseDir: 'Restored/YOLO' } },
      { learning: { schemaVersion: 1, data: { modelId: 'model-a' } } },
    )

    expect(
      adapter.files.has(
        'Restored/YOLO/.yolo_json_db/module-settings/learning.json',
      ),
    ).toBe(true)
    await expect(
      readObsidianModuleConfigEnvelopes(app, {
        yolo: { baseDir: 'Restored/YOLO' },
      }),
    ).resolves.toEqual({
      learning: { schemaVersion: 1, data: { modelId: 'model-a' } },
    })
  })

  test('publishes imported config writes to an active backend subscription', async () => {
    const adapter = new MemoryAdapter()
    const vault = {
      adapter: adapter as unknown as DataAdapter,
      on: () => ({}) as EventRef,
      offref: () => undefined,
    } as unknown as Vault
    const app = { vault } as App
    const factory = createObsidianModuleConfigBackendFactory({
      app,
      getSettings: () => ({ yolo: { baseDir: 'YOLO' } }),
      subscribeSettingsChange: () => () => undefined,
    })
    const listener = jest.fn()
    const unsubscribe = factory('learning').subscribe(listener)
    await writeObsidianModuleConfigEnvelopes(
      app,
      { yolo: { baseDir: 'YOLO' } },
      {
        learning: { schemaVersion: 1, data: { modelId: 'model-a' } },
      },
    )
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  test('isolates throwing config write listeners', async () => {
    const adapter = new MemoryAdapter()
    const vault = {
      adapter: adapter as unknown as DataAdapter,
      on: () => ({}),
      offref: () => undefined,
    } as unknown as Vault
    const app = { vault } as App
    const factory = createObsidianModuleConfigBackendFactory({
      app,
      getSettings: () => ({ yolo: { baseDir: 'YOLO' } }),
      subscribeSettingsChange: () => () => undefined,
    })
    const throwing = factory('learning').subscribe(() => {
      throw new Error('listener')
    })
    const observed = jest.fn()
    const unsubscribe = factory('learning').subscribe(observed)
    await expect(
      writeObsidianModuleConfigEnvelopes(
        app,
        { yolo: { baseDir: 'YOLO' } },
        { learning: { schemaVersion: 1, data: {} } },
      ),
    ).resolves.toBeUndefined()
    expect(observed).toHaveBeenCalledTimes(1)
    throwing()
    unsubscribe()
  })
})
