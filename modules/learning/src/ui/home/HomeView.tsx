import * as Popover from '@radix-ui/react-popover'
import {
  ArrowRight,
  CheckCircle2,
  Clock,
  Import,
  PauseCircle,
  PlayCircle,
  Plus,
  RotateCcw,
  Sparkles,
  Trash2,
} from 'lucide-react'
import {
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import type {
  LearningProjectAction,
  LearningProjectStats,
} from '../../domain/stats/learningStats'
import type { LearningStatsSnapshot } from '../../domain/stats/learningStatsService'
import type { Project, ProjectStatus } from '../../domain/types'
import { Pill, ProgressBar, SelectMenu } from '../primitives'
import type { LearningTranslate } from '../wizard/Wizard'

type ProjectSort = 'recent' | 'created' | 'progress'
type Locale = 'en' | 'it' | 'zh'

export type HomeProjectActions = {
  setPaused: (project: Project, paused: boolean) => Promise<void>
  deleteProject: (
    project: Project,
  ) => Promise<'deleted' | 'deleted-state-failed'>
  confirmDelete: (project: Project, onConfirm: () => void) => void
  showNotice: (message: string) => void
  reportError?: (message: string, error: unknown) => void
}

export function HomeView({
  projects,
  statsSnapshot,
  locale,
  t,
  projectActions,
  onOpenProject,
  onStartReview,
  onNewProject,
  onImportAnki,
}: {
  projects: readonly Project[]
  statsSnapshot: LearningStatsSnapshot
  locale: Locale
  t: LearningTranslate
  projectActions: HomeProjectActions
  onOpenProject: (id: string) => void
  onStartReview: (id: string) => void
  onNewProject: () => void
  onImportAnki: () => void
}) {
  const [sortValue, setSortValue] = useState<ProjectSort>('recent')
  const [pendingProjectSlug, setPendingProjectSlug] = useState<string | null>(
    null,
  )
  const statsByProject = statsSnapshot.byProject
  const isPaused = (project: Project) =>
    statsByProject.get(project.id)?.paused ??
    statsSnapshot.pausedProjectIds.has(project.id)
  const activeProjects = useMemo(
    () =>
      projects
        .filter(
          (project) => statsByProject.has(project.id) && !isPaused(project),
        )
        .map((project, index) => ({ project, index }))
        .sort((left, right) => {
          const leftActive =
            statsByProject.get(left.project.id)?.lastActiveAt ?? 0
          const rightActive =
            statsByProject.get(right.project.id)?.lastActiveAt ?? 0
          return rightActive - leftActive || left.index - right.index
        })
        .map(({ project }) => project),
    [projects, statsByProject, statsSnapshot.pausedProjectIds],
  )
  const dueProjects = activeProjects.filter(
    (project) => (statsByProject.get(project.id)?.dueCards ?? 0) > 0,
  )
  const recentProject = activeProjects[0]
  const recentStats = recentProject
    ? statsByProject.get(recentProject.id)
    : undefined
  const totalDueCards = statsSnapshot.loading
    ? null
    : activeProjects.reduce(
        (total, project) =>
          total + (statsByProject.get(project.id)?.dueCards ?? 0),
        0,
      )
  const sortedProjects = useMemo(
    () =>
      projects
        .map((project, index) => ({ project, index }))
        .sort((left, right) => {
          const leftValue = resolveSortValue(
            sortValue,
            statsByProject.get(left.project.id),
          )
          const rightValue = resolveSortValue(
            sortValue,
            statsByProject.get(right.project.id),
          )
          return rightValue - leftValue || left.index - right.index
        })
        .map(({ project }) => project),
    [projects, sortValue, statsByProject],
  )

  const setPaused = async (project: Project, paused: boolean) => {
    setPendingProjectSlug(project.slug)
    try {
      await projectActions.setPaused(project, paused)
      projectActions.showNotice(
        paused
          ? t('learning.home.pauseSuccess', '学习计划已暂停')
          : t('learning.home.resumeSuccess', '学习计划已恢复'),
      )
    } catch (error) {
      projectActions.reportError?.(
        'Failed to update project pause state',
        error,
      )
      projectActions.showNotice(
        paused
          ? t('learning.home.pauseFailed', '暂停学习计划失败，请重试')
          : t('learning.home.resumeFailed', '恢复学习计划失败，请重试'),
      )
    } finally {
      setPendingProjectSlug(null)
    }
  }

  const deleteProject = async (project: Project) => {
    setPendingProjectSlug(project.slug)
    try {
      const outcome = await projectActions.deleteProject(project)
      projectActions.showNotice(
        outcome === 'deleted'
          ? t('learning.home.deleteSuccess', '学习计划已移入回收站')
          : t(
              'learning.home.deleteStateFailed',
              '学习计划已移入回收站，但复习数据未能一并移除',
            ),
      )
    } catch (error) {
      projectActions.reportError?.('Failed to delete project', error)
      projectActions.showNotice(
        t('learning.home.deleteFailed', '删除学习计划失败，��重试'),
      )
    } finally {
      setPendingProjectSlug(null)
    }
  }

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
            {formatText(
              t(
                'learning.home.summary',
                '你有 {projects} 个学习项目，今日有 {due} 张卡片待复习。',
              ),
              { projects: projects.length, due: totalDueCards ?? '—' },
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
                      ? formatAction(recentStats.nextAction, t)
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
                />
                <MiniStat
                  icon={<RotateCcw aria-hidden />}
                  value={recentStats.dueCards}
                  label={t('learning.home.cardsDue', '待复习卡片')}
                />
              </div>
            </div>
          ) : (
            <div className="yolo-learning-home-focus-empty">
              <span>
                {statsSnapshot.loading && projects.length > 0
                  ? t('learning.home.statsLoading', '正在更新学习数据')
                  : projects.length > 0
                    ? t(
                        'learning.home.statsUnavailableEmpty',
                        '暂时无法读取项目统计',
                      )
                    : t('learning.home.noProjects', '还没有学习计划')}
              </span>
              {projects.length === 0 && !statsSnapshot.loading && (
                <button type="button" onClick={onNewProject}>
                  {t('learning.home.createFirstPlan', '创建第一个学习计划')}
                </button>
              )}
            </div>
          )}
        </section>

        <section className="yolo-learning-home-due-card">
          <div className="yolo-learning-home-card-heading">
            <span className="yolo-learning-home-card-title">
              <RotateCcw size={17} aria-hidden />
              {t('learning.home.todayReview', '今日待复习')}
            </span>
            <Pill tone={totalDueCards ? 'warning' : 'neutral'}>
              {formatText(t('learning.home.items', '{count} 张'), {
                count: totalDueCards ?? '—',
              })}
            </Pill>
          </div>
          <div className="yolo-learning-home-due-list">
            {dueProjects.slice(0, 3).map((project) => (
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
                <Pill>{statsByProject.get(project.id)?.dueCards ?? 0}</Pill>
              </button>
            ))}
            {dueProjects.length === 0 && (
              <div className="yolo-learning-home-due-empty">
                {statsSnapshot.loading
                  ? t('learning.home.statsLoading', '正在更新学习数据')
                  : t('learning.home.reviewMetaEmpty', '暂无到期复习')}
              </div>
            )}
          </div>
          <div className="yolo-learning-home-due-footer">
            <button
              type="button"
              className="yolo-learning-home-start-review"
              disabled={statsSnapshot.loading || !dueProjects[0]}
              onClick={() => dueProjects[0] && onStartReview(dueProjects[0].id)}
            >
              {t('learning.home.startReview', '开始今日复习')}
            </button>
            {statsSnapshot.failedProjectIds.size > 0 && (
              <div className="yolo-learning-home-stats-error" role="status">
                {formatText(
                  t(
                    'learning.home.statsUnavailable',
                    '{count} 个项目统计不可用',
                  ),
                  { count: statsSnapshot.failedProjectIds.size },
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
            options={[
              {
                value: 'recent',
                label: t('learning.home.sortRecent', '按最近活跃'),
              },
              {
                value: 'created',
                label: t('learning.home.sortCreated', '按创建时间'),
              },
              {
                value: 'progress',
                label: t('learning.home.sortProgress', '按进度'),
              },
            ]}
            onChange={(value) => setSortValue(value as ProjectSort)}
          />
        </div>
        <div className="yolo-learning-home-project-grid">
          {sortedProjects.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              stats={statsByProject.get(project.id)}
              paused={isPaused(project)}
              pending={pendingProjectSlug === project.slug}
              locale={locale}
              t={t}
              onClick={() => onOpenProject(project.id)}
              onPause={() => void setPaused(project, true)}
              onResume={() => void setPaused(project, false)}
              onDelete={() =>
                projectActions.confirmDelete(
                  project,
                  () => void deleteProject(project),
                )
              }
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

function ProjectCard({
  project,
  stats,
  paused,
  pending,
  locale,
  t,
  onClick,
  onPause,
  onResume,
  onDelete,
}: {
  project: Project
  stats?: LearningProjectStats
  paused: boolean
  pending: boolean
  locale: Locale
  t: LearningTranslate
  onClick: () => void
  onPause: () => void
  onResume: () => void
  onDelete: () => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const cardRef = useRef<HTMLButtonElement>(null)
  const menuAnchorRef = useRef({
    getBoundingClientRect: () =>
      cardRef.current?.getBoundingClientRect() as DOMRect,
  })
  const pressTimerRef = useRef<number | null>(null)
  const pressStartRef = useRef<{ x: number; y: number } | null>(null)
  const suppressClickRef = useRef(false)
  const ownerWindow = () => cardRef.current?.ownerDocument.defaultView
  const clearPress = useCallback(() => {
    const ownerWin = ownerWindow()
    if (pressTimerRef.current !== null && ownerWin) {
      ownerWin.clearTimeout(pressTimerRef.current)
    }
    pressTimerRef.current = null
    pressStartRef.current = null
  }, [])
  const openMenuAt = (x: number, y: number) => {
    const ownerWin = ownerWindow()
    if (!ownerWin) return
    menuAnchorRef.current = {
      getBoundingClientRect: () => ownerWin.DOMRect.fromRect({ x, y }),
    }
    setMenuOpen(true)
  }
  useEffect(() => {
    const scroller = cardRef.current?.closest('.yolo-learning-page.is-home')
    scroller?.addEventListener('scroll', clearPress, { passive: true })
    return () => {
      clearPress()
      scroller?.removeEventListener('scroll', clearPress)
    }
  }, [clearPress])
  const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.pointerType !== 'touch' || !event.isPrimary || event.button !== 0)
      return
    clearPress()
    pressStartRef.current = { x: event.clientX, y: event.clientY }
    const ownerWin = event.currentTarget.ownerDocument.defaultView
    if (!ownerWin) return
    pressTimerRef.current = ownerWin.setTimeout(() => {
      const start = pressStartRef.current
      clearPress()
      if (!start) return
      suppressClickRef.current = true
      openMenuAt(start.x, start.y)
    }, 420)
  }
  const handleContextMenu = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    const rect = event.currentTarget.getBoundingClientRect()
    const keyboardTriggered = event.clientX === 0 && event.clientY === 0
    openMenuAt(
      keyboardTriggered ? rect.left + 16 : event.clientX,
      keyboardTriggered ? rect.top + 16 : event.clientY,
    )
  }
  const runAction = (action: () => void) => {
    setMenuOpen(false)
    action()
  }

  return (
    <Popover.Root open={menuOpen} onOpenChange={setMenuOpen}>
      <Popover.Anchor virtualRef={menuAnchorRef} />
      <button
        ref={cardRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={(event) => {
          if (suppressClickRef.current) {
            event.preventDefault()
            suppressClickRef.current = false
            return
          }
          onClick()
        }}
        onContextMenu={handleContextMenu}
        onPointerDown={handlePointerDown}
        onPointerMove={(event) => {
          const start = pressStartRef.current
          if (
            start &&
            (Math.abs(event.clientX - start.x) > 8 ||
              Math.abs(event.clientY - start.y) > 8)
          )
            clearPress()
        }}
        onPointerUp={clearPress}
        onPointerCancel={clearPress}
        className={`yolo-learning-home-project-card${paused ? ' is-paused' : ''}`}
      >
        <div className="yolo-learning-home-project-header">
          <div className="yolo-learning-home-project-identity">
            <h3>{project.topic}</h3>
            <p>{project.goal}</p>
          </div>
          <Pill tone={paused ? 'neutral' : 'primary'}>
            {paused
              ? t('learning.home.statusPaused', '已暂停')
              : projectStatusLabel(project.status, t)}
          </Pill>
        </div>
        <div className="yolo-learning-home-project-progress">
          <ProgressBar value={stats?.targetCardProgress ?? 0} />
          <span>{stats ? `${stats.targetCardProgress}%` : '—'}</span>
        </div>
        {stats?.nextAction && (
          <div className="yolo-learning-home-project-action">
            <span className="yolo-learning-home-project-action-label">
              {stats.nextAction.kind === 'review'
                ? t('learning.home.priorityReview', '优先复习')
                : t('learning.home.nextLearning', '下一步学习')}
            </span>
            <strong>{formatAction(stats.nextAction, t)}</strong>
          </div>
        )}
        <div className="yolo-learning-home-project-meta">
          <span>
            <CheckCircle2 aria-hidden />
            {stats ? `${stats.targetCards}/${stats.totalCards}` : '—'}
          </span>
          <span>
            <RotateCcw aria-hidden />
            {stats?.dueCards ?? '—'}
          </span>
          <span>
            <Clock aria-hidden />
            {stats ? formatRelativeTime(stats.lastActiveAt, locale) : '—'}
          </span>
        </div>
      </button>
      <Popover.Portal container={cardRef.current?.ownerDocument.body}>
        <Popover.Content
          sideOffset={4}
          align="start"
          collisionPadding={10}
          className="yolo-popover-surface yolo-popover-surface--default yolo-learning-project-menu"
          style={{ minWidth: 172, maxWidth: 232 }}
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          <div className="yolo-learning-project-menu-list" role="menu">
            <button
              type="button"
              role="menuitem"
              className="yolo-learning-project-menu-item"
              disabled={pending}
              onClick={() => runAction(paused ? onResume : onPause)}
            >
              {paused ? (
                <PlayCircle size={15} aria-hidden />
              ) : (
                <PauseCircle size={15} aria-hidden />
              )}
              <span>
                {paused
                  ? t('learning.home.resumeProject', '恢复学习')
                  : t('learning.home.pauseProject', '暂停学习')}
              </span>
            </button>
            <button
              type="button"
              role="menuitem"
              className="yolo-learning-project-menu-item is-danger"
              disabled={pending}
              onClick={() => runAction(onDelete)}
            >
              <Trash2 size={15} aria-hidden />
              <span>{t('learning.home.deleteProject', '删除')}</span>
            </button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

function MiniStat({
  icon,
  value,
  label,
}: {
  icon: React.ReactNode
  value: React.ReactNode
  label: string
}) {
  return (
    <div className="yolo-learning-home-mini-stat is-primary">
      <span className="yolo-learning-home-mini-stat-icon">{icon}</span>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  )
}

export function resolveSortValue(
  sort: ProjectSort,
  stats?: LearningProjectStats,
) {
  if (!stats) return Number.NEGATIVE_INFINITY
  if (sort === 'created') return stats.createdAt
  if (sort === 'progress') return stats.targetCardProgress
  return stats.lastActiveAt
}

function projectStatusLabel(status: ProjectStatus, t: LearningTranslate) {
  if (status === 'studying') return t('learning.home.statusStudying', '学习中')
  if (status === 'building') return t('learning.home.statusBuilding', '生成中')
  return t('learning.home.statusOutlining', '规划中')
}

function resolveGreeting(hour: number, t: LearningTranslate) {
  const greeting =
    hour < 12
      ? t('learning.home.greetingMorning', '早上好')
      : hour < 18
        ? t('learning.home.greetingAfternoon', '下午好')
        : t('learning.home.greetingEvening', '晚上好')
  return `${greeting}，${t('learning.home.greetingSuffix', '想要学些什么？')}`
}

function formatAction(action: LearningProjectAction, t: LearningTranslate) {
  const template =
    action.kind === 'review'
      ? t('learning.home.reviewKnowledgePoint', '复习「{point}」')
      : action.started
        ? t('learning.home.continueKnowledgePoint', '继续学习「{point}」')
        : t('learning.home.startKnowledgePoint', '开始学习「{point}」')
  return formatText(template, { point: action.knowledgePointTitle })
}

function formatText(template: string, values: Record<string, string | number>) {
  return template.replace(/\{([^}]+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key)
      ? String(values[key])
      : match,
  )
}

function formatRelativeTime(timestamp: number, locale: Locale) {
  if (timestamp <= 0) return '—'
  const intlLocale =
    locale === 'zh' ? 'zh-CN' : locale === 'it' ? 'it-IT' : 'en-US'
  const elapsed = Date.now() - timestamp
  const formatter = new Intl.RelativeTimeFormat(intlLocale, { numeric: 'auto' })
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
  return new Intl.DateTimeFormat(intlLocale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(timestamp)
}
