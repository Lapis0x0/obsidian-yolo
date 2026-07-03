import { ArrowRight, Clock, Plus } from 'lucide-react'

import { type Project, projects } from './mockLearningData'
import { Pill, ProgressBar, RingProgress, SelectMenu } from './primitives'

export function HomeView({
  onOpenProject,
  onNewProject,
}: {
  onOpenProject: (id: string) => void
  onNewProject: () => void
}) {
  const totalDueCards = projects.reduce(
    (sum, project) => sum + project.dueCards,
    0,
  )
  const totalDueExercises = projects.reduce(
    (sum, project) => sum + project.dueExercises,
    0,
  )

  return (
    <div className="yolo-learning-home">
      <header className="yolo-learning-home-header">
        <div>
          <h1 className="yolo-learning-home-title">学习中心</h1>
          <p className="yolo-learning-home-subtitle">
            今天是 2026 年 6 月 28 日，你已经连续学习 5 天
          </p>
        </div>
        <button
          type="button"
          onClick={onNewProject}
          className="yolo-learning-home-new-button"
        >
          <Plus size={16} />
          新建项目
        </button>
      </header>

      <section className="yolo-learning-home-review-card">
        <div className="yolo-learning-home-review-main">
          <div className="yolo-learning-home-review-summary">
            <div className="yolo-learning-home-review-title">今日待复习</div>
            <div className="yolo-learning-home-review-stats">
              <div>
                <div className="yolo-learning-home-review-number">
                  {totalDueCards}
                </div>
                <div className="yolo-learning-home-review-label">
                  张卡片到期
                </div>
              </div>
              <div>
                <div className="yolo-learning-home-review-number">
                  {totalDueExercises}
                </div>
                <div className="yolo-learning-home-review-label">
                  道题待练习
                </div>
              </div>
            </div>
          </div>
          <button type="button" className="yolo-learning-home-review-button">
            开始今日复习
            <ArrowRight size={16} />
          </button>
        </div>
        <div className="yolo-learning-home-review-meta">
          <Clock size={13} />跨 2 个项目 · 预计耗时 20 分钟
        </div>
      </section>

      <div className="yolo-learning-home-section-bar">
        <h2 className="yolo-learning-home-section-title">
          我的项目{' '}
          <span className="yolo-learning-home-section-count">
            ({projects.length})
          </span>
        </h2>
        <SelectMenu
          value="按最近活跃"
          options={['按最近活跃', '按创建时间', '按进度']}
        />
      </div>

      <div className="yolo-learning-home-project-grid">
        {projects.map((project) => (
          <ProjectCard
            key={project.id}
            project={project}
            onClick={() => onOpenProject(project.id)}
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
          <span className="yolo-learning-home-add-label">新建学习项目</span>
        </button>
      </div>
    </div>
  )
}

function ProjectCard({
  project,
  onClick,
}: {
  project: Project
  onClick: () => void
}) {
  const due = project.dueCards + project.dueExercises

  return (
    <button
      type="button"
      onClick={onClick}
      className="yolo-learning-home-project-card"
    >
      <div className="yolo-learning-home-project-header">
        <RingProgress
          value={project.progress}
          size={52}
          stroke={5}
          className="yolo-learning-home-project-ring"
        />
        <div className="yolo-learning-home-project-identity">
          <h3 className="yolo-learning-home-project-name">{project.name}</h3>
          <div className="yolo-learning-home-project-status">
            {due > 0 && <Pill tone="primary">今日 {due} 项待复习</Pill>}
            <span className="yolo-learning-home-project-last-studied">
              最近学习于 {project.lastStudied}
            </span>
          </div>
        </div>
      </div>

      <div className="yolo-learning-home-metrics">
        <MetricBar
          label="卡片"
          value={project.cardProgress}
          completed={project.completedCards}
          total={project.totalCards}
        />
        <MetricBar
          label="习题"
          value={project.exerciseProgress}
          completed={project.completedExercises}
          total={project.totalExercises}
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
