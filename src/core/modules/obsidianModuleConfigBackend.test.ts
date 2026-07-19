import type { App, DataAdapter, EventRef, Vault } from 'obsidian'

import { createObsidianModuleConfigBackendFactory } from './obsidianModuleConfigBackend'

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
})
