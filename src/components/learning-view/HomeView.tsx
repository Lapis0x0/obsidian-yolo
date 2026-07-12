import {
  ArrowRight,
  CheckCircle2,
  Clock,
  Import,
  PlayCircle,
  Plus,
  RotateCcw,
  Sparkles,
  Target,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { useApp } from '../../contexts/app-context'
import { useLanguage } from '../../contexts/language-context'
import { usePlugin } from '../../contexts/plugin-context'
import {
  type LearningProjectAction,
  type LearningProjectStats,
  loadLearningProjectStats,
} from '../../core/learning/learningStats'
import type {
  ProjectStatus,
  Project as VaultProject,
} from '../../core/learning/types'

import { formatLearningText } from './i18n'
import { Pill, ProgressBar, SelectMenu } from './primitives'

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
  onImportAnki,
}: {
  projects: VaultProject[]
  onOpenProject: (id: string) => void
  onStartReview: (id: string) => void
  onNewProject: () => void
  onImportAnki: () => void
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
  const recentlyActiveProjects = useMemo(
    () =>
      projects
        .filter((project) => statsByProject.has(project.id))
        .map((project, index) => ({ project, index }))
        .sort((left, right) => {
          const leftActive =
            statsByProject.get(left.project.id)?.lastActiveAt ?? 0
          const rightActive =
            statsByProject.get(right.project.id)?.lastActiveAt ?? 0
          return rightActive - leftActive || left.index - right.index
        })
        .map(({ project }) => project),
    [projects, statsByProject],
  )
  const recentProject = recentlyActiveProjects[0]
  const recentStats = recentProject
    ? statsByProject.get(recentProject.id)
    : undefined
  const dueProjects = recentlyActiveProjects.filter(
    (project) => (statsByProject.get(project.id)?.dueCards ?? 0) > 0,
  )
  const firstDueProject = dueProjects[0]
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
        <div className="yolo-learning-home-heading">
          <div className="yolo-learning-home-greeting">
            <Sparkles size={16} aria-hidden />
            {resolveGreeting(new Date().getHours(), t)}
          </div>
          <h1 className="yolo-learning-home-title">
            {t('learning.home.title', '学习中心')}
          </h1>
          <p className="yolo-learning-home-subtitle">
            {formatLearningText(
              t(
                'learning.home.summary',
                '你有 {projects} 个学习项目，今日有 {due} 张卡片待复习。',
              ),
              {
                projects: projects.length,
                due: totalDueCards ?? '—',
              },
            )}
          </p>
        </div>
        <div className="yolo-learning-home-create-actions">
          <button
            type="button"
            onClick={onImportAnki}
            className="yolo-learning-home-import-button"
            title={t('learning.anki.entry', '从 Anki 导入')}
            aria-label={t('learning.anki.entry', '从 Anki 导入')}
          >
            <Import size={16} aria-hidden />
          </button>
          <button
            type="button"
            onClick={onNewProject}
            className="yolo-learning-home-new-button"
          >
            <Plus size={16} aria-hidden />
            {t('learning.home.createPlan', '创建学习计划')}
          </button>
        </div>
      </header>

      <div className="yolo-learning-home-focus-grid">
        <section className="yolo-learning-home-focus-card">
          <div className="yolo-learning-home-card-heading">
            <span className="yolo-learning-home-card-title">
              <PlayCircle size={17} aria-hidden />
              {t('learning.home.continueLearning', '继续学习')}
            </span>
            {recentProject && (
              <Pill tone="primary" className="yolo-learning-home-status-pill">
                {projectStatusLabel(recentProject.status, t)}
              </Pill>
            )}
          </div>

          {recentProject && recentStats ? (
            <div className="yolo-learning-home-focus-body">
              <div className="yolo-learning-home-focus-project">
                <div className="yolo-learning-home-focus-identity">
                  <h2>{recentProject.topic}</h2>
                  <p>{recentProject.goal}</p>
                </div>
              </div>

              <div className="yolo-learning-home-focus-progress">
                <ProgressBar value={recentStats.targetCardProgress} />
                <span>{recentStats.targetCardProgress}%</span>
              </div>

              <div className="yolo-learning-home-focus-action">
                <div className="yolo-learning-home-focus-action-copy">
                  <span>{t('learning.home.todayPlan', '今日安排')}</span>
                  <strong>
                    {recentStats.nextAction
                      ? formatProjectActionTitle(recentStats.nextAction, t)
                      : t('learning.home.openProject', '打开项目继续学习')}
                  </strong>
                </div>
                <button
                  type="button"
                  className="yolo-learning-home-continue-button"
                  onClick={() =>
                    recentStats.dueCards > 0
                      ? onStartReview(recentProject.id)
                      : onOpenProject(recentProject.id)
                  }
                >
                  {t('learning.home.continue', '继续')}
                  <ArrowRight size={16} aria-hidden />
                </button>
              </div>

              <div className="yolo-learning-home-mini-stats">
                <MiniStat
                  icon={<CheckCircle2 aria-hidden />}
                  value={`${recentStats.targetCards}/${recentStats.totalCards}`}
                  label={t('learning.home.targetCards', '达标卡片')}
                  tone="success"
                />
                <MiniStat
                  icon={<Target aria-hidden />}
                  value={`${recentStats.estimatedRetention}%`}
                  label={t('learning.home.retention30Days', '30 天预计保持率')}
                  tone="warning"
                />
                <MiniStat
                  icon={<RotateCcw aria-hidden />}
                  value={recentStats.dueCards}
                  label={t('learning.home.cardsDue', '待复习卡片')}
                  tone="primary"
                />
              </div>
            </div>
          ) : (
            <FocusEmpty
              loading={statsState.loading && projects.length > 0}
              hasProjects={projects.length > 0}
              onNewProject={onNewProject}
              t={t}
            />
          )}
        </section>

        <section className="yolo-learning-home-due-card">
          <div className="yolo-learning-home-card-heading">
            <span className="yolo-learning-home-card-title">
              <RotateCcw size={17} aria-hidden />
              {t('learning.home.todayReview', '今日待复习')}
            </span>
            <Pill
              tone={totalDueCards && totalDueCards > 0 ? 'warning' : 'neutral'}
              className="yolo-learning-home-due-count"
            >
              {formatLearningText(t('learning.home.items', '{count} 张'), {
                count: totalDueCards ?? '—',
              })}
            </Pill>
          </div>

          <div className="yolo-learning-home-due-list">
            {dueProjects.slice(0, 3).map((project) => {
              const stats = statsByProject.get(project.id)
              if (!stats) return null
              return (
                <button
                  type="button"
                  key={project.id}
                  className="yolo-learning-home-due-row"
                  onClick={() => onStartReview(project.id)}
                >
                  <span className="yolo-learning-home-due-project">
                    <strong>{project.topic}</strong>
                    <span>{project.goal}</span>
                  </span>
                  <Pill tone="neutral">{stats.dueCards}</Pill>
                </button>
              )
            })}
            {dueProjects.length === 0 && (
              <div className="yolo-learning-home-due-empty">
                {statsState.loading
                  ? t('learning.home.statsLoading', '正在更新学习数据')
                  : t('learning.home.reviewMetaEmpty', '暂无到期复习')}
              </div>
            )}
          </div>

          <div className="yolo-learning-home-due-footer">
            <button
              type="button"
              className="yolo-learning-home-start-review"
              disabled={statsState.loading || !firstDueProject}
              onClick={() => {
                if (firstDueProject) onStartReview(firstDueProject.id)
              }}
            >
              {t('learning.home.startReview', '开始今日复习')}
            </button>
            {statsState.failedProjectIds.size > 0 && (
              <div className="yolo-learning-home-stats-error">
                {formatLearningText(
                  t(
                    'learning.home.statsUnavailable',
                    '{count} 个项目统计不可用',
                  ),
                  { count: statsState.failedProjectIds.size },
                )}
              </div>
            )}
          </div>
        </section>
      </div>

      <section className="yolo-learning-home-projects">
        <div className="yolo-learning-home-section-bar">
          <h2 className="yolo-learning-home-section-title">
            {t('learning.home.learningPlans', '学习计划')}{' '}
            <span>({projects.length})</span>
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
              <Plus size={20} aria-hidden />
            </span>
            <span className="yolo-learning-home-add-copy">
              <strong>
                {t('learning.home.newLearningProject', '创建新的学习计划')}
              </strong>
              <span>
                {t(
                  'learning.home.newProjectHint',
                  '告诉 YOLO 你想学什么，自动生成大纲',
                )}
              </span>
            </span>
          </button>
        </div>
      </section>
    </div>
  )
}

