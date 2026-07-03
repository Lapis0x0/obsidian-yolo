import cx from 'clsx'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import {
  Children,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { PointerEvent, ReactNode } from 'react'

import { useLanguage } from '../../contexts/language-context'
import { formatLearningText } from './i18n'
import { type Card, cards, chapters } from './mockLearningData'
import { MasteryDot, Segmented, SelectMenu } from './primitives'

const cardModes = ['浏览', '复习'] as const
const masteryFilters = ['全部', '已掌握', '学习中', '未开始'] as const

function masteryText(
  t: (keyPath: string, fallback?: string) => string,
  mastery: Card['mastery'],
) {
  const labels: Record<Card['mastery'], string> = {
    mastered: t('learning.mastery.mastered', '已掌握'),
    learning: t('learning.mastery.learning', '学习中'),
    new: t('learning.mastery.new', '未开始'),
  }
  return labels[mastery]
}

function pointTitle(pointId: string) {
  for (const chapter of chapters) {
    const point = chapter.points.find((p) => p.id === pointId)
    if (point) return `${point.index} ${point.title}`
  }
  return ''
}

export function CardsView({
  selectedPointId,
}: {
  selectedPointId: string | null
}) {
  const { t } = useLanguage()
  const dueCount = cards.filter((card) => card.due).length
  const [mode, setMode] = useState<'浏览' | '复习'>('浏览')
  const modeLabels: Record<(typeof cardModes)[number], string> = {
    浏览: t('learning.common.browse', '浏览'),
    复习: t('learning.cards.review', '复习'),
  }

  return (
    <div className="yolo-learning-cards-view">
      <div className="yolo-learning-cards-topbar">
        <Segmented
          options={cardModes}
          value={mode}
          onChange={(nextMode) => setMode(nextMode)}
          badges={{ 复习: dueCount }}
          getLabel={(option) => modeLabels[option]}
        />
        {selectedPointId && mode === '浏览' && (
          <span className="yolo-learning-cards-selected-point">
            {t('learning.cards.filteredTo', '已筛选至：')}
            <span className="yolo-learning-cards-selected-point-title">
              {pointTitle(selectedPointId)}
            </span>
          </span>
        )}
      </div>

      {mode === '浏览' ? (
        <BrowseMode selectedPointId={selectedPointId} />
      ) : (
        <ReviewMode onExit={() => setMode('浏览')} />
      )}
    </div>
  )
}

/* ---------------- Browse ---------------- */
function BrowseMode({
  selectedPointId: _selectedPointId,
}: {
  selectedPointId: string | null
}) {
  const { t } = useLanguage()
  const [mastery, setMastery] =
    useState<(typeof masteryFilters)[number]>('全部')
  const columnCount = useMasonryColumnCount()
  const masteryFilterLabels: Record<(typeof masteryFilters)[number], string> = {
    全部: t('learning.common.all', '全部'),
    已掌握: t('learning.mastery.mastered', '已掌握'),
    学习中: t('learning.mastery.learning', '学习中'),
    未开始: t('learning.mastery.new', '未开始'),
  }

  return (
    <>
      <div className="yolo-learning-cards-filters">
        <SelectMenu
          value="全部章节"
          options={[
            {
              value: '全部章节',
              label: t('learning.common.allChapters', '全部章节'),
            },
            ...chapters.map((c) => c.title),
          ]}
        />
        <SelectMenu
          value="全部知识点"
          options={[
            {
              value: '全部知识点',
              label: t('learning.common.allKnowledgePoints', '全部知识点'),
            },
            '2.2 可变引用',
            '2.3 借用检查器规则',
          ]}
        />
        <div className="yolo-learning-cards-mastery-filter">
          {masteryFilters.map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMastery(m)}
              className={cx(
                'yolo-learning-cards-mastery-filter-btn',
                mastery === m &&
                  'yolo-learning-cards-mastery-filter-btn-active',
              )}
            >
              {masteryFilterLabels[m]}
            </button>
          ))}
        </div>
        <SelectMenu
          value="按到期时间"
          options={[
            {
              value: '按到期时间',
              label: t('learning.cards.sortDue', '按到期时间'),
            },
            {
              value: '按掌握度',
              label: t('learning.cards.sortMastery', '按掌握度'),
            },
            {
              value: '按创建时间',
              label: t('learning.home.sortCreated', '按创建时间'),
            },
          ]}
        />
        <button type="button" className="yolo-learning-cards-new-btn">
          <Plus size={15} /> {t('learning.cards.newCard', '新建卡片')}
        </button>
      </div>

      <MasonryColumns columnCount={columnCount}>
        {cards.map((card) => (
          <BrowseCard key={card.id} card={card} />
        ))}
      </MasonryColumns>
    </>
  )
}

