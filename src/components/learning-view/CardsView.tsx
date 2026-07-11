import {
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import { SortableContext, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import cx from 'clsx'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { Notice, TFile, normalizePath } from 'obsidian'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent, ReactNode } from 'react'

import { useApp } from '../../contexts/app-context'
import { useLanguage } from '../../contexts/language-context'
import { usePlugin } from '../../contexts/plugin-context'
import {
  CardFileConflictError,
  type CardFileError,
  CardFileFormatError,
  getLearningCardFileStore,
  parseCardFile,
  scanProjectCards,
} from '../../core/learning/cardFile'
import {
  fsrsStateToMastery,
  isDue,
} from '../../core/learning/srs/masteryMapping'
import type {
  CardScheduling,
  ReviewRating,
  SrsCardState,
} from '../../core/learning/srs/srsTypes'
import type { Project as VaultProject } from '../../core/learning/types'
import { openMarkdownFile } from '../../utils/obsidian'
import { ConfirmModal } from '../modals/ConfirmModal'

import {
  type CardGenerationWorkspace,
  type WorkspaceCard,
  calculateTargetFileIndex,
  groupCardsByProjectOrder,
  isBrowseDragDisabled,
  mergeDiskAndPreviewCards,
} from './cardsWorkspace'
import { formatLearningText } from './i18n'
import { type Mastery, MasteryDot, Segmented, SelectMenu } from './primitives'
import {
  getExtremeGradeThreshold,
  keyboardToGrade,
  resolveSwipeGrade,
  updateReviewQueue,
} from './reviewInteractions'

const cardModes = ['浏览', '复习'] as const
const masteryFilters = ['全部', '已掌握', '学习中', '未开始'] as const

type Card = WorkspaceCard

type CardWorkspaceError = {
  kind: 'format' | 'load'
  items: CardFileError[]
}

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

export function CardsView({
  project,
  generation,
}: {
  project: VaultProject | null
  generation: CardGenerationWorkspace | null
}) {
  const { t } = useLanguage()
  const {
    cards,
    loading,
    now,
    dueCount,
    todayIntroducedCount,
    applyReviewResult,
    error,
    refresh,
    writing,
    setWriting,
  } = useProjectCards(project, generation)
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
      </div>

      {mode === '浏览' ? (
        <BrowseMode
          project={project}
          cards={cards}
          loading={loading}
          now={now}
          generation={generation}
          error={error}
          refresh={refresh}
          writing={writing}
          setWriting={setWriting}
        />
      ) : (
        <ReviewMode
          key={project?.slug}
          projectSlug={project?.slug ?? null}
          cards={cards.filter((card) => !card.preview)}
          now={now}
          todayIntroducedCount={todayIntroducedCount}
          onReviewed={applyReviewResult}
          onExit={() => setMode('浏览')}
        />
      )}
    </div>
  )
}

