import { FileAnkiImportJournalStorage } from '../../anki/import/journalStorage'
import type { AnkiImportResult } from '../../anki/parser/types'
import { parseAnkiPackageInWorker } from '../../anki/worker/client'
import { LEARNING_MANAGED_DATA_NAMESPACE } from '../paths'
import { createHostLearningSrsStorage } from '../srsStorage'

import { createHostAnkiRuntime } from './runtime'
import {
  createHostAnkiJournalFilePort,
  createHostAnkiJournalStorage,
} from './sharedData'
import {
  HOST_ANKI_IMPORT_BLOCKER,
  createHostAnkiImportVaultPort,
} from './vault'
import { HOST_ANKI_WORKER_METHOD, createHostAnkiWorkerFactory } from './worker'

type PrivateScope = YoloModuleHostApiV1['privateStorage']['deviceLocal']

class MemoryPrivateScope {
  readonly files = new Map<string, string | ArrayBuffer>()
  readonly folders = new Set<string>()
  readonly calls: string[] = []
  readonly removeFile = jest.fn(async (key: string) => {
    this.calls.push(`removeFile:${key}`)
    return this.files.delete(key)
  })
  readonly remove = jest.fn(async (key: string) => {
    this.calls.push(`remove:${key}`)
    this.files.delete(key)
    for (const file of [...this.files.keys()]) {
      if (file.startsWith(`${key}/`)) this.files.delete(file)
    }
    for (const folder of [...this.folders]) {
      if (folder === key || folder.startsWith(`${key}/`)) {
        this.folders.delete(folder)
      }
    }
  })

  asScope(): PrivateScope {
    return this as unknown as PrivateScope
  }

  async list(prefix = ''): Promise<readonly string[]> {
    return [...this.files.keys()].filter((key) =>
      prefix ? key.startsWith(`${prefix}/`) : true,
    )
  }

  async stat(key: string) {
    const value = this.files.get(key)
    if (value !== undefined) {
      return {
        type: 'file' as const,
        size: typeof value === 'string' ? value.length : value.byteLength,
      }
    }
    return this.folders.has(key) ? { type: 'folder' as const, size: 0 } : null
  }

  async listEntries(prefix = '') {
    const direct = (key: string) => {
      const suffix = prefix ? key.slice(prefix.length + 1) : key
      return key.startsWith(prefix ? `${prefix}/` : '') && !suffix.includes('/')
    }
    return {
      files: [...this.files.keys()].filter(direct),
      folders: [...this.folders].filter(direct),
    }
  }

  async readText(key: string): Promise<string | null> {
    const value = this.files.get(key)
    return typeof value === 'string' ? value : null
  }

  async readBinary(key: string): Promise<ArrayBuffer | null> {
    const value = this.files.get(key)
    return value instanceof ArrayBuffer ? value.slice(0) : null
  }

  async readJson<T>(key: string): Promise<T | null> {
    const value = await this.readText(key)
    return value === null ? null : (JSON.parse(value) as T)
  }

  async writeText(key: string, value: string): Promise<void> {
    this.calls.push(`writeText:${key}`)
    this.files.set(key, value)
  }

  async writeBinary(key: string, value: ArrayBuffer): Promise<void> {
    this.calls.push(`writeBinary:${key}`)
    this.files.set(key, value.slice(0))
  }

  async writeJson(key: string, value: unknown): Promise<void> {
    await this.writeText(key, JSON.stringify(value))
  }

  async mkdir(key: string): Promise<void> {
    this.calls.push(`mkdir:${key}`)
    this.folders.add(key)
  }

  async rename(fromKey: string, toKey: string): Promise<void> {
    this.calls.push(`rename:${fromKey}:${toKey}`)
    if (this.files.has(fromKey)) {
      this.files.set(toKey, this.files.get(fromKey)!)
      this.files.delete(fromKey)
      return
    }
    if (this.folders.has(fromKey)) {
      this.folders.delete(fromKey)
      this.folders.add(toKey)
      for (const key of [...this.files.keys()]) {
        if (!key.startsWith(`${fromKey}/`)) continue
        this.files.set(
          `${toKey}${key.slice(fromKey.length)}`,
          this.files.get(key)!,
        )
        this.files.delete(key)
      }
      return
    }
    throw new Error('missing source')
  }
}

