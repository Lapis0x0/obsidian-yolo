import type {
  LearningVaultEntryListener,
  LearningVaultReadApi,
  LearningVaultRenameListener,
} from './learningVaultReadApi'
import { ProjectEventBus, diffProjects } from './projectEventBus'
import { scanProject } from './projectScanner'
import type { LearningEvent, OutlineProject } from './types'

jest.mock('./projectScanner', () => {
  const actual =
    jest.requireActual<typeof import('./projectScanner')>('./projectScanner')
  return { ...actual, scanProject: jest.fn() }
})

const mockedScanProject = jest.mocked(scanProject)

function project({
  projectPath = 'Learning/project',
  chapterTitle = 'Chapter',
  knowledgeTitle = 'Point',
  relationTarget,
}: {
  projectPath?: string
  chapterTitle?: string
  knowledgeTitle?: string
  relationTarget?: string
} = {}): OutlineProject {
  const chapterPath = `${projectPath}/chapter`
  return {
    kind: 'outline',
    id: projectPath,
    slug: projectPath.split('/').pop() ?? projectPath,
    topic: 'Project',
    goal: 'Learn',
    status: 'studying',
    folderPath: projectPath,
    indexFilePath: `${projectPath}/index.md`,
    chapters: [
      {
        id: chapterPath,
        projectId: projectPath,
        slug: 'chapter',
        title: chapterTitle,
        folderPath: chapterPath,
        knowledgePointIds: [`${chapterPath}/kp`],
      },
    ],
    knowledgePoints: [
      {
        id: `${chapterPath}/kp`,
        projectId: projectPath,
        chapterId: chapterPath,
        uuid: 'kp',
        title: knowledgeTitle,
        knowledgeFilePath: `${chapterPath}/knowledge.md`,
        relations: relationTarget
          ? [{ targetId: relationTarget, type: 'related' }]
          : [],
        hasCards: false,
        hasExercises: false,
        mtime: 1,
      },
    ],
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

function createVault() {
  const listeners: {
    create: LearningVaultEntryListener[]
    modify: LearningVaultEntryListener[]
    delete: LearningVaultEntryListener[]
    rename: LearningVaultRenameListener[]
  } = { create: [], modify: [], delete: [], rename: [] }
  const cleanups: jest.Mock[] = []
  const subscribe = <Listener>(target: Listener[], listener: Listener) => {
    target.push(listener)
    const cleanup = jest.fn()
    cleanups.push(cleanup)
    return cleanup
  }
  const onCreate = jest.fn((_scope, listener) =>
    subscribe(listeners.create, listener),
  )
  const vault: LearningVaultReadApi = {
    getEntry: (path) =>
      path === 'Learning/project' ||
      path === 'Learning/second' ||
      path === 'Study/project'
        ? { kind: 'folder', path, name: path.split('/').pop() ?? path }
        : null,
    listChildren: () => [],
    listMarkdownFiles: () => [],
    exists: async () => false,
    readText: async () => '',
    readBinary: async () => new ArrayBuffer(0),
    onCreate,
    onModify: jest.fn((_scope, listener) =>
      subscribe(listeners.modify, listener),
    ),
    onDelete: jest.fn((_scope, listener) =>
      subscribe(listeners.delete, listener),
    ),
    onRename: jest.fn((_scope, listener) =>
      subscribe(listeners.rename, listener),
    ),
  }
  return { vault, listeners, cleanups, onCreate }
}

describe('diffProjects', () => {
  it('keeps structural and relation events ordered and typed', () => {
    const before = project()
    const after = project({
      chapterTitle: 'Changed chapter',
      knowledgeTitle: 'Changed point',
      relationTarget: 'other',
    })
    let sequence = 0

    const events = diffProjects(before, after, () => ({
      sequence: ++sequence,
      timestamp: 10,
    }))

    expect(events.map((event) => event.type)).toEqual([
      'chapter_updated',
      'knowledge_point_updated',
      'relation_established',
    ])
    expect(events[1]).toEqual(
      expect.objectContaining({
        changedFields: ['title'],
        sequence: 2,
        timestamp: 10,
      }),
    )
  })
})

describe('ProjectEventBus', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    mockedScanProject.mockReset()
  })

  afterEach(() => {
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  it('filters to the active project and coalesces vault refreshes', async () => {
    const host = createVault()
    const initial = project()
    const changed = project({ chapterTitle: 'Changed' })
    mockedScanProject.mockResolvedValueOnce(initial).mockResolvedValue(changed)
    const bus = new ProjectEventBus(host.vault)
    const events: LearningEvent[] = []
    bus.subscribe((event) => events.push(event))
    await bus.setActiveProject('Learning', 'Learning/project')
    bus.startWatchingVault()

    host.listeners.modify[0]({
      kind: 'file',
      path: 'Learning/sibling/index.md',
      name: 'index.md',
      ctime: 1,
      mtime: 1,
    })
    host.listeners.create[0]({
      kind: 'file',
      path: 'Learning/project/chapter/knowledge.md',
      name: 'knowledge.md',
      ctime: 1,
      mtime: 1,
    })
    host.listeners.modify[0]({
      kind: 'file',
      path: 'Learning/project/index.md',
      name: 'index.md',
      ctime: 1,
      mtime: 2,
    })

    await jest.advanceTimersByTimeAsync(149)
    expect(mockedScanProject).toHaveBeenCalledTimes(1)
    await jest.advanceTimersByTimeAsync(1)

    expect(mockedScanProject).toHaveBeenCalledTimes(2)
    expect(events.map((event) => event.type)).toEqual([
      'project_initialized',
      'chapter_updated',
    ])
  })

  it('serializes scans and fences stale completion across a project switch', async () => {
    const host = createVault()
    const firstScan = deferred<OutlineProject | null>()
    mockedScanProject
      .mockResolvedValueOnce(project())
      .mockReturnValueOnce(firstScan.promise)
      .mockResolvedValueOnce(project({ projectPath: 'Learning/second' }))
    const bus = new ProjectEventBus(host.vault)
    const events: LearningEvent[] = []
    bus.subscribe((event) => events.push(event))
    await bus.setActiveProject('Learning', 'Learning/project')
    events.length = 0

    const staleRefresh = bus.refreshSnapshot({ emitInitial: false })
    await Promise.resolve()
    const secondSwitch = bus.setActiveProject('Learning', 'Learning/second')
    await Promise.resolve()
    expect(mockedScanProject).toHaveBeenCalledTimes(2)
    expect(bus.getSnapshot()).toBeNull()

    firstScan.resolve(project({ chapterTitle: 'Stale result' }))
    await staleRefresh
    await secondSwitch

    expect(mockedScanProject).toHaveBeenNthCalledWith(
      3,
      host.vault,
      'Learning/second',
    )
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual(
      expect.objectContaining({
        type: 'project_initialized',
        projectId: 'Learning/second',
      }),
    )
    expect(bus.getSnapshot()?.id).toBe('Learning/second')
  })

  it('coalesces events across debounce windows into one trailing refresh', async () => {
    const host = createVault()
    const inFlight = deferred<OutlineProject | null>()
    mockedScanProject
      .mockResolvedValueOnce(project())
      .mockReturnValueOnce(inFlight.promise)
      .mockResolvedValueOnce(project({ chapterTitle: 'Second change' }))
    const bus = new ProjectEventBus(host.vault)
    const events: LearningEvent[] = []
    bus.subscribe((event) => events.push(event))
    await bus.setActiveProject('Learning', 'Learning/project')
    bus.startWatchingVault()

    const changedEntry = {
      kind: 'file' as const,
      path: 'Learning/project/index.md',
      name: 'index.md',
      ctime: 1,
      mtime: 2,
    }
    host.listeners.modify[0](changedEntry)
    await jest.advanceTimersByTimeAsync(150)
    expect(mockedScanProject).toHaveBeenCalledTimes(2)

    for (let mtime = 3; mtime < 8; mtime += 1) {
      host.listeners.modify[0]({ ...changedEntry, mtime })
      await jest.advanceTimersByTimeAsync(200)
      expect(mockedScanProject).toHaveBeenCalledTimes(2)
    }

    inFlight.resolve(project({ chapterTitle: 'First change' }))
    await jest.advanceTimersByTimeAsync(0)

    expect(mockedScanProject).toHaveBeenCalledTimes(3)
    expect(
      events
        .filter((event) => event.type === 'chapter_updated')
        .map((event) => event.chapter.title),
    ).toEqual(['First change', 'Second change'])
  })

  it('reuses same-base watchers and atomically replaces changed-base scope', async () => {
    const host = createVault()
    mockedScanProject.mockImplementation((_vault, path) =>
      Promise.resolve(project({ projectPath: path })),
    )
    const bus = new ProjectEventBus(host.vault)
    await bus.setActiveProject('Learning', 'Learning/project')
    bus.startWatchingVault()
    const originalCleanups = host.cleanups.slice()

    await bus.setActiveProject('Learning', 'Learning/second')
    expect(host.onCreate).toHaveBeenCalledTimes(1)
    for (const cleanup of originalCleanups) {
      expect(cleanup).not.toHaveBeenCalled()
    }

    await bus.setActiveProject('Study', 'Study/project')
    expect(host.onCreate).toHaveBeenNthCalledWith(
      2,
      'Study',
      expect.any(Function),
    )
    for (const cleanup of originalCleanups) {
      expect(cleanup).toHaveBeenCalledTimes(1)
    }

    host.listeners.create[0]({
      kind: 'file',
      path: 'Learning/second/index.md',
      name: 'index.md',
      ctime: 1,
      mtime: 2,
    })
    await jest.advanceTimersByTimeAsync(150)
    expect(mockedScanProject).toHaveBeenCalledTimes(3)

    host.listeners.create[1]({
      kind: 'file',
      path: 'Study/project/index.md',
      name: 'index.md',
      ctime: 1,
      mtime: 2,
    })
    await jest.advanceTimersByTimeAsync(150)
    expect(mockedScanProject).toHaveBeenCalledTimes(4)
  })

  it('refreshes only for renames intersecting the active project', async () => {
    const host = createVault()
    mockedScanProject.mockResolvedValue(project())
    const bus = new ProjectEventBus(host.vault)
    await bus.setActiveProject('Learning', 'Learning/project')
    bus.startWatchingVault()
    const rename = (path: string, oldPath: string) => {
      host.listeners.rename[0](
        { kind: 'folder', path, name: path.split('/').pop() ?? path },
        oldPath,
      )
    }

    rename('Learning/sibling/new', 'Learning/sibling/old')
    rename('Learning/sibling/item', 'Outside/item')
    await jest.advanceTimersByTimeAsync(150)
    expect(mockedScanProject).toHaveBeenCalledTimes(1)

    const relevantRenames = [
      ['Learning/project/item', 'Outside/item'],
      ['Outside/item', 'Learning/project/item'],
      ['Learning/renamed', 'Learning/project'],
      ['Archive', 'Learning'],
    ] as const
    for (const [path, oldPath] of relevantRenames) {
      rename(path, oldPath)
      await jest.advanceTimersByTimeAsync(150)
    }
    expect(mockedScanProject).toHaveBeenCalledTimes(5)
  })

  it('rolls back partial watcher registration when a subscription throws', () => {
    const host = createVault()
    const registrationError = new Error('delete subscription failed')
    host.vault.onDelete = jest.fn(() => {
      throw registrationError
    })
    const bus = new ProjectEventBus(host.vault)

    expect(() => bus.startWatchingVault()).toThrow(registrationError)
    expect(host.cleanups).toHaveLength(2)
    for (const cleanup of host.cleanups) {
      expect(cleanup).toHaveBeenCalledTimes(1)
    }
    expect(host.listeners.rename).toHaveLength(0)
    expect(() => bus.stopWatchingVault()).not.toThrow()
  })

  it('isolates listener errors and enriches synthetic events', () => {
    const host = createVault()
    const bus = new ProjectEventBus(host.vault)
    const error = new Error('listener failed')
    const consoleError = jest.spyOn(console, 'error').mockImplementation()
    const secondListener = jest.fn()
    bus.subscribe(() => {
      throw error
    })
    bus.subscribe(secondListener)

    const event = bus.emitSynthetic({
      type: 'knowledge_point_focused',
      projectId: 'Learning/project',
      knowledgePointId: null,
    })

    expect(event).toEqual(
      expect.objectContaining({ sequence: 1, timestamp: expect.any(Number) }),
    )
    expect(secondListener).toHaveBeenCalledWith(event)
    expect(consoleError).toHaveBeenCalledWith(
      '[YOLO] Learning event listener failed',
      error,
    )
  })

  it('starts and disposes watcher sets idempotently and cancels refresh', async () => {
    const host = createVault()
    mockedScanProject.mockResolvedValue(project())
    const bus = new ProjectEventBus(host.vault)
    await bus.setActiveProject('Learning', 'Learning/project')

    bus.startWatchingVault()
    const firstCleanups = host.cleanups.slice()
    bus.startWatchingVault()
    expect(firstCleanups).toHaveLength(4)
    for (const cleanup of firstCleanups) {
      expect(cleanup).toHaveBeenCalledTimes(1)
    }

    host.listeners.create[1]({
      kind: 'file',
      path: 'Learning/project/index.md',
      name: 'index.md',
      ctime: 1,
      mtime: 2,
    })
    bus.dispose()
    bus.dispose()
    await jest.advanceTimersByTimeAsync(150)

    for (const cleanup of host.cleanups.slice(4)) {
      expect(cleanup).toHaveBeenCalledTimes(1)
    }
    expect(mockedScanProject).toHaveBeenCalledTimes(1)
  })

  it('rejects public mutations after disposal without resurrecting events', async () => {
    const host = createVault()
    const bus = new ProjectEventBus(host.vault)
    bus.dispose()
    const listener = jest.fn()
    const disposedError = 'ProjectEventBus has been disposed'

    expect(() => bus.subscribe(listener)).toThrow(disposedError)
    expect(() =>
      bus.emitSynthetic({
        type: 'knowledge_point_focused',
        projectId: 'Learning/project',
        knowledgePointId: null,
      }),
    ).toThrow(disposedError)
    expect(() => bus.startWatchingVault()).toThrow(disposedError)
    await expect(
      bus.setActiveProject('Learning', 'Learning/project'),
    ).rejects.toThrow(disposedError)
    await expect(bus.refreshSnapshot({ emitInitial: false })).rejects.toThrow(
      disposedError,
    )
    expect(listener).not.toHaveBeenCalled()
  })

  it('completes disposal state cleanup before reporting cleanup failures', async () => {
    const host = createVault()
    mockedScanProject.mockResolvedValue(project())
    const bus = new ProjectEventBus(host.vault)
    await bus.setActiveProject('Learning', 'Learning/project')
    bus.startWatchingVault()
    const listener = jest.fn()
    bus.subscribe(listener)
    host.listeners.create[0]({
      kind: 'file',
      path: 'Learning/project/index.md',
      name: 'index.md',
      ctime: 1,
      mtime: 2,
    })
    const firstError = new Error('first cleanup failed')
    const secondError = new Error('second cleanup failed')
    host.cleanups[0].mockImplementation(() => {
      throw firstError
    })
    host.cleanups[1].mockImplementation(() => {
      throw secondError
    })

    expect(() => bus.dispose()).toThrow(firstError)
    for (const cleanup of host.cleanups) {
      expect(cleanup).toHaveBeenCalledTimes(1)
    }
    expect(() => bus.dispose()).not.toThrow()
    expect(() =>
      bus.emitSynthetic({
        type: 'knowledge_point_focused',
        projectId: 'Learning/project',
        knowledgePointId: null,
      }),
    ).toThrow('ProjectEventBus has been disposed')
    await jest.advanceTimersByTimeAsync(150)

    expect(listener).not.toHaveBeenCalled()
    expect(mockedScanProject).toHaveBeenCalledTimes(1)
  })
})