/** Match tailwind sm / lg / xl breakpoints for 1-4 columns. */
function useMasonryColumnCount() {
  const [count, setCount] = useState(1)

  useEffect(() => {
    const update = () => {
      const width = window.innerWidth
      if (width >= 1280) setCount(4)
      else if (width >= 1024) setCount(3)
      else if (width >= 640) setCount(2)
      else setCount(1)
    }
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])

  return count
}

/**
 * Round-robin into independent column stacks so expanding one card only pushes
 * siblings below it in the same column, never sideways.
 */
function MasonryColumns({
  columnCount,
  children,
}: {
  columnCount: number
  children: ReactNode
}) {
  const items = Children.toArray(children)
  const columns = Array.from({ length: columnCount }, () => [] as ReactNode[])
  for (let i = 0; i < items.length; i += 1) {
    columns[i % columnCount].push(items[i])
  }

  const colIds = ['masonry-a', 'masonry-b', 'masonry-c', 'masonry-d'] as const

  return (
    <div className="yolo-learning-cards-masonry">
      {columns.map((col, colIndex) => (
        <div
          key={colIds[colIndex]}
          className="yolo-learning-cards-masonry-column"
        >
          {col}
        </div>
      ))}
    </div>
  )
}

function StreamReveal({ text, active }: { text: string; active: boolean }) {
  const [visible, setVisible] = useState(0)

  useEffect(() => {
    if (!active) {
      setVisible(0)
      return
    }

    const total = text.length
    if (total === 0) return

    const duration = Math.min(380, Math.max(100, total * 4))
    const start = performance.now()
    let frame = 0

    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / duration)
      setVisible(Math.max(1, Math.ceil(progress * total)))
      if (progress < 1) frame = requestAnimationFrame(tick)
    }

    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [active, text])

  return (
    <p className="yolo-learning-cards-stream-text">{text.slice(0, visible)}</p>
  )
}

