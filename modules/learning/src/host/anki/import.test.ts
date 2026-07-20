import type { AnkiImportPlan } from '../../anki/import'
import { FileAnkiImportJournalStorage } from '../../anki/import/journalStorage'
import { LearningSrsStore } from '../../domain/srs/srsStore'
import { LEARNING_MANAGED_DATA_NAMESPACE } from '../paths'
import { createHostLearningRuntimeAdapter } from '../runtime'
import { createHostLearningSrsStorage } from '../srsStorage'

import { createHostAnkiImportService } from './import'
import { getHostLearningDataRoot } from './paths'
import { createHostAnkiJournalFilePort } from './sharedData'

type VaultEntry = ReturnType<YoloModuleHostApiV1['vault']['getEntry']>

class MemoryVault {
  readonly folders = new Set<string>()
  readonly files = new Map<string, string | ArrayBuffer>()
  readonly exactFileRemovals: string[] = []
  readonly emptyFolderRemovals: string[] = []
  readonly trashPath = jest.fn(async () => true)

  getEntry(path: string): VaultEntry {
    if (this.folders.has(path)) {
      return { kind: 'folder', path, name: path.split('/').at(-1)! }
    }
    if (this.files.has(path)) {
      return {
        kind: 'file',
        path,
        name: path.split('/').at(-1)!,
        ctime: 0,
        mtime: 0,
      }
    }
    return null
  }

  listChildren(folderPath: string) {
    const prefix = `${folderPath}/`
    const direct = (path: string) =>
      path.startsWith(prefix) && !path.slice(prefix.length).includes('/')
    return [
      ...[...this.folders].filter(direct).map((path) => this.getEntry(path)!),
      ...[...this.files.keys()]
        .filter(direct)
        .map((path) => this.getEntry(path)!),
    ]
  }

  async stat(path: string): Promise<VaultEntry> {
    return this.getEntry(path)
  }

  async list(folderPath: string): Promise<readonly NonNullable<VaultEntry>[]> {
    return this.listChildren(folderPath)
  }

  async exists(path: string) {
    return this.getEntry(path) !== null
  }

  async readText(path: string) {
    const value = this.files.get(path)
    if (typeof value !== 'string') throw new Error(`Text file missing: ${path}`)
    return value
  }

  async readBinary(path: string) {
    const value = this.files.get(path)
    if (!(value instanceof ArrayBuffer)) {
      throw new Error(`Binary file missing: ${path}`)
    }
    return value.slice(0)
  }

  async ensureFolder(path: string) {
    this.folders.add(path)
  }

  async createFolder(path: string) {
    if (this.getEntry(path)) throw new Error(`Path exists: ${path}`)
    this.folders.add(path)
  }

  async createText(path: string, content: string) {
    if (this.getEntry(path)) throw new Error(`Path exists: ${path}`)
    this.files.set(path, content)
    return { path, mtime: 0 }
  }

  async createTextIfAbsent(path: string, content: string) {
    if (this.getEntry(path)) return null
    this.files.set(path, content)
    return { path, content }
  }

  async writeText(path: string, content: string) {
    const entry = this.getEntry(path)
    if (entry?.kind === 'folder') throw new Error(`Path is a folder: ${path}`)
    this.files.set(path, content)
    return { path, mtime: 0 }
  }

  async createBinary(path: string, content: ArrayBuffer) {
    if (this.getEntry(path)) throw new Error(`Path exists: ${path}`)
    this.files.set(path, content.slice(0))
  }

  async removeFileExact(path: string) {
    const entry = this.getEntry(path)
    if (entry?.kind !== 'file') return false
    this.exactFileRemovals.push(path)
    return this.files.delete(path)
  }

  async removeEmptyFolderExact(path: string) {
    const entry = this.getEntry(path)
    if (entry?.kind !== 'folder' || this.listChildren(path).length !== 0) {
      return false
    }
    this.emptyFolderRemovals.push(path)
    return this.folders.delete(path)
  }
}

class MemoryPrivateScope {
  readonly files = new Map<string, string | ArrayBuffer>()
  readonly folders = new Set<string>()

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
      const start = prefix ? `${prefix}/` : ''
      return key.startsWith(start) && !key.slice(start.length).includes('/')
    }
    return {
      files: [...this.files.keys()].filter(direct),
      folders: [...this.folders].filter(direct),
    }
  }

  async readText(key: string) {
    const value = this.files.get(key)
    return typeof value === 'string' ? value : null
  }

  async writeText(key: string, value: string) {
    this.files.set(key, value)
  }

  async mkdir(key: string) {
    this.folders.add(key)
  }

  async removeFile(key: string) {
    return this.files.delete(key)
  }
}

