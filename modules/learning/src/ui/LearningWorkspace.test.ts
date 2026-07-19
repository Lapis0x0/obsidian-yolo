import type { ProjectEventBus } from '../domain/projectEventBus'
import type { LearningNavigationTarget } from '../domain/runtime/learningNavigation'
import type { LearningStatsSnapshot } from '../domain/stats/learningStatsService'

jest.mock('./graph/KnowledgeGraph', () => ({ KnowledgeGraph: () => null }))

import {
  connectLearningWorkspaceLifecycle,
  initialLearningWorkspaceState,
  initializeLearningWorkspace,
  learningWorkspaceReducer,
  resolveNavigationTarget,
  subscribeLearningWorkspaceEvents,
} from './LearningWorkspace'

const snapshot = (pausedProjectIds: readonly string[] = []) =>
  ({
    projects: [
      {
        id: 'outline-project',
        slug: 'outline-project',
        topic: 'Outline',
        goal: 'Learn',
        status: 'studying',
        folderPath: 'Learning/outline-project',
        indexFilePath: 'Learning/outline-project/index.md',
        kind: 'outline',
        chapters: [],
        knowledgePoints: [],
      },
      {
        id: 'cards-project',
        slug: 'cards-project',
        topic: 'Cards',
        goal: 'Review',
        status: 'studying',
        folderPath: 'Learning/cards-project',
        indexFilePath: 'Learning/cards-project/index.md',
        kind: 'cards',
        chapters: [],
        knowledgePoints: [],
      },
    ],
    byProject: new Map(),
    pausedProjectIds: new Set(pausedProjectIds),
    failedProjectIds: new Set(),
    loading: false,
  }) satisfies LearningStatsSnapshot

describe('LearningWorkspace state', () => {
  it('switches projects while preserving the stable Chinese tab and card keys', () => {
    const outline = learningWorkspaceReducer(initialLearningWorkspaceState, {
      type: 'open-project',
      projectId: 'outline-project',
      projectKind: 'outline',
    })
    expect(outline).toMatchObject({
      projectId: 'outline-project',
      activeTab: '大纲',
      cardMode: '学习',
    })

    const cards = learningWorkspaceReducer(outline, {
      type: 'open-project',
      projectId: 'cards-project',
      projectKind: 'cards',
    })
    expect(cards).toMatchObject({
      projectId: 'cards-project',
      activeTab: '卡片',
      cardMode: '浏览',
      selectedPointId: null,
    })
  })

  it('waits for an unknown navigation project and downgrades paused study targets', () => {
    expect(
      resolveNavigationTarget(
        {
          type: 'project',
          projectId: 'missing',
          tab: '卡片',
          cardMode: '学习',
        },
        snapshot(),
      ),
    ).toBeNull()
    expect(
      resolveNavigationTarget(
        {
          type: 'project',
          projectId: 'outline-project',
          tab: '卡片',
          cardMode: '学习',
        },
        snapshot(['outline-project']),
      ),
    ).toEqual({
      type: 'project',
      projectId: 'outline-project',
      tab: '卡片',
      cardMode: '浏览',
    })
  })

  it('returns home through a queued navigation target', () => {
    const project = learningWorkspaceReducer(initialLearningWorkspaceState, {
      type: 'open-project',
      projectId: 'outline-project',
      projectKind: 'outline',
    })
    const queued = learningWorkspaceReducer(project, {
      type: 'queue-navigation',
      target: { type: 'home' },
    })
    const home = learningWorkspaceReducer(queued, {
      type: 'consume-navigation',
      target: { type: 'home' },
    })
    expect(home.projectId).toBeNull()
    expect(home.navigationTarget).toBeNull()
  })

  it('keeps generation previews scoped to their run and clears them on failure', () => {
    const started = learningWorkspaceReducer(initialLearningWorkspaceState, {
      type: 'card-generation-started',
      runId: 'run-1',
      projectId: 'outline-project',
    })
    const stale = learningWorkspaceReducer(started, {
      type: 'card-generated',
      event: {
        runId: 'run-2',
        projectId: 'outline-project',
        chapterId: 'chapter-1',
        chapterIndex: 0,
        cardIndex: 0,
        cardUuid: 'card-1',
        card: {
          cardUuid: 'card-1',
          title: 'Card',
          kpUuid: 'point-1',
          front: 'Front',
          back: 'Back',
          startLine: 1,
        },
      },
    })
    expect(stale).toBe(started)

    const failed = learningWorkspaceReducer(started, {
      type: 'card-generation-finished',
      runId: 'run-1',
      projectId: 'outline-project',
      failed: true,
    })
    expect(failed.cardGeneration).toBeNull()
  })
})

