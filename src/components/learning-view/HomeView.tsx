import { ArrowRight, Clock, Plus } from 'lucide-react'

import { useLanguage } from '../../contexts/language-context'
import type { Project as VaultProject } from '../../core/learning/types'

import { formatLearningText } from './i18n'
import { Pill, ProgressBar, RingProgress, SelectMenu } from './primitives'

export function HomeView({
  projects,
  onOpenProject,
  onNewProject,
}: {
  projects: VaultProject[]
  onOpenProject: (id: string) => void
  onNewProject: () => void
}) {
  const { t } = useLanguage()
  const totalDueCards = 0
  const totalDueExercises = 0
  const sortValue = 'recent'
  const sortOptions = [
    { value: 'recent', label: t('learning.home.sortRecent', '按最近活跃') },
    { value: 'created', label: t('learning.home.sortCreated', '按创建时间') },
    { value: 'progress', label: t('learning.home.sortProgress', '按进度') },
  ]

  return (
    <div className="yolo-learning-home">
      <header className="yolo-learning-home-header">
        <div>
          <h1 className="yolo-learning-home-title">
            {t('learning.home.title', '学习中心')}
          </h1>
          <p className="yolo-learning-home-subtitle">
            {t(
              'learning.home.subtitle',
              '今天是 2026 年 6 月 28 日，你已经连续学习 5 天',
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={onNewProject}
          className="yolo-learning-home-new-button"
        >
          <Plus size={16} />
          {t('learning.home.newProject', '新建项目')}
        </button>
      </header>

      <section className="yolo-learning-home-review-card">
        <div className="yolo-learning-home-review-main">
          <div className="yolo-learning-home-review-summary">
            <div className="yolo-learning-home-review-title">
              {t('learning.home.todayReview', '今日待复习')}
            </div>
            <div className="yolo-learning-home-review-stats">
              <div>
                <div className="yolo-learning-home-review-number">
                  {totalDueCards}
                </div>
                <div className="yolo-learning-home-review-label">
                  {t('learning.home.dueCardsLabel', '张卡片到期')}
                </div>
              </div>
              <div>
                <div className="yolo-learning-home-review-number">
                  {totalDueExercises}
                </div>
                <div className="yolo-learning-home-review-label">
                  {t('learning.home.dueExercisesLabel', '道题待练习')}
                </div>
              </div>
            </div>
          </div>
          <button type="button" className="yolo-learning-home-review-button">
            {t('learning.home.startReview', '开始今日复习')}
            <ArrowRight size={16} />
          </button>
        </div>
        <div className="yolo-learning-home-review-meta">
          <Clock size={13} />
          {t('learning.home.reviewMetaEmpty', '暂无到期复习')}
        </div>
      </section>

      <div className="yolo-learning-home-section-bar">
        <h2 className="yolo-learning-home-section-title">
          {t('learning.home.myProjects', '我的项目')}{' '}
          <span className="yolo-learning-home-section-count">
            ({projects.length})
          </span>
        </h2>
        <SelectMenu value={sortValue} options={sortOptions} />
      </div>

      <div className="yolo-learning-home-project-grid">
        {projects.map((project) => (
          <ProjectCard
            key={project.id}
            project={project}
            onClick={() => onOpenProject(project.id)}
            t={t}
          />
        ))}
        <button
          type="button"
          onClick={onNewProject}
          className="yolo-learning-home-add-card"
        >
          <span className="yolo-learning-home-add-icon">
            <Plus size={18} />
          </span>
          <span className="yolo-learning-home-add-label">
            {t('learning.home.newLearningProject', '新建学习项目')}
          </span>
        </button>
      </div>
    </div>
  )
}

function ProjectCard({
  project,
  onClick,
  t,
}: {
  project: VaultProject
  onClick: () => void
  t: (keyPath: string, fallback?: string) => string
}) {
  const due = 0
  const totalCards = project.knowledgePoints.length

  return (
    <button
      type="button"
      onClick={onClick}
      className="yolo-learning-home-project-card"
    >
      <div className="yolo-learning-home-project-header">
        <RingProgress
          value={0}
          size={52}
          stroke={5}
          className="yolo-learning-home-project-ring"
        />
        <div className="yolo-learning-home-project-identity">
          <h3 className="yolo-learning-home-project-name">{project.topic}</h3>
          <div className="yolo-learning-home-project-status">
            {due > 0 && (
              <Pill tone="primary">
                {formatLearningText(
                  t('learning.home.projectDue', '今日 {count} 项待复习'),
                  { count: due },
                )}
              </Pill>
            )}
            <span className="yolo-learning-home-project-last-studied">
              {formatLearningText(
                t('learning.home.lastStudied', '最近学习于 {time}'),
                {
                  time: '—',
                },
              )}
            </span>
          </div>
        </div>
      </div>

      <div className="yolo-learning-home-metrics">
        <MetricBar
          label={t('learning.common.cards', '卡片')}
          value={0}
          completed={0}
          total={totalCards}
        />
        <MetricBar
          label={t('learning.common.exercises', '习题')}
          value={0}
          completed={0}
          total={0}
        />
      </div>
    </button>
  )
}

function MetricBar({
  label,
  value,
  completed,
  total,
}: {
  label: string
  value: number
  completed: number
  total: number
}) {
  return (
    <div className="yolo-learning-home-metric-row">
      <span className="yolo-learning-home-metric-label">{label}</span>
      <ProgressBar
        value={value}
        className="yolo-learning-home-metric-progress"
      />
      <span className="yolo-learning-home-metric-value">
        {completed}/{total}
      </span>
    </div>
  )
}
