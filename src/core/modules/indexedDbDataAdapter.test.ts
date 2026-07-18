import { IDBFactory, IDBObjectStore } from 'fake-indexeddb'

import {
  IndexedDbDataAdapter,
  MODULE_DEVICE_LOCAL_DATABASE_NAMESPACE_KEY,
} from './indexedDbDataAdapter'
import { MAX_MODULE_PRIVATE_LIST_ENTRIES } from './modulePrivateStorage'

const FIRST_NAMESPACE = '11111111-1111-4111-8111-111111111111'
const SECOND_NAMESPACE = '22222222-2222-4222-8222-222222222222'
const DATABASE_NAME_PREFIX = 'yolo-module-device-local:'

class FakeAppLocalStorage {
  readonly values = new Map<string, unknown>()

  loadLocalStorage(key: string): unknown {
    return this.values.get(key) ?? null
  }

  saveLocalStorage(key: string, value: unknown): void {
    this.values.set(key, value)
  }
}

function createAdapter(
  app = new FakeAppLocalStorage(),
  indexedDB = new IDBFactory(),
  namespaceId = FIRST_NAMESPACE,
): IndexedDbDataAdapter {
  return new IndexedDbDataAdapter(app, {
    indexedDB,
    createNamespaceId: () => namespaceId,
  })
}

async function createTree(adapter: IndexedDbDataAdapter): Promise<void> {
  await adapter.mkdir('private')
  await adapter.mkdir('private/notes')
}

async function putRawRecord(
  indexedDB: IDBFactory,
  namespaceId: string,
  record: unknown,
): Promise<void> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(`${DATABASE_NAME_PREFIX}${namespaceId}`, 1)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () =>
      reject(request.error ?? new Error('Raw database open failed'))
  })
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('entries', 'readwrite')
      const store = transaction.objectStore('entries')
      for (const entry of Array.isArray(record) ? record : [record]) {
        store.put(entry)
      }
      transaction.oncomplete = () => resolve()
      transaction.onerror = () =>
        reject(transaction.error ?? new Error('Raw transaction failed'))
      transaction.onabort = () =>
        reject(transaction.error ?? new Error('Raw transaction aborted'))
    })
  } finally {
    database.close()
  }
}

async function deleteRawDatabase(
  indexedDB: IDBFactory,
  namespaceId: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(
      `${DATABASE_NAME_PREFIX}${namespaceId}`,
    )
    request.onsuccess = () => resolve()
    request.onerror = () =>
      reject(request.error ?? new Error('Raw database delete failed'))
    request.onblocked = () => reject(new Error('Raw database delete blocked'))
  })
}

async function createDatabaseWithWrongIndex(
  indexedDB: IDBFactory,
  namespaceId: string,
): Promise<void> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(`${DATABASE_NAME_PREFIX}${namespaceId}`, 1)
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore('entries', {
        keyPath: 'path',
      })
      store.createIndex('by-parent-kind', 'parent')
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () =>
      reject(request.error ?? new Error('Wrong-schema database open failed'))
  })
  database.close()
}