const importPlan = (): AnkiImportPlan => ({
  version: 1,
  projectName: 'Deck',
  projectSlug: 'deck',
  baseDir: 'Root/learning',
  projectPath: 'Root/learning/deck',
  chapters: [
    {
      title: 'Deck',
      slug: 'deck',
      cards: [
        {
          ankiCardId: 1,
          uuid: '1234abcd',
          title: 'Question',
          front: 'Question',
          back: 'Answer {{anki-media:image:a.png}}',
        },
      ],
    },
  ],
  assets: [
    {
      sourceName: 'a.png',
      fileName: `${'a'.repeat(64)}.png`,
      bytes: Uint8Array.from([1, 2, 3]),
    },
  ],
  srsState: {
    version: 3,
    cards: {},
    suspended: [],
    pausedAt: null,
    lastStudiedAt: '2024-01-02T03:04:05.000Z',
  },
  cardCount: 1,
  warnings: [],
})

const harness = () => {
  const vault = new MemoryVault()
  vault.folders.add('Root/learning')
  const synchronized = new MemoryPrivateScope()
  const deviceLocal = new MemoryPrivateScope()
  let contentRoot = 'Root/learning'
  let lockQueue = Promise.resolve()
  const runExclusive = jest.fn(
    <T>(
      _namespace: string,
      operation: () => T | PromiseLike<T>,
    ): Promise<T> => {
      const result = lockQueue.then(operation)
      lockQueue = result.then(
        () => undefined,
        () => undefined,
      )
      return result
    },
  )
  const host = {
    paths: {
      getSnapshot: () => ({ contentRoot }),
      subscribe: () => () => undefined,
      runExclusive,
    },
    settings: {
      getModelSnapshot: () => ({ defaultModelId: null, models: [] }),
      subscribeModels: () => () => undefined,
    },
    config: {
      getSnapshot: () => ({ schemaVersion: 1, data: {} }),
      subscribe: () => () => undefined,
    },
    background: { upsert: jest.fn(), remove: jest.fn() },
    vault,
    privateStorage: { synchronized, deviceLocal },
    workers: { create: jest.fn() },
  } as unknown as Pick<
    YoloModuleHostApiV1,
    'paths' | 'privateStorage' | 'vault' | 'workers'
  >
  return {
    host,
    vault,
    synchronized,
    runExclusive,
    setContentRoot: (next: string) => {
      contentRoot = next
    },
  }
}

