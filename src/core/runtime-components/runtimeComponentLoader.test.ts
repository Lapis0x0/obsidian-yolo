import type { BlobScriptHost } from '../modules/scriptExecutor'

import type { RuntimeComponentDefinition } from './contracts'
import { RuntimeComponentLoader } from './runtimeComponentLoader'
import type { RuntimeComponentDescriptor } from './runtimeComponentManifest'

const descriptor: RuntimeComponentDescriptor & { id: 'tokenizer' } = {
  id: 'tokenizer',
  platforms: ['desktop', 'mobile'],
  nameKey: 'name',
  descriptionKey: 'description',
  impactKey: 'impact',
  entry: 'runtime-components/tokenizer/dist/entry.js',
  byteSize: 1,
  sha256: 'a'.repeat(64),
}

function host(
  register: (
    callback: (definition: RuntimeComponentDefinition) => void,
  ) => void,
): BlobScriptHost {
  let bridge: unknown
  return {
    setBridge: (_name, value) => {
      bridge = value
      return () => {
        bridge = undefined
      }
    },
    createScriptUrl: () => 'blob:test',
    appendScript: (_url, onLoad, onError) => {
      try {
        register(bridge as (definition: RuntimeComponentDefinition) => void)
        onLoad()
      } catch (error) {
        onError(error)
      }
      return { remove: () => undefined }
    },
    revokeScriptUrl: () => undefined,
  }
}

describe('RuntimeComponentLoader', () => {
  it('captures exactly one synchronous definition with the descriptor id', async () => {
    const definition: RuntimeComponentDefinition<'tokenizer'> = {
      id: 'tokenizer',
      create: () => ({
        count: (text) => text.length,
        dispose: () => undefined,
      }),
    }
    const loader = new RuntimeComponentLoader(
      host((register) => register(definition)),
    )
    await expect(
      loader.load(descriptor, new TextEncoder().encode('source')),
    ).resolves.toBe(definition)
  })

  it('rejects duplicate and mismatched registrations', async () => {
    const definition: RuntimeComponentDefinition<'tokenizer'> = {
      id: 'tokenizer',
      create: () => ({
        count: (text) => text.length,
        dispose: () => undefined,
      }),
    }
    const duplicate = new RuntimeComponentLoader(
      host((register) => {
        register(definition)
        register(definition)
      }),
    )
    await expect(
      duplicate.load(descriptor, new TextEncoder().encode('source')),
    ).rejects.toThrow('more than once')

    const mismatch = new RuntimeComponentLoader(
      host((register) =>
        register({ id: 'pdf-engine', create: () => ({}) as never }),
      ),
    )
    await expect(
      mismatch.load(descriptor, new TextEncoder().encode('source')),
    ).rejects.toThrow('does not match')
  })
})
