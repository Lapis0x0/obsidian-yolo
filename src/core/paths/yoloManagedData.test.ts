import { App, Stat } from 'obsidian'

import { migrateHiddenYoloBaseDir } from './yoloBaseDirMigration'
import { relocateYoloBaseDir } from './yoloBaseDirRelocation'
import {
  YOLO_DATA_META_KEY,
  ensureJsonDbRootDir,
  ensureLearningJsonDbRootDir,
  ensureUserDataRootDir,
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
  private readonly mtimes = new Map<string, number>()
  private readonly mtimeSequences = new Map<string, number[]>()
  private readonly lastSequencedMtime = new Map<string, number>()
  private failWriteBinaryPaths = new Set<string>()
  private failWritePaths = new Set<string>()
  private failReadPaths = new Set<string>()
  private failMkdirPaths = new Set<string>()
  private failRemovePaths = new Set<string>()
  private failRenamePaths = new Set<string>()
  private throwAfterRenamePaths = new Set<string>()

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.folders.has(path)
  }

  async mkdir(path: string): Promise<void> {
    if (this.failMkdirPaths.has(path)) {
      throw new Error(`Mock mkdir failure: ${path}`)
    }
    const segments = path.split('/').filter(Boolean)
    let current = ''
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment
      this.folders.add(current)
    }
  }

  async read(path: string): Promise<string> {
    if (this.failReadPaths.has(path)) {
      throw new Error(`Mock read failure: ${path}`)
    }
    const value = this.files.get(path)
    if (typeof value !== 'string') {
      throw new Error(`File is not text: ${path}`)
    }
    return value
  }

  async write(path: string, content: string): Promise<void> {
    if (this.failWritePaths.has(path)) {
      throw new Error(`Mock write failure: ${path}`)
    }
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
    const mtime = this.nextMtime(path)
    if (this.files.has(path)) {
      const value = this.files.get(path)
      return {
        type: 'file',
        ctime: 0,
        mtime,
        size:
          typeof value === 'string' ? value.length : (value?.byteLength ?? 0),
      }
    }

    if (this.folders.has(path)) {
      return {
        type: 'folder',
        ctime: 0,
        mtime,
        size: 0,
      }
    }

    return null
  }

  /**
   * Returns the mtime a `stat()` call for `path` should report, consuming
   * one entry from a queued sequence (see `setMtimeSequence`) if one is
   * pending — used to simulate a file being rewritten mid-merge (TOCTOU)
   * between two `stat()` calls on the same path. Falls back to the fixed
   * value from `setMtime`, then 0.
   */
  private nextMtime(path: string): number {
    const sequence = this.mtimeSequences.get(path)
    if (sequence && sequence.length > 0) {
      const next = sequence.shift() as number
      this.lastSequencedMtime.set(path, next)
      return next
    }
    return this.lastSequencedMtime.get(path) ?? this.mtimes.get(path) ?? 0
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

    // Mirrors Obsidian 1.13+ on desktop: `rmdir(path, false)` maps to
    // `fs.rm(path, { recursive: false })`, which rejects every directory —
    // even an empty one — with ERR_FS_EISDIR (see vaultFs.ts).
    if (!recursive) {
      throw new Error(`Path is a directory: rm returned EISDIR: ${path}`)
    }

    const prefix = `${path}/`
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
    if (this.throwAfterRenamePaths.has(`${from}->${to}`)) {
      throw new Error(`Mock post-rename failure: ${from} -> ${to}`)
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

  failWrite(path: string): void {
    this.failWritePaths.add(path)
  }

  failRead(path: string): void {
    this.failReadPaths.add(path)
  }

  failMkdir(path: string): void {
    this.failMkdirPaths.add(path)
  }

  setMtime(path: string, mtime: number): void {
    this.mtimes.set(path, mtime)
  }

  /**
   * Queues the mtimes returned by successive `stat()` calls for `path` — the
   * first call consumes `mtimes[0]`, the second `mtimes[1]`, etc. Once the
   * queue is exhausted, every later call keeps returning the last consumed
   * value. Used to simulate an external rewrite landing between two `stat()`
   * calls on the same file (TOCTOU).
   */
  setMtimeSequence(path: string, mtimes: number[]): void {
    this.mtimeSequences.set(path, [...mtimes])
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

  throwAfterRename(from: string, to: string): void {
    this.throwAfterRenamePaths.add(`${from}->${to}`)
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
      createFolder: (path: string) => adapter.mkdir(path),
      getAbstractFileByPath: () => null,
    },
    fileManager: {},
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

describe('YOLO base directory relocation', () => {
  test('moves the complete workspace and then persists the new root', async () => {
    const adapter = new MockAdapter()
    await adapter.write('YOLO/skills/review/SKILL.md', 'skill')
    await adapter.write('YOLO/snippets.md', 'snippet')
    await adapter.write('YOLO/learning/project/note.md', 'learning')
    const persistTargetBaseDir = jest.fn().mockResolvedValue(undefined)

    await expect(
      relocateYoloBaseDir({
        app: createMockApp(adapter),
        source: 'YOLO',
        target: 'Config/YOLO',
        persistTargetBaseDir,
      }),
    ).resolves.toMatchObject({ status: 'migrated' })
    expect(persistTargetBaseDir).toHaveBeenCalledWith('Config/YOLO')
    await expect(
      adapter.read('Config/YOLO/skills/review/SKILL.md'),
    ).resolves.toBe('skill')
    await expect(adapter.read('Config/YOLO/snippets.md')).resolves.toBe(
      'snippet',
    )
    await expect(adapter.exists('YOLO')).resolves.toBe(false)
  })

  test('replaces an empty target folder instead of reporting a conflict', async () => {
    const adapter = new MockAdapter()
    await adapter.write('YOLO/skills/example.md', 'skill')
    await adapter.mkdir('Config/YOLO')

    await expect(
      relocateYoloBaseDir({
        app: createMockApp(adapter),
        source: 'YOLO',
        target: 'Config/YOLO',
        persistTargetBaseDir: jest.fn().mockResolvedValue(undefined),
      }),
    ).resolves.toMatchObject({ status: 'migrated' })
    await expect(adapter.read('Config/YOLO/skills/example.md')).resolves.toBe(
      'skill',
    )
  })

  test('adopts a non-empty target without moving or merging the source', async () => {
    const adapter = new MockAdapter()
    await adapter.write('YOLO/skills/source.md', 'source')
    await adapter.write('Config/YOLO/skills/target.md', 'target')
    const persistTargetBaseDir = jest.fn()

    await expect(
      relocateYoloBaseDir({
        app: createMockApp(adapter),
        source: 'YOLO',
        target: 'Config/YOLO',
        persistTargetBaseDir,
      }),
    ).resolves.toMatchObject({ status: 'adopted' })
    expect(persistTargetBaseDir).toHaveBeenCalledWith('Config/YOLO')
    await expect(adapter.read('YOLO/skills/source.md')).resolves.toBe('source')
    await expect(adapter.read('Config/YOLO/skills/target.md')).resolves.toBe(
      'target',
    )
  })

  test('adopts an existing target when source is missing', async () => {
    const adapter = new MockAdapter()
    await adapter.write('Config/YOLO/skills/existing.md', 'existing')
    const persistTargetBaseDir = jest.fn().mockResolvedValue(undefined)

    await expect(
      relocateYoloBaseDir({
        app: createMockApp(adapter),
        source: 'YOLO',
        target: 'Config/YOLO',
        persistTargetBaseDir,
      }),
    ).resolves.toMatchObject({ status: 'adopted' })
    expect(persistTargetBaseDir).toHaveBeenCalledWith('Config/YOLO')
  })

  test('adopts a non-empty target without touching a protected source', async () => {
    const adapter = new MockAdapter()
    const source = `${CONFIG_DIR}/YOLO`
    const target = 'Config/YOLO'
    await adapter.write(`${source}/source.md`, 'source')
    await adapter.write(`${target}/target.md`, 'target')
    const persistTargetBaseDir = jest.fn().mockResolvedValue(undefined)

    await expect(
      relocateYoloBaseDir({
        app: createMockApp(adapter),
        source,
        target,
        persistTargetBaseDir,
      }),
    ).resolves.toMatchObject({ status: 'adopted' })
    expect(persistTargetBaseDir).toHaveBeenCalledWith(target)
    await expect(adapter.read(`${source}/source.md`)).resolves.toBe('source')
    await expect(adapter.read(`${target}/target.md`)).resolves.toBe('target')
  })

  test('does not move a protected source into an empty or missing target', async () => {
    for (const target of ['Config/YOLO', 'Missing/YOLO']) {
      const adapter = new MockAdapter()
      const source = `${CONFIG_DIR}/YOLO`
      await adapter.write(`${source}/source.md`, 'source')
      if (target === 'Config/YOLO') await adapter.mkdir(target)
      const persistTargetBaseDir = jest.fn()

      await expect(
        relocateYoloBaseDir({
          app: createMockApp(adapter),
          source,
          target,
          persistTargetBaseDir,
        }),
      ).resolves.toMatchObject({ status: 'protected-source' })
      expect(persistTargetBaseDir).not.toHaveBeenCalled()
      await expect(adapter.read(`${source}/source.md`)).resolves.toBe('source')
      await expect(adapter.exists(target)).resolves.toBe(
        target === 'Config/YOLO',
      )
    }
  })

  test('keeps both workspaces unchanged when adopting an existing target cannot be persisted', async () => {
    const adapter = new MockAdapter()
    await adapter.write('YOLO/skills/source.md', 'source')
    await adapter.write('Config/YOLO/skills/existing.md', 'existing')
    const persistTargetBaseDir = jest.fn(async () => {
      throw new Error('save failed')
    })

    await expect(
      relocateYoloBaseDir({
        app: createMockApp(adapter),
        source: 'YOLO',
        target: 'Config/YOLO',
        persistTargetBaseDir,
      }),
    ).resolves.toMatchObject({ status: 'failed', rollbackFailed: false })
    expect(persistTargetBaseDir).toHaveBeenCalledWith('Config/YOLO')
    await expect(adapter.read('YOLO/skills/source.md')).resolves.toBe('source')
    await expect(adapter.read('Config/YOLO/skills/existing.md')).resolves.toBe(
      'existing',
    )
  })

  test('rolls the complete workspace back when settings persistence fails', async () => {
    const adapter = new MockAdapter()
    await adapter.write('YOLO/skills/example.md', 'skill')
    await adapter.mkdir('Config/YOLO')

    await expect(
      relocateYoloBaseDir({
        app: createMockApp(adapter),
        source: 'YOLO',
        target: 'Config/YOLO',
        persistTargetBaseDir: async () => {
          throw new Error('save failed')
        },
      }),
    ).resolves.toMatchObject({ status: 'failed', rollbackFailed: false })
    await expect(adapter.read('YOLO/skills/example.md')).resolves.toBe('skill')
    await expect(adapter.exists('Config/YOLO')).resolves.toBe(true)
    await expect(adapter.list('Config/YOLO')).resolves.toEqual({
      files: [],
      folders: [],
    })
  })

  test('recovers when the filesystem reports an error after moving the folder', async () => {
    const adapter = new MockAdapter()
    await adapter.write('YOLO/skills/example.md', 'skill')
    adapter.throwAfterRename('YOLO', 'Config/YOLO')

    await expect(
      relocateYoloBaseDir({
        app: createMockApp(adapter),
        source: 'YOLO',
        target: 'Config/YOLO',
        persistTargetBaseDir: jest.fn(),
      }),
    ).resolves.toMatchObject({ status: 'failed', rollbackFailed: false })
    await expect(adapter.read('YOLO/skills/example.md')).resolves.toBe('skill')
    await expect(adapter.exists('Config/YOLO')).resolves.toBe(false)
  })

  test('rejects destinations nested inside the current root', async () => {
    await expect(
      relocateYoloBaseDir({
        app: createMockApp(new MockAdapter()),
        source: 'YOLO',
        target: 'YOLO/Archive',
        persistTargetBaseDir: jest.fn(),
      }),
    ).resolves.toMatchObject({
      status: 'target-conflict',
      reason: 'nested-target',
    })
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
    const targetRoot = 'Config/YOLO/data'
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
    ).resolves.toContain('Config/YOLO/data/learning-srs/project.json')
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
    const targetPath = 'Config/YOLO/data/learning-srs/project.json'
    const markerPath = 'Config/YOLO/data/.learning-path-migration-v1'
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
    const targetPath = 'Config/YOLO/data/learning-srs/project.json'
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

  test('relocates managed data when YOLO base dir changes', async () => {
    const adapter = new MockAdapter()
    const app = createMockApp(adapter)
    await adapter.mkdir('YOLO/.yolo_json_db/chats')
    await adapter.write(
      'YOLO/.yolo_json_db/chats/v1_abc.json',
      '{"id":"abc","title":"Moved"}',
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
    await expect(adapter.exists('YOLO/.yolo_json_db')).resolves.toBe(false)
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
    await expect(adapter.exists('.smtcmp_json_db')).resolves.toBe(false)
  })
})

describe('ensureUserDataRootDir', () => {
  test('creates an empty visible data root on a fresh install', async () => {
    const adapter = new MockAdapter()
    const app = createMockApp(adapter)

    const root = await ensureUserDataRootDir(app, {
      yolo: { baseDir: 'YOLO' },
    })

    expect(root).toBe('YOLO/data')
    await expect(adapter.exists('YOLO/data')).resolves.toBe(true)
  })

  test('migrates every managed subdirectory from the hidden root to the visible root', async () => {
    const adapter = new MockAdapter()
    const app = createMockApp(adapter)
    await adapter.write('YOLO/.yolo_json_db/chats/v1_abc.json', '{"id":"abc"}')
    await adapter.write(
      'YOLO/.yolo_json_db/learning-srs/project.json',
      '{"state":"srs"}',
    )
    await adapter.write(
      'YOLO/.yolo_json_db/anki-import-journals/run.json',
      '{"version":1}',
    )
    await adapter.write(
      'YOLO/.yolo_json_db/module-settings/learning.json',
      '{"schemaVersion":1,"data":{}}',
    )
    await adapter.write(
      'YOLO/.yolo_json_db/module-intent-v1/learning.json',
      '{"schemaVersion":1,"data":{}}',
    )
    await adapter.write(
      'YOLO/.yolo_json_db/component-intent-v1/bash-engine.json',
      '{"schemaVersion":1,"data":{}}',
    )

    const root = await ensureUserDataRootDir(app, {
      yolo: { baseDir: 'YOLO' },
    })

    expect(root).toBe('YOLO/data')
    await expect(adapter.read('YOLO/data/chats/v1_abc.json')).resolves.toBe(
      '{"id":"abc"}',
    )
    await expect(
      adapter.read('YOLO/data/learning-srs/project.json'),
    ).resolves.toBe('{"state":"srs"}')
    await expect(
      adapter.read('YOLO/data/anki-import-journals/run.json'),
    ).resolves.toBe('{"version":1}')
    await expect(
      adapter.read('YOLO/data/module-settings/learning.json'),
    ).resolves.toBe('{"schemaVersion":1,"data":{}}')
    await expect(
      adapter.read('YOLO/data/module-intent-v1/learning.json'),
    ).resolves.toBe('{"schemaVersion":1,"data":{}}')
    await expect(
      adapter.read('YOLO/data/component-intent-v1/bash-engine.json'),
    ).resolves.toBe('{"schemaVersion":1,"data":{}}')
    // The hidden root's managed subdirectories are gone; device-local state
    // (not part of the migrated list) would remain untouched if present.
    await expect(adapter.exists('YOLO/.yolo_json_db/chats')).resolves.toBe(
      false,
    )
    await expect(
      adapter.exists('YOLO/.yolo_json_db/learning-srs'),
    ).resolves.toBe(false)
    await expect(
      adapter.exists('YOLO/.yolo_json_db/anki-import-journals'),
    ).resolves.toBe(false)
    await expect(
      adapter.exists('YOLO/.yolo_json_db/module-settings'),
    ).resolves.toBe(false)
    await expect(
      adapter.exists('YOLO/.yolo_json_db/module-intent-v1'),
    ).resolves.toBe(false)
    await expect(
      adapter.exists('YOLO/.yolo_json_db/component-intent-v1'),
    ).resolves.toBe(false)
  })

  test('is a cheap no-op on the second call once migration has completed', async () => {
    const adapter = new MockAdapter()
    const app = createMockApp(adapter)
    await adapter.write('YOLO/.yolo_json_db/chats/v1_abc.json', '{"id":"abc"}')

    await ensureUserDataRootDir(app, { yolo: { baseDir: 'YOLO' } })
    const root = await ensureUserDataRootDir(app, {
      yolo: { baseDir: 'YOLO' },
    })

    expect(root).toBe('YOLO/data')
    await expect(adapter.read('YOLO/data/chats/v1_abc.json')).resolves.toBe(
      '{"id":"abc"}',
    )
  })

  test('keeps the file with the newer mtime when both roots hold a same-named file', async () => {
    const adapter = new MockAdapter()
    const app = createMockApp(adapter)
    // Hidden root has the newer write (e.g. an older-version device wrote
    // here and got synced in after this device already migrated).
    await adapter.write(
      'YOLO/.yolo_json_db/chats/v1_a.json',
      '{"title":"from hidden root, newer"}',
    )
    adapter.setMtime('YOLO/.yolo_json_db/chats/v1_a.json', 200)
    await adapter.write(
      'YOLO/data/chats/v1_a.json',
      '{"title":"already migrated, stale"}',
    )
    adapter.setMtime('YOLO/data/chats/v1_a.json', 100)
    // Visible root has the newer write for a second file.
    await adapter.write(
      'YOLO/.yolo_json_db/chats/v1_b.json',
      '{"title":"from hidden root, stale"}',
    )
    adapter.setMtime('YOLO/.yolo_json_db/chats/v1_b.json', 10)
    await adapter.write(
      'YOLO/data/chats/v1_b.json',
      '{"title":"already migrated, newer"}',
    )
    adapter.setMtime('YOLO/data/chats/v1_b.json', 999)

    await ensureUserDataRootDir(app, { yolo: { baseDir: 'YOLO' } })

    await expect(adapter.read('YOLO/data/chats/v1_a.json')).resolves.toBe(
      '{"title":"from hidden root, newer"}',
    )
    await expect(adapter.read('YOLO/data/chats/v1_b.json')).resolves.toBe(
      '{"title":"already migrated, newer"}',
    )
    await expect(
      adapter.exists('YOLO/.yolo_json_db/chats/v1_a.json'),
    ).resolves.toBe(false)
    await expect(
      adapter.exists('YOLO/.yolo_json_db/chats/v1_b.json'),
    ).resolves.toBe(false)
  })

  test('falls back to the hidden root when the visible root cannot be created', async () => {
    const adapter = new MockAdapter()
    const app = createMockApp(adapter)
    await adapter.write('YOLO/.yolo_json_db/chats/v1_abc.json', '{"id":"abc"}')
    adapter.failMkdir('YOLO/data')

    const root = await ensureUserDataRootDir(app, {
      yolo: { baseDir: 'YOLO' },
    })

    expect(root).toBe('YOLO/.yolo_json_db')
    await expect(
      adapter.read('YOLO/.yolo_json_db/chats/v1_abc.json'),
    ).resolves.toBe('{"id":"abc"}')
  })

  test('leaves one failed subdirectory untouched (self-healing) while others still migrate', async () => {
    const adapter = new MockAdapter()
    const app = createMockApp(adapter)
    await adapter.write('YOLO/.yolo_json_db/chats/v1_abc.json', '{"id":"abc"}')
    await adapter.write(
      'YOLO/.yolo_json_db/learning-srs/project.json',
      '{"state":"srs"}',
    )
    // Both paths have to fail for the subdirectory to fail: the whole-tree
    // rename first, then the per-file merge it falls back to.
    adapter.failRename('YOLO/.yolo_json_db/chats', 'YOLO/data/chats')
    adapter.failRead('YOLO/.yolo_json_db/chats/v1_abc.json')

    const root = await ensureUserDataRootDir(app, {
      yolo: { baseDir: 'YOLO' },
    })

    // The whole-root return value is unaffected by a single subdir failure —
    // other subdirectories (learning-srs) must keep working.
    expect(root).toBe('YOLO/data')
    await expect(
      adapter.read('YOLO/data/learning-srs/project.json'),
    ).resolves.toBe('{"state":"srs"}')
    // The failed subdirectory's source file is left completely untouched —
    // no data lost, safe to retry on the next launch.
    await expect(
      adapter.exists('YOLO/.yolo_json_db/chats/v1_abc.json'),
    ).resolves.toBe(true)
    await expect(adapter.exists('YOLO/data/chats/v1_abc.json')).resolves.toBe(
      false,
    )
  })

  test('rewrites an Anki import journal srsPath to the new root during migration', async () => {
    const adapter = new MockAdapter()
    const app = createMockApp(adapter)
    const oldSrsPath = 'YOLO/.yolo_json_db/learning-srs/deck.json'
    await adapter.write(oldSrsPath, '{"version":3,"cards":{}}')
    await adapter.write(
      'YOLO/.yolo_json_db/anki-import-journals/run-1.json',
      JSON.stringify({
        version: 1,
        phase: 'verified',
        runId: 'run-1',
        projectSlug: 'deck',
        projectPath: 'Learning/deck',
        indexPath: 'Learning/deck/index.md',
        srsPath: oldSrsPath,
        createdFiles: ['Learning/deck/index.md'],
        createdFolders: ['Learning/deck'],
      }),
    )

    await ensureUserDataRootDir(app, { yolo: { baseDir: 'YOLO' } })

    const migratedJournal = JSON.parse(
      await adapter.read('YOLO/data/anki-import-journals/run-1.json'),
    ) as { srsPath: string }
    // The journal's pinned srsPath must follow the SRS file to its new
    // location — otherwise `recoverAnkiImports` (Learning module) would look
    // for it at the now-vacated hidden path, find nothing, and treat this
    // already-verified import as failed, deleting everything it created.
    expect(migratedJournal.srsPath).toBe('YOLO/data/learning-srs/deck.json')
    await expect(adapter.exists(migratedJournal.srsPath)).resolves.toBe(true)
    await expect(adapter.exists(oldSrsPath)).resolves.toBe(false)
  })

  test('does not delete a source file whose mtime changed during the merge window (TOCTOU guard)', async () => {
    const adapter = new MockAdapter()
    const app = createMockApp(adapter)
    const sourcePath = 'YOLO/.yolo_json_db/chats/v1_abc.json'
    await adapter.write(sourcePath, '{"id":"abc","title":"original"}')
    // An already-populated target forces the per-file merge — the guard being
    // tested only exists there, since the whole-tree rename has no
    // copy-then-delete window to protect.
    await adapter.write('YOLO/data/chats/v1_other.json', '{"id":"other"}')
    // First stat() (captured as the pre-copy baseline) sees mtime 100; the
    // second stat() (taken immediately before deleting the source) sees 250
    // — as if a sync tool rewrote the file in between.
    adapter.setMtimeSequence(sourcePath, [100, 250])

    await ensureUserDataRootDir(app, { yolo: { baseDir: 'YOLO' } })

    await expect(adapter.exists(sourcePath)).resolves.toBe(true)
    await expect(adapter.read(sourcePath)).resolves.toBe(
      '{"id":"abc","title":"original"}',
    )
    await expect(adapter.exists('YOLO/data/chats/v1_abc.json')).resolves.toBe(
      true,
    )
  })

  test('deduplicates concurrent calls for the same root instead of migrating twice', async () => {
    const adapter = new MockAdapter()
    const app = createMockApp(adapter)
    await adapter.write('YOLO/.yolo_json_db/chats/v1_abc.json', '{"id":"abc"}')
    const renameSpy = jest.spyOn(adapter, 'rename')

    // Simulates the host startup call and a store's lazy first-touch
    // `prepareDataDir` racing each other at launch.
    const [first, second] = await Promise.all([
      ensureUserDataRootDir(app, { yolo: { baseDir: 'YOLO' } }),
      ensureUserDataRootDir(app, { yolo: { baseDir: 'YOLO' } }),
    ])

    expect(first).toBe('YOLO/data')
    expect(second).toBe('YOLO/data')
    // Both callers shared one in-flight migration: the chats subdirectory is
    // moved exactly once, not once per caller. A second rename would also
    // have thrown (its source is gone), so the count is the contract.
    const chatsRenameCalls = renameSpy.mock.calls.filter(
      ([from]) => from === 'YOLO/.yolo_json_db/chats',
    )
    expect(chatsRenameCalls).toHaveLength(1)

    // A later, non-overlapping call still works (single-flight entries are
    // cleared once settled, not cached forever).
    const third = await ensureUserDataRootDir(app, {
      yolo: { baseDir: 'YOLO' },
    })
    expect(third).toBe('YOLO/data')
  })

  test('moves an absent-target subdirectory with one rename instead of walking its files', async () => {
    const adapter = new MockAdapter()
    const app = createMockApp(adapter)
    await adapter.write('YOLO/.yolo_json_db/chats/v1_a.json', '{"id":"a"}')
    await adapter.write(
      'YOLO/.yolo_json_db/chats/nested/v1_b.json',
      '{"id":"b"}',
    )
    const readSpy = jest.spyOn(adapter, 'read')
    const renameSpy = jest.spyOn(adapter, 'rename')

    await ensureUserDataRootDir(app, { yolo: { baseDir: 'YOLO' } })

    expect(renameSpy).toHaveBeenCalledWith(
      'YOLO/.yolo_json_db/chats',
      'YOLO/data/chats',
    )
    // The whole point of the fast path: cost is independent of file count.
    // Reading even one migrated file means the per-file walk ran.
    const chatReads = readSpy.mock.calls.filter(([path]) =>
      path.startsWith('YOLO/.yolo_json_db/chats/'),
    )
    expect(chatReads).toHaveLength(0)
    await expect(adapter.read('YOLO/data/chats/v1_a.json')).resolves.toBe(
      '{"id":"a"}',
    )
    await expect(
      adapter.read('YOLO/data/chats/nested/v1_b.json'),
    ).resolves.toBe('{"id":"b"}')
    await expect(adapter.exists('YOLO/.yolo_json_db/chats')).resolves.toBe(
      false,
    )
  })

  test('merges per-file when the target subdirectory already exists', async () => {
    const adapter = new MockAdapter()
    const app = createMockApp(adapter)
    await adapter.write('YOLO/.yolo_json_db/chats/v1_a.json', '{"id":"a"}')
    await adapter.write('YOLO/data/chats/v1_b.json', '{"id":"b"}')
    const renameSpy = jest.spyOn(adapter, 'rename')

    await ensureUserDataRootDir(app, { yolo: { baseDir: 'YOLO' } })

    // Renaming onto an existing directory is rejected by the real adapters,
    // so the fast path must not even be attempted here.
    expect(
      renameSpy.mock.calls.filter(
        ([from]) => from === 'YOLO/.yolo_json_db/chats',
      ),
    ).toHaveLength(0)
    await expect(adapter.read('YOLO/data/chats/v1_a.json')).resolves.toBe(
      '{"id":"a"}',
    )
    await expect(adapter.read('YOLO/data/chats/v1_b.json')).resolves.toBe(
      '{"id":"b"}',
    )
  })

  test('falls back to the per-file merge when the rename fails outright', async () => {
    const adapter = new MockAdapter()
    const app = createMockApp(adapter)
    await adapter.write('YOLO/.yolo_json_db/chats/v1_a.json', '{"id":"a"}')
    // Stands in for an adapter that cannot rename a folder at all (a platform
    // we cannot verify, e.g. iOS) — migration must still complete.
    adapter.failRename('YOLO/.yolo_json_db/chats', 'YOLO/data/chats')

    await ensureUserDataRootDir(app, { yolo: { baseDir: 'YOLO' } })

    await expect(adapter.read('YOLO/data/chats/v1_a.json')).resolves.toBe(
      '{"id":"a"}',
    )
    await expect(
      adapter.exists('YOLO/.yolo_json_db/chats/v1_a.json'),
    ).resolves.toBe(false)
  })

  test('treats a rename that threw after moving the tree as done, not as a failure to redo', async () => {
    const adapter = new MockAdapter()
    const app = createMockApp(adapter)
    await adapter.write('YOLO/.yolo_json_db/chats/v1_a.json', '{"id":"a"}')
    // `DataAdapter.rename` guarantees no defined post-failure state, so a
    // throw after the move must be resolved by re-reading the disk: the
    // source is gone, so the move did happen and re-running the merge would
    // be wrong.
    adapter.throwAfterRename('YOLO/.yolo_json_db/chats', 'YOLO/data/chats')

    await ensureUserDataRootDir(app, { yolo: { baseDir: 'YOLO' } })

    await expect(adapter.read('YOLO/data/chats/v1_a.json')).resolves.toBe(
      '{"id":"a"}',
    )
  })

  test('never fast-paths a subdirectory that needs its contents rewritten', async () => {
    const adapter = new MockAdapter()
    const app = createMockApp(adapter)
    const oldSrsPath = 'YOLO/.yolo_json_db/learning-srs/deck.json'
    await adapter.write(oldSrsPath, '{"version":3,"cards":{}}')
    await adapter.write(
      'YOLO/.yolo_json_db/anki-import-journals/run-1.json',
      JSON.stringify({ version: 1, phase: 'verified', srsPath: oldSrsPath }),
    )
    const renameSpy = jest.spyOn(adapter, 'rename')

    await ensureUserDataRootDir(app, { yolo: { baseDir: 'YOLO' } })

    // A rename moves bytes untouched, which would silently skip the srsPath
    // rewrite and leave journals pointing at the vacated hidden root.
    expect(
      renameSpy.mock.calls.filter(
        ([from]) => from === 'YOLO/.yolo_json_db/anki-import-journals',
      ),
    ).toHaveLength(0)
    const migrated = JSON.parse(
      await adapter.read('YOLO/data/anki-import-journals/run-1.json'),
    ) as { srsPath: string }
    expect(migrated.srsPath).toBe('YOLO/data/learning-srs/deck.json')
  })

  test('deletes dead legacy chat caches instead of migrating them into the visible root', async () => {
    const adapter = new MockAdapter()
    const app = createMockApp(adapter)
    await adapter.write('YOLO/.yolo_json_db/chats/v1_a.json', '{"id":"a"}')
    await adapter.write(
      'YOLO/.yolo_json_db/chats/timeline_height_cache/c1.json',
      '{"scopes":{}}',
    )
    await adapter.write(
      'YOLO/.yolo_json_db/chats/external_agent_progress/p1.json',
      '{}',
    )
    // A device that already migrated carries its copies under the visible
    // root instead — both sides have to be swept.
    await adapter.write(
      'YOLO/data/chats/timeline_height_cache/c2.json',
      '{"scopes":{}}',
    )

    await ensureUserDataRootDir(app, { yolo: { baseDir: 'YOLO' } })

    await expect(
      adapter.exists('YOLO/data/chats/timeline_height_cache'),
    ).resolves.toBe(false)
    await expect(
      adapter.exists('YOLO/data/chats/external_agent_progress'),
    ).resolves.toBe(false)
    await expect(
      adapter.exists('YOLO/.yolo_json_db/chats/timeline_height_cache'),
    ).resolves.toBe(false)
    // Real chat data is untouched by the sweep.
    await expect(adapter.read('YOLO/data/chats/v1_a.json')).resolves.toBe(
      '{"id":"a"}',
    )
  })
})

describe('relocateYoloManagedData (visible user data root)', () => {
  test('prefers the source file when it is newer than an existing same-named target file', async () => {
    const adapter = new MockAdapter()
    const app = createMockApp(adapter)
    await adapter.write(
      'YOLO/data/chats/v1_a.json',
      '{"title":"from source, newer"}',
    )
    adapter.setMtime('YOLO/data/chats/v1_a.json', 200)
    await adapter.write(
      'Config/YOLO/data/chats/v1_a.json',
      '{"title":"already at target, stale"}',
    )
    adapter.setMtime('Config/YOLO/data/chats/v1_a.json', 50)

    const migrated = await relocateYoloManagedData({
      app,
      fromSettings: { yolo: { baseDir: 'YOLO' } },
      toSettings: { yolo: { baseDir: 'Config/YOLO' } },
    })

    expect(migrated).toBe(true)
    await expect(
      adapter.read('Config/YOLO/data/chats/v1_a.json'),
    ).resolves.toBe('{"title":"from source, newer"}')
    await expect(adapter.exists('YOLO/data/chats/v1_a.json')).resolves.toBe(
      false,
    )
  })

  test('relocates both the hidden root and the visible data root when baseDir changes', async () => {
    const adapter = new MockAdapter()
    const app = createMockApp(adapter)
    await adapter.write(
      'YOLO/.yolo_json_db/chats/v1_hidden.json',
      '{"id":"hidden"}',
    )
    await adapter.write('YOLO/data/chats/v1_visible.json', '{"id":"visible"}')

    const migrated = await relocateYoloManagedData({
      app,
      fromSettings: { yolo: { baseDir: 'YOLO' } },
      toSettings: { yolo: { baseDir: 'Config/YOLO' } },
    })

    expect(migrated).toBe(true)
    await expect(
      adapter.exists('Config/YOLO/.yolo_json_db/chats/v1_hidden.json'),
    ).resolves.toBe(true)
    await expect(
      adapter.exists('Config/YOLO/data/chats/v1_visible.json'),
    ).resolves.toBe(true)
    await expect(adapter.exists('YOLO/.yolo_json_db')).resolves.toBe(false)
    await expect(adapter.exists('YOLO/data')).resolves.toBe(false)
  })

  test('rejects a visible data root nested inside its own source tree', async () => {
    await expect(
      relocateYoloManagedData({
        app: createMockApp(new MockAdapter()),
        fromSettings: { yolo: { baseDir: 'YOLO' } },
        toSettings: { yolo: { baseDir: 'YOLO/data/custom' } },
      }),
    ).resolves.toBe(false)
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