const privateStorageHost = (
  synchronized: MemoryPrivateScope,
  deviceLocal = new MemoryPrivateScope(),
) => ({
  privateStorage: {
    synchronized: synchronized.asScope(),
    deviceLocal: deviceLocal.asScope(),
  },
})

describe('Host Anki private storage adapters', () => {
  it('maps the runtime empty root to a non-empty private key and preserves atomic rename', async () => {
    const deviceLocal = new MemoryPrivateScope()
    const runtime = createHostAnkiRuntime(
      privateStorageHost(new MemoryPrivateScope(), deviceLocal),
      jest.fn(),
    )

    await runtime.storage.mkdir('')
    await runtime.storage.mkdir('.tmp-v1')
    await runtime.storage.writeText('.tmp-v1/manifest.json', '{}')
    await runtime.storage.rename('.tmp-v1', 'v1')
    await runtime.storage.writeText('current.json', '{"version":"v1"}')

    expect(deviceLocal.calls).toContain('mkdir:anki-runtime')
    expect(deviceLocal.calls).not.toContain('mkdir:')
    expect(deviceLocal.calls).toContain(
      'rename:anki-runtime/p2e746d702d7631:anki-runtime/p7631',
    )
    expect(
      deviceLocal.calls.some((call) => call.includes('anki-runtime/.tmp-v1')),
    ).toBe(false)
    expect(
      deviceLocal.files.get('anki-runtime/p7631/p6d616e69666573742e6a736f6e'),
    ).toBe('{}')
    expect(
      deviceLocal.files.get('anki-runtime/p63757272656e742e6a736f6e'),
    ).toBe('{"version":"v1"}')
    await expect(runtime.storage.list('')).resolves.toEqual({
      files: ['current.json'],
      folders: ['v1'],
    })
  })

  it('serializes managers sharing one Host storage root', async () => {
    const deviceLocal = new MemoryPrivateScope()
    const host = privateStorageHost(new MemoryPrivateScope(), deviceLocal)
    const first = createHostAnkiRuntime(host, jest.fn())
    const second = createHostAnkiRuntime(host, jest.fn())
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const order: string[] = []

    const firstRun = first.runExclusive(async () => {
      order.push('first-start')
      markStarted()
      await gate
      order.push('first-end')
    })
    const secondRun = second.runExclusive(async () => {
      order.push('second')
    })
    await started
    expect(order).toEqual(['first-start'])
    release()
    await Promise.all([firstRun, secondRun])
    expect(order).toEqual(['first-start', 'first-end', 'second'])
  })

  it('downloads bytes and rejects non-success responses', async () => {
    const ok = jest.fn(
      async () => new Response(Uint8Array.from([1, 2]), { status: 200 }),
    )
    const runtime = createHostAnkiRuntime(
      privateStorageHost(new MemoryPrivateScope()),
      ok,
    )
    await expect(
      runtime.downloadArrayBuffer('https://example.test/a'),
    ).resolves.toEqual(Uint8Array.from([1, 2]).buffer)

    const failed = createHostAnkiRuntime(
      privateStorageHost(new MemoryPrivateScope()),
      async () => new Response(null, { status: 503 }),
    )
    await expect(
      failed.downloadArrayBuffer('https://example.test/fail'),
    ).rejects.toThrow('HTTP 503')
  })
})

