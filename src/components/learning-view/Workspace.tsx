import { ChevronLeft } from 'lucide-react'
import type { ReactNode } from 'react'

import { useLanguage } from '../../contexts/language-context'
import type { Project as VaultProject } from '../../core/learning/types'

import { CardsView } from './CardsView'
import { ExercisesView } from './ExercisesView'
import { OutlineView } from './OutlineView'
import { Pill, Segmented } from './primitives'
import { type TabKey, tabs } from './tabs'

export function Workspace({
  project,
  onBack,
  activeTab,
  onTabChange,
  selectedPointId,
  onSelectPoint,
  knowledgeMap,
}: {
  project: VaultProject | null
  onBack: () => void
  activeTab: TabKey
  onTabChange: (t: TabKey) => void
  selectedPointId: string | null
  onSelectPoint: (id: string) => void
  knowledgeMap: ReactNode
}) {
  const { t } = useLanguage()
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
        <h1 className="yolo-learning-workspace-project-name">
          {project?.topic ??
            t('learning.workspace.missingProject', '未找到项目')}
        </h1>
        <Pill tone="primary" className="yolo-learning-workspace-progress-pill">
          {t('learning.workspace.learned', '已学')} 0%
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
        {activeTab === '大纲' &&
          (project ? (
            <OutlineView
              project={project}
              selectedPointId={selectedPointId}
              onSelectPoint={onSelectPoint}
            />
          ) : (
            <div className="yolo-learning-outline-empty">
              {t(
                'learning.workspace.projectNotFound',
                '项目不存在或尚未扫描完成',
              )}
            </div>
          ))}
        {activeTab === '知识地图' && knowledgeMap}
        {activeTab === '卡片' && <CardsView project={project} />}
        {activeTab === '习题' && <ExercisesView project={project} />}
      </main>
    </div>
  )
}
