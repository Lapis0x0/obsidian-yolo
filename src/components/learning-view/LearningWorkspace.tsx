import { useEffect, useMemo, useState } from 'react'

import { DEFAULT_LEARNING_BASE_DIR } from '../../constants'
import { useApp } from '../../contexts/app-context'
import { usePlugin } from '../../contexts/plugin-context'
import { ProjectEventBus } from '../../core/learning/projectEventBus'
import { scanProjects } from '../../core/learning/projectScanner'
import type { Project } from '../../core/learning/types'

import { KnowledgeGraph } from './KnowledgeGraph'

/**
 * LearningWorkspace
 * ─────────────────
 * The single React entry rendered inside LearningView. In this MVP scaffold
 * it does the bare minimum to put the KnowledgeGraph on screen:
 *   1. Resolves the configured learning base dir (settings or default).
 *   2. Scans the vault once for projects; picks the first one (or none).
 *   3. Owns a ProjectEventBus, wires it to the active project, and feeds
 *      the graph component.
 *
 * Project switching / creation UI is intentionally out of scope here — that
 * comes in a later iteration. For now, "open the demo project" is the only
 * path. The bus is exposed to the plugin via window for the mock replay
 * command to drive directly.
 */
export function LearningWorkspace() {
  const app = useApp()
  const plugin = usePlugin()
  // baseDir is hard-wired to the default for the MVP scaffold. When real
  // settings UI lands, source it from settings.learning.baseDir instead.
  const baseDir = DEFAULT_LEARNING_BASE_DIR

  const [projects, setProjects] = useState<Project[]>([])
  const [activeProjectPath, setActiveProjectPath] = useState<string | null>(
    null,
  )

  const bus = useMemo(() => new ProjectEventBus(app), [app])

  // Register the bus with the plugin so mock-replay commands can drive it.
  useEffect(() => {
    plugin.setLearningEventBus(bus)
    return () => {
      plugin.setLearningEventBus(null)
    }
  }, [bus, plugin])

  // Initial scan + watcher lifecycle.
  useEffect(() => {
    let cancelled = false
    const run = async () => {
      const { projects: scanned } = await scanProjects(app, baseDir)
      if (cancelled) return
      setProjects(scanned)
      const firstPath = scanned[0]?.folderPath ?? null
      setActiveProjectPath(firstPath)
      await bus.setActiveProject(baseDir, firstPath)
      bus.startWatchingVault()
    }
    void run()
    return () => {
      cancelled = true
      bus.stopWatchingVault()
    }
  }, [app, bus, baseDir])

  // Cleanup bus when workspace unmounts.
  useEffect(() => {
    return () => {
      bus.dispose()
    }
  }, [bus])

  const initialSnapshot = bus.getSnapshot()

  return (
    <div className="yolo-learning-workspace">
      <div className="yolo-learning-workspace-toolbar">
        <span className="yolo-learning-workspace-title">学习模式</span>
        <span className="yolo-learning-workspace-subtitle">
          {activeProjectPath
            ? `项目：${activeProjectPath}`
            : `未找到项目（目录：${baseDir}）`}
        </span>
      </div>
      <div className="yolo-learning-workspace-body">
        <KnowledgeGraph eventBus={bus} initialSnapshot={initialSnapshot} />
      </div>
      {projects.length > 1 ? (
        <div className="yolo-learning-workspace-projects">
          <span className="yolo-learning-workspace-projects-label">
            其他项目（暂未实现切换 UI）：
          </span>
          {projects
            .filter((p) => p.folderPath !== activeProjectPath)
            .map((p) => (
              <span
                key={p.folderPath}
                className="yolo-learning-workspace-project-chip"
              >
                {p.topic}
              </span>
            ))}
        </div>
      ) : null}
    </div>
  )
}