function BrowseCard({ card }: { card: Card }) {
  const { t } = useLanguage()
  const [revealed, setRevealed] = useState(false)
  const [shimmer, setShimmer] = useState(false)

  const handleToggle = () => {
    if (!revealed) {
      setShimmer(true)
      window.setTimeout(() => setShimmer(false), 300)
    }
    setRevealed((r) => !r)
  }

  return (
    <article className="yolo-learning-cards-browse-card">
      <div className="yolo-learning-cards-browse-card-header">
        <span className="yolo-learning-cards-browse-card-point">
          {pointTitle(card.pointId)}
        </span>
        <div className="yolo-learning-cards-browse-card-meta">
          {card.due && (
            <span className="yolo-learning-cards-due-label">
              {t('learning.cards.due', '待复习')}
            </span>
          )}
          <span className="yolo-learning-cards-mastery-label">
            <MasteryDot mastery={card.mastery} />
            {masteryText(t, card.mastery)}
          </span>
        </div>
      </div>

      <button
        type="button"
        onClick={handleToggle}
        className="yolo-learning-cards-browse-card-body"
      >
        <p
          className={cx(
            'yolo-learning-cards-front-text',
            revealed && 'yolo-learning-cards-front-text-revealed',
          )}
        >
          {card.front}
        </p>

        {revealed && (
          <div className="yolo-learning-cards-answer">
            {shimmer && (
              <div className="yolo-learning-cards-answer-shimmer-mask">
                <div className="yolo-learning-cards-answer-sweep" />
              </div>
            )}
            <div className="yolo-learning-cards-answer-label">
              {t('learning.cards.answer', '答案')}
            </div>
            <div className="yolo-learning-cards-answer-content">
              <StreamReveal text={card.back} active={revealed} />
            </div>
          </div>
        )}

        <span className="yolo-learning-cards-toggle-hint">
          {revealed
            ? t('learning.cards.hideAnswer', '点击收回')
            : t('learning.cards.showAnswer', '点击查看答案')}
        </span>
      </button>

      <div className="yolo-learning-cards-actions">
        <CardIconBtn label={t('common.edit', '编辑')}>
          <Pencil size={13} />
        </CardIconBtn>
        <CardIconBtn label={t('common.delete', '删除')}>
          <Trash2 size={13} />
        </CardIconBtn>
      </div>
    </article>
  )
}

/* ---------------- Review ---------------- */

type ReviewGrade = 'forgot' | 'hard' | 'good'

const SWIPE_THRESHOLD = 72

const gradeDragTint: Record<ReviewGrade, string> = {
  forgot: 'yolo-learning-cards-review-tint-danger',
  hard: 'yolo-learning-cards-review-tint-warning',
  good: 'yolo-learning-cards-review-tint-success',
}

function resolveSwipeGrade(dx: number, dy: number): ReviewGrade | null {
  if (Math.abs(dx) < SWIPE_THRESHOLD && Math.abs(dy) < SWIPE_THRESHOLD)
    return null
  if (Math.abs(dy) > Math.abs(dx) && dy < -SWIPE_THRESHOLD) return 'hard'
  if (Math.abs(dx) >= Math.abs(dy) && dx < -SWIPE_THRESHOLD) return 'forgot'
  if (Math.abs(dx) >= Math.abs(dy) && dx > SWIPE_THRESHOLD) return 'good'
  return null
}

function keyboardToGrade(event: KeyboardEvent): ReviewGrade | null {
  if (event.key === '1' || event.key === 'ArrowLeft') return 'forgot'
  if (event.key === '2' || event.key === 'ArrowUp') return 'hard'
  if (event.key === '3' || event.key === 'ArrowRight') return 'good'
  return null
}

type ReviewPhase = 'idle' | 'exit' | 'settle'

const EXIT_MS = 300
const PROMOTE_DELAY_MS = 120
const SETTLE_MS = 150

const exitTransforms: Record<ReviewGrade, string> = {
  forgot: 'translateX(-135%) rotate(-14deg)',
  hard: 'translateY(-135%) rotate(-3deg)',
  good: 'translateX(135%) rotate(14deg)',
}

const peekFanLeft = 'translateX(-18px) rotate(-5deg) scale(0.98)'
const peekFanRight = 'translateX(18px) rotate(5deg) scale(0.98)'
const peekSingle = 'translateY(6px) scale(0.98)'
const peekCenter = 'translate(0,0) rotate(0deg) scale(1)'

