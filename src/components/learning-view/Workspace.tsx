import { ChevronLeft } from 'lucide-react'
import { type ReactNode, useCallback, useState } from 'react'

import { useLanguage } from '../../contexts/language-context'
import type { Project as VaultProject } from '../../core/learning/types'

import { type CardMode, CardsView, cardModes } from './CardsView'
import type { CardGenerationWorkspace } from './cardsWorkspace'
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
  cardGeneration,
}: {
  project: VaultProject | null
  onBack: () => void
  activeTab: TabKey
  onTabChange: (t: TabKey) => void
  selectedPointId: string | null
  onSelectPoint: (id: string) => void
  knowledgeMap: ReactNode
  cardGeneration: CardGenerationWorkspace | null
}) {
  const { t } = useLanguage()
  const [cardMode, setCardMode] = useState<CardMode>('浏览')
  const [dueCardCount, setDueCardCount] = useState(0)
  const handleDueCardCountChange = useCallback(
    (count: number) => setDueCardCount(count),
    [],
  )
  const tabLabels: Record<TabKey, string> = {
    大纲: t('learning.tabs.outline', '大纲'),
    知识地图: t('learning.tabs.knowledgeMap', '知识地图'),
    卡片: t('learning.tabs.cards', '卡片'),
    习题: t('learning.tabs.exercises', '习题'),
  }
  const cardModeLabels: Record<CardMode, string> = {
    浏览: t('learning.common.browse', '浏览'),
    复习: t('learning.cards.review', '复习'),
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
        {activeTab === '卡片' && (
          <Segmented<CardMode>
            options={cardModes}
            value={cardMode}
            onChange={setCardMode}
            badges={{ 复习: dueCardCount }}
            getLabel={(mode) => cardModeLabels[mode]}
            className="yolo-learning-workspace-card-mode"
          />
        )}
        <div className="yolo-learning-workspace-header-spacer" />
        <Segmented
          options={tabs}
          value={activeTab}
          onChange={onTabChange}
          disabledOptions={['习题']}
          getLabel={(tab) => (
            <>
              {tabLabels[tab]}
              {tab === '习题' && (
                <span className="yolo-learning-workspace-coming-soon">
                  {t('learning.common.comingSoon', '即将推出')}
                </span>
              )}
            </>
          )}
        />
      </header>
      <main
        className={`yolo-learning-workspace-main ${activeTab === '大纲' ? 'is-outline yolo-learning-scrollbar-thin' : ''}`}
      >
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
        {activeTab === '卡片' && (
          <CardsView
            project={project}
            generation={cardGeneration}
            mode={cardMode}
            onModeChange={setCardMode}
            onDueCountChange={handleDueCardCountChange}
          />
        )}
        {activeTab === '习题' && <ExercisesView project={project} />}
      </main>
    </div>
  )
}
