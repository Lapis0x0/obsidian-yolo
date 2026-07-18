import {
  type ModuleIntentBackend,
  ModuleIntentStore,
  ModuleIntentWriteUncertainError,
} from './moduleIntentStore'
import {
  ModuleSettingsCorruptionError,
  type SynchronizedModuleSettingsBackend,
} from './moduleSettingsStore'

class MemoryAdapter {
  readonly files = new Map<string, string>()
  readonly folders = new Set<string>()
  readonly writes: string[] = []
  readHook?: (path: string) => Promise<string>
  writeHook?: (path: string, data: string) => Promise<void>

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.folders.has(path)
  }

  async mkdir(path: string): Promise<void> {
    this.folders.add(path)
  }

  async read(path: string): Promise<string> {
    if (this.readHook) return this.readHook(path)
    const value = this.files.get(path)
    if (value === undefined) throw new Error(`Missing file: ${path}`)
    return value
  }

  async write(path: string, data: string): Promise<void> {
    this.writes.push(path)
    if (this.writeHook) await this.writeHook(path, data)
    else this.files.set(path, data)
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path)
  }
}

function createBackend(
  adapter: MemoryAdapter,
  getRoot: () => string,
): ModuleIntentBackend {
  return {
    capture: (): SynchronizedModuleSettingsBackend => ({
      kind: 'synchronized-intent',
      adapter,
      rootPath: getRoot(),
    }),
    subscribe: () => () => undefined,
  }
}

function createHarness(rootPath = 'YOLO/.yolo_json_db/module-intent') {
  const adapter = new MemoryAdapter()
  let root = rootPath
  const backend = createBackend(adapter, () => root)
  return {
    adapter,
    backend,
    store: new ModuleIntentStore(backend),
    path: (moduleId: string) => `${root}/${moduleId}.json`,
    setRoot: (next: string) => {
      root = next
    },
  }
}

function envelope(data: unknown, schemaVersion = 1): string {
  return JSON.stringify({ schemaVersion, data })
}

