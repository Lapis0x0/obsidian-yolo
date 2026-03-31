import { App, Stat } from 'obsidian'

import {
  ensureJsonDbRootDir,
  ensureVectorDbPath,
  relocateYoloManagedData,
} from './yoloManagedData'

type Listing = {
  files: string[]
  folders: string[]
}

class MockAdapter {
  private readonly files = new Map<string, string | ArrayBuffer>()
  private readonly folders = new Set<string>()
  private failWriteBinaryPaths = new Set<string>()

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.folders.has(path)
  }

  async mkdir(path: string): Promise<void> {
    const segments = path.split('/').filter(Boolean)
    let current = ''
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment
      this.folders.add(current)
    }
  }

  async read(path: string): Promise<string> {
    const value = this.files.get(path)
    if (typeof value !== 'string') {
      throw new Error(`File is not text: ${path}`)
    }
    return value
  }

  async write(path: string, content: string): Promise<void> {
    this.files.set(path, content)
    await this.ensureParent(path)
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const value = this.files.get(path)
    if (!(value instanceof ArrayBuffer)) {
      throw new Error(`File is not binary: ${path}`)
    }
    return value
  }

  async writeBinary(path: string, content: ArrayBuffer): Promise<void> {
    if (this.failWriteBinaryPaths.has(path)) {
      throw new Error(`Mock writeBinary failure: ${path}`)
    }
    this.files.set(path, content)
    await this.ensureParent(path)
  }

  async stat(path: string): Promise<Stat | null> {
    if (this.files.has(path)) {
      const value = this.files.get(path)
      return {
        type: 'file',
        ctime: 0,
        mtime: 0,
        size:
          typeof value === 'string' ? value.length : (value?.byteLength ?? 0),
      }
    }

    if (this.folders.has(path)) {
      return {
        type: 'folder',
        ctime: 0,
        mtime: 0,
        size: 0,
      }
    }

    return null
  }

  async remove(path: string): Promise<void> {
    if (this.folders.has(path)) {
      throw new Error(`Cannot remove directory as file: ${path}`)
    }
    this.files.delete(path)
  }

  async rmdir(path: string, recursive: boolean): Promise<void> {
    if (!this.folders.has(path)) {
      throw new Error(`Directory does not exist: ${path}`)
    }

    const prefix = `${path}/`
    const hasChildren =
      Array.from(this.files.keys()).some((filePath) =>
        filePath.startsWith(prefix),
      ) ||
      Array.from(this.folders).some(
        (folderPath) => folderPath !== path && folderPath.startsWith(prefix),
      )

    if (hasChildren && !recursive) {
      throw new Error(`Directory is not empty: ${path}`)
    }

    for (const filePath of Array.from(this.files.keys())) {
      if (filePath.startsWith(prefix)) {
        this.files.delete(filePath)
      }
    }
    for (const folderPath of Array.from(this.folders)) {
      if (folderPath === path || folderPath.startsWith(prefix)) {
        this.folders.delete(folderPath)
      }
    }
  }

  async list(path: string): Promise<Listing> {
    const prefix = path ? `${path}/` : ''
    const files = Array.from(this.files.keys()).filter((filePath) => {
      if (!filePath.startsWith(prefix)) {
        return false
      }
      return !filePath.slice(prefix.length).includes('/')
    })
    const folders = Array.from(this.folders).filter((folderPath) => {
      if (!folderPath.startsWith(prefix) || folderPath === path) {
        return false
      }
      return !folderPath.slice(prefix.length).includes('/')
    })
    return { files, folders }
  }

  failWriteBinary(path: string): void {
    this.failWriteBinaryPaths.add(path)
  }

  private async ensureParent(path: string): Promise<void> {
    const slashIndex = path.lastIndexOf('/')
    if (slashIndex <= 0) {
      return
    }
    await this.mkdir(path.slice(0, slashIndex))
  }
}

const createMockApp = (adapter: MockAdapter): App =>
  ({
    vault: {
      adapter,
    },
  }) as unknown as App

