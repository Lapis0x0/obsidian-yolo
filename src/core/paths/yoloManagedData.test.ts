import { App, Stat } from 'obsidian'

import { migrateHiddenYoloBaseDir } from './yoloBaseDirMigration'
import {
  YOLO_DATA_META_KEY,
  ensureJsonDbRootDir,
  ensureLearningJsonDbRootDir,
  ensureVectorDbPath,
  extractYoloDataMeta,
  readVaultDataJson,
  relocateYoloManagedData,
  stampYoloDataMeta,
} from './yoloManagedData'
import {
  getVisibleYoloBaseDir,
  hasHiddenYoloBaseDirSegment,
  resolveExternalYoloBaseDir,
} from './yoloPaths'

type Listing = {
  files: string[]
  folders: string[]
}

const CONFIG_DIR = '.vault-config'

class MockAdapter {
  private readonly files = new Map<string, string | ArrayBuffer>()
  private readonly folders = new Set<string>()
  private failWriteBinaryPaths = new Set<string>()
  private failRemovePaths = new Set<string>()
  private failRenamePaths = new Set<string>()

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
    if (this.failRemovePaths.has(path)) {
      throw new Error(`Mock remove failure: ${path}`)
    }
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

  async rename(from: string, to: string): Promise<void> {
    if (this.failRenamePaths.has(`${from}->${to}`)) {
      throw new Error(`Mock rename failure: ${from} -> ${to}`)
    }
    if (!(await this.exists(from)))
      throw new Error(`Source does not exist: ${from}`)
    if (await this.exists(to)) throw new Error(`Target exists: ${to}`)

    const movePath = (path: string) =>
      path === from ? to : `${to}${path.slice(from.length)}`
    for (const [path, content] of Array.from(this.files)) {
      if (path === from || path.startsWith(`${from}/`)) {
        this.files.delete(path)
        this.files.set(movePath(path), content)
      }
    }
    for (const path of Array.from(this.folders)) {
      if (path === from || path.startsWith(`${from}/`)) {
        this.folders.delete(path)
        this.folders.add(movePath(path))
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

  failRemove(path: string): void {
    this.failRemovePaths.add(path)
  }

  allowRemove(path: string): void {
    this.failRemovePaths.delete(path)
  }

  failRename(from: string, to: string): void {
    this.failRenamePaths.add(`${from}->${to}`)
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
      configDir: CONFIG_DIR,
    },
  }) as unknown as App

describe('hidden YOLO base directory migration', () => {
  test('identifies hidden segments and derives their indexed target', () => {
    expect(hasHiddenYoloBaseDirSegment('.yolo')).toBe(true)
    expect(hasHiddenYoloBaseDirSegment('Config/.yolo')).toBe(true)
    expect(hasHiddenYoloBaseDirSegment('.')).toBe(true)
    expect(hasHiddenYoloBaseDirSegment('Config/YOLO')).toBe(false)
    expect(getVisibleYoloBaseDir('.yolo')).toBe('yolo')
    expect(getVisibleYoloBaseDir('Config/.yolo')).toBe('Config/yolo')
    expect(getVisibleYoloBaseDir('.Config/.yolo')).toBe('Config/yolo')
    expect(
      getVisibleYoloBaseDir(CONFIG_DIR, { reservedRoots: [CONFIG_DIR] }),
    ).toBeNull()
    expect(
      getVisibleYoloBaseDir(`${CONFIG_DIR}/plugins`, {
        reservedRoots: [CONFIG_DIR],
      }),
    ).toBeNull()
    expect(getVisibleYoloBaseDir('.git')).toBeNull()
    expect(getVisibleYoloBaseDir('.trash')).toBeNull()
    expect(getVisibleYoloBaseDir('Config/YOLO')).toBeNull()
    expect(resolveExternalYoloBaseDir('YOLO', '.yolo')).toBe('YOLO')
    expect(resolveExternalYoloBaseDir('YOLO', 'Notes/YOLO')).toBe('Notes/YOLO')
  })

  test('leaves an already indexed base directory unchanged', async () => {
    const persistTargetBaseDir = jest.fn()
    await expect(
      migrateHiddenYoloBaseDir({
        app: createMockApp(new MockAdapter()),
        settings: { yolo: { baseDir: 'Config/YOLO' } },
        persistTargetBaseDir,
      }),
    ).resolves.toEqual({ status: 'not-needed' })
    expect(persistTargetBaseDir).not.toHaveBeenCalled()
  })

  test('requires manual repair for reserved hidden vault roots', async () => {
    const adapter = new MockAdapter()
    await adapter.write(`${CONFIG_DIR}/plugins/example/main.js`, 'plugin')
    const persistTargetBaseDir = jest.fn()

    await expect(
      migrateHiddenYoloBaseDir({
        app: createMockApp(adapter),
        settings: { yolo: { baseDir: CONFIG_DIR } },
        persistTargetBaseDir,
      }),
    ).resolves.toEqual({ status: 'manual-repair', source: CONFIG_DIR })
    expect(persistTargetBaseDir).not.toHaveBeenCalled()
    await expect(
      adapter.read(`${CONFIG_DIR}/plugins/example/main.js`),
    ).resolves.toBe('plugin')
  })

  test('moves the whole hidden root before persisting the target setting', async () => {
    const adapter = new MockAdapter()
    const persisted: string[] = []
    await adapter.write('Config/.yolo/skills/example.md', 'skill')
    const result = await migrateHiddenYoloBaseDir({
      app: createMockApp(adapter),
      settings: { yolo: { baseDir: 'Config/.yolo' } },
      persistTargetBaseDir: async (baseDir) => {
        persisted.push(baseDir)
      },
    })

    expect(result).toEqual({
      status: 'migrated',
      source: 'Config/.yolo',
      target: 'Config/yolo',
    })
    expect(persisted).toEqual(['Config/yolo'])
    await expect(adapter.exists('Config/.yolo')).resolves.toBe(false)
    await expect(adapter.read('Config/yolo/skills/example.md')).resolves.toBe(
      'skill',
    )
  })

  test('keeps the source and old setting when the target already exists', async () => {
    const adapter = new MockAdapter()
    const persistTargetBaseDir = jest.fn()
    await adapter.write('.yolo/a.md', 'source')
    await adapter.write('yolo/a.md', 'target')

    await expect(
      migrateHiddenYoloBaseDir({
        app: createMockApp(adapter),
        settings: { yolo: { baseDir: '.yolo' } },
        persistTargetBaseDir,
      }),
    ).resolves.toMatchObject({ status: 'target-exists' })
    expect(persistTargetBaseDir).not.toHaveBeenCalled()
    await expect(adapter.read('.yolo/a.md')).resolves.toBe('source')
    await expect(adapter.read('yolo/a.md')).resolves.toBe('target')
  })

  test('keeps settings and source when the adapter move fails', async () => {
    const adapter = new MockAdapter()
    const persistTargetBaseDir = jest.fn()
    await adapter.write('.yolo/a.md', 'source')
    adapter.failRename('.yolo', 'yolo')

    await expect(
      migrateHiddenYoloBaseDir({
        app: createMockApp(adapter),
        settings: { yolo: { baseDir: '.yolo' } },
        persistTargetBaseDir,
      }),
    ).resolves.toMatchObject({ status: 'failed', rollbackFailed: false })
    expect(persistTargetBaseDir).not.toHaveBeenCalled()
    await expect(adapter.read('.yolo/a.md')).resolves.toBe('source')
  })

  test('cleans newly created parents when the adapter move fails', async () => {
    const adapter = new MockAdapter()
    await adapter.write('.config/.yolo/a.md', 'source')
    adapter.failRename('.config/.yolo', 'config/yolo')

    await expect(
      migrateHiddenYoloBaseDir({
        app: createMockApp(adapter),
        settings: { yolo: { baseDir: '.config/.yolo' } },
        persistTargetBaseDir: jest.fn(),
      }),
    ).resolves.toMatchObject({ status: 'failed', rollbackFailed: false })
    await expect(adapter.exists('config')).resolves.toBe(false)
  })

  test('does not move a file that occupies the configured root path', async () => {
    const adapter = new MockAdapter()
    await adapter.write('.yolo', 'not a folder')

    await expect(
      migrateHiddenYoloBaseDir({
        app: createMockApp(adapter),
        settings: { yolo: { baseDir: '.yolo' } },
        persistTargetBaseDir: jest.fn(),
      }),
    ).resolves.toMatchObject({ status: 'failed', rollbackFailed: false })
    await expect(adapter.read('.yolo')).resolves.toBe('not a folder')
    await expect(adapter.exists('yolo')).resolves.toBe(false)
  })

  test('rolls the directory back when persisting the new setting fails', async () => {
    const adapter = new MockAdapter()
    await adapter.write('.yolo/a.md', 'source')

    await expect(
      migrateHiddenYoloBaseDir({
        app: createMockApp(adapter),
        settings: { yolo: { baseDir: '.yolo' } },
        persistTargetBaseDir: async () => {
          throw new Error('save failed')
        },
      }),
    ).resolves.toMatchObject({ status: 'failed', rollbackFailed: false })
    await expect(adapter.read('.yolo/a.md')).resolves.toBe('source')
    await expect(adapter.exists('yolo')).resolves.toBe(false)
  })

  test('updates a hidden setting safely when its source no longer exists', async () => {
    const adapter = new MockAdapter()
    const persistTargetBaseDir = jest.fn().mockResolvedValue(undefined)

    await expect(
      migrateHiddenYoloBaseDir({
        app: createMockApp(adapter),
        settings: { yolo: { baseDir: '.yolo' } },
        persistTargetBaseDir,
      }),
    ).resolves.toEqual({
      status: 'source-missing',
      source: '.yolo',
      target: 'yolo',
    })
    expect(persistTargetBaseDir).toHaveBeenCalledWith('yolo')
  })

  test('does not adopt an existing target when the hidden source is missing', async () => {
    const adapter = new MockAdapter()
    await adapter.write('yolo/unrelated.md', 'keep')
    const persistTargetBaseDir = jest.fn()
    await expect(
      migrateHiddenYoloBaseDir({
        app: createMockApp(adapter),
        settings: { yolo: { baseDir: '.yolo' } },
        persistTargetBaseDir,
      }),
    ).resolves.toMatchObject({ status: 'target-exists' })
    expect(persistTargetBaseDir).not.toHaveBeenCalled()
  })

  test('creates missing visible parents for every hidden path segment', async () => {
    const adapter = new MockAdapter()
    await adapter.write('.config/.yolo/a.md', 'source')
    await expect(
      migrateHiddenYoloBaseDir({
        app: createMockApp(adapter),
        settings: { yolo: { baseDir: '.config/.yolo' } },
        persistTargetBaseDir: jest.fn().mockResolvedValue(undefined),
      }),
    ).resolves.toMatchObject({ status: 'migrated', target: 'config/yolo' })
    await expect(adapter.read('config/yolo/a.md')).resolves.toBe('source')
  })

  test('cleans migration-created empty parents after persistence rollback', async () => {
    const adapter = new MockAdapter()
    await adapter.write('.config/.yolo/a.md', 'source')
    await migrateHiddenYoloBaseDir({
      app: createMockApp(adapter),
      settings: { yolo: { baseDir: '.config/.yolo' } },
      persistTargetBaseDir: async () => {
        throw new Error('save failed')
      },
    })
    await expect(adapter.exists('config')).resolves.toBe(false)
  })

  test('reports when both persistence and directory rollback fail', async () => {
    const adapter = new MockAdapter()
    await adapter.write('.yolo/a.md', 'source')
    adapter.failRename('yolo', '.yolo')

    await expect(
      migrateHiddenYoloBaseDir({
        app: createMockApp(adapter),
        settings: { yolo: { baseDir: '.yolo' } },
        persistTargetBaseDir: async () => {
          throw new Error('save failed')
        },
      }),
    ).resolves.toMatchObject({ status: 'failed', rollbackFailed: true })
    await expect(adapter.read('yolo/a.md')).resolves.toBe('source')
    await expect(adapter.exists('.yolo')).resolves.toBe(false)
  })
})

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

  test('moves misplaced learning data to the configured root and overwrites stale targets', async () => {
    const adapter = new MockAdapter()
    const app = createMockApp(adapter)
    const sourceRoot = 'YOLO/.yolo_json_db'
    const targetRoot = 'Config/YOLO/.yolo_json_db'
    await adapter.write(
      `${sourceRoot}/learning-srs/project.json`,
      '{"state":"current"}',
    )
    await adapter.write(
      `${targetRoot}/learning-srs/project.json`,
      '{"state":"stale"}',
    )
    await adapter.write(
      `${targetRoot}/learning-srs/target-only.json`,
      '{"state":"preserved"}',
    )
    await adapter.write(
      `${sourceRoot}/anki-import-journals/run.json`,
      JSON.stringify({
        version: 1,
        srsPath: `${sourceRoot}/learning-srs/project.json`,
      }),
    )

    await expect(
      ensureLearningJsonDbRootDir(app, {
        yolo: { baseDir: 'Config/YOLO' },
      }),
    ).resolves.toBe(targetRoot)

    await expect(
      adapter.read(`${targetRoot}/learning-srs/project.json`),
    ).resolves.toBe('{"state":"current"}')
    await expect(
      adapter.read(`${targetRoot}/learning-srs/target-only.json`),
    ).resolves.toBe('{"state":"preserved"}')
    await expect(
      adapter.read(`${targetRoot}/anki-import-journals/run.json`),
    ).resolves.toContain('Config/YOLO/.yolo_json_db/learning-srs/project.json')
    await expect(adapter.exists(sourceRoot)).resolves.toBe(false)
    await expect(adapter.exists('YOLO')).resolves.toBe(false)
  })

  test('preserves a default YOLO root that contains unrelated data', async () => {
    const adapter = new MockAdapter()
    const app = createMockApp(adapter)
    await adapter.write(
      'YOLO/.yolo_json_db/learning-srs/project.json',
      '{"state":"current"}',
    )
    await adapter.write(
      'YOLO/.yolo_json_db/chats/chat.json',
      '{"title":"keep"}',
    )

    await ensureLearningJsonDbRootDir(app, {
      yolo: { baseDir: 'Config/YOLO' },
    })

    await expect(
      adapter.exists('YOLO/.yolo_json_db/learning-srs'),
    ).resolves.toBe(false)
    await expect(
      adapter.read('YOLO/.yolo_json_db/chats/chat.json'),
    ).resolves.toBe('{"title":"keep"}')
    await expect(adapter.exists('YOLO/.yolo_json_db')).resolves.toBe(true)
    await expect(adapter.exists('YOLO')).resolves.toBe(true)
  })

  test('resumes cleanup without recopying stale source data after interruption', async () => {
    const adapter = new MockAdapter()
    const app = createMockApp(adapter)
    const sourcePath = 'YOLO/.yolo_json_db/learning-srs/project.json'
    const targetPath = 'Config/YOLO/.yolo_json_db/learning-srs/project.json'
    const markerPath = 'Config/YOLO/.yolo_json_db/.learning-path-migration-v1'
    await adapter.write(sourcePath, '{"state":"source"}')
    adapter.failRemove(sourcePath)

    await expect(
      ensureLearningJsonDbRootDir(app, {
        yolo: { baseDir: 'Config/YOLO' },
      }),
    ).rejects.toThrow('Mock remove failure')
    await expect(adapter.read(targetPath)).resolves.toBe('{"state":"source"}')
    await expect(adapter.exists(markerPath)).resolves.toBe(true)

    await adapter.write(targetPath, '{"state":"newer-target"}')
    adapter.allowRemove(sourcePath)
    await ensureLearningJsonDbRootDir(app, {
      yolo: { baseDir: 'Config/YOLO' },
    })

    await expect(adapter.read(targetPath)).resolves.toBe(
      '{"state":"newer-target"}',
    )
    await expect(adapter.exists(sourcePath)).resolves.toBe(false)
    await expect(adapter.exists(markerPath)).resolves.toBe(false)
  })

  test('restores a missing migration target before deleting its source', async () => {
    const adapter = new MockAdapter()
    const app = createMockApp(adapter)
    const sourcePath = 'YOLO/.yolo_json_db/learning-srs/project.json'
    const targetPath = 'Config/YOLO/.yolo_json_db/learning-srs/project.json'
    await adapter.write(sourcePath, '{"state":"source"}')
    adapter.failRemove(sourcePath)

    await expect(
      ensureLearningJsonDbRootDir(app, {
        yolo: { baseDir: 'Config/YOLO' },
      }),
    ).rejects.toThrow('Mock remove failure')
    await adapter.remove(targetPath)
    adapter.allowRemove(sourcePath)

    await ensureLearningJsonDbRootDir(app, {
      yolo: { baseDir: 'Config/YOLO' },
    })

    await expect(adapter.read(targetPath)).resolves.toBe('{"state":"source"}')
    await expect(adapter.exists(sourcePath)).resolves.toBe(false)
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

  test('rejects a configured root nested inside the default managed-data tree', async () => {
    const adapter = new MockAdapter()
    const app = createMockApp(adapter)

    await expect(
      ensureLearningJsonDbRootDir(app, {
        yolo: { baseDir: 'YOLO/.yolo_json_db/custom' },
      }),
    ).rejects.toThrow('cannot be nested inside managed data')
    await expect(
      relocateYoloManagedData({
        app,
        fromSettings: { yolo: { baseDir: 'YOLO' } },
        toSettings: { yolo: { baseDir: 'YOLO/.yolo_json_db/custom' } },
      }),
    ).resolves.toBe(false)
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

describe('yoloManagedData meta helpers', () => {
  test('extractYoloDataMeta returns null for non-objects', () => {
    expect(extractYoloDataMeta(null)).toBeNull()
    expect(extractYoloDataMeta('string')).toBeNull()
    expect(extractYoloDataMeta([1, 2])).toBeNull()
  })

  test('extractYoloDataMeta strips meta and returns parsed shape', () => {
    const result = extractYoloDataMeta({
      foo: 1,
      [YOLO_DATA_META_KEY]: { updatedAt: 42, deviceId: 'abc' },
    })
    expect(result).not.toBeNull()
    expect(result?.meta).toEqual({ updatedAt: 42, deviceId: 'abc' })
    expect(result?.raw).toEqual({ foo: 1 })
    expect(result?.raw).not.toHaveProperty(YOLO_DATA_META_KEY)
  })

  test('extractYoloDataMeta returns null meta when shape is invalid', () => {
    const result = extractYoloDataMeta({
      foo: 1,
      [YOLO_DATA_META_KEY]: { updatedAt: 'oops', deviceId: 'abc' },
    })
    expect(result?.meta).toBeNull()
    expect(result?.raw).toEqual({ foo: 1 })
  })

  test('extractYoloDataMeta returns null meta for legacy data without meta', () => {
    const result = extractYoloDataMeta({ foo: 1 })
    expect(result?.meta).toBeNull()
    expect(result?.raw).toEqual({ foo: 1 })
  })

  test('stampYoloDataMeta attaches meta and preserves data fields', () => {
    const stamped = stampYoloDataMeta(
      { foo: 1 },
      { updatedAt: 99, deviceId: 'd1' },
    )
    expect(stamped).toEqual({
      foo: 1,
      [YOLO_DATA_META_KEY]: { updatedAt: 99, deviceId: 'd1' },
    })
  })

  test('stampYoloDataMeta tolerates non-object data by yielding meta-only payload', () => {
    const stamped = stampYoloDataMeta(null, { updatedAt: 1, deviceId: 'd1' })
    expect(stamped).toEqual({
      [YOLO_DATA_META_KEY]: { updatedAt: 1, deviceId: 'd1' },
    })
  })
})

describe('readVaultDataJson (legacy mirror reader, used only for one-time migration)', () => {
  test('roundtrips meta-stamped data when set up via the legacy on-disk layout', async () => {
    const adapter = new MockAdapter()
    const app = createMockApp(adapter)
    const meta = { updatedAt: 12345, deviceId: 'pc-1' }

    await adapter.mkdir('YOLO')
    await adapter.write(
      'YOLO/.yolo_data.json',
      JSON.stringify({ hello: 'world', [YOLO_DATA_META_KEY]: meta }),
    )
    await adapter.write(
      '.yolo_sync',
      JSON.stringify({ dataPath: 'YOLO/.yolo_data.json' }),
    )

    const result = await readVaultDataJson(app)
    expect(result).not.toBeNull()
    expect(result?.meta).toEqual(meta)
    expect(result?.raw).toEqual({ hello: 'world' })
  })

  test('returns null when pointer is missing', async () => {
    const adapter = new MockAdapter()
    const app = createMockApp(adapter)
    await expect(readVaultDataJson(app)).resolves.toBeNull()
  })

  test('returns null when pointer references a missing file', async () => {
    const adapter = new MockAdapter()
    const app = createMockApp(adapter)
    await adapter.write('.yolo_sync', JSON.stringify({ dataPath: 'gone.json' }))
    await expect(readVaultDataJson(app)).resolves.toBeNull()
  })

  test('does NOT fall back to default path when pointer exists but target is missing', async () => {
    const adapter = new MockAdapter()
    const app = createMockApp(adapter)
    // Pointer points to a custom-baseDir mirror that doesn't exist.
    await adapter.write(
      '.yolo_sync',
      JSON.stringify({ dataPath: 'CustomDir/.yolo_data.json' }),
    )
    // A stale default-path mirror is left behind from an even older
    // setup — must NOT be picked up since pointer is authoritative.
    await adapter.mkdir('YOLO')
    await adapter.write('YOLO/.yolo_data.json', JSON.stringify({ stale: true }))
    const result = await readVaultDataJson(app, { yolo: { baseDir: 'YOLO' } })
    expect(result).toBeNull()
  })

  test('does NOT fall back when pointer file exists but contents are corrupt', async () => {
    const adapter = new MockAdapter()
    const app = createMockApp(adapter)
    // Pointer file present but unparseable.
    await adapter.write('.yolo_sync', '{not valid json')
    // Stale default mirror present — must NOT be picked up since the
    // pointer file exists (even if corrupt) and is treated as
    // authoritative.
    await adapter.mkdir('YOLO')
    await adapter.write('YOLO/.yolo_data.json', JSON.stringify({ stale: true }))
    const result = await readVaultDataJson(app, { yolo: { baseDir: 'YOLO' } })
    expect(result).toBeNull()
  })

  test('does NOT fall back when pointer file exists with invalid schema', async () => {
    const adapter = new MockAdapter()
    const app = createMockApp(adapter)
    // Pointer parses as JSON but lacks `dataPath`.
    await adapter.write('.yolo_sync', JSON.stringify({ wrongField: 'X' }))
    await adapter.mkdir('YOLO')
    await adapter.write('YOLO/.yolo_data.json', JSON.stringify({ stale: true }))
    const result = await readVaultDataJson(app, { yolo: { baseDir: 'YOLO' } })
    expect(result).toBeNull()
  })

  test('falls back to settings-derived default path only when pointer is absent', async () => {
    const adapter = new MockAdapter()
    const app = createMockApp(adapter)
    await adapter.mkdir('YOLO')
    await adapter.write(
      'YOLO/.yolo_data.json',
      JSON.stringify({ recovered: true }),
    )
    const result = await readVaultDataJson(app, { yolo: { baseDir: 'YOLO' } })
    expect(result).not.toBeNull()
    expect(result?.raw).toEqual({ recovered: true })
  })

  test('legacy mirror without meta still parses with meta=null', async () => {
    const adapter = new MockAdapter()
    const app = createMockApp(adapter)
    await adapter.mkdir('YOLO')
    await adapter.write(
      'YOLO/.yolo_data.json',
      JSON.stringify({ legacy: true }),
    )
    await adapter.write(
      '.yolo_sync',
      JSON.stringify({ dataPath: 'YOLO/.yolo_data.json' }),
    )
    const result = await readVaultDataJson(app)
    expect(result).not.toBeNull()
    expect(result?.meta).toBeNull()
    expect(result?.raw).toEqual({ legacy: true })
  })
})
