import { TAbstractFile } from 'obsidian'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useApp } from '../../contexts/app-context'
import { usePlugin } from '../../contexts/plugin-context'
import { useSettings } from '../../contexts/settings-context'
import { ProjectEventBus } from '../../core/learning/projectEventBus'
import {
  isPathUnderLearningBase,
  scanProjects,
} from '../../core/learning/projectScanner'
import type { Project as VaultProject } from '../../core/learning/types'
import { getYoloLearningDir } from '../../core/paths/yoloPaths'

import { HomeView } from './HomeView'
import { KnowledgeGraph } from './KnowledgeGraph'
import { OutlineBuilder } from './OutlineBuilder'
import { type TabKey, tabs } from './tabs'
import { type LearningWizardInput, Wizard } from './Wizard'
import { Workspace } from './Workspace'

const LEARNING_PROJECT_REFRESH_DEBOUNCE_MS = 200

export function LearningWorkspace() {
  const app = useApp()
  const plugin = usePlugin()
  const { settings } = useSettings()
  const baseDir = useMemo(() => getYoloLearningDir(settings), [settings])

  const [projectId, setProjectId] = useState<string | null>(null)
  const [wizardOpen, setWizardOpen] = useState(false)
  const [buildingOutline, setBuildingOutline] = useState(false)
  const [wizardInput, setWizardInput] = useState<LearningWizardInput | null>(
    null,
  )
  const [activeTab, setActiveTab] = useState<TabKey>(tabs[0])
  const [selectedPointId, setSelectedPointId] = useState<string | null>(null)
  const refreshTimerRef = useRef<number | null>(null)

  const bus = useMemo(() => new ProjectEventBus(app), [app])
  const [vaultProjects, setVaultProjects] = useState<VaultProject[]>([])

  useEffect(() => {
    plugin.setLearningEventBus(bus)
    return () => {
      plugin.setLearningEventBus(null)
    }
  }, [bus, plugin])

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      const { projects: scanned } = await scanProjects(app, baseDir)
      if (cancelled) return
      setVaultProjects(scanned)
      bus.startWatchingVault()
    }
    void run()
    return () => {
      cancelled = true
      bus.stopWatchingVault()
    }
  }, [app, bus, baseDir])

  useEffect(() => {
    const project = vaultProjects.find((item) => item.id === projectId)
    void bus.setActiveProject(baseDir, project?.folderPath ?? null)
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
    const { projects: scanned } = await scanProjects(app, baseDir)
    setVaultProjects(scanned)
    return scanned
  }, [app, baseDir])

  useEffect(() => {
    const scheduleRefreshProjects = () => {
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current)
      }

      refreshTimerRef.current = window.setTimeout(() => {
        refreshTimerRef.current = null
        void refreshProjects()
      }, LEARNING_PROJECT_REFRESH_DEBOUNCE_MS)
    }

    const refreshIfLearningPath = (file: TAbstractFile) => {
      if (isPathUnderLearningBase(file.path, baseDir)) scheduleRefreshProjects()
    }
    const refs = [
      app.vault.on('create', refreshIfLearningPath),
      app.vault.on('modify', refreshIfLearningPath),
      app.vault.on('delete', refreshIfLearningPath),
    ]
    return () => {
      for (const ref of refs) app.vault.offref(ref)
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current)
        refreshTimerRef.current = null
      }
    }
  }, [app, baseDir, refreshProjects])

  const knowledgeMap = (
    <KnowledgeGraph eventBus={bus} initialSnapshot={bus.getSnapshot()} />
  )

  return (
    <div className="yolo-learning yolo-learning-root">
      <div
        className={`yolo-learning-page ${projectId && !buildingOutline ? 'is-workspace' : ''}`}
      >
        {buildingOutline ? (
          wizardInput && (
            <OutlineBuilder
              plugin={plugin}
              eventBus={bus}
              topic={wizardInput.topic}
              level={wizardInput.level}
              goal={wizardInput.goal}
              onCancel={() => setBuildingOutline(false)}
              onProjectStarted={async (newProjectId) => {
                await refreshProjects()
                setProjectId(newProjectId)
                setActiveTab('知识地图')
                setBuildingOutline(false)
              }}
              onComplete={(newProjectId) => {
                void refreshProjects().then(() => setProjectId(newProjectId))
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
          />
        ) : (
          <HomeView
            projects={vaultProjects}
            onOpenProject={setProjectId}
            onNewProject={() => setWizardOpen(true)}
          />
        )}
      </div>

      {wizardOpen && (
        <Wizard
          onClose={() => setWizardOpen(false)}
          onComplete={(input) => {
            setWizardInput(input)
            setWizardOpen(false)
            setBuildingOutline(true)
          }}
        />
      )}
    </div>
  )
}
