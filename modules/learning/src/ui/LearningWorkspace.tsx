import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react'

import type { ProjectEventBus } from '../domain/projectEventBus'
import type {
  LearningNavigationHandler,
  LearningNavigationTarget,
} from '../domain/runtime/learningNavigation'
import type { LearningStatsSnapshot } from '../domain/stats/learningStatsService'
import type { ProjectKind } from '../domain/types'
import type {
  CardGenerationEvent,
  CardGenerationResult,
} from '../generation/types'

import { AnkiImportModal, type AnkiImportUiPort } from './anki/AnkiImportModal'
import type { CardMode } from './cards/CardsView'
import {
  type CardGenerationWorkspace,
  reconcilePreviewEvents,
} from './cards/cardsWorkspace'
import { KnowledgeGraph } from './graph/KnowledgeGraph'
import { type HomeProjectActions, HomeView } from './home/HomeView'
import {
  OutlineBuilder,
  type OutlineBuilderWorkflow,
} from './outline/OutlineBuilder'
import { type LearningTabKey, defaultLearningTab } from './tabs/tabs'
import { type LearningWorkspaceTabServices, Workspace } from './tabs/Workspace'
import {
  type LearningTranslate,
  type LearningWizardInput,
  Wizard,
  type WizardReferenceHost,
} from './wizard/Wizard'

export type LearningLocale = 'en' | 'it' | 'zh'

export type LearningWorkspaceGenerationEvents = {
  onCardGenerationStarted(runId: string, projectId: string): void
  onCard(event: CardGenerationEvent): void
  onChapterSettled(
    runId: string,
    projectId: string,
    result: CardGenerationResult,
  ): void
  onCardGenerationFinished(
    runId: string,
    projectId: string,
    failed: boolean,
  ): void
}

export type LearningWorkspacePorts = {
  ownerDocument: Document
  locale: LearningLocale
  t: LearningTranslate
  configuration: {
    getLearningBaseDir(): string
    subscribeLearningBaseDir(listener: (baseDir: string) => void): () => void
  }
  projects: {
    getSnapshot(): LearningStatsSnapshot
    subscribe(listener: (snapshot: LearningStatsSnapshot) => void): () => void
    refresh(): Promise<LearningStatsSnapshot>
  }
  projectActions: HomeProjectActions
  projectEvents: {
    create(): ProjectEventBus
  }
  navigation: {
    register(handler: LearningNavigationHandler): () => void
  }
  generation: {
    createWorkflow(
      events: LearningWorkspaceGenerationEvents,
    ): OutlineBuilderWorkflow
    abortAll(): void
  }
  recovery: {
    recoverAnkiImports(): Promise<void>
  }
  wizardReferences: WizardReferenceHost
  ankiImport: AnkiImportUiPort
  tabs: LearningWorkspaceTabServices
  reportError?: (message: string, error: unknown) => void
}

export type LearningWorkspaceProps = {
  ports: LearningWorkspacePorts
}

export type LearningWorkspaceState = {
  projectId: string | null
  wizardOpen: boolean
  ankiImportOpen: boolean
  buildingOutline: boolean
  wizardInput: LearningWizardInput | null
  activeTab: LearningTabKey
  cardMode: CardMode
  navigationTarget: LearningNavigationTarget | null
  selectedPointId: string | null
  cardGeneration: CardGenerationWorkspace | null
}

