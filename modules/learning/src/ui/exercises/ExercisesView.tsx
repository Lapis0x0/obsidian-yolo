import cx from 'clsx'
import { ArrowRight, Check, RotateCcw, X } from 'lucide-react'
import { createContext, useContext, useEffect, useMemo, useState } from 'react'

import type { LearningVaultReadApi } from '../../domain/learningVaultReadApi'
import { normalizeLearningVaultPath } from '../../domain/learningVaultReadApi'
import { scanMarkdownEntries } from '../../domain/markdownScanner'
import type { Project as VaultProject } from '../../domain/types'

import { formatLearningText } from './formatLearningText'
import { Pill, Segmented, SelectMenu } from './primitives'

export type Exercise = {
  id: string
  pointId: string | null
  pointTitle: string
  chapterId: string
  chapterTitle: string
  question: string
  practiced: boolean
}

type PracticeScope = { kind: 'global' } | { kind: 'chapter'; chapterId: string }

export type ExercisesViewServices = {
  vault: Pick<LearningVaultReadApi, 'getEntry' | 'readText'>
}
export type ExerciseText = (keyPath: string, fallback?: string) => string

type ExercisesUiContextValue = {
  services: ExercisesViewServices
  t: ExerciseText
}
const ExercisesUiContext = createContext<ExercisesUiContextValue | null>(null)

function useExercisesUi(): ExercisesUiContextValue {
  const value = useContext(ExercisesUiContext)
  if (!value) throw new Error('ExercisesView requires services and t')
  return value
}

export function ExercisesView({
  project,
  services,
  t,
}: {
  project: VaultProject | null
  services: ExercisesViewServices
  t: ExerciseText
}) {
  return (
    <ExercisesUiContext.Provider value={{ services, t }}>
      <ExercisesViewContent project={project} />
    </ExercisesUiContext.Provider>
  )
}

function ExercisesViewContent({ project }: { project: VaultProject | null }) {
  const { t } = useExercisesUi()
  const { exercises, loading } = useProjectExercises(project)
  const practiceCount = exercises.filter(
    (exercise) => !exercise.practiced,
  ).length
  const [mode, setMode] = useState<'浏览' | '练习'>('浏览')
  const [practiceScope, setPracticeScope] = useState<PracticeScope>({
    kind: 'global',
  })

  const enterPractice = (scope: PracticeScope = { kind: 'global' }) => {
    setPracticeScope(scope)
    setMode('练习')
  }
  const modeLabels: Record<'浏览' | '练习', string> = {
    浏览: t('learning.common.browse', '浏览'),
    练习: t('learning.exercises.practice', '练习'),
  }

  return (
    <div className="yolo-learning-exercises">
      <div className="yolo-learning-exercises-modebar">
        <Segmented
          options={['浏览', '练习'] as const}
          value={mode}
          onChange={(nextMode) => {
            setMode(nextMode)
            if (nextMode === '练习') setPracticeScope({ kind: 'global' })
          }}
          badges={practiceCount > 0 ? { 练习: practiceCount } : undefined}
          getLabel={(option) => modeLabels[option]}
        />
      </div>

      {mode === '浏览' ? (
        <BrowseMode
          project={project}
          exercises={exercises}
          loading={loading}
          onPracticeChapter={(chapterId) =>
            enterPractice({ kind: 'chapter', chapterId })
          }
        />
      ) : (
        <PracticeMode
          exercises={exercises}
          scope={practiceScope}
          onExit={() => {
            setMode('浏览')
            setPracticeScope({ kind: 'global' })
          }}
        />
      )}
    </div>
  )
}