describe('IndexedDbDataAdapter', () => {
  it('initializes lazily and stores only a random namespace identity in App storage', async () => {
    const app = new FakeAppLocalStorage()
    const load = jest.spyOn(app, 'loadLocalStorage')
    const save = jest.spyOn(app, 'saveLocalStorage')
    const adapter = createAdapter(app)

    expect(load).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()

    await adapter.mkdir('private')
    await adapter.write('private/value.txt', 'payload')

    expect(load).toHaveBeenCalledWith(
      MODULE_DEVICE_LOCAL_DATABASE_NAMESPACE_KEY,
    )
    expect(save).toHaveBeenCalledWith(
      MODULE_DEVICE_LOCAL_DATABASE_NAMESPACE_KEY,
      FIRST_NAMESPACE,
    )
    expect([...app.values.entries()]).toEqual([
      [MODULE_DEVICE_LOCAL_DATABASE_NAMESPACE_KEY, FIRST_NAMESPACE],
    ])
  })

  it('round-trips a 16 MiB binary with independent input and output buffers', async () => {
    const adapter = createAdapter()
    await createTree(adapter)
    const source = new Uint8Array(16 * 1024 * 1024)
    for (let index = 0; index < source.length; index += 1) {
      source[index] = index % 251
    }

    const write = adapter.writeBinary('private/notes/index.bin', source.buffer)
    source.fill(255)
    await write

    const first = await adapter.readBinary('private/notes/index.bin')
    expect(first.byteLength).toBe(16 * 1024 * 1024)
    expect(new Uint8Array(first)[0]).toBe(0)
    expect(new Uint8Array(first)[1_000_000]).toBe(16)
    new Uint8Array(first).fill(17)
    const second = await adapter.readBinary('private/notes/index.bin')
    expect(new Uint8Array(second)[0]).toBe(0)
    expect(new Uint8Array(second)[1_000_000]).toBe(16)
  })

  it('persists records across adapter instances for the same vault identity', async () => {
    const app = new FakeAppLocalStorage()
    const indexedDB = new IDBFactory()
    const first = createAdapter(app, indexedDB)
    await createTree(first)
    await first.write('private/notes/value.txt', 'persisted')

    const second = new IndexedDbDataAdapter(app, { indexedDB })

    await expect(second.read('private/notes/value.txt')).resolves.toBe(
      'persisted',
    )
  })

  it('does not expose records across vault database namespaces', async () => {
    const indexedDB = new IDBFactory()
    const firstApp = new FakeAppLocalStorage()
    const secondApp = new FakeAppLocalStorage()
    const first = createAdapter(firstApp, indexedDB, FIRST_NAMESPACE)
    const second = createAdapter(secondApp, indexedDB, SECOND_NAMESPACE)
    await createTree(first)
    await createTree(second)
    await first.write('private/notes/value.txt', 'first')
    await second.write('private/notes/value.txt', 'second')

    await expect(first.read('private/notes/value.txt')).resolves.toBe('first')
    await expect(second.read('private/notes/value.txt')).resolves.toBe('second')
    await first.remove('private/notes/value.txt')
    await expect(second.read('private/notes/value.txt')).resolves.toBe('second')
  })

  it('supports explicit folders, parent checks, deterministic immediate lists, and file removal', async () => {
    const adapter = createAdapter()
    await createTree(adapter)
    await adapter.mkdir('private/notes/z-folder')
    await adapter.mkdir('private/notes/a-folder')
    await adapter.write('private/notes/z.txt', 'z')
    await adapter.write('private/notes/a.txt', 'alpha')
    await adapter.write('private/notes/a-folder/nested.txt', 'nested')

    await expect(adapter.list('private/notes')).resolves.toEqual({
      files: ['private/notes/a.txt', 'private/notes/z.txt'],
      folders: ['private/notes/a-folder', 'private/notes/z-folder'],
    })
    await expect(adapter.stat('private/notes/a.txt')).resolves.toMatchObject({
      type: 'file',
      size: 5,
    })
    await expect(adapter.stat('private/notes/a-folder')).resolves.toMatchObject(
      { type: 'folder', size: 0 },
    )
    await expect(adapter.list('private/notes/a.txt')).resolves.toEqual({
      files: [],
      folders: [],
    })
    await expect(adapter.write('missing/value.txt', 'x')).rejects.toThrow(
      'parent folder',
    )
    await expect(adapter.remove('private/notes')).rejects.toThrow('folder')
    await adapter.remove('private/notes/a.txt')
    await expect(adapter.exists('private/notes/a.txt')).resolves.toBe(false)
  })

  it('lists through key cursors without fetching or cloning child payloads', async () => {
    const adapter = createAdapter()
    await createTree(adapter)
    await adapter.writeBinary(
      'private/notes/large.bin',
      new Uint8Array(1024 * 1024).buffer,
    )
    await adapter.mkdir('private/notes/child')
    const get = jest.spyOn(IDBObjectStore.prototype, 'get')
    const getAll = jest.spyOn(IDBObjectStore.prototype, 'getAll')

    await expect(adapter.list('private/notes')).resolves.toEqual({
      files: ['private/notes/large.bin'],
      folders: ['private/notes/child'],
    })

    expect(get).toHaveBeenCalledTimes(1)
    expect(get).toHaveBeenCalledWith('private/notes')
    expect(getAll).not.toHaveBeenCalled()
    get.mockRestore()
    getAll.mockRestore()
  })

  it('bounds wide immediate-child listings at the provider cap plus one', async () => {
    const indexedDB = new IDBFactory()
    const adapter = createAdapter(new FakeAppLocalStorage(), indexedDB)
    await createTree(adapter)
    const now = Date.now()
    await putRawRecord(
      indexedDB,
      FIRST_NAMESPACE,
      Array.from(
        { length: MAX_MODULE_PRIVATE_LIST_ENTRIES + 2 },
        (_, index) => ({
          version: 1,
          path: `private/notes/${String(index).padStart(4, '0')}.txt`,
          parent: 'private/notes',
          kind: 'file',
          type: 'text',
          ctime: now,
          mtime: now,
          size: 1,
          data: 'x',
        }),
      ),
    )

    const listed = await adapter.list('private/notes')

    expect(listed.files).toHaveLength(MAX_MODULE_PRIVATE_LIST_ENTRIES + 1)
    expect(listed.folders).toEqual([])
  }, 30_000)

  it('commits concurrent writes to different records without losing either file', async () => {
    const adapter = createAdapter()
    await createTree(adapter)

    await Promise.all([
      adapter.write('private/notes/first.txt', 'first'),
      adapter.write('private/notes/second.txt', 'second'),
    ])

    await expect(adapter.read('private/notes/first.txt')).resolves.toBe('first')
    await expect(adapter.read('private/notes/second.txt')).resolves.toBe(
      'second',
    )
  })

  it('rejects corrupt direct reads while isolating listings from unrelated corrupt payloads', async () => {
    const app = new FakeAppLocalStorage()
    const indexedDB = new IDBFactory()
    const adapter = createAdapter(app, indexedDB)
    await createTree(adapter)
    await adapter.write('private/notes/corrupt.txt', 'valid')
    await putRawRecord(indexedDB, FIRST_NAMESPACE, {
      version: 1,
      path: 'private/notes/corrupt.txt',
      parent: 'private/notes',
      kind: 'file',
      type: 'text',
      ctime: 1,
      mtime: 1,
      size: 999,
      data: 'valid',
    })
    await putRawRecord(indexedDB, FIRST_NAMESPACE, {
      version: 1,
      path: 'private/other-module/corrupt.bin',
      parent: 'private/other-module',
      kind: 'file',
      type: 'binary',
      ctime: 1,
      mtime: 1,
      size: 10,
      data: new Uint8Array([1]).buffer,
    })

    await expect(adapter.stat('private/notes/corrupt.txt')).rejects.toThrow(
      'record is corrupt',
    )
    await expect(adapter.read('private/notes/corrupt.txt')).rejects.toThrow(
      'record is corrupt',
    )
    await expect(adapter.list('private/notes')).resolves.toEqual({
      files: ['private/notes/corrupt.txt'],
      folders: [],
    })
  })

  it('rejects invalid paths before opening IndexedDB', async () => {
    const app = new FakeAppLocalStorage()
    const adapter = createAdapter(app)

    await expect(adapter.stat('../outside')).rejects.toThrow(
      'normalized relative path',
    )
    await expect(adapter.mkdir('/outside')).rejects.toThrow(
      'normalized relative path',
    )
    expect(app.values.size).toBe(0)
  })

  it('reports unavailable IndexedDB only when an operation starts', async () => {
    const app = new FakeAppLocalStorage()
    const adapter = new IndexedDbDataAdapter(app, {
      indexedDB: null,
      createNamespaceId: () => FIRST_NAMESPACE,
    })

    expect(app.values.size).toBe(0)
    await expect(adapter.stat('private')).rejects.toThrow(
      'IndexedDB is unavailable',
    )

    const inaccessibleFactory = new IDBFactory()
    jest.spyOn(inaccessibleFactory, 'open').mockImplementation(() => {
      throw new Error('security policy')
    })
    await expect(
      createAdapter(new FakeAppLocalStorage(), inaccessibleFactory).stat(
        'private',
      ),
    ).rejects.toThrow('database open failed: security policy')
  })

  it('retries failed opens and reopens after a versionchange closes the connection', async () => {
    const app = new FakeAppLocalStorage()
    const indexedDB = new IDBFactory()
    const realOpen = indexedDB.open.bind(indexedDB)
    const open = jest
      .spyOn(indexedDB, 'open')
      .mockImplementationOnce(() => {
        throw new Error('temporary failure')
      })
      .mockImplementation((name, version) => realOpen(name, version))
    const adapter = createAdapter(app, indexedDB)

    await expect(adapter.stat('private')).rejects.toThrow('temporary failure')
    await expect(adapter.stat('private')).resolves.toBeNull()
    await adapter.mkdir('private')
    await deleteRawDatabase(indexedDB, FIRST_NAMESPACE)
    await expect(adapter.stat('private')).resolves.toBeNull()
    expect(open).toHaveBeenCalledTimes(3)
  })

  it('rejects existing databases with the wrong required index schema', async () => {
    const indexedDB = new IDBFactory()
    await createDatabaseWithWrongIndex(indexedDB, FIRST_NAMESPACE)
    const app = new FakeAppLocalStorage()
    app.values.set(MODULE_DEVICE_LOCAL_DATABASE_NAMESPACE_KEY, FIRST_NAMESPACE)
    const adapter = new IndexedDbDataAdapter(app, { indexedDB })

    await expect(adapter.stat('private')).rejects.toThrow(
      'database schema is corrupt',
    )
  })

  it('closes idempotently and rejects later operations', async () => {
    const adapter = createAdapter()
    await createTree(adapter)

    adapter.close()
    adapter.close()
    adapter.dispose()

    await expect(adapter.stat('private')).rejects.toThrow('adapter is closed')
    await expect(adapter.write('private/value.txt', 'x')).rejects.toThrow(
      'adapter is closed',
    )
  })

  it('fails closed for malformed or inaccessible vault namespace identities', async () => {
    const indexedDB = new IDBFactory()
    const malformed = new FakeAppLocalStorage()
    malformed.values.set(
      MODULE_DEVICE_LOCAL_DATABASE_NAMESPACE_KEY,
      'not-a-namespace',
    )
    const malformedSave = jest.spyOn(malformed, 'saveLocalStorage')
    const malformedAdapter = new IndexedDbDataAdapter(malformed, { indexedDB })
    await expect(malformedAdapter.stat('private')).rejects.toThrow(
      'namespace is malformed',
    )
    expect(malformedSave).not.toHaveBeenCalled()

    const unreadable = new FakeAppLocalStorage()
    jest.spyOn(unreadable, 'loadLocalStorage').mockImplementation(() => {
      throw new Error('denied')
    })
    await expect(
      createAdapter(unreadable, indexedDB).stat('private'),
    ).rejects.toThrow('namespace read failed')

    const unwritable = new FakeAppLocalStorage()
    jest.spyOn(unwritable, 'saveLocalStorage').mockImplementation(() => {
      throw new Error('quota')
    })
    await expect(
      createAdapter(unwritable, indexedDB).stat('private'),
    ).rejects.toThrow('namespace write failed')

    const invalidGenerated = new IndexedDbDataAdapter(
      new FakeAppLocalStorage(),
      {
        indexedDB,
        createNamespaceId: () => 'invalid',
      },
    )
    await expect(invalidGenerated.stat('private')).rejects.toThrow(
      'generated vault database namespace is malformed',
    )
  })
})