describe('LearningWorkspace lifecycle', () => {
  it('unregisters only its navigation handler', () => {
    const unregister = jest.fn()
    const register = jest.fn(() => unregister)
    const abortAll = jest.fn()
    const lifecyclePorts = {
      navigation: { register },
      generation: { createWorkflow: jest.fn(), abortAll },
      onNavigate: jest.fn(),
    }
    const cleanup = connectLearningWorkspaceLifecycle(lifecyclePorts)

    expect(register).toHaveBeenCalledWith(lifecyclePorts.onNavigate)

    cleanup()

    expect(unregister).toHaveBeenCalledTimes(1)
    expect(abortAll).not.toHaveBeenCalled()
  })

  it('keeps sibling navigation and event subscriptions alive in either close order', () => {
    const handlers = new Map<
      symbol,
      (target: LearningNavigationTarget) => void
    >()
    const navigation = {
      register: (handler: (target: LearningNavigationTarget) => void) => {
        const token = Symbol()
        handlers.set(token, handler)
        return () => handlers.delete(token)
      },
    }
    const createMount = () => {
      const listeners = new Set<() => void>()
      let snapshot: ReturnType<ProjectEventBus['getSnapshot']> = null
      const dispose = jest.fn(() => listeners.clear())
      const eventBus = {
        dispose,
        getSnapshot: () => snapshot,
        subscribe: (listener: () => void) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      } as unknown as ProjectEventBus
      const onNavigate = jest.fn()
      const onRefresh = jest.fn()
      const unsubscribe = subscribeLearningWorkspaceEvents(eventBus, onRefresh)
      const cleanup = connectLearningWorkspaceLifecycle({
        navigation,
        onNavigate,
      })
      return {
        cleanup,
        dispose,
        emit: (nextSnapshot: ReturnType<ProjectEventBus['getSnapshot']>) => {
          snapshot = nextSnapshot
          listeners.forEach((listener) => listener())
        },
        onNavigate,
        onRefresh,
        unsubscribe,
      }
    }
    const first = createMount()
    const second = createMount()
    const project = {
      type: 'project',
      projectId: 'cards-project',
      tab: '卡片',
      cardMode: '浏览',
    } as const

    for (const handler of handlers.values()) handler(project)
    const firstSnapshot = {
      id: 'first-project',
    } as unknown as ReturnType<ProjectEventBus['getSnapshot']>
    const secondSnapshot = {
      id: 'second-project',
    } as unknown as ReturnType<ProjectEventBus['getSnapshot']>
    first.emit(firstSnapshot)
    second.emit(secondSnapshot)
    expect(first.onNavigate).toHaveBeenCalledWith(project)
    expect(second.onNavigate).toHaveBeenCalledWith(project)
    expect(first.onRefresh).toHaveBeenCalledTimes(1)
    expect(second.onRefresh).toHaveBeenCalledTimes(1)
    expect(first.onRefresh).toHaveBeenCalledWith(firstSnapshot)
    expect(second.onRefresh).toHaveBeenCalledWith(secondSnapshot)

    first.cleanup()
    for (const handler of handlers.values()) handler({ type: 'home' })
    second.emit(secondSnapshot)
    expect(first.onNavigate).toHaveBeenCalledTimes(1)
    expect(second.onNavigate).toHaveBeenCalledTimes(2)
    expect(second.onRefresh).toHaveBeenCalledTimes(2)

    second.cleanup()
    expect(handlers.size).toBe(0)
    expect(first.dispose).not.toHaveBeenCalled()
    expect(second.dispose).not.toHaveBeenCalled()

    const reverseFirst = createMount()
    const reverseSecond = createMount()
    reverseSecond.cleanup()
    for (const handler of handlers.values()) handler(project)
    expect(reverseFirst.onNavigate).toHaveBeenCalledWith(project)
    expect(reverseSecond.onNavigate).not.toHaveBeenCalled()
    reverseFirst.cleanup()
  })

  it('reports recovery failure and still refreshes before watching the vault', async () => {
    const recoveryError = new Error('recovery failed')
    const recoverAnkiImports = jest.fn().mockRejectedValue(recoveryError)
    const refreshProjects = jest.fn().mockResolvedValue(undefined)
    const startWatchingVault = jest.fn()
    const reportError = jest.fn()

    await initializeLearningWorkspace({
      recoverAnkiImports,
      refreshProjects,
      startWatchingVault,
      isCancelled: () => false,
      reportError,
    })

    expect(reportError).toHaveBeenCalledWith(
      'Failed to recover Anki imports',
      recoveryError,
    )
    expect(refreshProjects).toHaveBeenCalledTimes(1)
    expect(startWatchingVault).toHaveBeenCalledTimes(1)
  })

  it('does not start watching when the initial project refresh fails', async () => {
    const refreshError = new Error('refresh failed')
    const startWatchingVault = jest.fn()
    const reportError = jest.fn()

    await initializeLearningWorkspace({
      recoverAnkiImports: jest.fn().mockResolvedValue(undefined),
      refreshProjects: jest.fn().mockRejectedValue(refreshError),
      startWatchingVault,
      isCancelled: () => false,
      reportError,
    })

    expect(reportError).toHaveBeenCalledWith(
      'Failed to refresh Learning projects',
      refreshError,
    )
    expect(startWatchingVault).not.toHaveBeenCalled()
  })

  it('isolates watcher registration errors', async () => {
    const watcherError = new Error('watcher failed')
    const reportError = jest.fn()

    await expect(
      initializeLearningWorkspace({
        recoverAnkiImports: jest.fn().mockResolvedValue(undefined),
        refreshProjects: jest.fn().mockResolvedValue(undefined),
        startWatchingVault: jest.fn(() => {
          throw watcherError
        }),
        isCancelled: () => false,
        reportError,
      }),
    ).resolves.toBeUndefined()
    expect(reportError).toHaveBeenCalledWith(
      'Failed to start watching Learning vault',
      watcherError,
    )
  })
})