describe('Host Anki shared sidecars', () => {
  const createSharedVault = () => {
    const files = new Map<string, string>()
    const folders = new Set<string>()
    const removeFileExact = jest.fn(async (path: string) => files.delete(path))
    const trashPath = jest.fn()
    const getEntry = (path: string) => {
      if (folders.has(path)) {
        return { kind: 'folder' as const, path, name: path.split('/').at(-1)! }
      }
      if (!files.has(path)) return null
      return {
        kind: 'file' as const,
        path,
        name: path.split('/').at(-1)!,
        ctime: 0,
        mtime: 0,
      }
    }
    const vault = {
      getEntry,
      listChildren: (directory: string) => {
        const prefix = `${directory}/`
        return [...files.keys(), ...folders]
          .filter(
            (path) =>
              path.startsWith(prefix) &&
              !path.slice(prefix.length).includes('/'),
          )
          .map((path) => getEntry(path)!)
      },
      stat: jest.fn(async (path: string) => getEntry(path)),
      list: jest.fn(async (directory: string) => {
        const prefix = `${directory}/`
        return [...files.keys(), ...folders]
          .filter(
            (path) =>
              path.startsWith(prefix) &&
              !path.slice(prefix.length).includes('/'),
          )
          .map((path) => getEntry(path)!)
      }),
      ensureFolder: jest.fn(async (path: string) => void folders.add(path)),
      exists: jest.fn(async (path: string) => getEntry(path) !== null),
      readText: jest.fn(async (path: string) => files.get(path)!),
      createText: jest.fn(async (path: string, content: string) => {
        if (getEntry(path)) throw new Error(`Path exists: ${path}`)
        files.set(path, content)
        return { path, mtime: 1 }
      }),
      createTextIfAbsent: jest.fn(async (path: string, content: string) => {
        if (files.has(path)) return null
        files.set(path, content)
        return { path, content }
      }),
      writeText: jest.fn(async (path: string, content: string) => {
        files.set(path, content)
        return { path, mtime: 1 }
      }),
      removeFileExact,
      trashPath,
    } as unknown as YoloModuleHostApiV1['vault']
    return { files, folders, removeFileExact, trashPath, vault }
  }

  it('keeps SRS and journals in their canonical Vault paths', async () => {
    const synchronized = new MemoryPrivateScope()
    let contentRoot = 'First/learning'
    const { files, vault } = createSharedVault()
    const storage = createHostLearningSrsStorage({
      vault,
      paths: {
        getSnapshot: () => ({ contentRoot }),
        subscribe: () => () => undefined,
        runExclusive: async <T>(
          _namespace: string,
          operation: () => T | PromiseLike<T>,
        ): Promise<T> => await operation(),
      },
    })
    const projectSlug = 'Project 一'
    const pinned = await storage.ensure(projectSlug)
    expect(pinned).toBe('First/.yolo_json_db/learning-srs/Project 一.json')
    await storage.writeProjectStateAtPath(projectSlug, pinned, 'old')

    contentRoot = 'Second/learning'
    expect(storage.getLocationKey()).toBe('Second/.yolo_json_db')
    await storage.write(projectSlug, 'new')
    await expect(
      storage.existsProjectStateAtPath(projectSlug, pinned),
    ).resolves.toBe(true)
    await expect(
      storage.removeProjectStateAtPath(projectSlug, pinned),
    ).resolves.toBe(true)
    await expect(storage.read(projectSlug)).resolves.toMatchObject({
      content: 'new',
    })
    const journals = createHostAnkiJournalStorage({
      vault,
      paths: {
        getSnapshot: () => ({ contentRoot }),
        subscribe: () => () => undefined,
        runExclusive: async <T>(
          _namespace: string,
          operation: () => T | PromiseLike<T>,
        ): Promise<T> => await operation(),
      },
    })
    const journalPath = await journals.create('{}')
    expect(journalPath).toMatch(
      /^Second\/.yolo_json_db\/anki-import-journals\/.+\.json$/,
    )
    expect(files.get(journalPath)).toBe('{}')
    expect(synchronized.calls).toEqual([])
  })

  it('follows the current root, lists explicit legacy roots, and removes exact files', async () => {
    const { files, folders, removeFileExact, trashPath, vault } =
      createSharedVault()
    let root = 'One/.yolo_json_db'
    const legacyDirectory = 'Legacy/.yolo_json_db/anki-import-journals'
    folders.add(legacyDirectory)
    files.set(`${legacyDirectory}/old.json`, '{}')
    files.set(`${legacyDirectory}/notes.md`, 'keep')
    files.set(`${legacyDirectory}/nested/run.json`, 'ignore')
    const journals = new FileAnkiImportJournalStorage(
      createHostAnkiJournalFilePort(vault, async () => root, {
        legacyJournalDataRoots: ['Legacy/.yolo_json_db'],
      }),
      async () => root,
    )
    const first = await journals.create('{}')
    root = 'Two/.yolo_json_db'
    const second = await journals.create('{"phase":"writing"}')

    await expect(journals.list()).resolves.toEqual([
      `${legacyDirectory}/old.json`,
      second,
    ])
    await journals.remove(first)
    expect(removeFileExact).toHaveBeenCalledWith(first)
    expect(trashPath).not.toHaveBeenCalled()
    expect(files.get(`${legacyDirectory}/notes.md`)).toBe('keep')
  })

  it('locks complete journal mutations and resolves root after queueing', async () => {
    const { files, vault } = createSharedVault()
    let contentRoot = 'Old/learning'
    let queue = Promise.resolve()
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const namespaces: string[] = []
    const runExclusive = <T>(
      namespace: string,
      operation: () => T | PromiseLike<T>,
    ): Promise<T> => {
      namespaces.push(namespace)
      const result = queue.then(operation)
      queue = result.then(
        () => undefined,
        () => undefined,
      )
      return result
    }
    const paths = {
      getSnapshot: () => ({ contentRoot }),
      subscribe: () => () => undefined,
      runExclusive,
    }
    const journals = createHostAnkiJournalStorage({ vault, paths })
    const relocation = paths.runExclusive(
      LEARNING_MANAGED_DATA_NAMESPACE,
      () => barrier,
    )
    const creating = journals.create('{}')

    await Promise.resolve()
    contentRoot = 'Moved/learning'
    release()
    await relocation
    const path = await creating
    await journals.write(path, '{"phase":"writing"}')
    await journals.remove(path)

    expect(path).toMatch(
      /^Moved\/.yolo_json_db\/anki-import-journals\/.+\.json$/,
    )
    expect(files.has(path)).toBe(false)
    expect(namespaces).toEqual([
      LEARNING_MANAGED_DATA_NAMESPACE,
      LEARNING_MANAGED_DATA_NAMESPACE,
      LEARNING_MANAGED_DATA_NAMESPACE,
      LEARNING_MANAGED_DATA_NAMESPACE,
    ])
  })
})