describe('yoloManagedData', () => {
  test('creates YOLO base dir even before chat data exists', async () => {
    const adapter = new MockAdapter()
    const app = createMockApp(adapter)

    const rootDir = await ensureJsonDbRootDir(app, {
      yolo: { baseDir: 'Config/YOLO' },
    })

    expect(rootDir).toBe('Config/YOLO/.yolo_json_db')
    await expect(adapter.exists('Config/YOLO')).resolves.toBe(true)
  })

  test('migrates legacy chat storage into YOLO root', async () => {
    const adapter = new MockAdapter()
    const app = createMockApp(adapter)
    await adapter.mkdir('.smtcmp_json_db/chats/chat_snapshots')
    await adapter.write(
      '.smtcmp_json_db/chats/v1_123.json',
      '{"id":"123","title":"Legacy"}',
    )
    await adapter.write(
      '.smtcmp_json_db/chats/chat_snapshots/123.json',
      '{"schemaVersion":1,"entries":{}}',
    )

    const rootDir = await ensureJsonDbRootDir(app, {
      yolo: { baseDir: 'YOLO' },
    })

    expect(rootDir).toBe('YOLO/.yolo_json_db')
    await expect(
      adapter.exists('YOLO/.yolo_json_db/chats/v1_123.json'),
    ).resolves.toBe(true)
    await expect(
      adapter.exists('YOLO/.yolo_json_db/chats/chat_snapshots/123.json'),
    ).resolves.toBe(true)
    await expect(adapter.exists('.smtcmp_json_db')).resolves.toBe(false)
  })

  test('cleans up legacy chat directories after migration', async () => {
    const adapter = new MockAdapter()
    const app = createMockApp(adapter)
    await adapter.mkdir('.smtcmp_json_db/chats/chat_snapshots')
    await adapter.write(
      '.smtcmp_json_db/chats/chat_snapshots/123.json',
      '{"schemaVersion":1,"entries":{}}',
    )

    await ensureJsonDbRootDir(app, {
      yolo: { baseDir: 'YOLO' },
    })

    await expect(
      adapter.exists('.smtcmp_json_db/chats/chat_snapshots'),
    ).resolves.toBe(false)
    await expect(adapter.exists('.smtcmp_json_db/chats')).resolves.toBe(false)
    await expect(adapter.exists('.smtcmp_json_db')).resolves.toBe(false)
  })

  test('migrates legacy vector db into YOLO root', async () => {
    const adapter = new MockAdapter()
    const app = createMockApp(adapter)
    const payload = new Uint8Array([1, 2, 3]).buffer
    await adapter.writeBinary('.smtcmp_vector_db.tar.gz', payload)

    const targetPath = await ensureVectorDbPath(app, {
      yolo: { baseDir: 'Config/YOLO' },
    })

    expect(targetPath).toBe('Config/YOLO/.yolo_vector_db.tar.gz')
    await expect(
      adapter.exists('Config/YOLO/.yolo_vector_db.tar.gz'),
    ).resolves.toBe(true)
    await expect(adapter.exists('.smtcmp_vector_db.tar.gz')).resolves.toBe(
      false,
    )
  })

  test('relocates managed data when YOLO base dir changes', async () => {
    const adapter = new MockAdapter()
    const app = createMockApp(adapter)
    await adapter.mkdir('YOLO/.yolo_json_db/chats')
    await adapter.write(
      'YOLO/.yolo_json_db/chats/v1_abc.json',
      '{"id":"abc","title":"Moved"}',
    )
    await adapter.writeBinary(
      'YOLO/.yolo_vector_db.tar.gz',
      new Uint8Array([9, 9]).buffer,
    )

    const migrated = await relocateYoloManagedData({
      app,
      fromSettings: { yolo: { baseDir: 'YOLO' } },
      toSettings: { yolo: { baseDir: 'Config/YOLO' } },
    })

    expect(migrated).toBe(true)
    await expect(
      adapter.exists('Config/YOLO/.yolo_json_db/chats/v1_abc.json'),
    ).resolves.toBe(true)
    await expect(
      adapter.exists('Config/YOLO/.yolo_vector_db.tar.gz'),
    ).resolves.toBe(true)
    await expect(adapter.exists('YOLO/.yolo_json_db')).resolves.toBe(false)
    await expect(adapter.exists('YOLO/.yolo_vector_db.tar.gz')).resolves.toBe(
      false,
    )
  })

  test('merges legacy chat storage into existing target dir', async () => {
    const adapter = new MockAdapter()
    const app = createMockApp(adapter)
    await adapter.mkdir('Config/YOLO/.yolo_json_db/chats')
    await adapter.write(
      'Config/YOLO/.yolo_json_db/chats/v1_new.json',
      '{"id":"new","title":"Existing"}',
    )
    await adapter.mkdir('YOLO/.yolo_json_db/chats')
    await adapter.write(
      'YOLO/.yolo_json_db/chats/v1_old.json',
      '{"id":"old","title":"Legacy"}',
    )

    const migrated = await relocateYoloManagedData({
      app,
      fromSettings: { yolo: { baseDir: 'YOLO' } },
      toSettings: { yolo: { baseDir: 'Config/YOLO' } },
    })

    expect(migrated).toBe(true)
    await expect(
      adapter.exists('Config/YOLO/.yolo_json_db/chats/v1_new.json'),
    ).resolves.toBe(true)
    await expect(
      adapter.exists('Config/YOLO/.yolo_json_db/chats/v1_old.json'),
    ).resolves.toBe(true)
    await expect(
      adapter.exists('YOLO/.yolo_json_db/chats/v1_old.json'),
    ).resolves.toBe(false)
  })

  test('rolls back chat relocation when vector relocation fails', async () => {
    const adapter = new MockAdapter()
    const app = createMockApp(adapter)
    await adapter.mkdir('YOLO/.yolo_json_db/chats')
    await adapter.write(
      'YOLO/.yolo_json_db/chats/v1_abc.json',
      '{"id":"abc","title":"Moved"}',
    )
    await adapter.writeBinary(
      'YOLO/.yolo_vector_db.tar.gz',
      new Uint8Array([9, 9]).buffer,
    )
    adapter.failWriteBinary('Config/YOLO/.yolo_vector_db.tar.gz')

    const migrated = await relocateYoloManagedData({
      app,
      fromSettings: { yolo: { baseDir: 'YOLO' } },
      toSettings: { yolo: { baseDir: 'Config/YOLO' } },
    })

    expect(migrated).toBe(false)
    await expect(
      adapter.exists('YOLO/.yolo_json_db/chats/v1_abc.json'),
    ).resolves.toBe(true)
    await expect(
      adapter.exists('Config/YOLO/.yolo_json_db/chats/v1_abc.json'),
    ).resolves.toBe(false)
    await expect(adapter.exists('YOLO/.yolo_vector_db.tar.gz')).resolves.toBe(
      true,
    )
    await expect(
      adapter.exists('Config/YOLO/.yolo_vector_db.tar.gz'),
    ).resolves.toBe(false)
  })

  test('merges legacy managed data into existing yolo target on startup', async () => {
    const adapter = new MockAdapter()
    const app = createMockApp(adapter)
    await adapter.mkdir('YOLO/.yolo_json_db/chats')
    await adapter.write(
      'YOLO/.yolo_json_db/chats/v1_current.json',
      '{"id":"current","title":"Current"}',
    )
    await adapter.mkdir('.smtcmp_json_db/chats')
    await adapter.write(
      '.smtcmp_json_db/chats/v1_legacy.json',
      '{"id":"legacy","title":"Legacy"}',
    )
    await adapter.writeBinary(
      '.smtcmp_vector_db.tar.gz',
      new Uint8Array([1, 2, 3]).buffer,
    )

    const migrated = await relocateYoloManagedData({
      app,
      fromSettings: { yolo: { baseDir: 'YOLO' } },
      toSettings: { yolo: { baseDir: 'YOLO' } },
    })

    expect(migrated).toBe(true)
    await expect(
      adapter.exists('YOLO/.yolo_json_db/chats/v1_current.json'),
    ).resolves.toBe(true)
    await expect(
      adapter.exists('YOLO/.yolo_json_db/chats/v1_legacy.json'),
    ).resolves.toBe(true)
    await expect(adapter.exists('YOLO/.yolo_vector_db.tar.gz')).resolves.toBe(
      true,
    )
    await expect(adapter.exists('.smtcmp_json_db')).resolves.toBe(false)
    await expect(adapter.exists('.smtcmp_vector_db.tar.gz')).resolves.toBe(
      false,
    )
  })
})
