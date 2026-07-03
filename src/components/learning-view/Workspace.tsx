import { ChevronLeft } from 'lucide-react'
import type { ReactNode } from 'react'

import { CardsView } from './CardsView'
import { ExercisesView } from './ExercisesView'
import { type TabKey, projects, tabs } from './mockLearningData'
import { OutlineView } from './OutlineView'
import { Pill, Segmented } from './primitives'

export function Workspace({
  projectId,
  onBack,
  activeTab,
  onTabChange,
  selectedPointId,
  onSelectPoint,
  knowledgeMap,
}: {
  projectId: string
  onBack: () => void
  activeTab: TabKey
  onTabChange: (t: TabKey) => void
  selectedPointId: string | null
  onSelectPoint: (id: string) => void
  knowledgeMap: ReactNode
}) {
  const project = projects.find((p) => p.id === projectId) ?? projects[0]

  return (
    <div className="yolo-learning-workspace-shell">
      <header className="yolo-learning-workspace-header">
        <button
          type="button"
          onClick={onBack}
          aria-label="返回学习中心"
          className="yolo-learning-workspace-back"
        >
          <ChevronLeft size={18} />
        </button>
        <div className="yolo-learning-workspace-divider" />
        <h1 className="yolo-learning-workspace-project-name">{project.name}</h1>
        <Pill tone="primary" className="yolo-learning-workspace-progress-pill">
          已学 {project.progress}%
        </Pill>
        <div className="yolo-learning-workspace-header-spacer" />
        <Segmented options={tabs} value={activeTab} onChange={onTabChange} />
      </header>
      <main className="yolo-learning-workspace-main">
        {activeTab === '大纲' && (
          <OutlineView
            selectedPointId={selectedPointId}
            onSelectPoint={onSelectPoint}
          />
        )}
        {activeTab === '知识地图' && knowledgeMap}
        {activeTab === '卡片' && (
          <CardsView selectedPointId={selectedPointId} />
        )}
        {activeTab === '习题' && (
          <ExercisesView selectedPointId={selectedPointId} />
        )}
      </main>
    </div>
  )
}
