import { IDBFactory } from 'fake-indexeddb'

import { IndexedDbDataAdapter } from './indexedDbDataAdapter'
import {
  type ModuleDeviceState,
  ModuleDeviceStateCorruptionError,
  ModuleDeviceStateStore,
} from './moduleDeviceStateStore'
import { ModuleSettingsConflictError } from './moduleSettingsStore'
import {
  MAX_MODULE_TRANSITION_SETTINGS_SNAPSHOT_BYTES,
  type ModuleTransitionJournal,
  advanceModuleTransitionPhase,
} from './moduleTransitionJournal'

class MemoryAdapter {
  readonly files = new Map<string, string>()
  readonly folders = new Set<string>()
  writes = 0
  writeHook?: (path: string, data: string) => Promise<void>
  listHook?: (path: string) => Promise<{ files: string[]; folders: string[] }>

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.folders.has(path)
  }

  async stat(path: string): Promise<{ type: 'file' | 'folder' } | null> {
    if (this.files.has(path)) return { type: 'file' }
    if (this.folders.has(path)) return { type: 'folder' }
    return null
  }

  async mkdir(path: string): Promise<void> {
    this.folders.add(path)
  }

  async read(path: string): Promise<string> {
    const value = this.files.get(path)
    if (value === undefined) throw new Error(`Missing file: ${path}`)
    return value
  }

  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    if (this.listHook) return this.listHook(path)
    if (!this.folders.has(path)) return { files: [], folders: [] }
    const prefix = `${path}/`
    const files = [...this.files.keys()].filter(
      (entry) =>
        entry.startsWith(prefix) && !entry.slice(prefix.length).includes('/'),
    )
    const folders = [...this.folders].filter(
      (entry) =>
        entry.startsWith(prefix) && !entry.slice(prefix.length).includes('/'),
    )
    return { files, folders }
  }

  async write(path: string, data: string): Promise<void> {
    this.writes += 1
    if (this.writeHook) await this.writeHook(path, data)
    else this.files.set(path, data)
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path)
  }
}

function listMemoryEntries(
  adapter: MemoryAdapter,
  path: string,
): { files: string[]; folders: string[] } {
  if (!adapter.folders.has(path)) return { files: [], folders: [] }
  const prefix = `${path}/`
  return {
    files: [...adapter.files.keys()].filter(
      (entry) =>
        entry.startsWith(prefix) && !entry.slice(prefix.length).includes('/'),
    ),
    folders: [...adapter.folders].filter(
      (entry) =>
        entry.startsWith(prefix) && !entry.slice(prefix.length).includes('/'),
    ),
  }
}

const ROOT = 'device/module-state'
const PATH = `${ROOT}/learning.json`
const HASH = 'a'.repeat(64)

function createStore(adapter = new MemoryAdapter()): ModuleDeviceStateStore {
  return new ModuleDeviceStateStore({
    kind: 'device-local-runtime-state',
    adapter,
    rootPath: ROOT,
  })
}

function state(moduleId = 'learning'): ModuleDeviceState {
  return {
    moduleId,
    platform: 'desktop',
    activeVersion: '1.2.3',
    downloadedCandidate: '2.0.0-beta.1',
    pendingVersion: null,
    readyVersions: {
      '1.2.3': descriptor('1.2.3', moduleId),
      '2.0.0-beta.1': descriptor('2.0.0-beta.1', moduleId),
    },
    transition: null,
  }
}

function descriptor(version: string, moduleId = 'learning') {
  return {
    id: moduleId,
    version,
    hostApi: '^1.0.0',
    dataSchemas: {
      cards: { readMin: 1, readMax: 3, write: 2 },
      settings: { readMin: 0, readMax: 3, write: 2 },
    },
    platform: 'desktop' as const,
    manifestUrl: `https://github.com/Lapis0x0/obsidian-yolo/releases/download/${moduleId}-v${version}/module.json`,
    manifest: { byteSize: 42, sha256: HASH },
  }
}

function rawData(value: unknown, schemaVersion = 1): string {
  return JSON.stringify({ schemaVersion, data: value })
}

function transition(
  patch: Partial<ModuleTransitionJournal> = {},
): ModuleTransitionJournal {
  return {
    phase: 'prepared',
    moduleId: 'learning',
    platform: 'desktop',
    previousActiveVersion: '1.2.3',
    targetVersion: '2.0.0-beta.1',
    targetManifestSha256: HASH,
    settings: {
      namespace: 'settings',
      sourceSchemaVersion: 1,
      targetSchemaVersion: 2,
      previous: {
        present: true,
        envelope: { schemaVersion: 1, data: { deck: 'A' } },
      },
      previousSha256: 'b'.repeat(64),
      expectedPostSha256: 'c'.repeat(64),
    },
    ...patch,
  }
}