describe('Host Anki import service', () => {
  it('commits and verifies an import without invoking rollback deletion', async () => {
    const h = harness()
    const service = createHostAnkiImportService(h.host)

    await expect(
      service.commit({
        plan: importPlan(),
        signal: new AbortController().signal,
      }),
    ).resolves.toBe('Root/learning/deck')

    expect(h.vault.files.has('Root/learning/deck/index.md')).toBe(true)
    expect(
      h.vault.files.has(`Root/learning/deck/assets/${'a'.repeat(64)}.png`),
    ).toBe(true)
    expect(h.vault.exactFileRemovals).toHaveLength(1)
    expect(h.vault.exactFileRemovals[0]).toMatch(
      /^Root\/.yolo_json_db\/anki-import-journals\/.+\.json$/,
    )
    expect(h.vault.emptyFolderRemovals).toEqual([])
    expect(h.vault.trashPath).not.toHaveBeenCalled()
    expect(h.vault.files.has('Root/.yolo_json_db/learning-srs/deck.json')).toBe(
      true,
    )
    expect(h.synchronized.files.size).toBe(0)
    expect(h.runExclusive).toHaveBeenCalledTimes(1)
    expect(h.runExclusive).toHaveBeenCalledWith(
      LEARNING_MANAGED_DATA_NAMESPACE,
      expect.any(Function),
    )
  })

  it('makes imported state visible through the runtime shared store', async () => {
    const h = harness()
    const srsStore = new LearningSrsStore(createHostLearningSrsStorage(h.host))
    const runtime = createHostLearningRuntimeAdapter({
      host: h.host as YoloModuleHostApiV1,
      owner: { defaultView: {}, nodeType: 9 } as unknown as Document,
      srsStore,
    })
    const runtimeStore = runtime.runtime.getSrsStore()
    await runtimeStore.getProjectState('deck')
    const service = createHostAnkiImportService(h.host, { srsStore })

    await service.commit({
      plan: importPlan(),
      signal: new AbortController().signal,
    })

    await expect(runtimeStore.getProjectState('deck')).resolves.toMatchObject({
      lastStudiedAt: '2024-01-02T03:04:05.000Z',
    })
    expect(runtimeStore).toBe(srsStore)
    runtime.dispose()
  })

  it('recovers a writing journal and preserves a foreign non-empty child', async () => {
    const h = harness()
    const projectPath = 'Root/learning/crashed'
    const ownedFile = `${projectPath}/owned.md`
    h.vault.folders.add(projectPath)
    h.vault.files.set(ownedFile, 'owned')
    h.vault.files.set(`${projectPath}/foreign.md`, 'keep')
    const journals = new FileAnkiImportJournalStorage(
      createHostAnkiJournalFilePort(h.host.vault, async () =>
        getHostLearningDataRoot(h.host.paths),
      ),
      async () => getHostLearningDataRoot(h.host.paths),
    )
    await journals.create(
      JSON.stringify({
        version: 1,
        phase: 'writing',
        runId: 'crashed',
        projectSlug: 'crashed',
        projectPath,
        indexPath: `${projectPath}/index.md`,
        srsPath: 'Root/.yolo_json_db/learning-srs/crashed.json',
        createdFiles: [ownedFile],
        createdFolders: [projectPath],
      }),
    )

    await expect(createHostAnkiImportService(h.host).recover()).rejects.toThrow(
      'non-empty',
    )
    expect(h.vault.files.has(ownedFile)).toBe(false)
    expect(h.vault.files.get(`${projectPath}/foreign.md`)).toBe('keep')
    expect(h.vault.folders.has(projectPath)).toBe(true)
    expect(h.vault.trashPath).not.toHaveBeenCalled()
    await expect(journals.list()).resolves.toHaveLength(1)
  })

  it('rolls back a crashed import and removes its journal', async () => {
    const h = harness()
    const projectPath = 'Root/learning/crashed'
    const ownedFile = `${projectPath}/owned.md`
    h.vault.folders.add(projectPath)
    h.vault.files.set(ownedFile, 'owned')
    const journals = new FileAnkiImportJournalStorage(
      createHostAnkiJournalFilePort(h.host.vault, async () =>
        getHostLearningDataRoot(h.host.paths),
      ),
      async () => getHostLearningDataRoot(h.host.paths),
    )
    await journals.create(
      JSON.stringify({
        version: 1,
        phase: 'writing',
        runId: 'crashed',
        projectSlug: 'crashed',
        projectPath,
        indexPath: `${projectPath}/index.md`,
        srsPath: 'Root/.yolo_json_db/learning-srs/crashed.json',
        createdFiles: [ownedFile],
        createdFolders: [projectPath],
      }),
    )

    await expect(
      createHostAnkiImportService(h.host).recover(),
    ).resolves.toEqual({ confirmed: [], rolledBack: [projectPath] })
    expect(h.vault.exactFileRemovals[0]).toBe(ownedFile)
    expect(h.vault.exactFileRemovals[1]).toMatch(
      /^Root\/.yolo_json_db\/anki-import-journals\/.+\.json$/,
    )
    expect(h.vault.emptyFolderRemovals).toEqual([projectPath])
    await expect(journals.list()).resolves.toEqual([])
  })

  it.each([
    ['legacy', 'current', undefined, false],
    ['writing', 'current', 'writing', false],
    ['verified', 'current', 'verified', true],
    ['legacy', 'old', undefined, false],
    ['writing', 'old', 'writing', false],
    ['verified', 'old', 'verified', true],
  ] as const)(
    'discovers a Core %s journal in the %s root and recovers it',
    async (_label, location, phase, confirmed) => {
      const h = harness()
      const projectSlug = `${location}-${phase ?? 'legacy'}`
      const projectPath = `Root/learning/${projectSlug}`
      const indexPath = `${projectPath}/index.md`
      const ownedPath = `${projectPath}/owned.md`
      const pinnedSrsPath = `Pinned/.yolo_json_db/learning-srs/${projectSlug}.json`
      const currentSrsPath = `Root/.yolo_json_db/learning-srs/${projectSlug}.json`
      const journalRoot =
        location === 'current' ? 'Root/.yolo_json_db' : 'Old/.yolo_json_db'
      const journalDirectory = `${journalRoot}/anki-import-journals`
      const journalPath = `${journalDirectory}/${projectSlug}.json`
      const createdFiles = confirmed ? [indexPath] : [ownedPath]
      const journal = {
        version: 1,
        ...(phase === undefined ? {} : { phase }),
        runId: projectSlug,
        projectSlug,
        projectPath,
        indexPath,
        srsPath: pinnedSrsPath,
        createdFiles,
        createdFolders: [projectPath],
      }
      h.vault.folders.add(projectPath)
      h.vault.folders.add(journalDirectory)
      h.vault.files.set(createdFiles[0], 'owned')
      h.vault.files.set(pinnedSrsPath, '{}')
      h.vault.files.set(currentSrsPath, '{}')
      h.vault.files.set(journalPath, JSON.stringify(journal))
      h.vault.files.set(`${journalDirectory}/README.md`, 'keep')

      const service = createHostAnkiImportService(h.host, {
        legacyJournalDataRoots: location === 'old' ? ['Old/.yolo_json_db'] : [],
      })
      await expect(service.recover()).resolves.toEqual(
        confirmed
          ? { confirmed: [projectPath], rolledBack: [] }
          : { confirmed: [], rolledBack: [projectPath] },
      )

      expect(h.vault.files.has(journalPath)).toBe(false)
      expect(h.vault.files.get(`${journalDirectory}/README.md`)).toBe('keep')
      expect(h.vault.files.has(currentSrsPath)).toBe(true)
      expect(h.vault.files.has(pinnedSrsPath)).toBe(confirmed)
      expect(h.vault.files.has(createdFiles[0])).toBe(confirmed)
      expect(h.vault.exactFileRemovals).toContain(journalPath)
      expect(h.vault.trashPath).not.toHaveBeenCalled()
      expect(h.runExclusive).toHaveBeenCalledTimes(1)
    },
  )

  it('reads project slugs from the requested base after a baseDir change', () => {
    const h = harness()
    h.vault.folders.add('Root/learning/old')
    h.vault.folders.add('Next/learning')
    h.vault.folders.add('Next/learning/new')
    const service = createHostAnkiImportService(h.host)

    expect(service.listExistingProjectSlugs('Root/learning')).toEqual(['old'])
    h.setContentRoot('Next/learning')
    expect(service.listExistingProjectSlugs('Next/learning')).toEqual(['new'])
  })

  it('aborts before creating a journal or vault entry', async () => {
    const h = harness()
    const controller = new AbortController()
    controller.abort()

    await expect(
      createHostAnkiImportService(h.host).commit({
        plan: importPlan(),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(h.vault.getEntry('Root/learning/deck')).toBeNull()
    expect(h.synchronized.files.size).toBe(0)
  })

  it('re-reads the managed root after a queued relocation barrier', async () => {
    const h = harness()
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const relocation = h.host.paths.runExclusive(
      LEARNING_MANAGED_DATA_NAMESPACE,
      () => barrier,
    )
    const committing = createHostAnkiImportService(h.host).commit({
      plan: importPlan(),
      signal: new AbortController().signal,
    })

    await Promise.resolve()
    h.setContentRoot('Moved/learning')
    release()
    await relocation
    await expect(committing).resolves.toBe('Root/learning/deck')
    expect(
      h.vault.files.has('Moved/.yolo_json_db/learning-srs/deck.json'),
    ).toBe(true)
    expect(h.vault.files.has('Root/.yolo_json_db/learning-srs/deck.json')).toBe(
      false,
    )
    expect(h.vault.exactFileRemovals[0]).toMatch(
      /^Moved\/.yolo_json_db\/anki-import-journals\/.+\.json$/,
    )
  })

  it('releases managed-data after a failed transaction', async () => {
    const h = harness()
    h.vault.folders.add('Root/learning/deck')
    const service = createHostAnkiImportService(h.host)

    await expect(
      service.commit({
        plan: importPlan(),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('already exists')
    await expect(
      h.host.paths.runExclusive(LEARNING_MANAGED_DATA_NAMESPACE, () => 'next'),
    ).resolves.toBe('next')
  })
})
