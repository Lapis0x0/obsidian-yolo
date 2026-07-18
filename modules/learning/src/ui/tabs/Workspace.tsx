import { ChevronLeft } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useState } from 'react'

import type { Project } from '../../domain/types'
import {
  type CardMode,
  CardsView,
  type CardsViewServices,
  cardModes,
} from '../cards/CardsView'
import type { CardGenerationWorkspace } from '../cards/cardsWorkspace'
import {
  ExercisesView,
  type ExercisesViewServices,
} from '../exercises/ExercisesView'
import { OutlineView, type OutlineViewHost } from '../outline/OutlineView'
import { Pill } from '../primitives'

import { LearningTabs } from './LearningTabs'
import { type LearningTabKey, learningTabs } from './tabs'

export type WorkspaceText = (key: string, fallback?: string) => string

export type LearningWorkspaceTabServices = {
  outline: OutlineViewHost
  cards: CardsViewServices
  exercises: ExercisesViewServices
}

export function Workspace({
  project,
  onBack,
  activeTab,
  onTabChange,
  selectedPointId,
  onSelectPoint,
  knowledgeMap,
  cardGeneration,
  cardMode,
  onCardModeChange,
  projectPaused,
  services,
  ownerDocument,
  t,
}: {
  project: Project | null
  onBack: () => void
  activeTab: LearningTabKey
  onTabChange: (tab: LearningTabKey) => void
  selectedPointId: string | null
  onSelectPoint: (id: string) => void
  knowledgeMap: ReactNode
  cardGeneration: CardGenerationWorkspace | null
  cardMode: CardMode
  onCardModeChange: (mode: CardMode) => void
  projectPaused: boolean
  services: LearningWorkspaceTabServices
  ownerDocument: Document
  t: WorkspaceText
}) {
  const [studyCardCount, setStudyCardCount] = useState(0)
  const handleStudyCardCountChange = useCallback(
    (count: number) => setStudyCardCount(count),
    [],
  )
  const visibleTabs =
    project?.kind === 'cards' ? (['卡片'] as const) : learningTabs
  const tabLabels = {
    大纲: t('learning.tabs.outline', '大纲'),
    知识地图: t('learning.tabs.knowledgeMap', '知识地图'),
    卡片: t('learning.tabs.cards', '卡片'),
    习题: (
      <>
        {t('learning.tabs.exercises', '习题')}
        <span className="yolo-learning-workspace-coming-soon">
          {t('learning.common.comingSoon', '即将推出')}
        </span>
      </>
    ),
  }

  useEffect(() => {
    if (projectPaused && cardMode === '学习') onCardModeChange('浏览')
  }, [cardMode, onCardModeChange, projectPaused])

  return (
    <div className="yolo-learning-workspace-shell">
      <header className="yolo-learning-workspace-header">
        <button
          aria-label={t('learning.workspace.backToHome', '返回学习中心')}
          className="yolo-learning-workspace-back"
          onClick={onBack}
          type="button"
        >
          <ChevronLeft size={18} strokeWidth={2} />
        </button>
        <div className="yolo-learning-workspace-divider" />
        <h1 className="yolo-learning-workspace-project-name">
          {project?.topic ??
            t('learning.workspace.missingProject', '未找到项目')}
        </h1>
        <Pill
          className="yolo-learning-workspace-progress-pill"
          tone={projectPaused ? 'neutral' : 'primary'}
        >
          {projectPaused
            ? t('learning.home.statusPaused', '已暂停')
            : `${t('learning.workspace.learned', '已学')} 0%`}
        </Pill>
        {activeTab === '卡片' ? (
          <div className="yolo-learning-segmented yolo-learning-workspace-card-mode">
            {cardModes.map((mode) => {
              const active = cardMode === mode
              return (
                <button
                  className={`yolo-learning-segmented-option ${active ? 'is-active' : ''}`}
                  disabled={projectPaused && mode === '学习'}
                  key={mode}
                  onClick={() => onCardModeChange(mode)}
                  type="button"
                >
                  {mode === '学习'
                    ? t('learning.cards.study', '学习')
                    : t('learning.common.browse', '浏览')}
                  {mode === '学习' && studyCardCount ? (
                    <span
                      className={`yolo-learning-segmented-badge ${active ? 'is-active' : ''}`}
                    >
                      {studyCardCount}
                    </span>
                  ) : null}
                </button>
              )
            })}
          </div>
        ) : null}
        <div className="yolo-learning-workspace-header-spacer" />
        <LearningTabs
          disabledTabs={['习题']}
          labels={tabLabels}
          onChange={onTabChange}
          value={activeTab}
          visibleTabs={visibleTabs}
        />
      </header>
      <main
        className={`yolo-learning-workspace-main ${activeTab === '大纲' ? 'is-outline yolo-learning-scrollbar-thin' : ''}`}
      >
        {activeTab === '大纲' ? (
          project?.kind === 'outline' ? (
            <OutlineView
              host={services.outline}
              onSelectPoint={onSelectPoint}
              project={project}
              selectedPointId={selectedPointId}
              t={t}
            />
          ) : (
            <div className="yolo-learning-outline-empty">
              {t(
                'learning.workspace.projectNotFound',
                '项目不存在或尚未扫描完成',
              )}
            </div>
          )
        ) : null}
        {activeTab === '知识地图' && project?.kind === 'outline'
          ? knowledgeMap
          : null}
        {activeTab === '卡片' ? (
          <CardsView
            generation={cardGeneration}
            mode={cardMode}
            onModeChange={onCardModeChange}
            onStudyCountChange={handleStudyCardCountChange}
            ownerDocument={ownerDocument}
            project={project}
            projectPaused={projectPaused}
            services={services.cards}
            t={t}
          />
        ) : null}
        {activeTab === '习题' ? (
          <ExercisesView
            project={project}
            services={services.exercises}
            t={t}
          />
        ) : null}
      </main>
    </div>
  )
}
