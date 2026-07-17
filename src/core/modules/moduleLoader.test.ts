import { ModuleLoader } from './moduleLoader'
import type {
  ModuleRegistrationCapture,
  ModuleScriptExecutor,
} from './scriptExecutor'
import type { YoloModuleDefinition, YoloModuleEntry } from './types'

const encoder = new TextEncoder()
const SHA256_BY_SOURCE: Record<string, string> = {
  entry: '923fe53966c6cd9343e11af776cd4b05be315ea4b200b02e4d5dfb0f929b73bf',
  'module source':
    '9bd535ac63d757a5c85a246f8c017058edd0488f5eb1b70eb393910b89e6985d',
  second: '16367aacb67a4a017c8da8ab95682ccb390863780f7114dda0a0e0c55644c7c4',
}

function fromHex(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}

const subtleCrypto: Pick<SubtleCrypto, 'digest'> = {
  digest: async (algorithm, data) => {
    if (algorithm !== 'SHA-256') throw new Error('Expected SHA-256')
    const bytes =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    const digest = SHA256_BY_SOURCE[new TextDecoder().decode(bytes)]
    if (!digest) throw new Error('Unexpected test input')
    return fromHex(digest).buffer
  },
}

function entryFor(
  id: string,
  source = 'entry',
): {
  entry: YoloModuleEntry
  bytes: Uint8Array
} {
  const bytes = encoder.encode(source)
  return {
    entry: {
      id,
      byteSize: bytes.byteLength,
      sha256: SHA256_BY_SOURCE[source],
    },
    bytes,
  }
}

class FakeExecutor implements ModuleScriptExecutor {
  active = 0
  maxActive = 0
  readonly sources: string[] = []

  constructor(
    private readonly run: (
      capture: ModuleRegistrationCapture,
      source: string,
    ) => void | Promise<void>,
  ) {}

  async execute(
    source: string,
    capture: ModuleRegistrationCapture,
  ): Promise<void> {
    this.sources.push(source)
    this.active += 1
    this.maxActive = Math.max(this.maxActive, this.active)
    try {
      const result = this.run(capture, source)
      capture.closeRegistration()
      await result
    } finally {
      capture.closeRegistration()
      this.active -= 1
    }
  }
}

const definition = (id: string): YoloModuleDefinition => ({
  id,
  activate: () => undefined,
})

describe('ModuleLoader', () => {
  it('verifies bytes and returns exactly one synchronous registration', async () => {
    const artifact = entryFor('notes', 'module source')
    const registered = definition('notes')
    const executor = new FakeExecutor((capture) => {
      capture.registration.registerModule(registered)
    })
    const loader = new ModuleLoader({
      executor,
      subtleCrypto,
    })

    await expect(loader.load(artifact.entry, artifact.bytes)).resolves.toBe(
      registered,
    )
    expect(executor.sources).toEqual(['module source'])
  })

  it('rejects byte-size and SHA-256 mismatches before execution', async () => {
    const artifact = entryFor('notes')
    const executor = new FakeExecutor(() => undefined)
    const loader = new ModuleLoader({
      executor,
      subtleCrypto,
    })

    await expect(
      loader.load(
        { ...artifact.entry, byteSize: artifact.bytes.length + 1 },
        artifact.bytes,
      ),
    ).rejects.toThrow('entry size mismatch')
    await expect(
      loader.load(
        { ...artifact.entry, sha256: '0'.repeat(64) },
        artifact.bytes,
      ),
    ).rejects.toThrow('entry SHA-256 mismatch')
    expect(executor.sources).toEqual([])
  })

  it('rejects empty, multiple, and wrong-id registrations', async () => {
    const artifact = entryFor('expected')
    const cases: Array<[string, (capture: ModuleRegistrationCapture) => void]> =
      [
        ['did not register', () => undefined],
        [
          'more than one',
          (capture) => {
            capture.registration.registerModule(definition('expected'))
            try {
              capture.registration.registerModule(definition('expected'))
            } catch {
              // The loader must retain the violation even if script code catches it.
            }
          },
        ],
        [
          'expected id "expected"',
          (capture) => capture.registration.registerModule(definition('other')),
        ],
      ]

    for (const [message, run] of cases) {
      const loader = new ModuleLoader({
        executor: new FakeExecutor(run),
        subtleCrypto,
      })
      await expect(loader.load(artifact.entry, artifact.bytes)).rejects.toThrow(
        message,
      )
    }
  })

  it('closes registration before asynchronous executor work', async () => {
    const artifact = entryFor('late')
    const executor = new FakeExecutor(async (capture) => {
      await Promise.resolve()
      capture.registration.registerModule(definition('late'))
    })
    const loader = new ModuleLoader({
      executor,
      subtleCrypto,
    })

    await expect(loader.load(artifact.entry, artifact.bytes)).rejects.toThrow(
      'registration must be synchronous',
    )
  })

  it('serializes execution and continues after a failed load', async () => {
    const first = entryFor('first')
    const second = entryFor('second', 'second')
    let releaseFirst!: () => void
    const blocked = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const executor = new FakeExecutor(async (capture, source) => {
      if (source === 'entry') await blocked
      capture.registration.registerModule(
        definition(source === 'entry' ? 'wrong' : 'second'),
      )
    })
    const loader = new ModuleLoader({
      executor,
      subtleCrypto,
    })
    const firstLoad = loader.load(first.entry, first.bytes)
    const secondLoad = loader.load(second.entry, encoder.encode('second'))
    releaseFirst()

    await expect(firstLoad).rejects.toThrow()
    await expect(secondLoad).resolves.toMatchObject({ id: 'second' })
    expect(executor.maxActive).toBe(1)
  })
})
