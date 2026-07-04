import { TAbstractFile } from 'obsidian'
import { useCallback, useEffect, useMemo, useState } from 'react'

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
    const refreshIfLearningPath = (file: TAbstractFile) => {
      if (isPathUnderLearningBase(file.path, baseDir)) void refreshProjects()
    }
    const refs = [
      app.vault.on('create', refreshIfLearningPath),
      app.vault.on('modify', refreshIfLearningPath),
      app.vault.on('delete', refreshIfLearningPath),
    ]
    return () => {
      for (const ref of refs) app.vault.offref(ref)
    }
  }, [app, baseDir, refreshProjects])

  const knowledgeMap = (
    <KnowledgeGraph eventBus={bus} initialSnapshot={bus.getSnapshot()} />
  )

  return (
    <div className="yolo-learning yolo-learning-root">
      <div className="yolo-learning-page">
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