function useProjectExercises(project: VaultProject | null) {
  const vault = useExercisesUi().services.vault
  const [exercises, setExercises] = useState<Exercise[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      if (!project) {
        setExercises([])
        setLoading(false)
        return
      }
      setLoading(true)
      const nextExercises = await loadProjectExercises(project, vault)
      if (!cancelled) {
        setExercises(nextExercises)
        setLoading(false)
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [project, vault])

  return { exercises, loading }
}

export async function loadProjectExercises(
  project: VaultProject,
  vault: ExercisesViewServices['vault'],
): Promise<Exercise[]> {
  const exercises: Exercise[] = []
  const pointByUuid = new Map(
    project.knowledgePoints.map((point) => [point.uuid, point]),
  )
  const chapterById = new Map(
    project.chapters.map((chapter) => [chapter.id, chapter]),
  )
  for (const chapter of project.chapters) {
    const filePath = normalizeLearningVaultPath(
      `${chapter.folderPath}/exercises.md`,
    )
    if (vault.getEntry(filePath)?.kind !== 'file') continue
    const entries = scanMarkdownEntries(await vault.readText(filePath)).filter(
      (entry) => entry.type === 'ex' && entry.uuid,
    )
    for (const entry of entries) {
      const point = entry.kpUuid ? pointByUuid.get(entry.kpUuid) : undefined
      const pointChapter = point ? chapterById.get(point.chapterId) : undefined
      exercises.push({
        id: entry.uuid,
        pointId: point?.id ?? null,
        pointTitle: point?.title ?? entry.title,
        chapterId: pointChapter?.id ?? chapter.id,
        chapterTitle: pointChapter?.title ?? chapter.title,
        question: entry.body || entry.title,
        practiced: false,
      })
    }
  }
  return exercises
}

function BrowseMode({
  project,
  exercises,
  loading,
  onPracticeChapter,
}: {
  project: VaultProject | null
  exercises: Exercise[]
  loading: boolean
  onPracticeChapter: (chapterId: string) => void
}) {
  const { t } = useExercisesUi()
  const [chapterFilter, setChapterFilter] = useState('全部章节')
  const [statusFilter, setStatusFilter] = useState('全部状态')

  const visibleChapters = useMemo(() => {
    return (project?.chapters ?? [])
      .filter(
        (chapter) =>
          chapterFilter === '全部章节' || chapter.title === chapterFilter,
      )
      .map((chapter) => ({
        ...chapter,
        exercises: exercises.filter((exercise) => {
          if (exercise.chapterId !== chapter.id) return false
          if (statusFilter === '已练习') return exercise.practiced
          if (statusFilter === '未练习') return !exercise.practiced
          return true
        }),
      }))
      .filter((chapter) => chapter.exercises.length > 0)
  }, [chapterFilter, exercises, project, statusFilter])

  return (
    <>
      <div className="yolo-learning-exercises-filters">
        <SelectMenu
          value={chapterFilter}
          options={[
            {
              value: '全部章节',
              label: t('learning.common.allChapters', '全部章节'),
            },
            ...(project?.chapters.map((chapter) => chapter.title) ?? []),
          ]}
          onChange={setChapterFilter}
        />
        <SelectMenu
          value={statusFilter}
          options={[
            {
              value: '全部状态',
              label: t('learning.exercises.allStatus', '全部状态'),
            },
            {
              value: '已练习',
              label: t('learning.exercises.practiced', '已练习'),
            },
            {
              value: '未练习',
              label: t('learning.exercises.unpracticed', '未练习'),
            },
          ]}
          onChange={setStatusFilter}
        />
      </div>

      <div className="yolo-learning-exercises-chapter-list">
        {loading ? (
          <p className="yolo-learning-exercises-empty">
            {t('learning.common.loading', '加载中…')}
          </p>
        ) : visibleChapters.length === 0 ? (
          <p className="yolo-learning-exercises-empty">
            {t(
              'learning.exercises.empty',
              '还没有习题，生成知识点后可在知识点上创建习题',
            )}
          </p>
        ) : (
          visibleChapters.map((chapter, index) => (
            <ChapterExerciseCard
              key={chapter.id}
              chapterIndex={index + 1}
              chapter={chapter}
              onPracticeChapter={() => onPracticeChapter(chapter.id)}
            />
          ))
        )}
      </div>
    </>
  )
}

function ChapterExerciseCard({
  chapter,
  chapterIndex,
  onPracticeChapter,
}: {
  chapter: { id: string; title: string; exercises: Exercise[] }
  chapterIndex: number
  onPracticeChapter: () => void
}) {
  const { t } = useExercisesUi()
  const practiced = chapter.exercises.filter(
    (exercise) => exercise.practiced,
  ).length
  const pending = chapter.exercises.length - practiced

  return (
    <article className="yolo-learning-exercise-chapter-card">
      <div className="yolo-learning-exercise-chapter-header">
        <div className="yolo-learning-exercise-chapter-title-wrap">
          <h3 className="yolo-learning-exercise-chapter-title">
            {formatLearningText(
              t('learning.exercises.chapterTitle', '第 {index} 章 · {title}'),
              {
                index: chapterIndex,
                title: chapter.title,
              },
            )}
          </h3>
          <p className="yolo-learning-exercise-chapter-meta">
            {formatLearningText(
              t('learning.exercises.practicedCount', '{done}/{total} 已练'),
              {
                done: practiced,
                total: chapter.exercises.length,
              },
            )}
            {pending > 0 && (
              <span className="yolo-learning-exercise-pending-text">
                {' · '}
                {formatLearningText(
                  t('learning.exercises.pendingCount', '{count} 待练'),
                  {
                    count: pending,
                  },
                )}
              </span>
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={onPracticeChapter}
          className="yolo-learning-exercise-primary-button yolo-learning-exercise-chapter-action"
        >
          {t('learning.exercises.practice', '练习')} <ArrowRight size={14} />
        </button>
      </div>

      <ul className="yolo-learning-exercise-point-list">
        {chapter.exercises.map((exercise) => (
          <li key={exercise.id} className="yolo-learning-exercise-point-row">
            <span className="yolo-learning-exercise-point-title">
              {exercise.pointTitle} · {exercise.question.split('\n')[0]}
            </span>
            <div className="yolo-learning-exercise-point-status">
              {exercise.practiced ? (
                <Pill tone="success">
                  <Check size={11} />{' '}
                  {t('learning.exercises.completed', '完成')}
                </Pill>
              ) : (
                <Pill tone="primary">
                  {t('learning.exercises.unpracticed', '未练习')}
                </Pill>
              )}
            </div>
          </li>
        ))}
      </ul>
    </article>
  )
}

function PracticeMode({
  exercises,
  scope,
  onExit,
}: {
  exercises: Exercise[]
  scope: PracticeScope
  onExit: () => void
}) {
  const { t } = useExercisesUi()
  const queue = useMemo(() => {
    if (scope.kind === 'chapter') {
      return exercises.filter(
        (exercise) => exercise.chapterId === scope.chapterId,
      )
    }
    return exercises
  }, [exercises, scope])
  const [index, setIndex] = useState(0)
  const [answer, setAnswer] = useState('')
  const exercise = queue[index]
  const done = index >= queue.length
  const progress = done ? 100 : ((index + 1) / queue.length) * 100

  useEffect(() => {
    setIndex(0)
    setAnswer('')
  }, [scope])

  if (queue.length === 0) {
    return (
      <div className="yolo-learning-exercise-complete">
        <p className="yolo-learning-exercise-complete-title">
          {t('learning.exercises.noPracticeExercises', '暂无习题可练习')}
        </p>
        <button
          type="button"
          onClick={onExit}
          className="yolo-learning-exercise-primary-button yolo-learning-exercise-complete-button"
        >
          {t('learning.cards.backToBrowse', '返回浏览')}
        </button>
      </div>
    )
  }

  if (done) {
    return (
      <div className="yolo-learning-exercise-complete">
        <p className="yolo-learning-exercise-complete-title">
          {t('learning.exercises.practiceDone', '本轮练习完成')}
        </p>
        <p className="yolo-learning-exercise-complete-meta">
          {formatLearningText(
            t('learning.exercises.practiceDoneCount', '共完成 {count} 道习题'),
            {
              count: queue.length,
            },
          )}
        </p>
        <button
          type="button"
          onClick={onExit}
          className="yolo-learning-exercise-primary-button yolo-learning-exercise-complete-button"
        >
          {t('learning.cards.backToBrowse', '返回浏览')}
        </button>
      </div>
    )
  }

  return (
    <div className="yolo-learning-exercise-practice">
      <div className="yolo-learning-exercise-practice-topbar">
        <span className="yolo-learning-exercise-practice-count">
          {index + 1}{' '}
          <span className="yolo-learning-exercise-practice-count-total">
            / {queue.length}
          </span>
        </span>
        <div className="yolo-learning-exercise-practice-progress">
          <div
            className="yolo-learning-exercise-practice-progress-fill"
            style={{ width: `${progress}%` }}
          />
        </div>
        <button
          type="button"
          onClick={onExit}
          className="yolo-learning-exercise-exit-button"
        >
          <X size={15} /> {t('learning.exercises.exit', '退出')}
        </button>
      </div>

      <div className="yolo-learning-exercise-practice-content is-visible">
        <div className="yolo-learning-exercise-card yolo-learning-exercise-question-card">
          <div className="yolo-learning-exercise-question-point">
            {exercise.chapterTitle} · {exercise.pointTitle}
          </div>
          <pre className="yolo-learning-exercise-question yolo-learning-exercise-question-large">
            {exercise.question}
          </pre>
        </div>

        <div className="yolo-learning-exercise-card yolo-learning-exercise-answer-card">
          <textarea
            rows={6}
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            className="yolo-learning-exercise-answer-input"
            placeholder={t(
              'learning.exercises.answerPlaceholder',
              '在这里输入你的答案…',
            )}
          />
          <div className="yolo-learning-exercise-answer-footer">
            <span>
              {formatLearningText(
                t('learning.exercises.answerChars', '已输入 {count} 字'),
                {
                  count: answer.length,
                },
              )}
            </span>
          </div>
        </div>
      </div>

      <div className="yolo-learning-exercise-practice-bottombar">
        <div className={cx('yolo-learning-exercise-actions')}>
          <button
            type="button"
            onClick={() => {
              setIndex((current) => current + 1)
              setAnswer('')
            }}
            className="yolo-learning-exercise-primary-button yolo-learning-exercise-submit-button"
          >
            {t('learning.exercises.nextQuestion', '下一题')}{' '}
            <ArrowRight size={15} />
          </button>
          <button
            type="button"
            onClick={() => setAnswer('')}
            className="yolo-learning-exercise-secondary-button"
          >
            <RotateCcw size={14} /> {t('learning.exercises.retry', '重做')}
          </button>
        </div>

        <div className="yolo-learning-exercise-shortcuts">
          {t('learning.exercises.mvpNoEvaluation', 'MVP 阶段暂不提供自动评估')}
        </div>
      </div>
    </div>
  )
}
