import { LEARNING_MANAGED_DATA_NAMESPACE } from './paths'
import {
  HostLearningSrsStorage,
  resolveHostLearningSrsStore,
  validateProjectStatePath,
} from './srsStorage'

type HostVault = YoloModuleHostApiV1['vault']

const createRunExclusive = () => {
  let queue = Promise.resolve()
  return <T>(operation: () => T | PromiseLike<T>): Promise<T> => {
    const result = queue.then(operation)
    queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}

function createVault() {
  const files = new Map<string, string>()
  const folders = new Set<string>()
  const removeFileExact = jest.fn(async (path: string) => files.delete(path))
  const trashPath = jest.fn(async (path: string) => files.delete(path))
  const createTextIfAbsent = jest.fn(async (path: string, content: string) => {
    if (files.has(path)) return null
    files.set(path, content)
    return { path, content }
  })
  const vault = {
    ensureFolder: jest.fn(async (path: string) => {
      folders.add(path)
    }),
    exists: jest.fn(
      async (path: string) => files.has(path) || folders.has(path),
    ),
    readText: jest.fn(async (path: string) => {
      const content = files.get(path)
      if (content === undefined) throw new Error(`Missing file: ${path}`)
      return content
    }),
    createTextIfAbsent,
    writeText: jest.fn(async (path: string, content: string) => {
      files.set(path, content)
      return { path, mtime: 1 }
    }),
    removeFileExact,
    trashPath,
  } as unknown as HostVault
  return {
    files,
    folders,
    createTextIfAbsent,
    removeFileExact,
    trashPath,
    vault,
  }
}

describe('HostLearningSrsStorage', () => {
  it('keeps the shared sidecar identity and follows baseDir changes', async () => {
    const { files, folders, vault } = createVault()
    let baseDir = 'YOLO'
    const storage = new HostLearningSrsStorage(
      vault,
      () => baseDir,
      createRunExclusive(),
    )

    expect(storage.getLocationKey()).toBe('YOLO/.yolo_json_db')
    await expect(storage.write('project-a', '{"version":3}')).resolves.toBe(
      'YOLO/.yolo_json_db/learning-srs/project-a.json',
    )
    expect(folders).toContain('YOLO/.yolo_json_db')
    expect(folders).toContain('YOLO/.yolo_json_db/learning-srs')

    baseDir = 'Moved/YOLO'
    expect(storage.getLocationKey()).toBe('Moved/YOLO/.yolo_json_db')
    await storage.write('project-a', '{"version":3,"moved":true}')
    expect(
      files.get('Moved/YOLO/.yolo_json_db/learning-srs/project-a.json'),
    ).toBe('{"version":3,"moved":true}')
  })

  it('only accepts pinned paths with the exact managed identity', async () => {
    const { files, vault } = createVault()
    const storage = new HostLearningSrsStorage(
      vault,
      () => 'YOLO',
      createRunExclusive(),
    )
    const pinned = 'Old Root/.yolo_json_db/learning-srs/project-a.json'

    await storage.writeProjectStateAtPath('project-a', pinned, '{}')
    expect(files.get(pinned)).toBe('{}')
    expect(
      validateProjectStatePath(
        'project-a',
        '.smtcmp_json_db/learning-srs/project-a.json',
      ),
    ).toBe('.smtcmp_json_db/learning-srs/project-a.json')
    expect(() =>
      validateProjectStatePath(
        'project-a',
        'Other/learning-srs/project-a.json',
      ),
    ).toThrow('Invalid Learning SRS project state path')
    expect(() =>
      validateProjectStatePath(
        'project-a',
        'YOLO/.yolo_json_db/learning-srs/project-b.json',
      ),
    ).toThrow('Invalid Learning SRS project state path')
  })

  it('permanently removes canonical and pinned state without using trash', async () => {
    const { files, removeFileExact, trashPath, vault } = createVault()
    const storage = new HostLearningSrsStorage(
      vault,
      () => 'Current',
      createRunExclusive(),
    )
    const canonical = await storage.write('project-a', '{}')
    const pinned = 'Old Root/.yolo_json_db/learning-srs/project-a.json'
    await storage.writeProjectStateAtPath('project-a', pinned, '{}')

    await expect(storage.remove('project-a')).resolves.toBe(true)
    await expect(storage.remove('project-a')).resolves.toBe(false)
    await expect(
      storage.removeProjectStateAtPath('project-a', pinned),
    ).resolves.toBe(true)
    await expect(
      storage.removeProjectStateAtPath('project-a', pinned),
    ).resolves.toBe(false)

    expect(removeFileExact).toHaveBeenCalledWith(canonical)
    expect(removeFileExact).toHaveBeenCalledWith(pinned)
    expect(trashPath).not.toHaveBeenCalled()
    expect(files.size).toBe(0)
  })

  it('serializes review, pause, and direct writes through managed-data', async () => {
    const { vault } = createVault()
    const operations: string[] = []
    const queued = createRunExclusive()
    const store = resolveHostLearningSrsStore({
      vault,
      paths: {
        getSnapshot: () => ({ contentRoot: 'Root/learning' }),
        subscribe: () => () => undefined,
        runExclusive: <T>(
          namespace: string,
          operation: () => T | PromiseLike<T>,
        ) => {
          operations.push(namespace)
          return queued(operation)
        },
      },
    })
    const emptyState = {
      version: 3 as const,
      cards: {},
      suspended: [],
      pausedAt: null,
      lastStudiedAt: null,
    }

    await store.initializeProjectState('project', emptyState)
    await store.reviewCard(
      'project',
      '1234abcd',
      'good',
      new Date('2026-07-19T10:00:00.000Z'),
    )
    await store.pauseProject('project', new Date('2026-07-19T11:00:00.000Z'))
    await store.initializeProjectState('other', emptyState)

    expect(operations).toEqual([
      LEARNING_MANAGED_DATA_NAMESPACE,
      LEARNING_MANAGED_DATA_NAMESPACE,
      LEARNING_MANAGED_DATA_NAMESPACE,
      LEARNING_MANAGED_DATA_NAMESPACE,
    ])
  })

  it('resolves the canonical root after a queued relocation barrier', async () => {
    const { files, vault } = createVault()
    let baseDir = 'Old'
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const runMutation = createRunExclusive()
    const storage = new HostLearningSrsStorage(
      vault,
      () => baseDir,
      runMutation,
    )
    const relocation = runMutation(() => barrier)
    const writing = storage.write('project', '{}')

    await Promise.resolve()
    expect(files.size).toBe(0)
    baseDir = 'Moved'
    release()
    await relocation
    await expect(writing).resolves.toBe(
      'Moved/.yolo_json_db/learning-srs/project.json',
    )
    expect(files.has('Old/.yolo_json_db/learning-srs/project.json')).toBe(false)
  })

  it('releases the managed-data queue after a mutation fails', async () => {
    const { createTextIfAbsent, files, vault } = createVault()
    const failure = new Error('write failed')
    const runMutation = createRunExclusive()
    const storage = new HostLearningSrsStorage(vault, () => 'Root', runMutation)
    createTextIfAbsent.mockRejectedValueOnce(failure)

    await expect(storage.write('failed', '{}')).rejects.toBe(failure)
    await expect(storage.write('next', '{}')).resolves.toContain('next.json')
    expect(files.has('Root/.yolo_json_db/learning-srs/next.json')).toBe(true)
  })
})