type WorkspaceAction =
  | { type: 'open-project'; projectId: string; projectKind: ProjectKind }
  | { type: 'start-review'; projectId: string }
  | { type: 'back-home' }
  | { type: 'open-wizard' }
  | { type: 'close-wizard' }
  | { type: 'open-anki' }
  | { type: 'close-anki' }
  | { type: 'start-outline'; input: LearningWizardInput }
  | { type: 'cancel-outline' }
  | { type: 'project-started'; projectId: string }
  | { type: 'project-completed'; projectId: string }
  | { type: 'set-tab'; tab: LearningTabKey }
  | { type: 'set-card-mode'; mode: CardMode }
  | { type: 'select-point'; pointId: string }
  | { type: 'queue-navigation'; target: LearningNavigationTarget }
  | { type: 'consume-navigation'; target: LearningNavigationTarget }
  | { type: 'project-missing' }
  | { type: 'card-generation-started'; runId: string; projectId: string }
  | { type: 'card-generated'; event: CardGenerationEvent }
  | {
      type: 'card-chapter-settled'
      runId: string
      projectId: string
      result: CardGenerationResult
    }
  | {
      type: 'card-generation-finished'
      runId: string
      projectId: string
      failed: boolean
    }

export const initialLearningWorkspaceState: LearningWorkspaceState = {
  projectId: null,
  wizardOpen: false,
  ankiImportOpen: false,
  buildingOutline: false,
  wizardInput: null,
  activeTab: defaultLearningTab,
  cardMode: '学习',
  navigationTarget: null,
  selectedPointId: null,
  cardGeneration: null,
}

export function learningWorkspaceReducer(
  state: LearningWorkspaceState,
  action: WorkspaceAction,
): LearningWorkspaceState {
  switch (action.type) {
    case 'open-project':
      return {
        ...state,
        projectId: action.projectId,
        selectedPointId: null,
        activeTab: action.projectKind === 'cards' ? '卡片' : defaultLearningTab,
        cardMode: action.projectKind === 'cards' ? '浏览' : '学习',
      }
    case 'start-review':
      return {
        ...state,
        projectId: action.projectId,
        selectedPointId: null,
        activeTab: '卡片',
        cardMode: '学习',
      }
    case 'back-home':
      return {
        ...state,
        projectId: null,
        selectedPointId: null,
        wizardOpen: false,
        ankiImportOpen: false,
        buildingOutline: false,
        navigationTarget: null,
      }
    case 'open-wizard':
      return { ...state, wizardOpen: true }
    case 'close-wizard':
      return { ...state, wizardOpen: false }
    case 'open-anki':
      return { ...state, ankiImportOpen: true }
    case 'close-anki':
      return { ...state, ankiImportOpen: false }
    case 'start-outline':
      return {
        ...state,
        wizardInput: action.input,
        wizardOpen: false,
        buildingOutline: true,
      }
    case 'cancel-outline':
      return { ...state, buildingOutline: false }
    case 'project-started':
      return {
        ...state,
        projectId: action.projectId,
        selectedPointId: null,
        activeTab: '知识地图',
        buildingOutline: false,
      }
    case 'project-completed':
      return { ...state, projectId: action.projectId }
    case 'set-tab':
      return { ...state, activeTab: action.tab }
    case 'set-card-mode':
      return { ...state, cardMode: action.mode }
    case 'select-point':
      return { ...state, selectedPointId: action.pointId }
    case 'queue-navigation':
      return { ...state, navigationTarget: action.target }
    case 'consume-navigation':
      if (action.target.type === 'home') {
        return learningWorkspaceReducer(state, { type: 'back-home' })
      }
      return {
        ...state,
        projectId: action.target.projectId,
        selectedPointId: null,
        activeTab: action.target.tab,
        cardMode: action.target.cardMode,
        navigationTarget: null,
      }
    case 'project-missing':
      return {
        ...state,
        projectId: null,
        selectedPointId: null,
        activeTab: defaultLearningTab,
      }
    case 'card-generation-started':
      return {
        ...state,
        cardGeneration: {
          runId: action.runId,
          projectId: action.projectId,
          cards: [],
          settled: [],
        },
        activeTab: '卡片',
        cardMode: '浏览',
      }
    case 'card-generated':
      return state.cardGeneration?.runId === action.event.runId &&
        state.cardGeneration.projectId === action.event.projectId
        ? {
            ...state,
            cardGeneration: {
              ...state.cardGeneration,
              cards: [...state.cardGeneration.cards, action.event],
            },
          }
        : state
    case 'card-chapter-settled':
      return state.cardGeneration?.runId === action.runId &&
        state.cardGeneration.projectId === action.projectId
        ? {
            ...state,
            cardGeneration: {
              ...state.cardGeneration,
              cards: reconcilePreviewEvents(
                state.cardGeneration.cards,
                action.result,
              ),
              settled: [...state.cardGeneration.settled, action.result],
            },
          }
        : state
    case 'card-generation-finished':
      if (
        state.cardGeneration?.runId !== action.runId ||
        state.cardGeneration.projectId !== action.projectId
      ) {
        return state
      }
      return {
        ...state,
        cardGeneration: action.failed
          ? null
          : { ...state.cardGeneration, cards: [] },
      }
  }
}