describe('Host Anki vault boundary', () => {
  it('uses permanent exact removal and never falls back to trash', async () => {
    const trashPath = jest.fn(async () => true)
    const removeFileExact = jest.fn(async () => true)
    const removeEmptyFolderExact = jest.fn(async () => true)
    const vault = {
      getEntry: jest.fn((path: string) =>
        path === 'folder'
          ? { kind: 'folder', path, name: path }
          : { kind: 'file', path, name: path, ctime: 0, mtime: 0 },
      ),
      listChildren: jest.fn(() => []),
      exists: jest.fn(async () => false),
      readText: jest.fn(async () => 'text'),
      readBinary: jest.fn(async () => new ArrayBuffer(0)),
      ensureFolder: jest.fn(async () => undefined),
      createFolder: jest.fn(async () => undefined),
      createText: jest.fn(async () => ({ path: 'a.md', mtime: 1 })),
      createBinary: jest.fn(async () => undefined),
      removeFileExact,
      removeEmptyFolderExact,
      trashPath,
    } as unknown as YoloModuleHostApiV1['vault']
    const adapter = createHostAnkiImportVaultPort(vault)
    await adapter.createText('a.md', 'text')
    await expect(adapter.readText('a.md')).resolves.toBe('text')
    await adapter.removeExactPath('a.md')
    await adapter.removeEmptyFolder('folder')

    expect(removeFileExact).toHaveBeenCalledWith('a.md')
    expect(removeEmptyFolderExact).toHaveBeenCalledWith('folder')
    expect(trashPath).not.toHaveBeenCalled()
  })

  it('refuses non-empty folders without invoking Host deletion', async () => {
    const removeEmptyFolderExact = jest.fn(async () => true)
    const vault = {
      getEntry: () => ({ kind: 'folder', path: 'folder', name: 'folder' }),
      listChildren: () => [
        { kind: 'file', path: 'folder/kept.md', name: 'kept.md' },
      ],
      removeFileExact: jest.fn(),
      removeEmptyFolderExact,
    } as unknown as YoloModuleHostApiV1['vault']

    await expect(
      createHostAnkiImportVaultPort(vault).removeEmptyFolder('folder'),
    ).rejects.toThrow('non-empty')
    expect(removeEmptyFolderExact).not.toHaveBeenCalled()
  })

  it('fails closed when exact Host capabilities are absent or refuse removal', async () => {
    const vault = {
      getEntry: () => ({
        kind: 'file',
        path: 'owned.md',
        name: 'owned.md',
        ctime: 0,
        mtime: 0,
      }),
      listChildren: () => [],
    } as unknown as YoloModuleHostApiV1['vault']
    expect(() => createHostAnkiImportVaultPort(vault)).toThrow(
      HOST_ANKI_IMPORT_BLOCKER,
    )

    Object.assign(vault, {
      removeFileExact: async () => false,
      removeEmptyFolderExact: async () => true,
    })
    await expect(
      createHostAnkiImportVaultPort(vault).removeExactPath('owned.md'),
    ).rejects.toThrow('Host refused')
  })
})

