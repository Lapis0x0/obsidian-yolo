import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { recoverAnkiImports } from '../../core/learning/anki/importService'
import { cleanupStaging } from '../../core/learning/generation/referenceStaging'
import type {
  CardGenerationEvent,
  CardGenerationResult,
} from '../../core/learning/generation/types'
import type { LearningNavigationTarget } from '../../core/learning/learningNavigation'
import { ProjectEventBus } from '../../core/learning/projectEventBus'
import { getYoloLearningDir } from '../../core/paths/yoloPaths'

import { AnkiImportModal } from './AnkiImportModal'
import type { CardMode } from './CardsView'
import {
  type CardGenerationWorkspace,
  reconcilePreviewEvents,
} from './cardsWorkspace'
import { HomeView } from './HomeView'
import { KnowledgeGraph } from './KnowledgeGraph'
import { useLearningUiHost } from './LearningUiHost'
import { OutlineBuilder } from './OutlineBuilder'
import { type TabKey, tabs } from './tabs'
import { type LearningWizardInput, Wizard } from './Wizard'
import { Workspace } from './Workspace'

export function LearningWorkspace() {
  const host = useLearningUiHost()
  const app = host.app
  const [settings, setSettings] = useState(() => host.settings)
  const baseDir = useMemo(() => getYoloLearningDir(settings), [settings])

  const [projectId, setProjectId] = useState<string | null>(null)
  const [wizardOpen, setWizardOpen] = useState(false)
  const [ankiImportOpen, setAnkiImportOpen] = useState(false)
  const [buildingOutline, setBuildingOutline] = useState(false)
  const [wizardInput, setWizardInput] = useState<LearningWizardInput | null>(
    null,
  )
  const [activeTab, setActiveTab] = useState<TabKey>(tabs[0])
  const [cardMode, setCardMode] = useState<CardMode>('学习')
  const [navigationTarget, setNavigationTarget] =
    useState<LearningNavigationTarget | null>(null)
  const [selectedPointId, setSelectedPointId] = useState<string | null>(null)
  const [cardGeneration, setCardGeneration] =
    useState<CardGenerationWorkspace | null>(null)
  const activeProjectRef = useRef<{
    baseDir: string
    projectPath: string | null
  } | null>(null)

  const bus = useMemo(() => new ProjectEventBus(app), [app])
  const statsService = host.statsService
  const [statsSnapshot, setStatsSnapshot] = useState(() =>
    statsService.getSnapshot(),
  )
  const vaultProjects = statsSnapshot.projects

  useEffect(() => {
    setSettings(host.settings)
    return host.subscribeSettings(setSettings)
  }, [host])

  useEffect(() => {
    host.setEventBus(bus)
    return () => {
      host.setEventBus(null)
    }
  }, [bus, host])

  useEffect(() => {
    host.setNavigationHandler(setNavigationTarget)
    return () => host.setNavigationHandler(null)
  }, [host])

  useEffect(() => {
    if (!navigationTarget) return
    if (navigationTarget.type === 'home') {
      setProjectId(null)
      setSelectedPointId(null)
      setWizardOpen(false)
      setAnkiImportOpen(false)
      setBuildingOutline(false)
      setNavigationTarget(null)
      return
    }
    if (
      !vaultProjects.some(
        (project) => project.id === navigationTarget.projectId,
      )
    )
      return
    const targetPaused =
      statsSnapshot.byProject.get(navigationTarget.projectId)?.paused ??
      statsSnapshot.pausedProjectIds.has(navigationTarget.projectId)
    setCardMode(
      navigationTarget.cardMode === '学习' && targetPaused
        ? '浏览'
        : navigationTarget.cardMode,
    )
    setActiveTab(navigationTarget.tab)
    setProjectId(navigationTarget.projectId)
    setNavigationTarget(null)
  }, [navigationTarget, statsSnapshot.byProject, vaultProjects])

  useEffect(() => {
    return statsService.subscribe(setStatsSnapshot)
  }, [statsService])

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      try {
        await recoverAnkiImports({
          app,
          srsStore: host.srsStore,
        })
      } catch (error) {
        console.error('[YOLO] Failed to recover Anki imports:', error)
      }
      if (cancelled) return
      await statsService.refreshAll()
      if (cancelled) return
      bus.startWatchingVault()
    }
    void run()
    return () => {
      cancelled = true
      bus.stopWatchingVault()
    }
  }, [app, baseDir, bus, host, statsService])

  useEffect(() => {
    const project = vaultProjects.find((item) => item.id === projectId)
    const projectPath = project?.folderPath ?? null
    const active = activeProjectRef.current
    if (active?.baseDir === baseDir && active.projectPath === projectPath) {
      return
    }

    activeProjectRef.current = { baseDir, projectPath }
    void bus.setActiveProject(baseDir, projectPath)
  }, [baseDir, bus, projectId, vaultProjects])

  useEffect(() => {
    if (!projectId) return
    if (vaultProjects.some((item) => item.id === projectId)) return

    setProjectId(null)
    setSelectedPointId(null)
    setActiveTab(tabs[0])
  }, [projectId, vaultProjects])

  useEffect(() => {
    return () => {
      bus.dispose()
    }
  }, [bus])

  const refreshProjects = useCallback(async () => {
    return (await statsService.refreshAll()).projects
  }, [statsService])

  const knowledgeMap = (
    <KnowledgeGraph eventBus={bus} initialSnapshot={bus.getSnapshot()} />
  )

  return (
    <div className="yolo-learning yolo-learning-root">
      <div
        className={`yolo-learning-page ${projectId && !buildingOutline ? 'is-workspace' : !buildingOutline ? 'is-home' : ''}`}
      >
        {buildingOutline ? (
          wizardInput && (
            <OutlineBuilder
              eventBus={bus}
              topic={wizardInput.topic}
              level={wizardInput.level}
              goal={wizardInput.goal}
              stagingDir={wizardInput.stagingDir}
              referenceFiles={wizardInput.referenceFiles}
              onCancel={() => {
                if (wizardInput.stagingDir) {
                  void cleanupStaging(app, wizardInput.stagingDir)
                }
                setBuildingOutline(false)
              }}
              onProjectStarted={async (newProjectId) => {
                await refreshProjects()
                setProjectId(newProjectId)
                setActiveTab('知识地图')
                setBuildingOutline(false)
              }}
              onComplete={(newProjectId) => {
                void refreshProjects().then(() => setProjectId(newProjectId))
              }}
              onCardGenerationStarted={(runId, generationProjectId) => {
                setCardGeneration({
                  runId,
                  projectId: generationProjectId,
                  cards: [],
                  settled: [],
                })
                setCardMode('浏览')
                setActiveTab('卡片')
              }}
              onCard={(event: CardGenerationEvent) => {
                setCardGeneration((current) =>
                  current?.runId === event.runId &&
                  current.projectId === event.projectId
                    ? { ...current, cards: [...current.cards, event] }
                    : current,
                )
              }}
              onChapterSettled={(
                runId,
                generationProjectId,
                result: CardGenerationResult,
              ) => {
                setCardGeneration((current) =>
                  current?.runId === runId &&
                  current.projectId === generationProjectId
                    ? {
                        ...current,
                        cards: reconcilePreviewEvents(current.cards, result),
                        settled: [...current.settled, result],
                      }
                    : current,
                )
              }}
              onCardGenerationFinished={(
                runId,
                generationProjectId,
                failed,
              ) => {
                void refreshProjects().then(() => {
                  setCardGeneration((current) => {
                    if (
                      current?.runId !== runId ||
                      current.projectId !== generationProjectId
                    )
                      return current
                    return failed ? null : { ...current, cards: [] }
                  })
                })
              }}
            />
          )
        ) : projectId ? (
          <Workspace
            project={
              vaultProjects.find((item) => item.id === projectId) ?? null
            }
            onBack={() => setProjectId(null)}
            activeTab={activeTab}
            onTabChange={setActiveTab}
            selectedPointId={selectedPointId}
            onSelectPoint={setSelectedPointId}
            knowledgeMap={knowledgeMap}
            cardGeneration={
              cardGeneration?.projectId === projectId ? cardGeneration : null
            }
            cardMode={cardMode}
            onCardModeChange={setCardMode}
            projectPaused={
              statsSnapshot.byProject.get(projectId)?.paused ??
              statsSnapshot.pausedProjectIds.has(projectId)
            }
          />
        ) : (
          <HomeView
            projects={vaultProjects}
            statsSnapshot={statsSnapshot}
            onOpenProject={(id) => {
              const project = vaultProjects.find((item) => item.id === id)
              if (project?.kind === 'cards') {
                setCardMode('浏览')
                setActiveTab('卡片')
              } else {
                setCardMode('学习')
                setActiveTab(tabs[0])
              }
              setProjectId(id)
            }}
            onStartReview={(id) => {
              if (
                statsSnapshot.byProject.get(id)?.paused ??
                statsSnapshot.pausedProjectIds.has(id)
              )
                return
              setCardMode('学习')
              setActiveTab('卡片')
              setProjectId(id)
            }}
            onNewProject={() => setWizardOpen(true)}
            onImportAnki={() => setAnkiImportOpen(true)}
          />
        )}
      </div>

      {wizardOpen && (
        <Wizard
          learningBaseDir={baseDir}
          onClose={() => setWizardOpen(false)}
          onComplete={(input) => {
            setWizardInput(input)
            setWizardOpen(false)
            setBuildingOutline(true)
          }}
        />
      )}
      {ankiImportOpen && (
        <AnkiImportModal
          baseDir={baseDir}
          onClose={() => setAnkiImportOpen(false)}
          onImported={async (projectPath) => {
            const projects = await refreshProjects()
            const imported = projects.find(
              (project) => project.folderPath === projectPath,
            )
            if (!imported) {
              throw new Error(`Imported project was not found: ${projectPath}`)
            }
            setCardMode('浏览')
            setActiveTab('卡片')
            setProjectId(imported.id)
          }}
        />
      )}
    </div>
  )
}