function useProjectCards(
  project: VaultProject | null,
  generation: CardGenerationWorkspace | null,
) {
  const app = useApp()
  const plugin = usePlugin()
  const { t } = useLanguage()
  const [cards, setCards] = useState<Card[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<CardWorkspaceError | null>(null)
  const [writing, setWriting] = useState(false)
  const [refreshToken, setRefreshToken] = useState(0)
  const [todayIntroducedCount, setTodayIntroducedCount] = useState(0)
  const loadGenerationRef = useRef(0)
  const introducedLoadGenerationRef = useRef(0)
  const introducedDayRef = useRef('')
  const prunedProjectRef = useRef<string | null>(null)
  const { now, refreshNow } = useReviewClock(cards)

  useEffect(() => {
    let cancelled = false
    const loadGeneration = loadGenerationRef.current + 1
    loadGenerationRef.current = loadGeneration
    const run = async () => {
      if (!project) {
        setCards([])
        setTodayIntroducedCount(0)
        setLoading(false)
        return
      }
      setLoading(true)
      const now = new Date()
      let introducedDay = localDayKey(now)
      const srsStore = plugin.getLearningSrsStore()
      const [projectState, initialIntroducedCount] = await Promise.all([
        srsStore.getProjectState(project.slug),
        srsStore.getTodayIntroducedCount(project.slug, now),
      ])
      let introducedCount = initialIntroducedCount
      const nextCards: Card[] = []
      const pointByUuid = new Map(
        project.knowledgePoints.map((point) => [point.uuid, point]),
      )
      const chapterById = new Map(
        project.chapters.map((chapter) => [chapter.id, chapter]),
      )
      for (const chapter of project.chapters) {
        const file = app.vault.getAbstractFileByPath(
          normalizePath(`${chapter.folderPath}/cards.md`),
        )
        if (!(file instanceof TFile)) continue
        const content = await app.vault.cachedRead(file)
        const parsedFile = parseCardFile(content, file.path)
        if (!parsedFile.complete) {
          throw new CardFileFormatError(file.path, parsedFile.errors)
        }
        for (const [sourceIndex, entry] of parsedFile.cards.entries()) {
          const point = pointByUuid.get(entry.kpUuid)
          if (!point || point.chapterId !== chapter.id) {
            throw new CardFileFormatError(file.path, [
              {
                path: file.path,
                line: entry.startLine,
                message: !point
                  ? `卡片引用了不存在的知识点：${entry.kpUuid}`
                  : `卡片知识点不属于当前章节：${entry.kpUuid}`,
              },
            ])
          }
          const pointChapter = point
            ? chapterById.get(point.chapterId)
            : undefined
          const srsState = projectState.cards[entry.cardUuid] ?? null
          nextCards.push({
            id: entry.cardUuid,
            kpUuid: entry.kpUuid,
            pointId: point?.id ?? null,
            pointTitle: point?.title ?? entry.kpUuid,
            chapterId: chapter.id,
            chapterTitle: pointChapter?.title ?? chapter.title,
            front: entry.front,
            back: entry.back,
            mastery: srsState ? fsrsStateToMastery(srsState.state) : 'new',
            dueAt: srsState?.due ?? null,
            srsState,
            filePath: file.path,
            startLine: entry.startLine,
            sourceIndex,
            preview: false,
          })
        }
      }
      const projectScan = await scanProjectCards(
        app,
        project.folderPath,
        project.chapters.map((chapter) => `${chapter.folderPath}/cards.md`),
      )
      if (!projectScan.complete) {
        throw new CardFileFormatError(project.folderPath, projectScan.errors)
      }
      if (
        prunedProjectRef.current !== project.id &&
        (!generation || generation.settled.length >= project.chapters.length) &&
        !writing
      ) {
        await srsStore.pruneOrphanedCards(project.slug, projectScan.uuids)
        prunedProjectRef.current = project.id
      }
      const commitNow = new Date()
      const commitDay = localDayKey(commitNow)
      if (commitDay !== introducedDay) {
        introducedCount = await srsStore.getTodayIntroducedCount(
          project.slug,
          commitNow,
        )
        introducedDay = commitDay
      }
      if (!cancelled && loadGenerationRef.current === loadGeneration) {
        setCards(nextCards)
        setError(null)
        setTodayIntroducedCount(introducedCount)
        introducedDayRef.current = introducedDay
        setLoading(false)
      }
    }
    void run().catch((loadError: unknown) => {
      if (!cancelled && loadGenerationRef.current === loadGeneration) {
        setCards([])
        setTodayIntroducedCount(0)
        setLoading(false)
        const formatError = loadError instanceof CardFileFormatError
        const errors = formatError
          ? loadError.errors
          : [
              {
                message:
                  loadError instanceof Error
                    ? loadError.message
                    : String(loadError),
              },
            ]
        setError({ kind: formatError ? 'format' : 'load', items: errors })
        new Notice(
          formatError
            ? t(
                'learning.cards.invalidProjectCards',
                '卡片文件格式错误或 UUID 重复，写操作已禁用',
              )
            : t('learning.cards.cardLoadFailed', '卡片加载失败，请重试'),
        )
      }
    })
    return () => {
      cancelled = true
    }
  }, [app, generation, plugin, project, refreshToken, t, writing])

  const previewCards = useMemo(() => {
    if (!project || generation?.projectId !== project.id) return []
    const points = new Map(
      project.knowledgePoints.map((point) => [point.uuid, point]),
    )
    const chapters = new Map(
      project.chapters.map((chapter) => [chapter.id, chapter]),
    )
    return generation.cards.map(({ card: draft, chapterIndex }): Card => {
      const point = points.get(draft.kpUuid)
      const chapter =
        project.chapters[chapterIndex] ??
        (point ? chapters.get(point.chapterId) : undefined)
      return {
        id: draft.cardUuid,
        kpUuid: draft.kpUuid,
        pointId: point?.id ?? null,
        pointTitle: point?.title ?? draft.kpUuid,
        chapterId: chapter?.id ?? '',
        chapterTitle: chapter?.title ?? '',
        front: draft.front,
        back: draft.back,
        mastery: 'new',
        dueAt: null,
        srsState: null,
        filePath: null,
        startLine: draft.startLine,
        sourceIndex: draft.startLine,
        preview: true,
      }
    })
  }, [generation, project])
  const mergedCards = useMemo(
    () => mergeDiskAndPreviewCards(cards, previewCards),
    [cards, previewCards],
  )

  const applyReviewResult = useCallback(
    (cardUuid: string, srsState: SrsCardState, introduced: boolean) => {
      const now = new Date()
      loadGenerationRef.current += 1
      introducedLoadGenerationRef.current += 1
      setLoading(false)
      refreshNow()
      setCards((current) =>
        current.map((card) =>
          card.id === cardUuid
            ? {
                ...card,
                mastery: fsrsStateToMastery(srsState.state),
                dueAt: srsState.due,
                srsState,
              }
            : card,
        ),
      )
      if (introduced) {
        const day = localDayKey(now)
        if (introducedDayRef.current === day) {
          setTodayIntroducedCount((count) => count + 1)
        } else {
          introducedDayRef.current = day
          setTodayIntroducedCount(1)
        }
      }
    },
    [refreshNow],
  )

  useEffect(() => {
    if (!project) return
    const day = localDayKey(now)
    if (introducedDayRef.current === day) return
    const generation = introducedLoadGenerationRef.current + 1
    introducedLoadGenerationRef.current = generation
    void plugin
      .getLearningSrsStore()
      .getTodayIntroducedCount(project.slug, now)
      .then((count) => {
        if (introducedLoadGenerationRef.current !== generation) return
        introducedDayRef.current = day
        setTodayIntroducedCount(count)
      })
      .catch(() => {
        if (introducedLoadGenerationRef.current !== generation) return
        new Notice(
          t('learning.cards.srsLoadFailed', '复习数据加载失败，请重试'),
        )
      })
  }, [now, plugin, project, t])

  const dueCount = cards.filter(
    (card) => card.srsState && card.dueAt && isDue(card.dueAt, now),
  ).length

  return {
    cards: mergedCards,
    loading,
    now,
    dueCount,
    todayIntroducedCount,
    applyReviewResult,
    error,
    refresh: () => setRefreshToken((value) => value + 1),
    writing,
    setWriting,
  }
}

function useReviewClock(cards: Card[]): { now: Date; refreshNow: () => void } {
  const [now, setNow] = useState(() => new Date())
  const refreshNow = useCallback(() => setNow(new Date()), [])

  useEffect(() => {
    const nowMs = now.getTime()
    const futureDueTimes = cards
      .map((card) => (card.dueAt ? new Date(card.dueAt).getTime() : Number.NaN))
      .filter((dueAt) => Number.isFinite(dueAt) && dueAt > nowMs)
    const nextDueAt =
      futureDueTimes.length > 0 ? Math.min(...futureDueTimes) : Infinity
    const nextMidnight = new Date(now)
    nextMidnight.setHours(24, 0, 0, 0)
    const nextWakeAt = Math.min(nextDueAt, nextMidnight.getTime())
    const delay = Math.min(
      Math.max(1_000, nextWakeAt - nowMs + 50),
      2_147_000_000,
    )
    const timer = window.setTimeout(refreshNow, delay)
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') refreshNow()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('focus', refreshNow)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('focus', refreshNow)
    }
  }, [cards, now, refreshNow])

  return { now, refreshNow }
}

function localDayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

/* ---------------- Browse ---------------- */
function BrowseMode({
  project,
  cards,
  loading,
  now,
  generation,
  error,
  refresh,
  writing,
  setWriting,
}: {
  project: VaultProject | null
  cards: Card[]
  loading: boolean
  now: Date
  generation: CardGenerationWorkspace | null
  error: CardWorkspaceError | null
  refresh: () => void
  writing: boolean
  setWriting: (writing: boolean) => void
}) {
  const { t } = useLanguage()
  const app = useApp()
  const plugin = usePlugin()
  const fileStore = getLearningCardFileStore(app)
  const [chapterFilter, setChapterFilter] = useState('all')
  const [pointFilter, setPointFilter] = useState('all')
  const [mastery, setMastery] =
    useState<(typeof masteryFilters)[number]>('全部')
  const [activeCardId, setActiveCardId] = useState<string | null>(null)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 250, tolerance: 6 },
    }),
  )
  const masteryFilterLabels: Record<(typeof masteryFilters)[number], string> = {
    全部: t('learning.common.all', '全部'),
    已掌握: t('learning.mastery.mastered', '已掌握'),
    学习中: t('learning.mastery.learning', '学习中'),
    未开始: t('learning.mastery.new', '未开始'),
  }

  const masteryValue: Record<(typeof masteryFilters)[number], Mastery | null> =
    {
      全部: null,
      已掌握: 'mastered',
      学习中: 'learning',
      未开始: 'new',
    }
  const filteredCards = cards.filter(
    (card) => !masteryValue[mastery] || card.mastery === masteryValue[mastery],
  )
  const groups = project ? groupCardsByProjectOrder(project, filteredCards) : []
  const visibleGroups = groups
    .filter(
      ({ chapter }) => chapterFilter === 'all' || chapter.id === chapterFilter,
    )
    .map((group) => ({
      ...group,
      points: group.points.filter(
        ({ point }) => pointFilter === 'all' || point.id === pointFilter,
      ),
    }))
    .filter((group) => group.points.length > 0)
  const settledIndexes = new Set(
    generation?.settled.map((item) => item.chapterIndex),
  )
  const generationActive = Boolean(
    generation && settledIndexes.size < (project?.chapters.length ?? 0),
  )
  const writeDisabled = Boolean(error || writing)

  const withWrite = async (operation: () => Promise<void>) => {
    if (writeDisabled) return
    setWriting(true)
    try {
      await operation()
      refresh()
    } catch (operationError) {
      console.error('[YOLO] Failed to update learning card:', operationError)
      new Notice(
        operationError instanceof CardFileConflictError
          ? t(
              'learning.cards.cardFileConflict',
              '卡片文件已在其他位置修改，请刷新后重试',
            )
          : t('learning.cards.cardUpdateFailed', '卡片更新失败，请重试'),
      )
    } finally {
      setWriting(false)
    }
  }

  const handleCreate = (
    chapter: VaultProject['chapters'][number],
    kpUuid: string,
  ) => {
    void withWrite(async () => {
      if (!project) return
      const path = normalizePath(`${chapter.folderPath}/cards.md`)
      const created = await fileStore.createCard(
        project.folderPath,
        path,
        chapter.title,
        kpUuid,
      )
      openMarkdownFile(app, path, created.startLine)
    })
  }

  const handleDelete = (card: Card) => {
    if (!card.filePath || !project) return
    new ConfirmModal(app, {
      title: t('learning.cards.deleteTitle', '删除卡片'),
      message: t(
        'learning.cards.deletePrompt',
        '确定删除这张卡片吗？此操作无法撤销。',
      ),
      ctaText: t('common.delete', '删除'),
      onConfirm: () => {
        void withWrite(async () => {
          await fileStore.deleteCard(card.filePath!, card.id)
          try {
            await plugin
              .getLearningSrsStore()
              .removeCards(project.slug, [card.id])
          } catch {
            new Notice(
              t(
                'learning.cards.srsDeleteFailed',
                '卡片已删除，但复习记录清理失败',
              ),
            )
          }
        })
      },
    }).open()
  }

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    setActiveCardId(null)
    if (!over || !project) return
    const source = cards.find((card) => card.id === active.id)
    const targetCard = cards.find((card) => card.id === over.id)
    const targetKpUuid =
      targetCard?.kpUuid ?? String(over.id).replace(/^kp:/, '')
    const point = project.knowledgePoints.find(
      (item) => item.uuid === targetKpUuid,
    )
    const chapter = point
      ? project.chapters.find((item) => item.id === point.chapterId)
      : undefined
    if (!source?.filePath || !point || !chapter) return
    const chapterCards = cards.filter(
      (card) => card.chapterId === chapter.id && !card.preview,
    )
    const pointCards = chapterCards.filter(
      (card) => card.kpUuid === targetKpUuid,
    )
    const targetVisibleIndex = targetCard
      ? Math.max(
          0,
          pointCards.findIndex((card) => card.id === targetCard.id),
        )
      : pointCards.length
    const targetIndex = calculateTargetFileIndex(
      targetKpUuid,
      targetVisibleIndex,
      chapter.knowledgePointIds
        .map(
          (id) => project.knowledgePoints.find((item) => item.id === id)?.uuid,
        )
        .filter((uuid): uuid is string => Boolean(uuid)),
      chapterCards,
      source.id,
    )
    void withWrite(() =>
      fileStore.moveCard({
        sourcePath: source.filePath!,
        targetPath: normalizePath(`${chapter.folderPath}/cards.md`),
        cardUuid: source.id,
        kpUuid: targetKpUuid,
        targetIndex,
        targetChapterTitle: chapter.title,
      }),
    )
  }

  return (
    <>
      <div className="yolo-learning-cards-filters">
        <SelectMenu
          value={chapterFilter}
          onChange={(value) => {
            setChapterFilter(value)
            setPointFilter('all')
          }}
          options={[
            {
              value: 'all',
              label: t('learning.common.allChapters', '全部章节'),
            },
            ...(project?.chapters.map((chapter) => ({
              value: chapter.id,
              label: chapter.title,
            })) ?? []),
          ]}
        />
        <SelectMenu
          value={pointFilter}
          onChange={setPointFilter}
          options={[
            {
              value: 'all',
              label: t('learning.common.allKnowledgePoints', '全部知识点'),
            },
            ...(project?.knowledgePoints
              .filter(
                (point) =>
                  chapterFilter === 'all' || point.chapterId === chapterFilter,
              )
              .map((point) => ({ value: point.id, label: point.title })) ?? []),
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
      </div>

      {error && (
        <div className="yolo-learning-cards-error" role="alert">
          <strong>
            {error.kind === 'format'
              ? t(
                  'learning.cards.invalidProjectCards',
                  '卡片文件格式错误或 UUID 重复，写操作已禁用',
                )
              : t('learning.cards.cardLoadFailed', '卡片加载失败，请重试')}
          </strong>
          {error.items.map((item, index) => (
            <div key={`${item.path}-${item.line}-${index}`}>
              {[
                item.path,
                item.line ? `:${item.line}` : '',
                error.kind === 'format'
                  ? t('learning.cards.invalidCardEntry', '卡片格式无效')
                  : t('learning.cards.cardLoadFailed', '卡片加载失败，请重试'),
              ]
                .filter(Boolean)
                .join(' ')}
            </div>
          ))}
        </div>
      )}
      {loading && cards.length === 0 ? (
        <p className="yolo-learning-cards-empty">
          {t('learning.common.loading', '加载中…')}
        </p>
      ) : !project ? (
        <p className="yolo-learning-cards-empty">
          {t(
            'learning.cards.empty',
            '还没有卡片，生成知识点后可在知识点上创建卡片',
          )}
        </p>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={({ active }: DragStartEvent) =>
            setActiveCardId(String(active.id))
          }
          onDragCancel={() => setActiveCardId(null)}
          onDragEnd={handleDragEnd}
        >
          <div className="yolo-learning-cards-chapters">
            {visibleGroups.map(({ chapter, points }) => {
              const sourceChapterIndex = project.chapters.findIndex(
                (item) => item.id === chapter.id,
              )
              const settled = generation?.settled.find(
                (item) => item.chapterIndex === sourceChapterIndex,
              )
              const generating = generationActive && !settled
              return (
                <section
                  key={chapter.id}
                  className="yolo-learning-cards-chapter"
                >
                  <header className="yolo-learning-cards-chapter-header">
                    <h2>{chapter.title}</h2>
                    {generating && (
                      <span>
                        {t('learning.cards.chapterGenerating', '正在生成卡片…')}
                      </span>
                    )}
                    {settled?.status === 'partial' && (
                      <span>
                        {t('learning.cards.chapterPartial', '部分卡片已生成')}
                      </span>
                    )}
                    {settled?.status === 'failed' && (
                      <span className="is-error">
                        {t('learning.cards.chapterFailed', '本章生成失败')}
                      </span>
                    )}
                  </header>
                  {points.map(({ point, cards: pointCards }) => (
                    <KnowledgePointDropZone
                      key={point.id}
                      point={point}
                      cards={pointCards}
                      readonly={generating || writeDisabled}
                      mastery={mastery}
                      now={now}
                      onCreate={() => handleCreate(chapter, point.uuid)}
                      onDelete={handleDelete}
                    />
                  ))}
                </section>
              )
            })}
          </div>
          <DragOverlay>
            {activeCardId ? (
              <div className="yolo-learning-cards-drag-overlay">
                {cards.find((card) => card.id === activeCardId)?.front}
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      )}
    </>
  )
}

function KnowledgePointDropZone({
  point,
  cards,
  readonly,
  mastery,
  now,
  onCreate,
  onDelete,
}: {
  point: VaultProject['knowledgePoints'][number]
  cards: Card[]
  readonly: boolean
  mastery: (typeof masteryFilters)[number]
  now: Date
  onCreate: () => void
  onDelete: (card: Card) => void
}) {
  const { t } = useLanguage()
  const { setNodeRef, isOver } = useDroppable({
    id: `kp:${point.uuid}`,
    disabled: readonly || mastery !== '全部',
  })
  return (
    <section
      ref={setNodeRef}
      className={cx('yolo-learning-cards-point', isOver && 'is-over')}
    >
      <header className="yolo-learning-cards-point-header">
        <h3>{point.title}</h3>
        <button
          type="button"
          disabled={readonly}
          onClick={onCreate}
          className="yolo-learning-cards-point-add"
        >
          <Plus size={14} />{' '}
          {t('learning.cards.addToKnowledgePoint', '新增卡片')}
        </button>
      </header>
      <SortableContext items={cards.map((card) => card.id)}>
        <div className="yolo-learning-cards-point-grid">
          {cards.map((card) => (
            <SortableBrowseCard
              key={card.id}
              card={card}
              disabled={isBrowseDragDisabled({
                masteryFilter: mastery,
                writeDisabled: readonly,
                chapterGenerating: false,
                preview: card.preview,
              })}
              due={Boolean(
                card.srsState && card.dueAt && isDue(card.dueAt, now),
              )}
              onDelete={() => onDelete(card)}
            />
          ))}
          {isOver && <div className="yolo-learning-cards-drop-placeholder" />}
          {cards.length === 0 && !isOver && (
            <span className="yolo-learning-cards-point-empty">
              {t('learning.cards.emptyKnowledgePoint', '暂无卡片')}
            </span>
          )}
        </div>
      </SortableContext>
    </section>
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

function SortableBrowseCard({
  card,
  due,
  disabled,
  onDelete,
}: {
  card: Card
  due: boolean
  disabled: boolean
  onDelete: () => void
}) {
  const sortable = useSortable({ id: card.id, disabled })
  return (
    <div
      ref={sortable.setNodeRef}
      style={{
        transform: CSS.Transform.toString(sortable.transform),
        transition: sortable.transition,
      }}
      className={cx(
        'yolo-learning-cards-sortable',
        sortable.isDragging && 'is-dragging',
        card.preview && 'is-preview',
      )}
      {...sortable.attributes}
      {...sortable.listeners}
    >
      <BrowseCard card={card} due={due} onDelete={onDelete} />
    </div>
  )
}

function BrowseCard({
  card,
  due,
  onDelete,
}: {
  card: Card
  due: boolean
  onDelete: () => void
}) {
  const { t } = useLanguage()
  const app = useApp()
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
    <article
      className={cx(
        'yolo-learning-cards-browse-card',
        card.preview && 'is-revealed',
      )}
    >
      <div className="yolo-learning-cards-browse-card-header">
        <span className="yolo-learning-cards-browse-card-point">
          {card.chapterTitle} · {card.pointTitle}
        </span>
        <div className="yolo-learning-cards-browse-card-meta">
          {due && (
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
        <CardIconBtn
          label={t('common.edit', '编辑')}
          disabled={!card.filePath}
          onClick={() =>
            card.filePath &&
            openMarkdownFile(app, card.filePath, card.startLine)
          }
        >
          <Pencil size={13} />
        </CardIconBtn>
        <CardIconBtn
          label={t('common.delete', '删除')}
          disabled={!card.filePath}
          onClick={onDelete}
        >
          <Trash2 size={13} />
        </CardIconBtn>
      </div>
    </article>
  )
}

/* ---------------- Review ---------------- */

type ReviewGrade = ReviewRating

type GradeTone = 'danger' | 'warning' | 'success' | 'easy'

const gradeDragTint: Record<ReviewGrade, string> = {
  again: 'yolo-learning-cards-review-tint-danger',
  hard: 'yolo-learning-cards-review-tint-warning',
  good: 'yolo-learning-cards-review-tint-success',
  easy: 'yolo-learning-cards-review-tint-easy',
}

type ReviewPhase = 'idle' | 'exit' | 'settle'

const EXIT_MS = 300
const PROMOTE_DELAY_MS = 120
const SETTLE_MS = 150

const exitTransforms: Record<ReviewGrade, string> = {
  again: 'translateX(-135%) rotate(-14deg)',
  hard: 'translateX(-135%) rotate(-8deg)',
  good: 'translateX(135%) rotate(8deg)',
  easy: 'translateX(135%) rotate(14deg)',
}

const peekFanLeft = 'translateX(-18px) rotate(-5deg) scale(0.98)'
const peekFanRight = 'translateX(18px) rotate(5deg) scale(0.98)'
const peekSingle = 'translateY(6px) scale(0.98)'
const peekCenter = 'translate(0,0) rotate(0deg) scale(1)'

function ReviewMode({
  projectSlug,
  cards,
  now,
  todayIntroducedCount,
  onReviewed,
  onExit,
}: {
  projectSlug: string | null
  cards: Card[]
  now: Date
  todayIntroducedCount: number
  onReviewed: (
    cardUuid: string,
    state: SrsCardState,
    introduced: boolean,
  ) => void
  onExit: () => void
}) {
  const { t } = useLanguage()
  const plugin = usePlugin()
  const initialQueue = useMemo(() => {
    const due = cards
      .filter((card) => card.srsState && card.dueAt && isDue(card.dueAt, now))
      .sort(
        (left, right) =>
          new Date(left.dueAt ?? 0).getTime() -
          new Date(right.dueAt ?? 0).getTime(),
      )
    const newCardLimit = Math.max(0, 20 - todayIntroducedCount)
    const newCards = cards
      .filter((card) => !card.srsState)
      .slice(0, newCardLimit)
    return [...due, ...newCards]
  }, [cards, now, todayIntroducedCount])

  const [queue, setQueue] = useState<Card[]>(initialQueue)
  const [index, setIndex] = useState(0)
  const [flipped, setFlipped] = useState(false)
  const [phase, setPhase] = useState<ReviewPhase>('idle')
  const [exitingGrade, setExitingGrade] = useState<ReviewGrade | null>(null)
  const [submittingGrade, setSubmittingGrade] = useState<ReviewGrade | null>(
    null,
  )
  const [promoting, setPromoting] = useState(false)
  const [peeksSettling, setPeeksSettling] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [schedulingByCardUuid, setSchedulingByCardUuid] = useState<
    Map<string, Record<ReviewGrade, CardScheduling>>
  >(new Map())
  const [drag, setDrag] = useState({ x: 0, y: 0 })
  const dragOrigin = useRef<{
    x: number
    y: number
    cardWidth: number
    extremeGradeThreshold: number
    pointerId: number
  } | null>(null)
  const dragCardWidthRef = useRef(300)
  const dragExtremeGradeThresholdRef = useRef(getExtremeGradeThreshold('mouse'))
  const activeCardRef = useRef<HTMLDivElement>(null)
  const timersRef = useRef<number[]>([])
  const hasStartedRef = useRef(false)
  const schedulingRequestGenerationRef = useRef(0)

  useEffect(() => {
    if (hasStartedRef.current) return
    setQueue(initialQueue)
    setIndex(0)
  }, [initialQueue])

  const card = queue[index]
  const nextCard = queue[index + 1]
  const done = index >= queue.length
  const remainingAfter = queue.length - index - 1
  const busy = phase !== 'idle' || submitting
  const progress = done ? 100 : ((index + 1) / queue.length) * 100

  const clearTimers = useCallback(() => {
    for (const id of timersRef.current) {
      window.clearTimeout(id)
    }
    timersRef.current = []
  }, [])

  const resetDrag = useCallback(() => {
    const pointerId = dragOrigin.current?.pointerId
    if (
      pointerId !== undefined &&
      activeCardRef.current?.hasPointerCapture(pointerId)
    ) {
      activeCardRef.current.releasePointerCapture(pointerId)
    }
    dragOrigin.current = null
    setDrag({ x: 0, y: 0 })
  }, [])

  useEffect(() => {
    if (!projectSlug || !card) return
    let cancelled = false
    const generation = schedulingRequestGenerationRef.current + 1
    schedulingRequestGenerationRef.current = generation
    const loadScheduling = async () => {
      try {
        const scheduling = await plugin
          .getLearningSrsStore()
          .getCardScheduling(projectSlug, card.id, new Date())
        if (
          !cancelled &&
          schedulingRequestGenerationRef.current === generation
        ) {
          setSchedulingByCardUuid((current) => {
            const next = new Map(current)
            next.set(card.id, scheduling)
            return next
          })
        }
      } catch {
        if (
          !cancelled &&
          schedulingRequestGenerationRef.current === generation
        ) {
          new Notice(
            t('learning.cards.srsLoadFailed', '复习计划加载失败，请重试'),
          )
        }
      }
    }
    void loadScheduling()
    return () => {
      cancelled = true
    }
  }, [card, plugin, projectSlug, t])

  const commitGrade = useCallback(
    async (grade: ReviewGrade) => {
      if (phase !== 'idle' || submitting || done || !card || !projectSlug)
        return

      clearTimers()
      setSubmitting(true)
      setSubmittingGrade(grade)
      const introduced = card.srsState === null
      let result
      try {
        result = await plugin
          .getLearningSrsStore()
          .reviewCard(projectSlug, card.id, grade, new Date())
      } catch {
        setSubmitting(false)
        setSubmittingGrade(null)
        resetDrag()
        new Notice(t('learning.cards.reviewSaveFailed', '评分保存失败，请重试'))
        return
      }

      hasStartedRef.current = true
      onReviewed(card.id, result.card, introduced)
      schedulingRequestGenerationRef.current += 1
      setSchedulingByCardUuid((current) => {
        const next = new Map(current)
        next.set(card.id, result.scheduling)
        return next
      })
      setQueue((current) =>
        updateReviewQueue(current, { ...card, srsState: result.card }, grade),
      )

      setSubmitting(false)
      setSubmittingGrade(null)
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
        setDrag({ x: 0, y: 0 })
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
    [
      card,
      clearTimers,
      done,
      onReviewed,
      phase,
      plugin,
      projectSlug,
      resetDrag,
      submitting,
      t,
    ],
  )

  useEffect(() => () => clearTimers(), [clearTimers])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (busy) return
      if (event.code === 'Escape') {
        event.preventDefault()
        onExit()
        return
      }
      if (done) return

      if (event.code === 'Space') {
        event.preventDefault()
        resetDrag()
        setFlipped((f) => !f)
        return
      }

      const grade = keyboardToGrade(event.key)
      if (grade) {
        event.preventDefault()
        resetDrag()
        void commitGrade(grade)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, done, onExit, commitGrade, resetDrag])

  const handlePointerDown = (event: PointerEvent) => {
    if (
      busy ||
      done ||
      dragOrigin.current ||
      !event.isPrimary ||
      event.button !== 0
    )
      return
    const cardWidth =
      activeCardRef.current?.getBoundingClientRect().width ?? 300
    const extremeGradeThreshold = getExtremeGradeThreshold(event.pointerType)
    dragCardWidthRef.current = cardWidth
    dragExtremeGradeThresholdRef.current = extremeGradeThreshold
    dragOrigin.current = {
      x: event.clientX,
      y: event.clientY,
      cardWidth,
      extremeGradeThreshold,
      pointerId: event.pointerId,
    }
    activeCardRef.current?.setPointerCapture(event.pointerId)
  }

  const handlePointerMove = (event: PointerEvent) => {
    if (
      !dragOrigin.current ||
      dragOrigin.current.pointerId !== event.pointerId ||
      busy
    )
      return
    setDrag({
      x: event.clientX - dragOrigin.current.x,
      y: 0,
    })
  }

  const handlePointerUp = (event: PointerEvent) => {
    if (!dragOrigin.current || dragOrigin.current.pointerId !== event.pointerId)
      return
    const { x, y, cardWidth, extremeGradeThreshold } = dragOrigin.current
    const dx = event.clientX - x
    const dy = event.clientY - y
    resetDrag()

    if (busy || done) return

    if (Math.hypot(dx, dy) < 10) {
      setFlipped((f) => !f)
      return
    }

    const grade = resolveSwipeGrade(dx, cardWidth, extremeGradeThreshold)
    if (grade) {
      setDrag({ x: dx, y: 0 })
      void commitGrade(grade)
    }
  }

  const handlePointerCancel = (event: PointerEvent) => {
    if (dragOrigin.current?.pointerId !== event.pointerId) return
    resetDrag()
  }

  const activeGrade =
    exitingGrade ??
    submittingGrade ??
    resolveSwipeGrade(
      drag.x,
      dragCardWidthRef.current,
      dragExtremeGradeThresholdRef.current,
    )
  const scheduling = card ? schedulingByCardUuid.get(card.id) : undefined
  const gradeMeta: Record<
    ReviewGrade,
    { label: string; hint: string; tone: GradeTone }
  > = {
    again: {
      label: t('learning.cards.reviewAgain', '重来'),
      hint: formatSchedulingHint(scheduling?.again, new Date()),
      tone: 'danger',
    },
    hard: {
      label: t('learning.cards.reviewHard', '模糊'),
      hint: formatSchedulingHint(scheduling?.hard, new Date()),
      tone: 'warning',
    },
    good: {
      label: t('learning.cards.reviewGood', '会了'),
      hint: formatSchedulingHint(scheduling?.good, new Date()),
      tone: 'success',
    },
    easy: {
      label: t('learning.cards.reviewEasy', '简单'),
      hint: formatSchedulingHint(scheduling?.easy, new Date()),
      tone: 'easy',
    },
  }
  const flipHint = t('learning.cards.flipHint', '点击翻面或按空格')

  if (queue.length === 0) {
    return (
      <div className="yolo-learning-cards-review-done">
        <p className="yolo-learning-cards-review-done-title">
          {t('learning.cards.noReviewCards', '暂无到期卡片')}
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

  const cardTransform = exitingGrade
    ? exitTransforms[exitingGrade]
    : `translateX(${drag.x}px) rotate(${drag.x * 0.04}deg)`

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
                    {promoteCard.chapterTitle} · {promoteCard.pointTitle}
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
                    <div
                      className={cx(
                        'yolo-learning-cards-review-card-point',
                        activeGrade &&
                          'yolo-learning-cards-review-card-point-with-grade',
                      )}
                    >
                      {card.chapterTitle} · {card.pointTitle}
                    </div>
                    {activeGrade && (
                      <div
                        className={cx(
                          'yolo-learning-cards-review-grade-badge',
                          `yolo-learning-cards-review-grade-badge-${gradeMeta[activeGrade].tone}`,
                        )}
                      >
                        {gradeMeta[activeGrade].label}
                      </div>
                    )}
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
                    <div
                      className={cx(
                        'yolo-learning-cards-review-card-point',
                        activeGrade &&
                          'yolo-learning-cards-review-card-point-with-grade',
                      )}
                    >
                      {card.chapterTitle} · {card.pointTitle}
                    </div>
                    {activeGrade && (
                      <div
                        className={cx(
                          'yolo-learning-cards-review-grade-badge',
                          `yolo-learning-cards-review-grade-badge-${gradeMeta[activeGrade].tone}`,
                        )}
                      >
                        {gradeMeta[activeGrade].label}
                      </div>
                    )}
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
        {(['again', 'hard', 'good', 'easy'] as const).map((grade) => (
          <EvalBtn
            key={grade}
            tone={gradeMeta[grade].tone}
            label={gradeMeta[grade].label}
            hint={gradeMeta[grade].hint}
            active={activeGrade === grade}
            disabled={busy}
            onClick={() => void commitGrade(grade)}
          />
        ))}
      </div>

      <div className="yolo-learning-cards-review-shortcuts">
        {t(
          'learning.cards.reviewShortcuts',
          '空格翻面 · 左右拖动或 1 / 2 / 3 / 4 评分 · Esc 返回浏览',
        )}
      </div>
    </div>
  )
}

function EvalBtn({
  tone,
  label,
  hint,
  active,
  disabled,
  onClick,
}: {
  tone: GradeTone
  label: string
  hint: string
  active: boolean
  disabled?: boolean
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cx(
        'yolo-learning-cards-eval-btn',
        `yolo-learning-cards-eval-btn-${tone}`,
        active && 'yolo-learning-cards-eval-btn-active',
      )}
    >
      <span className="yolo-learning-cards-eval-label">{label}</span>
      <span className="yolo-learning-cards-eval-hint">{hint}</span>
    </button>
  )
}

function formatSchedulingHint(
  scheduling: CardScheduling | undefined,
  now: Date,
): string {
  if (!scheduling) return '…'
  const minutes = Math.max(
    1,
    Math.round((scheduling.due.getTime() - now.getTime()) / 60_000),
  )
  if (minutes < 60) return `${minutes} 分钟后`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} 小时后`
  return `${Math.max(1, scheduling.scheduledDays)} 天后`
}

function CardIconBtn({
  children,
  label,
  onClick,
  disabled,
}: {
  children: ReactNode
  label: string
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      data-no-dnd
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation()
        onClick()
      }}
      className="yolo-learning-cards-icon-btn"
    >
      {children}
    </button>
  )
}