describe('Host Anki worker RPC bridge', () => {
  const result: AnkiImportResult = {
    format: 'modern',
    decks: [],
    notes: [],
    media: {},
    mediaFiles: {},
    srsPlan: { eventsByCard: {} },
    warnings: [],
  }

  it('forwards transfer ownership through Host RPC and terminates on success', async () => {
    const terminate = jest.fn()
    const call = jest.fn(async () => ({
      id: '00000000-0000-4000-8000-000000000000',
      result,
    }))
    let createdSource = ''
    const create: YoloModuleHostApiV1['workers']['create'] = (source) => {
      createdSource = source
      return {
        call: call as unknown as YoloModuleHostWorkerV1['call'],
        terminate,
      }
    }
    const factory = createHostAnkiWorkerFactory({ create })
    jest
      .spyOn(crypto, 'randomUUID')
      .mockReturnValue('00000000-0000-4000-8000-000000000000')
    const packageBytes = new ArrayBuffer(2)
    const wasmBytes = new ArrayBuffer(3)

    await expect(
      parseAnkiPackageInWorker(
        factory,
        'self.onmessage = () => undefined;',
        packageBytes,
        wasmBytes,
      ),
    ).resolves.toBe(result)
    expect(call).toHaveBeenCalledWith(
      HOST_ANKI_WORKER_METHOD,
      {
        id: '00000000-0000-4000-8000-000000000000',
        packageBytes,
        wasmBytes,
      },
      { transfer: [packageBytes, wasmBytes] },
    )
    expect(createdSource).toContain("Object.defineProperty(self, 'onmessage'")
    expect(terminate).toHaveBeenCalledTimes(1)
  })

  it('terminates once on abort and suppresses the late Host rejection', async () => {
    let rejectCall!: (error: Error) => void
    const call = jest.fn(
      () =>
        new Promise<never>((_resolve, reject) => {
          rejectCall = reject
        }),
    )
    const terminate = jest.fn()
    const factory = createHostAnkiWorkerFactory({
      create: () => ({
        call: call as unknown as YoloModuleHostWorkerV1['call'],
        terminate,
      }),
    })
    const controller = new AbortController()
    const parsing = parseAnkiPackageInWorker(
      factory,
      'self.onmessage = () => undefined;',
      new ArrayBuffer(1),
      new ArrayBuffer(1),
      controller.signal,
    )

    controller.abort()
    await expect(parsing).rejects.toMatchObject({ name: 'AbortError' })
    rejectCall(new Error('terminated'))
    await Promise.resolve()
    expect(terminate).toHaveBeenCalledTimes(1)
  })

  afterEach(() => jest.restoreAllMocks())
})