function ReviewMode({ onExit }: { onExit: () => void }) {
  const { t } = useLanguage()
  const queue = useMemo(() => {
    const due = cards.filter((card) => card.due)
    return due.length > 0 ? due : cards.slice(0, 5)
  }, [])

  const [index, setIndex] = useState(0)
  const [flipped, setFlipped] = useState(false)
  const [phase, setPhase] = useState<ReviewPhase>('idle')
  const [exitingGrade, setExitingGrade] = useState<ReviewGrade | null>(null)
  const [promoting, setPromoting] = useState(false)
  const [peeksSettling, setPeeksSettling] = useState(false)
  const [drag, setDrag] = useState({ x: 0, y: 0 })
  const dragOrigin = useRef<{ x: number; y: number } | null>(null)
  const activeCardRef = useRef<HTMLDivElement>(null)
  const timersRef = useRef<number[]>([])

  const card = queue[index]
  const nextCard = queue[index + 1]
  const done = index >= queue.length
  const remainingAfter = queue.length - index - 1
  const busy = phase !== 'idle'
  const progress = done ? 100 : ((index + 1) / queue.length) * 100

  const clearTimers = useCallback(() => {
    for (const id of timersRef.current) {
      window.clearTimeout(id)
    }
    timersRef.current = []
  }, [])

  const commitGrade = useCallback(
    (grade: ReviewGrade) => {
      if (phase !== 'idle' || done) return

      clearTimers()
      setDrag({ x: 0, y: 0 })
      setExitingGrade(grade)
      setPhase('exit')
      setPromoting(false)

      const schedule = (fn: () => void, ms: number) => {
        timersRef.current.push(window.setTimeout(fn, ms))
      }

      schedule(() => setPromoting(true), PROMOTE_DELAY_MS)

      schedule(() => {
        setIndex((i) => i + 1)
        setFlipped(false)
        setExitingGrade(null)
        setPhase('settle')
        setPeeksSettling(true)
        requestAnimationFrame(() => {
          requestAnimationFrame(() => setPeeksSettling(false))
        })
      }, EXIT_MS)

      schedule(() => {
        setPhase('idle')
        setPromoting(false)
      }, EXIT_MS + SETTLE_MS)
    },
    [phase, done, clearTimers],
  )

  useEffect(() => () => clearTimers(), [clearTimers])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.code === 'Escape') {
        event.preventDefault()
        onExit()
        return
      }
      if (busy || done) return

      if (event.code === 'Space') {
        event.preventDefault()
        setFlipped((f) => !f)
        setDrag({ x: 0, y: 0 })
        return
      }

      const grade = keyboardToGrade(event)
      if (grade) {
        event.preventDefault()
        commitGrade(grade)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, done, onExit, commitGrade])

  const handlePointerDown = (event: PointerEvent) => {
    if (busy || done) return
    dragOrigin.current = { x: event.clientX, y: event.clientY }
    activeCardRef.current?.setPointerCapture(event.pointerId)
  }

  const handlePointerMove = (event: PointerEvent) => {
    if (!dragOrigin.current || busy) return
    setDrag({
      x: event.clientX - dragOrigin.current.x,
      y: event.clientY - dragOrigin.current.y,
    })
  }

  const handlePointerUp = (event: PointerEvent) => {
    if (!dragOrigin.current || busy || done) return
    const dx = event.clientX - dragOrigin.current.x
    const dy = event.clientY - dragOrigin.current.y
    dragOrigin.current = null
    activeCardRef.current?.releasePointerCapture(event.pointerId)

    if (Math.hypot(dx, dy) < 10) {
      setFlipped((f) => !f)
      setDrag({ x: 0, y: 0 })
      return
    }

    const grade = resolveSwipeGrade(dx, dy)
    if (grade) commitGrade(grade)
    else setDrag({ x: 0, y: 0 })
  }

  const handlePointerCancel = () => {
    dragOrigin.current = null
    setDrag({ x: 0, y: 0 })
  }

  const activeGrade = exitingGrade ?? resolveSwipeGrade(drag.x, drag.y)
  const gradeMeta: Record<
    ReviewGrade,
    { label: string; hint: string; tone: 'danger' | 'warning' | 'success' }
  > = {
    forgot: {
      label: t('learning.cards.reviewForgot', '忘了'),
      hint: t('learning.cards.reviewForgotHint', '< 1 分钟后'),
      tone: 'danger',
    },
    hard: {
      label: t('learning.cards.reviewHard', '模糊'),
      hint: t('learning.cards.reviewHardHint', '10 分钟后'),
      tone: 'warning',
    },
    good: {
      label: t('learning.cards.reviewGood', '会了'),
      hint: t('learning.cards.reviewGoodHint', '2 天后'),
      tone: 'success',
    },
  }
  const flipHint = t('learning.cards.flipHint', '点击翻面或按空格')

  const cardTransform = exitingGrade
    ? exitTransforms[exitingGrade]
    : `translate(${drag.x}px, ${drag.y}px) rotate(${drag.x * 0.04}deg)`

  const promoteFrom = remainingAfter >= 2 ? peekFanRight : peekSingle
  const promoteCard =
    phase === 'exit' ? nextCard : phase === 'settle' ? card : null
  const showPromoteLayer = promoteCard != null
  const promoteAtCenter = promoting || phase === 'settle'
  const hideTopPeek = phase === 'exit' && nextCard != null
  const hideActiveCard = phase !== 'idle'

  if (done) {
    return (
      <div className="yolo-learning-cards-review-done">
        <p className="yolo-learning-cards-review-done-title">
          {t('learning.cards.reviewDone', '本轮复习完成')}
        </p>
        <p className="yolo-learning-cards-review-done-subtitle">
          {formatLearningText(
            t('learning.cards.reviewDoneCount', '共复习 {count} 张卡片'),
            { count: queue.length },
          )}
        </p>
        <button
          type="button"
          onClick={onExit}
          className="yolo-learning-cards-review-back-btn"
        >
          {t('learning.cards.backToBrowse', '返回浏览')}
        </button>
      </div>
    )
  }

  return (
    <div className="yolo-learning-cards-review">
      <div className="yolo-learning-cards-review-stats">
        <span className="yolo-learning-cards-review-count">
          {index + 1}{' '}
          <span className="yolo-learning-cards-review-total">
            / {queue.length}
          </span>
        </span>
        <span className="yolo-learning-cards-review-timer">2:34</span>
      </div>
      <div className="yolo-learning-cards-review-progress">
        <div
          className="yolo-learning-cards-review-progress-fill"
          style={{ width: `${progress}%` }}
        />
      </div>

      <div className="yolo-learning-cards-review-stage-wrap">
        <div className="yolo-learning-cards-review-stage">
          <div className="yolo-learning-cards-review-stack">
            {remainingAfter >= 2 && (
              <div
                aria-hidden
                className={cx(
                  'yolo-learning-cards-review-peek yolo-learning-cards-review-peek-left',
                  peeksSettling && 'yolo-learning-cards-review-peek-settling',
                )}
                style={{
                  transform: peeksSettling
                    ? 'translateY(8px) scale(0.96)'
                    : peekFanLeft,
                }}
              />
            )}
            {remainingAfter >= 2 && !hideTopPeek && (
              <div
                aria-hidden
                className={cx(
                  'yolo-learning-cards-review-peek yolo-learning-cards-review-peek-right',
                  peeksSettling && 'yolo-learning-cards-review-peek-settling',
                )}
                style={{
                  transform: peeksSettling
                    ? 'translateY(8px) scale(0.96)'
                    : peekFanRight,
                }}
              />
            )}
            {remainingAfter === 1 && !hideTopPeek && (
              <div
                aria-hidden
                className={cx(
                  'yolo-learning-cards-review-peek yolo-learning-cards-review-peek-single',
                  peeksSettling && 'yolo-learning-cards-review-peek-settling',
                )}
                style={{
                  transform: peeksSettling
                    ? 'translateY(8px) scale(0.96)'
                    : peekSingle,
                }}
              />
            )}

            {showPromoteLayer && promoteCard && (
              <div
                aria-hidden
                className="yolo-learning-cards-review-promote"
                style={{
                  transform: promoteAtCenter ? peekCenter : promoteFrom,
                  opacity: promoteAtCenter ? 1 : 0.88,
                }}
              >
                <div className="yolo-learning-cards-review-promote-card">
                  <div className="yolo-learning-cards-review-card-point">
                    {pointTitle(promoteCard.pointId)}
                  </div>
                  <p className="yolo-learning-cards-review-card-front-text">
                    {promoteCard.front}
                  </p>
                  <div className="yolo-learning-cards-review-card-bottom-hint">
                    {flipHint}
                  </div>
                </div>
              </div>
            )}

            <div
              key={card.id}
              ref={activeCardRef}
              className={cx(
                'yolo-learning-cards-review-active',
                exitingGrade && 'yolo-learning-cards-review-active-exiting',
                hideActiveCard &&
                  !exitingGrade &&
                  'yolo-learning-cards-review-active-hidden',
                drag.x === 0 &&
                  drag.y === 0 &&
                  !exitingGrade &&
                  'yolo-learning-cards-review-active-resting',
              )}
              style={{
                transform: cardTransform,
                opacity: hideActiveCard ? 0 : exitingGrade ? 0 : 1,
              }}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerCancel}
            >
              <div className="yolo-learning-cards-review-perspective">
                <div
                  className={cx(
                    'yolo-learning-cards-review-flip',
                    flipped && 'yolo-learning-cards-review-flip-flipped',
                  )}
                >
                  <div className="yolo-learning-cards-review-face yolo-learning-cards-review-face-front">
                    <div className="yolo-learning-cards-review-card-point">
                      {pointTitle(card.pointId)}
                    </div>
                    <p className="yolo-learning-cards-review-card-front-text">
                      {card.front}
                    </p>
                    <div className="yolo-learning-cards-review-card-bottom-hint">
                      {flipHint}
                    </div>
                    <div
                      className={cx(
                        'yolo-learning-cards-review-tint',
                        !flipped && activeGrade && gradeDragTint[activeGrade],
                      )}
                    />
                  </div>
                  <div className="yolo-learning-cards-review-face yolo-learning-cards-review-face-back">
                    <div className="yolo-learning-cards-review-card-point">
                      {pointTitle(card.pointId)}
                    </div>
                    <p className="yolo-learning-cards-review-card-back-text yolo-learning-scrollbar-thin">
                      {card.back}
                    </p>

                    <div
                      className={cx(
                        'yolo-learning-cards-review-tint',
                        flipped && activeGrade && gradeDragTint[activeGrade],
                      )}
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div
        className={cx(
          'yolo-learning-cards-review-actions',
          busy && 'yolo-learning-cards-review-actions-busy',
        )}
      >
        {(['forgot', 'hard', 'good'] as const).map((grade) => (
          <EvalBtn
            key={grade}
            tone={gradeMeta[grade].tone}
            label={gradeMeta[grade].label}
            hint={gradeMeta[grade].hint}
            onClick={() => commitGrade(grade)}
          />
        ))}
      </div>

      <div className="yolo-learning-cards-review-shortcuts">
        {t(
          'learning.cards.reviewShortcuts',
          '空格 翻面 · ← ↑ → 或 1 / 2 / 3 评估 · Esc 回浏览',
        )}
      </div>
    </div>
  )
}

function EvalBtn({
  tone,
  label,
  hint,
  onClick,
}: {
  tone: 'danger' | 'warning' | 'success'
  label: string
  hint: string
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        'yolo-learning-cards-eval-btn',
        `yolo-learning-cards-eval-btn-${tone}`,
      )}
    >
      <span className="yolo-learning-cards-eval-label">{label}</span>
      <span className="yolo-learning-cards-eval-hint">{hint}</span>
    </button>
  )
}

function CardIconBtn({
  children,
  label,
}: {
  children: ReactNode
  label: string
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(event) => event.stopPropagation()}
      className="yolo-learning-cards-icon-btn"
    >
      {children}
    </button>
  )
}
