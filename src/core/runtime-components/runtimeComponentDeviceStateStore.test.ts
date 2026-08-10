import { RuntimeComponentDeviceStateStore } from './runtimeComponentDeviceStateStore'

describe('RuntimeComponentDeviceStateStore retry state', () => {
  it('reads schema 1 state and writes the retry-aware schema 2 state', async () => {
    const path = 'runtime/tokenizer.json'
    const files = new Map<string, string>([
      [
        path,
        JSON.stringify({
          schemaVersion: 1,
          data: {
            componentId: 'tokenizer',
            platform: 'desktop',
            activeHash: null,
            pending: null,
            error: null,
          },
        }),
      ],
    ])
    const store = new RuntimeComponentDeviceStateStore({
      kind: 'device-local-runtime-state',
      rootPath: 'runtime',
      adapter: {
        exists: async (target) => target === 'runtime' || files.has(target),
        mkdir: async () => undefined,
        read: async (target) => {
          const value = files.get(target)
          if (value === undefined) throw new Error(`Missing ${target}`)
          return value
        },
        write: async (target, value) => {
          files.set(target, value)
        },
        remove: async (target) => {
          files.delete(target)
        },
      },
    })

    const legacy = await store.read('tokenizer')
    expect(legacy).toMatchObject({ retry: null })

    await store.write({
      ...legacy!,
      error: 'network timeout',
      retry: {
        descriptorHash: 'a'.repeat(64),
        automaticRetryCount: 2,
        retryAt: 1234,
      },
    })

    expect(JSON.parse(files.get(path)!)).toMatchObject({
      schemaVersion: 2,
      data: {
        error: 'network timeout',
        retry: {
          descriptorHash: 'a'.repeat(64),
          automaticRetryCount: 2,
          retryAt: 1234,
        },
      },
    })
  })
})