describe('ModuleIntentStore', () => {
  it('represents missing files as no intent and persists all four combinations', async () => {
    const harness = createHarness()

    await expect(harness.store.get('missing')).resolves.toBeUndefined()

    for (const desiredInstalled of [false, true]) {
      for (const enabled of [false, true]) {
        const moduleId = `module-${Number(desiredInstalled)}-${Number(enabled)}`
        await expect(
          harness.store.set(moduleId, { desiredInstalled, enabled }),
        ).resolves.toEqual({ desiredInstalled, enabled })
        await expect(harness.store.get(moduleId)).resolves.toEqual({
          desiredInstalled,
          enabled,
        })
      }
    }

    expect(
      JSON.parse(harness.adapter.files.get(harness.path('module-0-0')) ?? '')
        .data,
    ).toEqual({ desiredInstalled: false, enabled: false })
  })

  it('preserves unknown safe fields and nested JSON for that module', async () => {
    const harness = createHarness()
    harness.adapter.files.set(
      harness.path('notes'),
      envelope({
        desiredInstalled: true,
        enabled: false,
        future: { flags: [1, { safe: true }] },
        generation: 4,
      }),
    )

    await harness.store.set('notes', {
      desiredInstalled: false,
      enabled: false,
    })

    expect(
      JSON.parse(harness.adapter.files.get(harness.path('notes')) ?? '').data,
    ).toEqual({
      desiredInstalled: false,
      enabled: false,
      future: { flags: [1, { safe: true }] },
      generation: 4,
    })
  })

  it('returns deeply frozen known intents', async () => {
    const harness = createHarness()
    const written = await harness.store.set('notes', {
      desiredInstalled: true,
      enabled: false,
    })
    const read = await harness.store.get('notes')

    expect(Object.isFrozen(written)).toBe(true)
    expect(Object.isFrozen(read)).toBe(true)
  })

  it.each([
    ['old schema', envelope({ desiredInstalled: true, enabled: true }, 0)],
    ['future schema', envelope({ desiredInstalled: true, enabled: true }, 2)],
    ['missing field', envelope({ desiredInstalled: true })],
    ['bad field', envelope({ desiredInstalled: true, enabled: 'yes' })],
    ['non-object data', envelope([])],
    ['broken JSON', '{broken'],
  ])('fails closed and does not overwrite %s', async (_label, raw) => {
    const harness = createHarness()
    harness.adapter.files.set(harness.path('notes'), raw)

    await expect(
      harness.store.set('notes', { desiredInstalled: false, enabled: false }),
    ).rejects.toBeInstanceOf(ModuleSettingsCorruptionError)
    expect(harness.adapter.files.get(harness.path('notes'))).toBe(raw)
    expect(harness.adapter.writes).toEqual([])
  })

  it.each(['__proto__', 'prototype', 'constructor'])(
    'rejects dangerous key %s at any nesting depth',
    async (dangerous) => {
      const harness = createHarness()
      harness.adapter.files.set(
        harness.path('notes'),
        `{"schemaVersion":1,"data":{"desiredInstalled":true,"enabled":true,"future":{"${dangerous}":1}}}`,
      )

      await expect(harness.store.get('notes')).rejects.toThrow(
        'dangerous JSON key',
      )
      await expect(
        harness.store.set('notes', {
          desiredInstalled: false,
          enabled: false,
        }),
      ).rejects.toThrow('dangerous JSON key')
      expect(harness.adapter.writes).toEqual([])
    },
  )

  it('validates module ids and rejects non-plain intent inputs', () => {
    const harness = createHarness()
    const accessor = {}
    Object.defineProperty(accessor, 'desiredInstalled', {
      enumerable: true,
      get: () => true,
    })
    Object.defineProperty(accessor, 'enabled', {
      enumerable: true,
      value: true,
    })

    expect(() =>
      harness.store.set('../notes', {
        desiredInstalled: true,
        enabled: true,
      }),
    ).toThrow('path segment')
    expect(() =>
      harness.store.set(
        'notes',
        accessor as { desiredInstalled: boolean; enabled: boolean },
      ),
    ).toThrow('data property')
    expect(() =>
      harness.store.set(
        'notes',
        Object.assign(Object.create(null), {
          desiredInstalled: true,
          enabled: true,
        }) as { desiredInstalled: boolean; enabled: boolean },
      ),
    ).toThrow('plain object')
  })

  it('serializes the same module across store instances', async () => {
    const harness = createHarness()
    const secondStore = new ModuleIntentStore(harness.backend)
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    let started!: () => void
    const writeStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    let writes = 0
    harness.adapter.writeHook = async (path, data) => {
      writes += 1
      if (writes === 1) {
        started()
        await blocked
      }
      harness.adapter.files.set(path, data)
    }

    const first = harness.store.set('notes', {
      desiredInstalled: true,
      enabled: false,
    })
    await writeStarted
    const second = secondStore.set('notes', {
      desiredInstalled: false,
      enabled: true,
    })
    await Promise.resolve()
    expect(writes).toBe(1)
    release()
    await Promise.all([first, second])

    await expect(harness.store.get('notes')).resolves.toEqual({
      desiredInstalled: false,
      enabled: true,
    })
  })

  it('shares the same-module queue across canonical root aliases', async () => {
    const adapter = new MemoryAdapter()
    const firstStore = new ModuleIntentStore(
      createBackend(adapter, () => 'Root\\module-intent'),
    )
    const secondStore = new ModuleIntentStore(
      createBackend(adapter, () => 'root/module-intent'),
    )
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    let started!: () => void
    const writeStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    let writes = 0
    adapter.writeHook = async (path, data) => {
      writes += 1
      if (writes === 1) {
        started()
        await blocked
      }
      adapter.files.set(path, data)
    }

    const first = firstStore.set('notes', {
      desiredInstalled: true,
      enabled: false,
    })
    await writeStarted
    const second = secondStore.set('notes', {
      desiredInstalled: false,
      enabled: true,
    })
    await Promise.resolve()
    expect(writes).toBe(1)
    release()
    await Promise.all([first, second])
  })

  it('lets different modules write independently without sharing a file', async () => {
    const harness = createHarness()
    const started = new Set<string>()
    let markBoth!: () => void
    const bothStarted = new Promise<void>((resolve) => {
      markBoth = resolve
    })
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    harness.adapter.writeHook = async (path, data) => {
      started.add(path)
      if (started.size === 2) markBoth()
      await blocked
      harness.adapter.files.set(path, data)
    }

    const notes = harness.store.set('notes', {
      desiredInstalled: true,
      enabled: false,
    })
    const search = harness.store.set('search', {
      desiredInstalled: false,
      enabled: true,
    })
    await bothStarted
    expect(started).toEqual(
      new Set([harness.path('notes'), harness.path('search')]),
    )
    release()
    await Promise.all([notes, search])

    await expect(harness.store.get('notes')).resolves.toEqual({
      desiredInstalled: true,
      enabled: false,
    })
    await expect(harness.store.get('search')).resolves.toEqual({
      desiredInstalled: false,
      enabled: true,
    })
  })

  it('treats throw-after-commit with exact semantic readback as success', async () => {
    const harness = createHarness()
    harness.adapter.files.set(
      harness.path('notes'),
      envelope({
        desiredInstalled: false,
        enabled: false,
        future: { retained: true },
      }),
    )
    harness.adapter.writeHook = async (path, data) => {
      const parsed = JSON.parse(data) as { data: Record<string, unknown> }
      harness.adapter.files.set(
        path,
        JSON.stringify({
          data: {
            enabled: parsed.data.enabled,
            future: parsed.data.future,
            desiredInstalled: parsed.data.desiredInstalled,
          },
          schemaVersion: 1,
        }),
      )
      throw new Error('transport lost acknowledgement')
    }

    await expect(
      harness.store.set('notes', { desiredInstalled: true, enabled: true }),
    ).resolves.toEqual({ desiredInstalled: true, enabled: true })
  })

  it('rethrows the original write error for divergent readable state', async () => {
    const harness = createHarness()
    const original = new Error('write failed')
    harness.adapter.writeHook = async (path) => {
      harness.adapter.files.set(
        path,
        envelope({ desiredInstalled: false, enabled: true }),
      )
      throw original
    }

    await expect(
      harness.store.set('notes', { desiredInstalled: true, enabled: true }),
    ).rejects.toBe(original)
  })

  it('reports an uncertain write when readback is unreadable', async () => {
    const harness = createHarness()
    const original = new Error('write failed')
    harness.adapter.writeHook = async (path, data) => {
      harness.adapter.files.set(path, data)
      harness.adapter.readHook = async () => {
        throw new Error('readback unavailable')
      }
      throw original
    }

    const result = harness.store.set('notes', {
      desiredInstalled: true,
      enabled: true,
    })
    await expect(result).rejects.toBeInstanceOf(ModuleIntentWriteUncertainError)
    await expect(result).rejects.toMatchObject({ originalError: original })
  })

  it('binds an operation to its captured root and uses the new root later', async () => {
    const oldRoot = 'Old/.yolo_json_db/module-intent'
    const newRoot = 'New/.yolo_json_db/module-intent'
    const harness = createHarness(oldRoot)
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    let started!: () => void
    const writeStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    harness.adapter.writeHook = async (path, data) => {
      started()
      await blocked
      harness.adapter.files.set(path, data)
    }

    const pending = harness.store.set('notes', {
      desiredInstalled: true,
      enabled: true,
    })
    await writeStarted
    harness.setRoot(newRoot)
    release()
    await pending
    harness.adapter.writeHook = undefined
    await harness.store.set('notes', {
      desiredInstalled: false,
      enabled: true,
    })

    expect(harness.adapter.files.has(`${oldRoot}/notes.json`)).toBe(true)
    expect(harness.adapter.files.has(`${newRoot}/notes.json`)).toBe(true)
    await expect(harness.store.get('notes')).resolves.toEqual({
      desiredInstalled: false,
      enabled: true,
    })
  })
})
