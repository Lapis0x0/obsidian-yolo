import { ArrowRight, Clock, Plus } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { useApp } from '../../contexts/app-context'
import { useLanguage } from '../../contexts/language-context'
import { usePlugin } from '../../contexts/plugin-context'
import {
  type LearningProjectStats,
  loadLearningProjectStats,
} from '../../core/learning/learningStats'
import type { Project as VaultProject } from '../../core/learning/types'

import { formatLearningText } from './i18n'
import { Pill, ProgressBar, RingProgress, SelectMenu } from './primitives'

type ProjectSort = 'recent' | 'created' | 'progress'
type StatsLoadState = {
  byProject: Map<string, LearningProjectStats>
  failedProjectIds: Set<string>
  loading: boolean
}

export function HomeView({
  projects,
  onOpenProject,
  onStartReview,
  onNewProject,
}: {
  projects: VaultProject[]
  onOpenProject: (id: string) => void
  onStartReview: (id: string) => void
  onNewProject: () => void
}) {
  const app = useApp()
  const plugin = usePlugin()
  const { language, t } = useLanguage()
  const [sortValue, setSortValue] = useState<ProjectSort>('recent')
  const [statsState, setStatsState] = useState<StatsLoadState>(() => ({
    byProject: new Map(),
    failedProjectIds: new Set(),
    loading: true,
  }))
  const [refreshToken, setRefreshToken] = useState(0)
  const loadGenerationRef = useRef(0)
  const sortOptions = [
    { value: 'recent', label: t('learning.home.sortRecent', '按最近活跃') },
    { value: 'created', label: t('learning.home.sortCreated', '按创建时间') },
    { value: 'progress', label: t('learning.home.sortProgress', '按进度') },
  ]
  const statsByProject = statsState.byProject
  const statsReady = !statsState.loading
  const statsComplete = statsReady && statsState.failedProjectIds.size === 0
  const totalDueCards = statsComplete
    ? projects.reduce(
        (total, project) =>
          total + (statsByProject.get(project.id)?.dueCards ?? 0),
        0,
      )
    : null
  const dueProjectCount = statsComplete
    ? projects.filter(
        (project) => (statsByProject.get(project.id)?.dueCards ?? 0) > 0,
      ).length
    : 0
  const sortedProjects = useMemo(() => {
    return projects
      .map((project, index) => ({ project, index }))
      .sort((left, right) => {
        const leftStats = statsByProject.get(left.project.id)
        const rightStats = statsByProject.get(right.project.id)
        const leftValue = resolveSortValue(sortValue, leftStats)
        const rightValue = resolveSortValue(sortValue, rightStats)
        return rightValue - leftValue || left.index - right.index
      })
      .map(({ project }) => project)
  }, [projects, sortValue, statsByProject])
  const firstDueProject = statsReady
    ? sortedProjects.find(
        (project) => (statsByProject.get(project.id)?.dueCards ?? 0) > 0,
      )
    : undefined

  useEffect(() => {
    const generation = loadGenerationRef.current + 1
    loadGenerationRef.current = generation
    const now = new Date()
    const srsStore = plugin.getLearningSrsStore()
    setStatsState((current) => ({
      ...current,
      failedProjectIds: new Set(),
      loading: true,
    }))

    void Promise.allSettled(
      projects.map(async (project) => ({
        projectId: project.id,
        stats: await loadLearningProjectStats({
          app,
          project,
          srsStore,
          now,
        }),
      })),
    ).then((results) => {
      if (loadGenerationRef.current !== generation) return
      const nextStats = new Map<string, LearningProjectStats>()
      const failedProjectIds = new Set<string>()
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          nextStats.set(result.value.projectId, result.value.stats)
        } else {
          failedProjectIds.add(projects[index].id)
        }
      })
      setStatsState({
        byProject: nextStats,
        failedProjectIds,
        loading: false,
      })
    })
  }, [app, plugin, projects, refreshToken])

  useEffect(() => {
    const refresh = () => setRefreshToken((value) => value + 1)
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') refresh()
    }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [])

  useEffect(() => {
    if (!statsReady) return
    const now = Date.now()
    const nextDueAt = projects.reduce<number | null>((next, project) => {
      const dueAt = statsByProject.get(project.id)?.nextDueAt ?? null
      if (dueAt === null || dueAt <= now) return next
      return next === null || dueAt < next ? dueAt : next
    }, null)
    if (nextDueAt === null) return
    const timer = window.setTimeout(
      () => setRefreshToken((value) => value + 1),
      Math.min(Math.max(nextDueAt - now + 50, 1_000), 2_147_000_000),
    )
    return () => window.clearTimeout(timer)
  }, [projects, statsByProject, statsReady])

  return (
    <div className="yolo-learning-home">
      <header className="yolo-learning-home-header">
        <div>
          <h1 className="yolo-learning-home-title">
            {t('learning.home.title', '学习中心')}
          </h1>
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
                  {totalDueCards ?? '—'}
                </div>
                <div className="yolo-learning-home-review-label">
                  {t('learning.home.dueCardsLabel', '张卡片到期')}
                </div>
              </div>
            </div>
          </div>
          <button
            type="button"
            className="yolo-learning-home-review-button"
            disabled={statsState.loading || !firstDueProject}
            onClick={() => {
              if (firstDueProject) onStartReview(firstDueProject.id)
            }}
          >
            {t('learning.home.startReview', '开始今日复习')}
            <ArrowRight size={16} />
          </button>
        </div>
        <div
          className={`yolo-learning-home-review-meta ${statsState.failedProjectIds.size > 0 ? 'is-error' : ''}`}
        >
          <Clock size={13} />
          {statsState.loading
            ? t('learning.home.statsLoading', '正在更新学习数据')
            : statsState.failedProjectIds.size > 0
              ? formatLearningText(
                  t(
                    'learning.home.statsUnavailable',
                    '{count} 个项目统计不可用',
                  ),
                  { count: statsState.failedProjectIds.size },
                )
              : totalDueCards && totalDueCards > 0
                ? formatLearningText(
                    t('learning.home.reviewProjects', '来自 {count} 个项目'),
                    { count: dueProjectCount },
                  )
                : t('learning.home.reviewMetaEmpty', '暂无到期复习')}
        </div>
      </section>

      <div className="yolo-learning-home-section-bar">
        <h2 className="yolo-learning-home-section-title">
          {t('learning.home.myProjects', '我的项目')}{' '}
          <span className="yolo-learning-home-section-count">
            ({projects.length})
          </span>
        </h2>
        <SelectMenu
          value={sortValue}
          options={sortOptions}
          onChange={(value) => setSortValue(value as ProjectSort)}
        />
      </div>

      <div className="yolo-learning-home-project-grid">
        {sortedProjects.map((project) => (
          <ProjectCard
            key={project.id}
            project={project}
            onClick={() => onOpenProject(project.id)}
            stats={statsByProject.get(project.id)}
            language={language}
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
  stats,
  language,
  t,
}: {
  project: VaultProject
  onClick: () => void
  stats?: LearningProjectStats
  language: 'en' | 'it' | 'zh'
  t: (keyPath: string, fallback?: string) => string
}) {
  const lastStudied = !stats
    ? '—'
    : stats.lastStudiedAt === null
      ? t('learning.home.neverStudied', '尚未学习')
      : formatLearningText(
          t('learning.home.lastStudied', '最近学习于 {time}'),
          { time: formatStudiedAt(stats.lastStudiedAt, language) },
        )

  return (
    <button
      type="button"
      onClick={onClick}
      className="yolo-learning-home-project-card"
    >
      <div className="yolo-learning-home-project-header">
        <RingProgress
          value={stats?.memoryProgress ?? 0}
          label={stats ? undefined : '—'}
          size={52}
          stroke={5}
          className="yolo-learning-home-project-ring"
        />
        <div className="yolo-learning-home-project-identity">
          <h3 className="yolo-learning-home-project-name">{project.topic}</h3>
          <div className="yolo-learning-home-project-status">
            {stats && stats.dueCards > 0 && (
              <Pill tone="primary">
                {formatLearningText(
                  t('learning.home.projectDue', '今日 {count} 项待复习'),
                  { count: stats.dueCards },
                )}
              </Pill>
            )}
            <span className="yolo-learning-home-project-last-studied">
              {lastStudied}
            </span>
          </div>
        </div>
      </div>

      <div className="yolo-learning-home-metrics">
        <MetricBar
          label={t('learning.common.cards', '卡片')}
          value={stats?.targetCardProgress ?? 0}
          completed={stats?.targetCards}
          total={stats?.totalCards}
        />
        <MetricBar
          label={t('learning.common.exercises', '习题')}
          value={0}
          displayValue={t('learning.common.comingSoon', '即将推出')}
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
  displayValue,
}: {
  label: string
  value: number
  completed?: number
  total?: number
  displayValue?: string
}) {
  return (
    <div className="yolo-learning-home-metric-row">
      <span className="yolo-learning-home-metric-label">{label}</span>
      <ProgressBar
        value={value}
        className="yolo-learning-home-metric-progress"
      />
      <span className="yolo-learning-home-metric-value">
        {displayValue ??
          (completed === undefined || total === undefined
            ? '—'
            : `${completed}/${total}`)}
      </span>
    </div>
  )
}

function resolveSortValue(
  sort: ProjectSort,
  stats: LearningProjectStats | undefined,
) {
  if (!stats) return Number.NEGATIVE_INFINITY
  if (sort === 'created') return stats.createdAt
  if (sort === 'progress') return stats.memoryProgress
  return stats.lastActiveAt
}

function formatStudiedAt(timestamp: number, language: 'en' | 'it' | 'zh') {
  const locale =
    language === 'zh' ? 'zh-CN' : language === 'it' ? 'it-IT' : 'en-US'
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp)
}
