import cx from 'clsx'
import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  Loader2,
  RotateCcw,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import { useLanguage } from '../../contexts/language-context'
import { formatLearningText } from './i18n'
import { chapters, exercises } from './mockLearningData'
import type { Exercise } from './mockLearningData'
import { Pill, Segmented, SelectMenu } from './primitives'

function pointTitle(pointId: string) {
  for (const chapter of chapters) {
    const point = chapter.points.find((p) => p.id === pointId)
    if (point) return `${point.index} ${point.title}`
  }
  return ''
}

export function ExercisesView({
  selectedPointId,
}: {
  selectedPointId: string | null
}) {
  const { t } = useLanguage()
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
        {selectedPointId && mode === '浏览' && (
          <span className="yolo-learning-exercises-location">
            {t('learning.exercises.locatedTo', '定位至：')}
            <span className="yolo-learning-exercises-location-target">
              {pointTitle(selectedPointId)}
            </span>
          </span>
        )}
      </div>

      {mode === '浏览' ? (
        <BrowseMode
          selectedPointId={selectedPointId}
          onPracticeChapter={(chapterId) =>
            enterPractice({ kind: 'chapter', chapterId })
          }
        />
      ) : (
        <PracticeMode
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

type PracticeScope =
  | { kind: 'global' }
  | { kind: 'chapter'; chapterId: string }
  | { kind: 'point'; pointId: string }

function exercisesForPoint(pointId: string) {
  return exercises.filter((exercise) => exercise.pointId === pointId)
}

function exercisesForChapter(chapterId: string) {
  const chapter = chapters.find((item) => item.id === chapterId)
  if (!chapter) return []
  const result: Exercise[] = []
  for (const point of chapter.points) {
    for (const exercise of exercises) {
      if (exercise.pointId === point.id) result.push(exercise)
    }
  }
  return result
}

function chapterExerciseStats(chapterId: string) {
  const all = exercisesForChapter(chapterId)
  const practiced = all.filter((exercise) => exercise.practiced).length
  return { total: all.length, practiced, pending: all.length - practiced }
}

function BrowseMode({
  selectedPointId,
  onPracticeChapter,
}: {
  selectedPointId: string | null
  onPracticeChapter: (chapterId: string) => void
}) {
  const { t } = useLanguage()
  const [chapterFilter, setChapterFilter] = useState('全部章节')
  const [statusFilter, setStatusFilter] = useState('全部状态')

  useEffect(() => {
    if (!selectedPointId) return
    const element = document.getElementById(`exercise-point-${selectedPointId}`)
    element?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [selectedPointId])

  const visibleChapters = useMemo(() => {
    return chapters
      .filter(
        (chapter) =>
          chapterFilter === '全部章节' || chapter.title === chapterFilter,
      )
      .map((chapter) => ({
        ...chapter,
        points: chapter.points.filter((point) => {
          const pointExercises = exercisesForPoint(point.id)
          if (pointExercises.length === 0) return false
          if (statusFilter === '已练习') {
            return pointExercises.every((exercise) => exercise.practiced)
          }
          if (statusFilter === '未练习') {
            return pointExercises.some((exercise) => !exercise.practiced)
          }
          return true
        }),
      }))
      .filter((chapter) => chapter.points.length > 0)
  }, [chapterFilter, statusFilter])

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
            ...chapters.map((chapter) => chapter.title),
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
        {visibleChapters.map((chapter) => (
          <ChapterExerciseCard
            key={chapter.id}
            chapter={chapter}
            selectedPointId={selectedPointId}
            onPracticeChapter={() => onPracticeChapter(chapter.id)}
          />
        ))}
        {visibleChapters.length === 0 && (
          <p className="yolo-learning-exercises-empty">
            {t('learning.exercises.emptyFiltered', '没有符合筛选条件的习题')}
          </p>
        )}
      </div>
    </>
  )
}

function ChapterExerciseCard({
  chapter,
  selectedPointId,
  onPracticeChapter,
}: {
  chapter: (typeof chapters)[number] & {
    points: (typeof chapters)[number]['points']
  }
  selectedPointId: string | null
  onPracticeChapter: () => void
}) {
  const { t } = useLanguage()
  const stats = chapterExerciseStats(chapter.id)

  return (
    <article className="yolo-learning-exercise-chapter-card">
      <div className="yolo-learning-exercise-chapter-header">
        <div className="yolo-learning-exercise-chapter-title-wrap">
          <h3 className="yolo-learning-exercise-chapter-title">
            {formatLearningText(
              t('learning.exercises.chapterTitle', '第 {index} 章 · {title}'),
              { index: chapter.index, title: chapter.title },
            )}
          </h3>
          <p className="yolo-learning-exercise-chapter-meta">
            {formatLearningText(
              t('learning.exercises.practicedCount', '{done}/{total} 已练'),
              { done: stats.practiced, total: stats.total },
            )}
            {stats.pending > 0 && (
              <>
                {' '}
                ·{' '}
                <span className="yolo-learning-exercise-pending-text">
                  {formatLearningText(
                    t('learning.exercises.pendingCount', '{count} 待练'),
                    { count: stats.pending },
                  )}
                </span>
              </>
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
        {chapter.points.map((point, index) => (
          <PointProgressRow
            key={point.id}
            point={point}
            pointExercises={exercisesForPoint(point.id)}
            highlighted={selectedPointId === point.id}
            className={
              index > 0 ? 'yolo-learning-exercise-point-row-border' : undefined
            }
          />
        ))}
      </ul>
    </article>
  )
}

function PointProgressRow({
  point,
  pointExercises,
  highlighted,
  className,
}: {
  point: (typeof chapters)[number]['points'][number]
  pointExercises: Exercise[]
  highlighted: boolean
  className?: string
}) {
  const { t } = useLanguage()
  const practicedCount = pointExercises.filter(
    (exercise) => exercise.practiced,
  ).length
  const total = pointExercises.length
  const pending = total - practicedCount
  const allPracticed = pending === 0

  return (
    <li
      id={`exercise-point-${point.id}`}
      className={cx(
        'yolo-learning-exercise-point-row',
        highlighted && 'is-highlighted',
        className,
      )}
    >
      <span className="yolo-learning-exercise-point-title">
        {point.index} {point.title}
      </span>
      <div className="yolo-learning-exercise-point-status">
        {allPracticed ? (
          <Pill tone="success">
            <Check size={11} /> {t('learning.exercises.completed', '完成')}
          </Pill>
        ) : (
          <Pill tone="primary">
            {formatLearningText(
              t('learning.exercises.pendingCount', '{count} 待练'),
              { count: pending },
            )}
          </Pill>
        )}
      </div>
    </li>
  )
}

function ExerciseQuestionBody({
  exercise,
  className,
}: {
  exercise: Exercise
  className?: string
}) {
  return (
    <div className={cx('yolo-learning-exercise-question', className)}>
      <p className="yolo-learning-exercise-question-text">
        {exercise.question}
      </p>
      {exercise.codeSnippet && (
        <pre className="yolo-learning-exercise-code">
          <code>{exercise.codeSnippet}</code>
        </pre>
      )}
    </div>
  )
}

type PracticePhase = 'answering' | 'submitting' | 'feedback' | 'transition'

type MockFeedback = {
  verdict: 'success' | 'warning' | 'danger'
  verdictLabel: string
  score: number
  strengths: string[]
  gaps: string[]
  explanation: string
}

const SUBMIT_MS = 1200
const TRANSITION_MS = 250

const mockFeedback: Record<string, MockFeedback> = {
  'e2-2a': {
    verdict: 'warning',
    verdictLabel: '部分正确',
    score: 85,
    strengths: [
      '正确指出了核心原因是「数据竞争」。',
      '用多线程并发写入举例，方向正确。',
    ],
    gaps: [
      '数据竞争在单线程下同样可能发生（如迭代时修改容器导致迭代器失效），不必依赖多线程。',
      '未提到借用检查器是在编译期静态阻止，而非运行时。',
    ],
    explanation:
      'Rust 的「可变引用独占」规则本质是为了保证别名与可变性不可兼得（aliasing XOR mutability）。借用检查器在编译期通过生命周期分析拒绝这类代码。',
  },
  'e2-3a': {
    verdict: 'success',
    verdictLabel: '完全正确',
    score: 96,
    strengths: [
      '准确识别了不可变借用与可变借用的冲突。',
      '给出了合理的修改思路。',
    ],
    gaps: ['可以补充说明 first 的生命周期延续到 println! 调用处。'],
    explanation:
      'first 是对 v 的不可变借用，而 v.push(4) 需要可变借用，二者在 first 仍存活时冲突。可在 push 之前结束 first 的使用，或先克隆出需要的值。',
  },
  'e1-2a': {
    verdict: 'warning',
    verdictLabel: '部分正确',
    score: 72,
    strengths: ['提到了 move 会转移所有权。'],
    gaps: [
      '未说明函数参数默认按值传递 String 会 move。',
      '避免所有权转移的方式描述不够完整。',
    ],
    explanation:
      '把 String 直接作为参数传入函数会移动所有权。可改为传引用 &str 借用，或 clone()，或在函数末尾返还所有权。',
  },
}

const defaultMockFeedback: MockFeedback = {
  verdict: 'warning',
  verdictLabel: '部分正确',
  score: 78,
  strengths: ['理解了题目的核心概念，回答方向正确。'],
  gaps: ['论证还可以更完整，建议补充具体代码示例或更精确术语。'],
  explanation: '（设计稿占位反馈，接入 Obsidian 后由 AI 评估生成。）',
}

const defaultMockAnswer =
  '因为同时存在多个可变引用会导致数据竞争。比如两个线程通过两个 &mut 同时写同一个变量，结果不可预测。'

function buildPracticeQueue(scope: PracticeScope) {
  let pool: Exercise[]
  if (scope.kind === 'chapter') {
    pool = exercisesForChapter(scope.chapterId)
  } else if (scope.kind === 'point') {
    pool = exercises.filter((exercise) => exercise.pointId === scope.pointId)
  } else {
    pool = exercises
  }
  const unpracticed = pool.filter((exercise) => !exercise.practiced)
  return unpracticed.length > 0 ? unpracticed : pool
}

function PracticeMode({
  scope,
  onExit,
}: {
  scope: PracticeScope
  onExit: () => void
}) {
  const { t } = useLanguage()
  const queue = useMemo(() => buildPracticeQueue(scope), [scope])

  const [index, setIndex] = useState(0)
  const [phase, setPhase] = useState<PracticePhase>('answering')
  const [answer, setAnswer] = useState('')
  const [showAnswer, setShowAnswer] = useState(false)
  const [contentVisible, setContentVisible] = useState(true)
  const timersRef = useRef<number[]>([])

  const exercise = queue[index]
  const done = index >= queue.length
  const busy = phase === 'submitting' || phase === 'transition'
  const feedback = exercise
    ? (mockFeedback[exercise.id] ?? defaultMockFeedback)
    : null
  const progress = done ? 100 : ((index + 1) / queue.length) * 100

  const clearTimers = useCallback(() => {
    for (const id of timersRef.current) {
      window.clearTimeout(id)
    }
    timersRef.current = []
  }, [])

  const schedule = useCallback((fn: () => void, ms: number) => {
    timersRef.current.push(window.setTimeout(fn, ms))
  }, [])

  useEffect(() => () => clearTimers(), [clearTimers])

  const resetForExercise = useCallback(() => {
    setAnswer('')
    setShowAnswer(false)
    setPhase('answering')
    setContentVisible(true)
  }, [])

  const goNext = useCallback(() => {
    if (phase !== 'feedback' || done) return

    setPhase('transition')
    setContentVisible(false)

    schedule(() => {
      setIndex((currentIndex) => currentIndex + 1)
      resetForExercise()
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setContentVisible(true))
      })
      schedule(() => setPhase('answering'), TRANSITION_MS)
    }, TRANSITION_MS)
  }, [phase, done, resetForExercise, schedule])

  const submitAnswer = useCallback(() => {
    if (phase !== 'answering' || !answer.trim() || done) return

    setPhase('submitting')
    schedule(() => setPhase('feedback'), SUBMIT_MS)
  }, [phase, answer, done, schedule])

  const retryExercise = useCallback(() => {
    if (busy) return
    resetForExercise()
  }, [busy, resetForExercise])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.code === 'Escape') {
        event.preventDefault()
        onExit()
        return
      }
      if (busy || done) return

      if (
        phase === 'answering' &&
        event.key === 'Enter' &&
        (event.metaKey || event.ctrlKey)
      ) {
        event.preventDefault()
        submitAnswer()
        return
      }

      if (
        phase === 'feedback' &&
        (event.key === 'Enter' ||
          event.key === 'ArrowRight' ||
          event.key === '3')
      ) {
        event.preventDefault()
        goNext()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, done, phase, onExit, submitAnswer, goNext])

  if (done) {
    return (
      <div className="yolo-learning-exercise-complete">
        <p className="yolo-learning-exercise-complete-title">
          {t('learning.exercises.practiceDone', '本轮练习完成')}
        </p>
        <p className="yolo-learning-exercise-complete-meta">
          {formatLearningText(
            t('learning.exercises.practiceDoneCount', '共完成 {count} 道习题'),
            { count: queue.length },
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

  if (!exercise || !feedback) return null

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

      <div
        className={cx(
          'yolo-learning-exercise-practice-content',
          contentVisible ? 'is-visible' : 'is-hidden',
        )}
      >
        <div className="yolo-learning-exercise-card yolo-learning-exercise-question-card">
          <div className="yolo-learning-exercise-question-point">
            {pointTitle(exercise.pointId)}
          </div>
          <div className="yolo-learning-exercise-question-wrap">
            <ExerciseQuestionBody
              exercise={exercise}
              className="yolo-learning-exercise-question-large"
            />
          </div>
        </div>

        {(phase === 'answering' || phase === 'submitting') && (
          <div className="yolo-learning-exercise-card yolo-learning-exercise-answer-card">
            <textarea
              rows={6}
              value={answer}
              readOnly={phase === 'submitting'}
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
                  { count: answer.length },
                )}
              </span>
              {phase === 'submitting' && (
                <span className="yolo-learning-exercise-answer-loading">
                  <Loader2 size={13} className="yolo-learning-exercise-spin" />{' '}
                  {t('learning.exercises.aiEvaluating', 'AI 评估中…')}
                </span>
              )}
            </div>
          </div>
        )}

        {phase === 'feedback' && (
          <>
            <button
              type="button"
              onClick={() => setShowAnswer((current) => !current)}
              className="yolo-learning-exercise-answer-toggle"
            >
              <span className="yolo-learning-exercise-answer-toggle-title">
                {t('learning.exercises.yourAnswer', '你的作答')}
              </span>
              <span className="yolo-learning-exercise-answer-toggle-state">
                {showAnswer
                  ? t('learning.common.collapse', '收起')
                  : t('learning.common.expand', '展开')}
                {showAnswer ? (
                  <ChevronUp size={14} />
                ) : (
                  <ChevronDown size={14} />
                )}
              </span>
            </button>
            {showAnswer && (
              <div className="yolo-learning-exercise-answer-preview">
                {answer || defaultMockAnswer}
              </div>
            )}

            <div className="yolo-learning-exercise-card yolo-learning-exercise-feedback-card">
              <div className="yolo-learning-exercise-feedback-head">
                <Pill tone={feedback.verdict}>
                  <CircleAlert size={12} /> {feedback.verdictLabel}
                </Pill>
                <span className="yolo-learning-exercise-feedback-score">
                  {feedback.score}
                  <span className="yolo-learning-exercise-feedback-score-total">
                    /100
                  </span>
                </span>
              </div>

              <div className="yolo-learning-exercise-feedback-list">
                <FeedbackBlock
                  title={t(
                    'learning.exercises.answerStrengths',
                    '你的答案要点',
                  )}
                  tone="success"
                >
                  <ul className="yolo-learning-exercise-feedback-items yolo-learning-exercise-feedback-items-success">
                    {feedback.strengths.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </FeedbackBlock>
                <FeedbackBlock
                  title={t('learning.exercises.answerGaps', '遗漏或错误')}
                  tone="warning"
                >
                  <ul className="yolo-learning-exercise-feedback-items yolo-learning-exercise-feedback-items-warning">
                    {feedback.gaps.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </FeedbackBlock>
                <FeedbackBlock
                  title={t('learning.exercises.fullExplanation', '完整讲解')}
                  tone="neutral"
                >
                  <p className="yolo-learning-exercise-feedback-text">
                    {feedback.explanation}
                  </p>
                </FeedbackBlock>
              </div>

              <details className="yolo-learning-exercise-reference">
                <summary className="yolo-learning-exercise-reference-summary">
                  {t('learning.exercises.referenceAnswer', '参考答案')}
                </summary>
                <p className="yolo-learning-exercise-reference-text">
                  {exercise.answer}
                </p>
              </details>
            </div>
          </>
        )}
      </div>

      <div className="yolo-learning-exercise-practice-bottombar">
        <div
          className={cx(
            'yolo-learning-exercise-actions',
            busy && 'is-disabled',
          )}
        >
          {phase === 'answering' && (
            <button
              type="button"
              disabled={!answer.trim()}
              onClick={submitAnswer}
              className="yolo-learning-exercise-primary-button yolo-learning-exercise-submit-button"
            >
              {t('learning.exercises.submitEvaluation', '提交评估')}
            </button>
          )}
          {phase === 'submitting' && (
            <button
              type="button"
              disabled
              className="yolo-learning-exercise-primary-button yolo-learning-exercise-submit-button is-loading"
            >
              <Loader2 size={15} className="yolo-learning-exercise-spin" />
              {t('learning.exercises.evaluating', '评估中…')}
            </button>
          )}
          {phase === 'feedback' && (
            <>
              <button
                type="button"
                onClick={goNext}
                className="yolo-learning-exercise-primary-button yolo-learning-exercise-submit-button"
              >
                {t('learning.exercises.nextQuestion', '下一题')}{' '}
                <ArrowRight size={15} />
              </button>
              <button
                type="button"
                onClick={retryExercise}
                className="yolo-learning-exercise-secondary-button"
              >
                <RotateCcw size={14} /> {t('learning.exercises.retry', '重做')}
              </button>
            </>
          )}
          {phase === 'transition' && (
            <button
              type="button"
              disabled
              className="yolo-learning-exercise-transition-button"
            >
              {t('learning.exercises.loadingNext', '加载下一题…')}
            </button>
          )}
        </div>

        <div className="yolo-learning-exercise-shortcuts">
          {phase === 'answering' &&
            t(
              'learning.exercises.shortcutAnswering',
              '⌘/Ctrl + Enter 提交 · Esc 回浏览',
            )}
          {phase === 'submitting' &&
            t('learning.exercises.shortcutSubmitting', 'AI 正在评估你的作答…')}
          {phase === 'feedback' &&
            t(
              'learning.exercises.shortcutFeedback',
              'Enter / → 下一题 · Esc 回浏览',
            )}
          {phase === 'transition' &&
            t('learning.exercises.shortcutTransition', '准备下一题…')}
        </div>
      </div>
    </div>
  )
}

function FeedbackBlock({
  title,
  tone,
  children,
}: {
  title: string
  tone: 'success' | 'warning' | 'neutral'
  children: ReactNode
}) {
  return (
    <div className="yolo-learning-exercise-feedback-block">
      <div className="yolo-learning-exercise-feedback-title">
        <span
          className={cx(
            'yolo-learning-exercise-feedback-dot',
            `yolo-learning-exercise-feedback-dot-${tone}`,
          )}
        />
        {title}
      </div>
      <div className="yolo-learning-exercise-feedback-body">{children}</div>
    </div>
  )
}