export function resolveNavigationTarget(
  target: LearningNavigationTarget,
  snapshot: LearningStatsSnapshot,
): LearningNavigationTarget | null {
  if (target.type === 'home') return target
  if (!snapshot.projects.some((project) => project.id === target.projectId)) {
    return null
  }
  const paused =
    snapshot.byProject.get(target.projectId)?.paused ??
    snapshot.pausedProjectIds.has(target.projectId)
  return paused && target.cardMode === '学习'
    ? { ...target, cardMode: '浏览' }
    : target
}

export function connectLearningWorkspaceLifecycle({
  eventBus,
  navigation,
  onNavigate,
}: {
  eventBus: ProjectEventBus
  navigation: LearningWorkspacePorts['navigation']
  onNavigate: LearningNavigationHandler
}): () => void {
  const unregisterNavigation = navigation.register(onNavigate)
  return () => {
    unregisterNavigation()
    eventBus.dispose()
  }
}

export function subscribeLearningWorkspaceEvents(
  eventBus: ProjectEventBus,
  onSnapshot: (snapshot: ReturnType<ProjectEventBus['getSnapshot']>) => void,
): () => void {
  return eventBus.subscribe(() => onSnapshot(eventBus.getSnapshot()))
}

export async function initializeLearningWorkspace({
  recoverAnkiImports,
  refreshProjects,
  startWatchingVault,
  isCancelled,
  reportError,
}: {
  recoverAnkiImports: () => Promise<void>
  refreshProjects: () => Promise<unknown>
  startWatchingVault: () => void
  isCancelled: () => boolean
  reportError?: (message: string, error: unknown) => void
}): Promise<void> {
  try {
    await recoverAnkiImports()
  } catch (error) {
    reportError?.('Failed to recover Anki imports', error)
  }
  if (isCancelled()) return

  try {
    await refreshProjects()
  } catch (error) {
    reportError?.('Failed to refresh Learning projects', error)
    return
  }
  if (isCancelled()) return

  try {
    startWatchingVault()
  } catch (error) {
    reportError?.('Failed to start watching Learning vault', error)
  }
}

