import type {
  AnkiRuntimeHost,
  AnkiRuntimeStorage,
} from './AnkiRuntimeHost'
import { AnkiSqliteRuntimeManager } from './AnkiSqliteRuntimeManager'
import type { AnkiRuntimeManifest } from './metadata'

class MemoryStorage implements AnkiRuntimeStorage {
  readonly entries = new Map<string, { type: 'file' | 'folder'; bytes?: ArrayBuffer }>([
    ['', { type: 'folder' }],
  ])
  readonly removed: string[] = []
  readonly renamed: [string, string][] = []
  readonly binaryWrites: string[] = []

  async exists(path: string) {
    return this.entries.has(path)
  }

  async stat(path: string) {
    const entry = this.entries.get(path)
    return entry
      ? { type: entry.type, size: entry.bytes?.byteLength ?? 0 }
      : null
  }

  async list(path: string) {
    const prefix = path ? `${path}/` : ''
    const files: string[] = []
    const folders: string[] = []
    for (const [entryPath, entry] of this.entries) {
      if (!entryPath.startsWith(prefix) || entryPath === path) continue
      if (entryPath.slice(prefix.length).includes('/')) continue
      ;(entry.type === 'folder' ? folders : files).push(entryPath)
    }
    return { files, folders }
  }

  async mkdir(path: string) {
    this.entries.set(path, { type: 'folder' })
  }

  async remove(path: string) {
    this.removed.push(path)
    for (const entryPath of [...this.entries.keys()]) {
      if (!path || entryPath === path || entryPath.startsWith(`${path}/`)) {
        this.entries.delete(entryPath)
      }
    }
  }

  async rename(fromPath: string, toPath: string) {
    this.renamed.push([fromPath, toPath])
    const moved = [...this.entries.entries()].filter(
      ([path]) => path === fromPath || path.startsWith(`${fromPath}/`),
    )
    if (!moved.length) throw new Error(`Missing path: ${fromPath}`)
    for (const [path] of moved) this.entries.delete(path)
    for (const [path, entry] of moved) {
      this.entries.set(`${toPath}${path.slice(fromPath.length)}`, entry)
    }
  }

  async readText(path: string) {
    const bytes = await this.readBinary(path)
    return new TextDecoder().decode(bytes)
  }

  async readBinary(path: string) {
    const entry = this.entries.get(path)
    if (!entry?.bytes) throw new Error(`Missing file: ${path}`)
    return entry.bytes.slice(0)
  }

  async writeText(path: string, content: string) {
    this.entries.set(path, {
      type: 'file',
      bytes: new TextEncoder().encode(content).buffer,
    })
  }

  async writeBinary(path: string, content: ArrayBuffer) {
    this.binaryWrites.push(path)
    this.entries.set(path, { type: 'file', bytes: content.slice(0) })
  }
}

const sha256 = async (bytes: ArrayBuffer): Promise<string> =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('')

const createExclusive = () => {
  let tail = Promise.resolve()
  return async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = tail
    let release!: () => void
    tail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }
}

const fixture = async () => {
  const bytes = Uint8Array.from([1, 2, 3, 4]).buffer
  const manifest: AnkiRuntimeManifest = {
    runtimeVersion: 'test-v1',
    files: [
      {
        name: 'sql-wasm.wasm',
        size: bytes.byteLength,
        sha256: await sha256(bytes),
        url: 'https://example.test/sql-wasm.wasm',
      },
    ],
  }
  const storage = new MemoryStorage()
  const downloadArrayBuffer = jest.fn(async () => bytes.slice(0))
  const host: AnkiRuntimeHost = {
    storage,
    downloadArrayBuffer,
    runExclusive: createExclusive(),
  }
  return { bytes, manifest, storage, host, downloadArrayBuffer }
}