function MiniStat({
  icon,
  value,
  label,
  tone,
}: {
  icon: React.ReactNode
  value: React.ReactNode
  label: string
  tone: 'primary' | 'success' | 'warning'
}) {
  return (
    <div className={`yolo-learning-home-mini-stat is-${tone}`}>
      <span className="yolo-learning-home-mini-stat-icon">{icon}</span>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  )
}

function FocusEmpty({
  loading,
  hasProjects,
  onNewProject,
  t,
}: {
  loading: boolean
  hasProjects: boolean
  onNewProject: () => void
  t: (keyPath: string, fallback?: string) => string
}) {
  return (
    <div className="yolo-learning-home-focus-empty">
      <span>
        {loading
          ? t('learning.home.statsLoading', '正在更新学习数据')
          : hasProjects
            ? t('learning.home.statsUnavailableEmpty', '暂时无法读取项目统计')
            : t('learning.home.noProjects', '还没有学习计划')}
      </span>
      {!hasProjects && !loading && (
        <button type="button" onClick={onNewProject}>
          {t('learning.home.createFirstPlan', '创建第一个学习计划')}
        </button>
      )}
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
  return (
    <button
      type="button"
      onClick={onClick}
      className="yolo-learning-home-project-card"
    >
      <div className="yolo-learning-home-project-header">
        <div className="yolo-learning-home-project-identity">
          <h3>{project.topic}</h3>
          <p>{project.goal}</p>
        </div>
        <Pill tone="primary">{projectStatusLabel(project.status, t)}</Pill>
      </div>

      <div className="yolo-learning-home-project-progress">
        <ProgressBar value={stats?.targetCardProgress ?? 0} />
        <span>{stats ? `${stats.targetCardProgress}%` : '—'}</span>
      </div>

      {stats?.nextAction && <ProjectAction action={stats.nextAction} t={t} />}

      <div className="yolo-learning-home-project-meta">
        <span>
          <CheckCircle2 aria-hidden />
          {stats
            ? formatLearningText(
                t('learning.home.targetCount', '达标 {completed}/{total}'),
                {
                  completed: stats.targetCards,
                  total: stats.totalCards,
                },
              )
            : '—'}
        </span>
        <span>
          <RotateCcw aria-hidden />
          {stats
            ? formatLearningText(
                t('learning.home.dueCount', '待复习 {count}'),
                { count: stats.dueCards },
              )
            : '—'}
        </span>
        <span>
          <Clock aria-hidden />
          {stats
            ? formatRelativeTime(stats.lastActiveAt, language)
            : t('learning.home.statsLoadingShort', '更新中')}
        </span>
      </div>
    </button>
  )
}

function ProjectAction({
  action,
  t,
}: {
  action: LearningProjectAction
  t: (keyPath: string, fallback?: string) => string
}) {
  return (
    <div className="yolo-learning-home-project-action">
      <span className="yolo-learning-home-project-action-label">
        {action.kind === 'review'
          ? t('learning.home.priorityReview', '优先复习')
          : t('learning.home.nextLearning', '下一步学习')}
      </span>
      <strong>{formatProjectActionTitle(action, t)}</strong>
    </div>
  )
}

function resolveSortValue(
  sort: ProjectSort,
  stats: LearningProjectStats | undefined,
) {
  if (!stats) return Number.NEGATIVE_INFINITY
  if (sort === 'created') return stats.createdAt
  if (sort === 'progress') return stats.targetCardProgress
  return stats.lastActiveAt
}

function resolveGreeting(
  hour: number,
  t: (keyPath: string, fallback?: string) => string,
) {
  const suffix = t('learning.home.greetingSuffix', '想要学些什么？')
  const greeting =
    hour < 12
      ? t('learning.home.greetingMorning', '早上好')
      : hour < 18
        ? t('learning.home.greetingAfternoon', '下午好')
        : t('learning.home.greetingEvening', '晚上好')
  return `${greeting}，${suffix}`
}

function projectStatusLabel(
  status: ProjectStatus,
  t: (keyPath: string, fallback?: string) => string,
) {
  if (status === 'studying') return t('learning.home.statusStudying', '学习中')
  if (status === 'building') return t('learning.home.statusBuilding', '生成中')
  return t('learning.home.statusOutlining', '规划中')
}

function formatProjectActionTitle(
  action: LearningProjectAction,
  t: (keyPath: string, fallback?: string) => string,
) {
  const template =
    action.kind === 'review'
      ? t('learning.home.reviewKnowledgePoint', '复习「{point}」')
      : action.started
        ? t('learning.home.continueKnowledgePoint', '继续学习「{point}」')
        : t('learning.home.startKnowledgePoint', '开始学习「{point}」')
  return formatLearningText(template, { point: action.knowledgePointTitle })
}

function formatRelativeTime(timestamp: number, language: 'en' | 'it' | 'zh') {
  if (timestamp <= 0) return '—'
  const locale =
    language === 'zh' ? 'zh-CN' : language === 'it' ? 'it-IT' : 'en-US'
  const elapsed = Date.now() - timestamp
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour

  if (elapsed < minute) return formatter.format(0, 'minute')
  if (elapsed < hour)
    return formatter.format(-Math.floor(elapsed / minute), 'minute')
  if (elapsed < day)
    return formatter.format(-Math.floor(elapsed / hour), 'hour')
  if (elapsed < 7 * day)
    return formatter.format(-Math.floor(elapsed / day), 'day')
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(timestamp)
}