export function LearningWorkspace({ ports }: LearningWorkspaceProps) {
  const reportError = ports.reportError
  const [state, dispatch] = useReducer(
    learningWorkspaceReducer,
    initialLearningWorkspaceState,
  )
  const [baseDir, setBaseDir] = useState(() =>
    ports.configuration.getLearningBaseDir(),
  )
  const [statsSnapshot, setStatsSnapshot] = useState(() =>
    ports.projects.getSnapshot(),
  )
  const [eventSnapshot, setEventSnapshot] = useState<
    ReturnType<ProjectEventBus['getSnapshot']>
  >(() => null)
  const eventBus = useMemo(
    () => ports.projectEvents.create(),
    [ports.projectEvents],
  )
  const activeProjectRef = useRef<{
    eventBus: ProjectEventBus
    baseDir: string
    projectPath: string | null
  } | null>(null)

  const refreshProjects = useCallback(
    () => ports.projects.refresh(),
    [ports.projects],
  )

  const generationEvents = useMemo<LearningWorkspaceGenerationEvents>(
    () => ({
      onCardGenerationStarted: (runId, projectId) =>
        dispatch({ type: 'card-generation-started', runId, projectId }),
      onCard: (event) => dispatch({ type: 'card-generated', event }),
      onChapterSettled: (runId, projectId, result) =>
        dispatch({ type: 'card-chapter-settled', runId, projectId, result }),
      onCardGenerationFinished: (runId, projectId, failed) => {
        void refreshProjects()
          .then(() =>
            dispatch({
              type: 'card-generation-finished',
              runId,
              projectId,
              failed,
            }),
          )
          .catch((error) =>
            reportError?.('Failed to refresh generated cards', error),
          )
      },
    }),
    [refreshProjects, reportError],
  )
  const outlineWorkflow = useMemo(
    () => ports.generation.createWorkflow(generationEvents),
    [generationEvents, ports.generation],
  )

  useEffect(
    () =>
      ports.configuration.subscribeLearningBaseDir((nextBaseDir) => {
        setBaseDir(nextBaseDir)
      }),
    [ports.configuration],
  )

  useEffect(() => ports.projects.subscribe(setStatsSnapshot), [ports.projects])

  useEffect(() => {
    const onNavigate: LearningNavigationHandler = (target) =>
      dispatch({ type: 'queue-navigation', target })
    return connectLearningWorkspaceLifecycle({
      eventBus,
      navigation: ports.navigation,
      onNavigate,
    })
  }, [eventBus, ports.navigation])

  useEffect(
    () => subscribeLearningWorkspaceEvents(eventBus, setEventSnapshot),
    [eventBus],
  )

  useEffect(() => {
    let cancelled = false
    void initializeLearningWorkspace({
      recoverAnkiImports: () => ports.recovery.recoverAnkiImports(),
      refreshProjects,
      startWatchingVault: () => eventBus.startWatchingVault(),
      isCancelled: () => cancelled,
      reportError,
    })
    return () => {
      cancelled = true
      eventBus.stopWatchingVault()
    }
  }, [baseDir, eventBus, ports.recovery, refreshProjects, reportError])

  useEffect(() => {
    const project = statsSnapshot.projects.find(
      (item) => item.id === state.projectId,
    )
    const projectPath = project?.folderPath ?? null
    const active = activeProjectRef.current
    if (
      active?.eventBus === eventBus &&
      active.baseDir === baseDir &&
      active.projectPath === projectPath
    ) {
      return
    }
    activeProjectRef.current = { eventBus, baseDir, projectPath }
    let current = true
    setEventSnapshot(null)
    void eventBus
      .setActiveProject(baseDir, projectPath)
      .then(() => {
        if (current) setEventSnapshot(eventBus.getSnapshot())
      })
      .catch((error) =>
        reportError?.('Failed to switch Learning project', error),
      )
    return () => {
      current = false
    }
  }, [baseDir, eventBus, reportError, state.projectId, statsSnapshot.projects])

  useEffect(() => {
    if (!state.navigationTarget) return
    const target = resolveNavigationTarget(
      state.navigationTarget,
      statsSnapshot,
    )
    if (target) dispatch({ type: 'consume-navigation', target })
  }, [state.navigationTarget, statsSnapshot])

  useEffect(() => {
    if (!state.projectId) return
    if (
      statsSnapshot.projects.some((project) => project.id === state.projectId)
    ) {
      return
    }
    dispatch({ type: 'project-missing' })
  }, [state.projectId, statsSnapshot.projects])

  const project = statsSnapshot.projects.find(
    (item) => item.id === state.projectId,
  )
  const projectPaused = state.projectId
    ? (statsSnapshot.byProject.get(state.projectId)?.paused ??
      statsSnapshot.pausedProjectIds.has(state.projectId))
    : false

  return (
    <div className="yolo-learning yolo-learning-root">
      <div
        className={`yolo-learning-page ${state.projectId && !state.buildingOutline ? 'is-workspace' : !state.buildingOutline ? 'is-home' : ''}`}
      >
        {state.buildingOutline ? (
          state.wizardInput ? (
            <OutlineBuilder
              goal={state.wizardInput.goal}
              level={state.wizardInput.level}
              onCancel={() => {
                if (state.wizardInput?.stagingDir) {
                  void ports.wizardReferences.cleanup(
                    state.wizardInput.stagingDir,
                  )
                }
                dispatch({ type: 'cancel-outline' })
              }}
              onComplete={(projectId) => {
                void refreshProjects()
                  .then(() =>
                    dispatch({ type: 'project-completed', projectId }),
                  )
                  .catch((error) =>
                    reportError?.('Failed to refresh completed project', error),
                  )
              }}
              onProjectStarted={async (projectId) => {
                await refreshProjects()
                dispatch({ type: 'project-started', projectId })
              }}
              referenceFiles={state.wizardInput.referenceFiles}
              stagingDir={state.wizardInput.stagingDir}
              t={ports.t}
              topic={state.wizardInput.topic}
              workflow={outlineWorkflow}
            />
          ) : null
        ) : state.projectId ? (
          <Workspace
            activeTab={state.activeTab}
            cardGeneration={
              state.cardGeneration?.projectId === state.projectId
                ? state.cardGeneration
                : null
            }
            cardMode={state.cardMode}
            knowledgeMap={
              <KnowledgeGraph
                eventBus={eventBus}
                initialSnapshot={eventSnapshot}
                key={state.projectId}
                t={ports.t}
              />
            }
            onBack={() => dispatch({ type: 'back-home' })}
            onCardModeChange={(mode) =>
              dispatch({ type: 'set-card-mode', mode })
            }
            onSelectPoint={(pointId) =>
              dispatch({ type: 'select-point', pointId })
            }
            onTabChange={(tab) => dispatch({ type: 'set-tab', tab })}
            ownerDocument={ports.ownerDocument}
            project={project ?? null}
            projectPaused={projectPaused}
            selectedPointId={state.selectedPointId}
            services={ports.tabs}
            t={ports.t}
          />
        ) : (
          <HomeView
            locale={ports.locale}
            onImportAnki={() => dispatch({ type: 'open-anki' })}
            onNewProject={() => dispatch({ type: 'open-wizard' })}
            onOpenProject={(projectId) => {
              const selected = statsSnapshot.projects.find(
                (item) => item.id === projectId,
              )
              if (selected) {
                dispatch({
                  type: 'open-project',
                  projectId,
                  projectKind: selected.kind,
                })
              }
            }}
            onStartReview={(projectId) => {
              const paused =
                statsSnapshot.byProject.get(projectId)?.paused ??
                statsSnapshot.pausedProjectIds.has(projectId)
              if (!paused) dispatch({ type: 'start-review', projectId })
            }}
            projectActions={ports.projectActions}
            projects={statsSnapshot.projects}
            statsSnapshot={statsSnapshot}
            t={ports.t}
          />
        )}
      </div>

      {state.wizardOpen ? (
        <Wizard
          learningBaseDir={baseDir}
          onClose={() => dispatch({ type: 'close-wizard' })}
          onComplete={(input) => dispatch({ type: 'start-outline', input })}
          references={ports.wizardReferences}
          t={ports.t}
        />
      ) : null}
      {state.ankiImportOpen ? (
        <AnkiImportModal
          baseDir={baseDir}
          onClose={() => dispatch({ type: 'close-anki' })}
          onImported={async (projectPath) => {
            const snapshot = await refreshProjects()
            const imported = snapshot.projects.find(
              (item) => item.folderPath === projectPath,
            )
            if (!imported) {
              throw new Error(`Imported project was not found: ${projectPath}`)
            }
            dispatch({
              type: 'open-project',
              projectId: imported.id,
              projectKind: 'cards',
            })
          }}
          port={ports.ankiImport}
          t={ports.t}
        />
      ) : null}
    </div>
  )
}
