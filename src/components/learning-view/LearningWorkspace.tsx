import { useEffect, useMemo, useState } from 'react'

import { DEFAULT_LEARNING_BASE_DIR } from '../../constants'
import { useApp } from '../../contexts/app-context'
import { usePlugin } from '../../contexts/plugin-context'
import { ProjectEventBus } from '../../core/learning/projectEventBus'
import { scanProjects } from '../../core/learning/projectScanner'
import type { Project as VaultProject } from '../../core/learning/types'

import { HomeView } from './HomeView'
import { KnowledgeGraph } from './KnowledgeGraph'
import { type TabKey, tabs } from './mockLearningData'
import { OutlineBuilder } from './OutlineBuilder'
import { Wizard } from './Wizard'
import { Workspace } from './Workspace'

/**
 * LearningWorkspace
 * ─────────────────
 * Root React entry for the Learning Mode view. Owns the top-level navigation
 * state machine (mirrors the design mock's `learning-view.tsx`):
 *
 *   HomeView ─(新建)→ Wizard ─(完成)→ OutlineBuilder ─(完成)→ Workspace
 *   HomeView ─(打开项目)──────────────────────────────────→ Workspace
 *
 * ⚠️ Migration phase: the views are driven by `mockLearningData`, NOT the
 * vault. The ProjectEventBus / vault scan below is kept only to feed the
 * existing force-directed KnowledgeGraph (the "知识地图" tab) and the mock
 * replay command. Wiring the shell to real vault data is a later phase.
 */
export function LearningWorkspace() {
  const app = useApp()
  const plugin = usePlugin()
  const baseDir = DEFAULT_LEARNING_BASE_DIR

  const [projectId, setProjectId] = useState<string | null>(null)
  const [wizardOpen, setWizardOpen] = useState(false)
  const [buildingOutline, setBuildingOutline] = useState(false)
  const [activeTab, setActiveTab] = useState<TabKey>(tabs[0])
  const [selectedPointId, setSelectedPointId] = useState<string | null>('p2-2')

  // Event bus + vault scan: only feeds the KnowledgeGraph tab / mock replay.
  const bus = useMemo(() => new ProjectEventBus(app), [app])
  const [, setVaultProjects] = useState<VaultProject[]>([])

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
      const firstPath = scanned[0]?.folderPath ?? null
      await bus.setActiveProject(baseDir, firstPath)
      bus.startWatchingVault()
    }
    void run()
    return () => {
      cancelled = true
      bus.stopWatchingVault()
    }
  }, [app, bus, baseDir])

  useEffect(() => {
    return () => {
      bus.dispose()
    }
  }, [bus])

  const knowledgeMap = (
    <KnowledgeGraph eventBus={bus} initialSnapshot={bus.getSnapshot()} />
  )

  return (
    <div className="yolo-learning yolo-learning-root">
      <div className="yolo-learning-page">
        {buildingOutline ? (
          <OutlineBuilder
            onCancel={() => setBuildingOutline(false)}
            onComplete={() => {
              setBuildingOutline(false)
              setProjectId('new')
            }}
          />
        ) : projectId ? (
          <Workspace
            projectId={projectId}
            onBack={() => setProjectId(null)}
            activeTab={activeTab}
            onTabChange={setActiveTab}
            selectedPointId={selectedPointId}
            onSelectPoint={setSelectedPointId}
            knowledgeMap={knowledgeMap}
          />
        ) : (
          <HomeView
            onOpenProject={setProjectId}
            onNewProject={() => setWizardOpen(true)}
          />
        )}
      </div>

      {wizardOpen && (
        <Wizard
          onClose={() => setWizardOpen(false)}
          onComplete={() => {
            setWizardOpen(false)
            setBuildingOutline(true)
          }}
        />
      )}
    </div>
  )
}
