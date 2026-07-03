import { ChevronLeft } from 'lucide-react'
import type { ReactNode } from 'react'

import { useLanguage } from '../../contexts/language-context'
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
  const { t } = useLanguage()
  const project = projects.find((p) => p.id === projectId) ?? projects[0]
  const tabLabels: Record<TabKey, string> = {
    大纲: t('learning.tabs.outline', '大纲'),
    知识地图: t('learning.tabs.knowledgeMap', '知识地图'),
    卡片: t('learning.tabs.cards', '卡片'),
    习题: t('learning.tabs.exercises', '习题'),
  }

  return (
    <div className="yolo-learning-workspace-shell">
      <header className="yolo-learning-workspace-header">
        <button
          type="button"
          onClick={onBack}
          aria-label={t('learning.workspace.backToHome', '返回学习中心')}
          className="yolo-learning-workspace-back"
        >
          <ChevronLeft size={18} strokeWidth={2} />
        </button>
        <div className="yolo-learning-workspace-divider" />
        <h1 className="yolo-learning-workspace-project-name">{project.name}</h1>
        <Pill tone="primary" className="yolo-learning-workspace-progress-pill">
          {t('learning.workspace.learned', '已学')} {project.progress}%
        </Pill>
        <div className="yolo-learning-workspace-header-spacer" />
        <Segmented
          options={tabs}
          value={activeTab}
          onChange={onTabChange}
          getLabel={(tab) => tabLabels[tab]}
        />
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