describe('AnkiSqliteRuntimeManager', () => {
  it('reports missing, installs a ready runtime, and loads its wasm', async () => {
    const { bytes, manifest, host } = await fixture()
    const manager = new AnkiSqliteRuntimeManager({ host, manifest })

    await expect(manager.getStatus()).resolves.toEqual({
      kind: 'missing',
      expectedVersion: 'test-v1',
      dir: 'test-v1',
    })
    await expect(manager.ensureReady()).resolves.toEqual({
      version: 'test-v1',
      dir: 'test-v1',
    })
    await expect(manager.getStatus()).resolves.toMatchObject({
      kind: 'ready',
      version: 'test-v1',
      dir: 'test-v1',
    })
    await expect(manager.loadWasm()).resolves.toEqual(new Uint8Array(bytes))
  })

  it('rejects integrity failures, records failure, and removes staging', async () => {
    const { manifest, storage, host } = await fixture()
    host.downloadArrayBuffer = jest.fn(async () => Uint8Array.from([9, 9]).buffer)
    const manager = new AnkiSqliteRuntimeManager({ host, manifest })

    await expect(manager.ensureReady()).rejects.toThrow('integrity check failed')
    await expect(manager.getStatus()).resolves.toMatchObject({
      kind: 'failed',
      reason: 'Runtime integrity check failed: sql-wasm.wasm',
    })
    expect(storage.entries.has('.tmp-test-v1')).toBe(false)
  })

  it('cleans interrupted staging and obsolete versions while preserving current', async () => {
    const { manifest, storage, host } = await fixture()
    await storage.mkdir('.tmp-test-v1')
    await storage.writeText('.tmp-test-v1/partial', 'partial')
    await storage.mkdir('old-v0')
    const manager = new AnkiSqliteRuntimeManager({ host, manifest })

    await manager.ensureReady()

    expect(storage.removed).toContain('.tmp-test-v1')
    expect(storage.entries.has('old-v0')).toBe(false)
    expect(storage.entries.has('test-v1/sql-wasm.wasm')).toBe(true)
    expect(storage.renamed).toEqual([['.tmp-test-v1', 'test-v1']])
    expect(storage.binaryWrites).toEqual(['.tmp-test-v1/sql-wasm.wasm'])
  })

  it('detects same-size corruption and reinstalls before loading wasm', async () => {
    const { bytes, manifest, storage, host, downloadArrayBuffer } = await fixture()
    const manager = new AnkiSqliteRuntimeManager({ host, manifest })
    await manager.ensureReady()
    await storage.writeBinary(
      'test-v1/sql-wasm.wasm',
      Uint8Array.from([4, 3, 2, 1]).buffer,
    )

    await expect(manager.getStatus()).resolves.toMatchObject({ kind: 'missing' })
    await expect(manager.loadWasm()).resolves.toEqual(new Uint8Array(bytes))
    expect(downloadArrayBuffer).toHaveBeenCalledTimes(2)
  })

  it('shares one download between two managers with separate hosts', async () => {
    const { bytes, manifest, storage } = await fixture()
    let release!: (bytes: ArrayBuffer) => void
    const pendingDownload = new Promise<ArrayBuffer>((resolve) => {
      release = resolve
    })
    const downloadArrayBuffer = jest.fn(() => pendingDownload)
    const runExclusive = createExclusive()
    const firstManager = new AnkiSqliteRuntimeManager({
      host: { storage, downloadArrayBuffer, runExclusive },
      manifest,
    })
    const secondManager = new AnkiSqliteRuntimeManager({
      host: { storage, downloadArrayBuffer, runExclusive },
      manifest,
    })

    const first = firstManager.ensureReady()
    const second = secondManager.ensureReady()
    release(bytes)

    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
    expect(downloadArrayBuffer).toHaveBeenCalledTimes(1)
  })

  it.each(['remove-target', 'rename', 'write-marker'] as const)(
    'does not leave a live marker when promotion fails at %s',
    async (failurePoint) => {
      const { manifest, storage, host } = await fixture()
      const originalRemove = storage.remove.bind(storage)
      const originalWriteText = storage.writeText.bind(storage)
      if (failurePoint === 'remove-target') {
        storage.remove = jest.fn(async (path) => {
          if (path === 'test-v1') throw new Error('remove target failed')
          await originalRemove(path)
        })
      } else if (failurePoint === 'rename') {
        storage.rename = jest.fn(async () => {
          throw new Error('rename failed')
        })
      } else {
        storage.writeText = jest.fn(async (path, content) => {
          if (path === 'current.json') throw new Error('marker write failed')
          await originalWriteText(path, content)
        })
      }
      await storage.mkdir('test-v1')
      await storage.writeBinary(
        'test-v1/sql-wasm.wasm',
        Uint8Array.from([4, 3, 2, 1]).buffer,
      )
      await originalWriteText(
        'current.json',
        JSON.stringify({ version: 'test-v1', readyAt: 1 }),
      )
      const manager = new AnkiSqliteRuntimeManager({ host, manifest })

      await expect(manager.ensureReady()).rejects.toThrow('failed')

      expect(storage.entries.has('current.json')).toBe(false)
      if (failurePoint === 'write-marker') {
        expect(storage.entries.has('test-v1/sql-wasm.wasm')).toBe(true)
      }
    },
  )

  it('preserves setup errors when staging cleanup also fails', async () => {
    const { manifest, storage, host } = await fixture()
    const setupError = new Error('root setup failed')
    storage.mkdir = jest.fn(async () => {
      throw setupError
    })
    storage.remove = jest.fn(async () => {
      throw new Error('cleanup failed')
    })
    const manager = new AnkiSqliteRuntimeManager({ host, manifest })

    await expect(manager.ensureReady()).rejects.toBe(setupError)
    await expect(manager.getStatus()).resolves.toMatchObject({
      kind: 'failed',
      reason: 'root setup failed; staging cleanup failed: cleanup failed',
    })
  })

  it('rejects manifest path traversal before accessing storage', async () => {
    const { manifest, host } = await fixture()

    expect(
      () =>
        new AnkiSqliteRuntimeManager({
          host,
          manifest: { ...manifest, runtimeVersion: '../escape' },
        }),
    ).toThrow('Runtime version must be a non-empty path segment')
  })
})