function transitioningState(
  phase: ModuleTransitionJournal['phase'] = 'prepared',
): ModuleDeviceState {
  const committed = phase === 'committed'
  const rolledBack = phase === 'rollback-completed'
  return {
    ...state(),
    activeVersion: committed ? '2.0.0-beta.1' : '1.2.3',
    downloadedCandidate: rolledBack ? '2.0.0-beta.1' : null,
    pendingVersion: committed || rolledBack ? null : '2.0.0-beta.1',
    transition: transition({ phase }),
  }
}

async function progressTransition(
  store: ModuleDeviceStateStore,
  targetPhase: ModuleTransitionJournal['phase'],
): Promise<ModuleDeviceState> {
  let current = await store.write(state())
  const phases: readonly ModuleTransitionJournal['phase'][] =
    targetPhase === 'rollback-completed'
      ? ['prepared', 'settings-committed', 'rollback-completed']
      : ['prepared', 'settings-committed', 'activation-started', 'committed']
  for (const phase of phases) {
    const committed = phase === 'committed'
    const rolledBack = phase === 'rollback-completed'
    current = await store.write({
      ...current,
      activeVersion: committed ? '2.0.0-beta.1' : '1.2.3',
      downloadedCandidate: rolledBack ? '2.0.0-beta.1' : null,
      pendingVersion: committed || rolledBack ? null : '2.0.0-beta.1',
      transition: transition({ phase }),
    })
    if (phase === targetPhase) return current
  }
  throw new Error('Unknown transition phase')
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('ModuleDeviceStateStore', () => {
  it('returns one frozen empty list for a missing or empty root', async () => {
    const adapter = new MemoryAdapter()
    const store = createStore(adapter)

    const missing = await store.list()
    adapter.folders.add(ROOT)
    const empty = await store.list()

    expect(missing).toBe(empty)
    expect(missing).toEqual([])
    expect(Object.isFrozen(missing)).toBe(true)
  })

  it('lists every valid state in module-id order as a frozen snapshot', async () => {
    const store = createStore()
    await store.write(state('zebra'))
    await store.write(state('alpha'))

    const listed = await store.list()

    expect(listed.map(({ moduleId }) => moduleId)).toEqual(['alpha', 'zebra'])
    expect(Object.isFrozen(listed)).toBe(true)
    expect(listed.every(Object.isFrozen)).toBe(true)
  })

  it('fails closed when the state root exists as a file', async () => {
    const adapter = new MemoryAdapter()
    adapter.files.set(ROOT, 'corrupt')

    await expect(createStore(adapter).list()).rejects.toThrow('not a folder')
  })

  it('retries a normal remove race during enumeration', async () => {
    const adapter = new MemoryAdapter()
    const store = createStore(adapter)
    await store.write(state('learning'))
    let listed = 0
    adapter.listHook = async (path) => {
      listed += 1
      if (listed === 1) {
        const listing = listMemoryEntries(adapter, path)
        adapter.files.delete(`${ROOT}/learning.json`)
        return listing
      }
      return listMemoryEntries(adapter, path)
    }

    await expect(store.list()).resolves.toEqual([])
    expect(listed).toBe(2)
  })

  it('fails closed when the state record bound is exceeded', async () => {
    const adapter = new MemoryAdapter()
    adapter.folders.add(ROOT)
    adapter.listHook = async () => ({
      files: Array.from(
        { length: 101 },
        (_, index) => `${ROOT}/module-${String(index)}.json`,
      ),
      folders: [],
    })

    await expect(createStore(adapter).list()).rejects.toThrow('too many')
  })

  it.each([
    [
      'folders',
      { files: [] as string[], folders: [`${ROOT}/unexpected`] },
      'unexpected folders',
    ],
    [
      'files outside the direct root',
      { files: [`${ROOT}/nested/learning.json`], folders: [] as string[] },
      'unexpected file',
    ],
    [
      'malformed filenames',
      { files: [`${ROOT}/Learning.json`], folders: [] as string[] },
      'malformed filename',
    ],
    [
      'filename aliases',
      {
        files: [`${ROOT}/learning.json`, `${ROOT}/learning.json`],
        folders: [] as string[],
      },
      'alias',
    ],
  ])('fails closed on unexpected %s', async (_label, listing, message) => {
    const adapter = new MemoryAdapter()
    adapter.folders.add(ROOT)
    adapter.listHook = async () => listing

    await expect(createStore(adapter).list()).rejects.toThrow(message)
  })

  it('fails the whole enumeration when a listed record is corrupt', async () => {
    const adapter = new MemoryAdapter()
    const store = createStore(adapter)
    await store.write(state('alpha'))
    adapter.files.set(`${ROOT}/zebra.json`, '{broken')

    await expect(store.list()).rejects.toBeInstanceOf(
      ModuleDeviceStateCorruptionError,
    )
  })

  it('reads empty state, writes a v2 snapshot, and removes it', async () => {
    const adapter = new MemoryAdapter()
    const store = createStore(adapter)

    await expect(store.read('learning')).resolves.toBeNull()
    await expect(store.remove('learning')).resolves.toBeUndefined()
    await expect(store.write(state())).resolves.toEqual(state())
    expect(JSON.parse(adapter.files.get(PATH) ?? '')).toMatchObject({
      schemaVersion: 2,
      data: {
        moduleId: 'learning',
        platform: 'desktop',
        transition: null,
      },
    })
    await expect(store.read('learning')).resolves.toEqual(state())
    await expect(store.remove('learning')).resolves.toBeUndefined()
    expect(adapter.files.has(PATH)).toBe(false)
    await expect(store.read('learning')).resolves.toBeNull()
  })

  it('explicitly reads concrete v1 state as v2 with a null transition, then writes v2', async () => {
    const adapter = new MemoryAdapter()
    const legacy = { ...state() } as Record<string, unknown>
    delete legacy.transition
    adapter.files.set(PATH, rawData(legacy, 1))
    const store = createStore(adapter)

    const migrated = await store.read('learning')

    expect(migrated).toEqual({ ...legacy, transition: null })
    expect(JSON.parse(adapter.files.get(PATH) ?? '').schemaVersion).toBe(1)
    await store.write(migrated!)
    expect(JSON.parse(adapter.files.get(PATH) ?? '')).toMatchObject({
      schemaVersion: 2,
      data: { transition: null },
    })
  })

  it('requires the nullable transition field in persisted v2 records', async () => {
    const adapter = new MemoryAdapter()
    const malformed = { ...state() } as Record<string, unknown>
    delete malformed.transition
    adapter.files.set(PATH, rawData(malformed, 2))

    await expect(createStore(adapter).read('learning')).rejects.toBeInstanceOf(
      ModuleDeviceStateCorruptionError,
    )
  })

  it.each([
    ['prepared', '2.0.0-beta.1'],
    ['settings-committed', '2.0.0-beta.1'],
    ['activation-started', '2.0.0-beta.1'],
    ['committed', '2.0.0-beta.1'],
    ['rollback-completed', null],
  ] as const)(
    'rejects persisted v2 %s state with an impossible downloaded candidate',
    async (phase, downloadedCandidate) => {
      const adapter = new MemoryAdapter()
      adapter.files.set(
        PATH,
        rawData({ ...transitioningState(phase), downloadedCandidate }, 2),
      )

      await expect(
        createStore(adapter).read('learning'),
      ).rejects.toBeInstanceOf(ModuleDeviceStateCorruptionError)
    },
  )

  it.each([
    'prepared',
    'settings-committed',
    'activation-started',
    'committed',
    'rollback-completed',
  ] as const)('roundtrips a deeply frozen %s transition', async (phase) => {
    const store = createStore()
    const written = await progressTransition(store, phase)
    const read = await store.read('learning')

    expect(read).toEqual(written)
    expect(read?.transition?.phase).toBe(phase)
    for (const value of [
      read?.transition,
      read?.transition?.settings,
      read?.transition?.settings.previous,
      read?.transition?.settings.previous.envelope,
      read?.transition?.settings.previous.envelope?.data,
    ]) {
      expect(Object.isFrozen(value)).toBe(true)
    }
  })

  it('enforces durable progression for public and transaction writes', async () => {
    const store = createStore()
    const baseline = await store.write(state())
    const prepared = transitioningState('prepared')
    const written = await store.runExclusive('learning', (transaction) =>
      transaction.write(prepared),
    )
    expect(written.transition?.phase).toBe('prepared')

    await expect(store.write(written)).resolves.toEqual(written)
    const settingsCommitted = await store.write({
      ...written,
      transition: transition({ phase: 'settings-committed' }),
    })
    const activationStarted = await store.write({
      ...settingsCommitted,
      transition: transition({ phase: 'activation-started' }),
    })
    const committed = await store.write({
      ...activationStarted,
      activeVersion: '2.0.0-beta.1',
      pendingVersion: null,
      transition: transition({ phase: 'committed' }),
    })
    const cleaned = await store.write({ ...committed, transition: null })

    expect(baseline.downloadedCandidate).toBe('2.0.0-beta.1')
    expect(cleaned).toMatchObject({
      activeVersion: '2.0.0-beta.1',
      downloadedCandidate: null,
      pendingVersion: null,
      transition: null,
    })
  })

  it('allows direct deterministic rollback only from prepared', async () => {
    const store = createStore()
    const current = await progressTransition(store, 'prepared')

    await expect(
      store.write({
        ...current,
        activeVersion: '1.2.3',
        downloadedCandidate: '2.0.0-beta.1',
        pendingVersion: null,
        transition: null,
      }),
    ).resolves.toMatchObject({
      activeVersion: '1.2.3',
      downloadedCandidate: '2.0.0-beta.1',
      pendingVersion: null,
      transition: null,
    })
  })

  it.each(['settings-committed', 'activation-started'] as const)(
    'requires durable rollback completion before clearing %s',
    async (phase) => {
      const store = createStore()
      const current = await progressTransition(store, phase)
      const cleared = {
        ...current,
        activeVersion: '1.2.3',
        downloadedCandidate: '2.0.0-beta.1',
        pendingVersion: null,
        transition: null,
      }

      await expect(store.write(cleared)).rejects.toThrow(
        'settings must be restored',
      )
      const rollbackCompleted = await store.write({
        ...cleared,
        transition: transition({ phase: 'rollback-completed' }),
      })
      expect((await store.read('learning'))?.transition?.phase).toBe(
        'rollback-completed',
      )
      await expect(
        store.write({ ...rollbackCompleted, transition: null }),
      ).resolves.toEqual(cleared)
    },
  )

  it('cannot remove state until its durable transition is resolved', async () => {
    const store = createStore()
    await progressTransition(store, 'prepared')

    await expect(store.remove('learning')).rejects.toThrow('cannot be removed')
    expect((await store.read('learning'))?.transition?.phase).toBe('prepared')

    const current = (await store.read('learning'))!
    await store.write({
      ...current,
      downloadedCandidate: '2.0.0-beta.1',
      pendingVersion: null,
      transition: null,
    })
    await expect(store.remove('learning')).resolves.toBeUndefined()
  })

  it('rejects phase skips, regression, payload replacement, and unrelated mutation', async () => {
    const skipped = createStore()
    const prepared = await progressTransition(skipped, 'prepared')
    await expect(
      skipped.write({
        ...prepared,
        transition: transition({ phase: 'activation-started' }),
      }),
    ).rejects.toThrow('advancement is invalid')

    const regressed = createStore()
    const settingsCommitted = await progressTransition(
      regressed,
      'settings-committed',
    )
    await expect(
      regressed.write({
        ...settingsCommitted,
        transition: transition({ phase: 'prepared' }),
      }),
    ).rejects.toThrow('advancement is invalid')

    await expect(
      regressed.write({
        ...settingsCommitted,
        transition: transition({
          phase: 'activation-started',
          settings: {
            ...transition().settings,
            expectedPostSha256: 'd'.repeat(64),
          },
        }),
      }),
    ).rejects.toThrow('immutable payload')
    await expect(
      regressed.write({
        ...settingsCommitted,
        transition: transition({
          phase: 'activation-started',
          settings: {
            ...transition().settings,
            previous: {
              present: true,
              envelope: { schemaVersion: 1, data: { deck: 'replacement' } },
            },
          },
        }),
      }),
    ).rejects.toThrow('immutable payload')
    await expect(
      regressed.write({
        ...settingsCommitted,
        readyVersions: {
          ...settingsCommitted.readyVersions,
          '3.0.0': descriptor('3.0.0'),
        },
        transition: transition({ phase: 'activation-started' }),
      }),
    ).rejects.toThrow('unrelated state mutation')

    const targetStore = createStore()
    const baseline = state()
    await targetStore.write({
      ...baseline,
      readyVersions: {
        ...baseline.readyVersions,
        '3.0.0': descriptor('3.0.0'),
      },
    })
    const targetPrepared = await targetStore.write({
      ...transitioningState(),
      readyVersions: {
        ...baseline.readyVersions,
        '3.0.0': descriptor('3.0.0'),
      },
    })
    await expect(
      targetStore.write({
        ...targetPrepared,
        pendingVersion: '3.0.0',
        transition: transition({
          phase: 'settings-committed',
          targetVersion: '3.0.0',
        }),
      }),
    ).rejects.toThrow('immutable payload')
  })

  it('rejects journal creation without consuming the downloaded target', async () => {
    const store = createStore()
    await store.write({ ...state(), downloadedCandidate: null })

    await expect(store.write(transitioningState())).rejects.toThrow(
      'Prepared transition state mutation',
    )
  })

  it('advances transition phases only one monotonic step at a time', () => {
    expect(advanceModuleTransitionPhase('prepared', 'settings-committed')).toBe(
      'settings-committed',
    )
    expect(
      advanceModuleTransitionPhase('settings-committed', 'activation-started'),
    ).toBe('activation-started')
    expect(
      advanceModuleTransitionPhase('activation-started', 'committed'),
    ).toBe('committed')
    expect(
      advanceModuleTransitionPhase('settings-committed', 'rollback-completed'),
    ).toBe('rollback-completed')
    expect(
      advanceModuleTransitionPhase('activation-started', 'rollback-completed'),
    ).toBe('rollback-completed')
    expect(() =>
      advanceModuleTransitionPhase('activation-started', 'prepared'),
    ).toThrow('advancement is invalid')
    expect(() =>
      advanceModuleTransitionPhase('prepared', 'activation-started'),
    ).toThrow('advancement is invalid')
    expect(() =>
      advanceModuleTransitionPhase('prepared', 'rollback-completed'),
    ).toThrow('advancement is invalid')
    expect(() =>
      advanceModuleTransitionPhase('committed', 'committed'),
    ).toThrow('advancement is invalid')
  })

  it.each([
    ['module binding', { moduleId: 'other' }],
    ['platform binding', { platform: 'mobile' }],
    ['previous active binding', { previousActiveVersion: null }],
    ['target pointer binding', { targetVersion: '1.2.3' }],
    ['manifest binding', { targetManifestSha256: 'd'.repeat(64) }],
    ['uppercase manifest hash', { targetManifestSha256: HASH.toUpperCase() }],
    ['unknown transition phase', { phase: 'started' }],
  ])('rejects an invalid transition %s', async (_label, patch) => {
    const store = createStore()
    await store.write(state())
    await expect(
      store.write({
        ...transitioningState(),
        transition: transition(patch as Partial<ModuleTransitionJournal>),
      }),
    ).rejects.toThrow()
  })

  it('enforces phase-specific active and pending pointers', async () => {
    const store = createStore()
    await store.write(state())
    await expect(
      store.write({
        ...transitioningState('prepared'),
        pendingVersion: null,
      }),
    ).rejects.toThrow('Uncommitted transition pointers')
    await expect(
      createStore().write({
        ...transitioningState('committed'),
        pendingVersion: '2.0.0-beta.1',
      }),
    ).rejects.toThrow('Committed transition pointers')
    await expect(
      createStore().write({
        ...transitioningState('rollback-completed'),
        pendingVersion: '2.0.0-beta.1',
      }),
    ).rejects.toThrow('Rollback-completed transition pointers')
  })

  it.each([
    ['namespace', { namespace: 'cards' }],
    ['source schema', { sourceSchemaVersion: -1 }],
    ['source descriptor range', { sourceSchemaVersion: 4 }],
    ['target schema', { targetSchemaVersion: 3 }],
    ['previous hash', { previousSha256: 'b'.repeat(63) }],
    ['uppercase post hash', { expectedPostSha256: 'C'.repeat(64) }],
  ])('rejects invalid transition settings %s', async (_label, patch) => {
    const base = transition()
    const store = createStore()
    await store.write(state())
    await expect(
      store.write({
        ...transitioningState(),
        transition: transition({
          settings: { ...base.settings, ...patch } as never,
        }),
      }),
    ).rejects.toThrow()
  })

  it('binds previous settings presence and envelope schema exactly', async () => {
    const base = transition()
    for (const settings of [
      {
        ...base.settings,
        previous: { present: false, envelope: null },
        sourceSchemaVersion: 1,
      },
      {
        ...base.settings,
        previous: {
          present: true,
          envelope: { schemaVersion: 2, data: {} },
        },
      },
      {
        ...base.settings,
        previous: { present: false, envelope: { schemaVersion: 0, data: {} } },
        sourceSchemaVersion: 0,
      },
    ]) {
      await expect(
        createStore().write({
          ...transitioningState(),
          transition: transition({ settings: settings as never }),
        }),
      ).rejects.toThrow()
    }

    const store = createStore()
    await store.write(state())
    await expect(
      store.write({
        ...transitioningState(),
        transition: transition({
          settings: {
            ...base.settings,
            sourceSchemaVersion: 0,
            previous: { present: false, envelope: null },
          },
        }),
      }),
    ).resolves.toBeDefined()
  })

  it('bounds and canonicalizes the embedded previous settings snapshot', async () => {
    const source = { z: [{ b: 2, a: 1 }], a: 'safe' }
    const base = transition()
    const store = createStore()
    await store.write(state())
    const written = await store.write({
      ...transitioningState(),
      transition: transition({
        settings: {
          ...base.settings,
          previous: {
            present: true,
            envelope: { schemaVersion: 1, data: source },
          },
        },
      }),
    })
    source.z[0].a = 9
    expect(written.transition?.settings.previous.envelope?.data).toEqual({
      a: 'safe',
      z: [{ a: 1, b: 2 }],
    })

    await expect(
      store.write({
        ...transitioningState(),
        transition: transition({
          settings: {
            ...base.settings,
            previous: {
              present: true,
              envelope: {
                schemaVersion: 1,
                data: 'x'.repeat(MAX_MODULE_TRANSITION_SETTINGS_SNAPSHOT_BYTES),
              },
            },
          },
        }),
      }),
    ).rejects.toThrow('too large')
  })

  it('rejects unknown, dangerous, accessor, and non-plain journal snapshot values', async () => {
    const base = transition()
    const values: unknown[] = [new Date(), { unknown: undefined }]
    const accessor = {}
    let invoked = false
    Object.defineProperty(accessor, 'secret', {
      enumerable: true,
      get: () => {
        invoked = true
        return true
      },
    })
    values.push(accessor)
    const accessorArray = [true]
    Object.defineProperty(accessorArray, '0', {
      enumerable: true,
      get: () => {
        invoked = true
        return true
      },
    })
    values.push(accessorArray)
    values.push(JSON.parse('{"__proto__":true}'))

    for (const data of values) {
      await expect(
        createStore().write({
          ...transitioningState(),
          transition: transition({
            settings: {
              ...base.settings,
              previous: {
                present: true,
                envelope: { schemaVersion: 1, data },
              },
            },
          }),
        }),
      ).rejects.toThrow()
    }
    expect(invoked).toBe(false)

    await expect(
      createStore().write({
        ...transitioningState(),
        transition: { ...transition(), unknown: true } as never,
      }),
    ).rejects.toThrow('Object must contain only')
  })

  it('returns defensive, deeply frozen snapshots', async () => {
    const adapter = new MemoryAdapter()
    const store = createStore(adapter)
    const source = state() as {
      activeVersion: string | null
      readyVersions: Record<string, ReturnType<typeof descriptor>>
    } & ModuleDeviceState

    const written = await store.write(source)
    source.activeVersion = null
    source.readyVersions['1.2.3'].manifest.sha256 = 'b'.repeat(64)
    source.readyVersions['1.2.3'].dataSchemas.cards.write = 3

    const read = await store.read('learning')
    expect(read?.activeVersion).toBe('1.2.3')
    expect(read?.readyVersions['1.2.3'].manifest.sha256).toBe(HASH)
    for (const value of [
      written,
      written.readyVersions,
      written.readyVersions['1.2.3'],
      written.readyVersions['1.2.3'].manifest,
      written.readyVersions['1.2.3'].dataSchemas,
      written.readyVersions['1.2.3'].dataSchemas.cards,
      read,
    ]) {
      expect(Object.isFrozen(value)).toBe(true)
    }
  })

  it.each([
    ['dangling active pointer', { activeVersion: '9.9.9' }],
    ['dangling candidate pointer', { downloadedCandidate: '9.9.9' }],
    ['dangling pending pointer', { pendingVersion: '9.9.9' }],
    ['malformed pointer version', { activeVersion: 'v1' }],
    ['invalid platform', { platform: 'web' }],
    ['unknown state field', { unexpected: true }],
  ])('rejects the %s invariant', async (_label, patch) => {
    await expect(
      createStore().write({
        ...state(),
        ...patch,
      } as unknown as ModuleDeviceState),
    ).rejects.toThrow()
  })

  it('requires every descriptor identity to match its record', async () => {
    for (const patch of [
      { id: 'other' },
      { version: '1.2.4' },
      { platform: 'mobile' },
    ]) {
      const value = state()
      const altered = {
        ...value,
        readyVersions: {
          ...value.readyVersions,
          '1.2.3': { ...value.readyVersions['1.2.3'], ...patch },
        },
      }
      await expect(
        createStore().write(altered as unknown as ModuleDeviceState),
      ).rejects.toThrow('Descriptor identity')
    }
  })

  it.each([
    ['version', { version: '01.2.3' }],
    ['host API', { hostApi: 'latest' }],
    ['manifest URL', { manifestUrl: 'https://example.com/module.json' }],
    [
      'non-official release URL',
      {
        manifestUrl:
          'https://github.com/other/project/releases/download/v1/module.json',
      },
    ],
    ['manifest size', { manifest: { byteSize: 0, sha256: HASH } }],
    ['manifest hash', { manifest: { byteSize: 42, sha256: 'nope' } }],
    ['unknown descriptor field', { extra: true }],
    [
      'schema bounds',
      { dataSchemas: { cards: { readMin: 3, readMax: 1, write: 2 } } },
    ],
    [
      'schema namespace',
      { dataSchemas: { Bad_Name: { readMin: 1, readMax: 1, write: 1 } } },
    ],
    [
      'unknown schema field',
      {
        dataSchemas: {
          cards: { readMin: 1, readMax: 1, write: 1, extra: 1 },
        },
      },
    ],
  ])('rejects malformed descriptor %s data', async (_label, patch) => {
    const value = state()
    const altered = {
      ...value,
      activeVersion: null,
      readyVersions: {
        '1.2.3': { ...value.readyVersions['1.2.3'], ...patch },
      },
      downloadedCandidate: null,
    }
    await expect(createStore().write(altered)).rejects.toThrow()
  })

  it('rejects prototype-pollution names and unknown persisted fields', async () => {
    const adapter = new MemoryAdapter()
    const store = createStore(adapter)
    adapter.files.set(
      PATH,
      `{"schemaVersion":1,"data":{"moduleId":"learning","platform":"desktop","activeVersion":null,"downloadedCandidate":null,"pendingVersion":null,"readyVersions":{"__proto__":{}}}}`,
    )
    await expect(store.read('learning')).rejects.toBeInstanceOf(
      ModuleDeviceStateCorruptionError,
    )

    adapter.files.set(PATH, rawData({ ...state(), unknown: true }))
    await expect(store.read('learning')).rejects.toBeInstanceOf(
      ModuleDeviceStateCorruptionError,
    )
  })

  it('rejects corruption in envelopes, schema versions, namespaces, and data', async () => {
    const adapter = new MemoryAdapter()
    const store = createStore(adapter)
    for (const raw of [
      '{broken',
      rawData(state(), 3),
      rawData({ ...state(), moduleId: 'other' }),
      rawData({ ...state(), activeVersion: '8.0.0' }),
      rawData({
        ...state(),
        readyVersions: {
          '1.2.3': { ...descriptor('1.2.3'), manifestUrl: 'http://bad' },
        },
        downloadedCandidate: null,
      }),
    ]) {
      adapter.files.set(PATH, raw)
      await expect(store.read('learning')).rejects.toBeInstanceOf(
        ModuleDeviceStateCorruptionError,
      )
    }
  })

  it('can explicitly clear corrupted device-local state', async () => {
    const adapter = new MemoryAdapter()
    const store = createStore(adapter)
    adapter.files.set(PATH, '{broken')

    await expect(store.read('learning')).rejects.toBeInstanceOf(
      ModuleDeviceStateCorruptionError,
    )
    await expect(store.remove('learning')).resolves.toBeUndefined()
    await expect(store.read('learning')).resolves.toBeNull()
  })

  it('rejects non-plain inputs without invoking accessors', async () => {
    const store = createStore()
    let invoked = false
    const accessor = descriptor('1.2.3') as Record<string, unknown>
    Object.defineProperty(accessor, 'manifestUrl', {
      enumerable: true,
      get: () => {
        invoked = true
        return 'https://example.com'
      },
    })
    const value = state()
    await expect(
      store.write({
        ...value,
        downloadedCandidate: null,
        readyVersions: { '1.2.3': accessor } as never,
      }),
    ).rejects.toThrow('data property')
    expect(invoked).toBe(false)

    const custom = Object.assign(Object.create({ inherited: true }), state())
    await expect(store.write(custom)).rejects.toThrow('plain object')
  })

  it('accepts null-prototype descriptor maps produced by trusted parsers', async () => {
    const value = state()
    const schemas = Object.assign(Object.create(null), {
      cards: Object.freeze({ readMin: 1, readMax: 3, write: 2 }),
    }) as ModuleDeviceState['readyVersions'][string]['dataSchemas']
    const readyVersions = Object.assign(Object.create(null), {
      '1.2.3': { ...descriptor('1.2.3'), dataSchemas: schemas },
    }) as ModuleDeviceState['readyVersions']

    await expect(
      createStore().write({
        ...value,
        downloadedCandidate: null,
        readyVersions,
      }),
    ).resolves.toMatchObject({
      activeVersion: '1.2.3',
      readyVersions: {
        '1.2.3': { dataSchemas: { cards: { write: 2 } } },
      },
    })
  })

  it('serializes write and remove operations per module across instances', async () => {
    const adapter = new MemoryAdapter()
    const first = createStore(adapter)
    const second = createStore(adapter)
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    let started!: () => void
    const writeStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    adapter.writeHook = async (path, data) => {
      started()
      await blocked
      adapter.files.set(path, data)
    }

    const writing = first.write(state())
    await writeStarted
    const removing = second.remove('learning')
    await Promise.resolve()
    expect(adapter.files.has(PATH)).toBe(false)
    release()
    await Promise.all([writing, removing])
    await expect(first.read('learning')).resolves.toBeNull()
  })

  it('reports an uncertain verified write without restoring stale state', async () => {
    const adapter = new MemoryAdapter()
    const store = createStore(adapter)
    await store.write(state())
    const competing = { ...state(), activeVersion: null }
    adapter.writeHook = async (path) => {
      adapter.files.set(path, rawData(competing, 2))
    }

    await expect(store.write(transitioningState())).rejects.toBeInstanceOf(
      ModuleSettingsConflictError,
    )
    await expect(store.read('learning')).resolves.toEqual(competing)
  })

  it('serializes whole transactions across equivalent store instances', async () => {
    const adapter = new MemoryAdapter()
    const first = createStore(adapter)
    const second = createStore(adapter)
    const blocked = deferred<undefined>()
    const events: string[] = []

    const firstOperation = first.runExclusive('learning', async () => {
      events.push('first-start')
      await blocked.promise
      events.push('first-end')
    })
    await Promise.resolve()
    const secondOperation = second.runExclusive('learning', async () => {
      events.push('second')
    })
    await Promise.resolve()
    expect(events).toEqual(['first-start'])

    blocked.resolve(undefined)
    await Promise.all([firstOperation, secondOperation])
    expect(events).toEqual(['first-start', 'first-end', 'second'])
  })

  it('keeps direct writes behind an active transaction lock', async () => {
    const adapter = new MemoryAdapter()
    const first = createStore(adapter)
    const second = createStore(adapter)
    const blocked = deferred<undefined>()

    const transaction = first.runExclusive('learning', async () => {
      await blocked.promise
    })
    await Promise.resolve()
    const writing = second.write(state())
    await Promise.resolve()
    expect(adapter.writes).toBe(0)

    blocked.resolve(undefined)
    await Promise.all([transaction, writing])
    expect(adapter.writes).toBe(1)
  })

  it('normalizes root aliases when coordinating transactions', async () => {
    const adapter = new MemoryAdapter()
    const first = createStore(adapter)
    const alias = new ModuleDeviceStateStore({
      kind: 'device-local-runtime-state',
      adapter,
      rootPath: ROOT.toUpperCase(),
    })
    const blocked = deferred<undefined>()
    const events: string[] = []

    const firstOperation = first.runExclusive('learning', async () => {
      events.push('first')
      await blocked.promise
    })
    await Promise.resolve()
    const aliasOperation = alias.runExclusive('learning', async () => {
      events.push('alias')
    })
    await Promise.resolve()
    expect(events).toEqual(['first'])

    blocked.resolve(undefined)
    await Promise.all([firstOperation, aliasOperation])
    expect(events).toEqual(['first', 'alias'])
  })

  it('works directly with IndexedDbDataAdapter', async () => {
    const localStorage = new Map<string, unknown>()
    const adapter = new IndexedDbDataAdapter(
      {
        loadLocalStorage: (key) => localStorage.get(key) ?? null,
        saveLocalStorage: (key, value) => {
          localStorage.set(key, value)
        },
      },
      {
        indexedDB: new IDBFactory(),
        createNamespaceId: () => '11111111-1111-4111-8111-111111111111',
      },
    )
    const store = new ModuleDeviceStateStore({
      kind: 'device-local-runtime-state',
      adapter,
      rootPath: ROOT,
    })

    await store.write(state())
    await expect(store.list()).resolves.toEqual([state()])
    await expect(store.read('learning')).resolves.toEqual(state())
    await store.remove('learning')
    await expect(store.read('learning')).resolves.toBeNull()
    adapter.close()
  })
})
