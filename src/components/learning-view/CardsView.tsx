import {
  type Collision,
  type CollisionDetection,
  DndContext,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  DragOverlay,
  type DragStartEvent,
  type DropAnimation,
  PointerSensor,
  TouchSensor,
  defaultDropAnimationSideEffects,
  rectIntersection,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import { SortableContext, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import * as Popover from '@radix-ui/react-popover'
import cx from 'clsx'
import {
  CircleCheck,
  Ellipsis,
  PauseCircle,
  PlayCircle,
  Plus,
  RotateCcw,
  Trash2,
  X,
} from 'lucide-react'
import { Notice, TFile, normalizePath } from 'obsidian'
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type {
  CSSProperties,
  PointerEvent,
  MouseEvent as ReactMouseEvent,
} from 'react'
import { createPortal } from 'react-dom'

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
  LEARNING_TARGET_RETENTION,
  MEMORY_RETENTION_HORIZON_MS,
} from '../../core/learning/learningStats'
import {
  fsrsStateToMastery,
  isDue,
} from '../../core/learning/srs/masteryMapping'
import type {
  CardScheduling,
  ReviewRating,
  SrsCardState,
} from '../../core/learning/srs/srsTypes'
import type {
  CardChapter as VaultCardChapter,
  Chapter as VaultChapter,
  KnowledgePoint as VaultKnowledgePoint,
  Project as VaultProject,
} from '../../core/learning/types'
import { YoloPopoverContent } from '../common/popover'

import { CardMarkdown } from './CardMarkdown'
import {
  type CardGenerationWorkspace,
  type WorkspaceCard,
  calculateTargetFileIndex,
  groupCardsByProjectOrder,
  isBrowseDragDisabled,
  mergeDiskAndPreviewCards,
} from './cardsWorkspace'
import { formatLearningText } from './i18n'
import { type Mastery, MasteryDot, SelectMenu } from './primitives'
import {
  buildInitialReviewQueue,
  getExtremeGradeThreshold,
  keyboardToGrade,
  resolveSwipeGrade,
  updateReviewQueue,
} from './reviewInteractions'

export const cardModes = ['学习', '浏览'] as const
export type CardMode = (typeof cardModes)[number]
const masteryFilters = ['全部', '已掌握', '学习中', '未开始', '已暂停'] as const

type Card = WorkspaceCard

type NewCardDraft = {
  key: number
  chapter: VaultChapter | VaultCardChapter
  point: VaultKnowledgePoint | null
  filePath: string
}

type CardContainers = Record<string, string[]>

type PendingDrop = {
  cardIds: string[]
  kpUuid: string
  persistedIndex: number
}

type DropProjection = {
  kpUuid: string
  index: number
  slotIndex: number
}

type VirtualDropSlot = {
  kpUuid: string
  index: number
  offsetX: number
  offsetY: number
}

type VirtualDropSlots = Map<
  string,
  { grid: HTMLElement; slots: VirtualDropSlot[] }
>

type CardLayoutTransition = {
  direction: 'open' | 'close' | 'drag'
  rects: Map<string, DOMRect>
}

type MarqueePoint = { x: number; y: number }

type MarqueeRect = {
  left: number
  top: number
  width: number
  height: number
}

type MarqueeSession = {
  active: boolean
  additive: boolean
  baseline: Set<string>
  origin: MarqueePoint
  pointerId: number
  startClientX: number
  startClientY: number
  latestClientX: number
  latestClientY: number
  scrollContainer: HTMLElement
}

const DROP_SLOT_HYSTERESIS = 6
const DROP_CONTAINER_ENTRY_THRESHOLD = 12
const CARD_DRAG_SCALE = 1.015
const CARD_DROP_DURATION = 150
const MARQUEE_ACTIVATION_DISTANCE = 4
const MARQUEE_SCROLL_EDGE = 48
const MARQUEE_MAX_SCROLL_SPEED = 18
const CARD_DROP_ANIMATION: DropAnimation = {
  duration: CARD_DROP_DURATION,
  easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
  keyframes: ({ transform: { initial, final } }) => [
    { transform: CSS.Transform.toString(initial) },
    {
      transform: CSS.Transform.toString({
        ...final,
        scaleX: final.scaleX / CARD_DRAG_SCALE,
        scaleY: final.scaleY / CARD_DRAG_SCALE,
      }),
    },
  ],
  sideEffects: defaultDropAnimationSideEffects({
    className: { dragOverlay: 'yolo-learning-cards-drag-overlay-dropping' },
    styles: { active: { opacity: '0' } },
  }),
}

function createCardContainers(
  project: VaultProject,
  cards: Card[],
): CardContainers {
  if (project.kind === 'cards') {
    return Object.fromEntries(
      project.chapters.map((chapter) => [
        chapter.id,
        cards
          .filter((card) => card.chapterId === chapter.id)
          .map((card) => card.id),
      ]),
    )
  }
  return Object.fromEntries(
    project.knowledgePoints.map((point) => [
      point.uuid,
      cards.filter((card) => card.kpUuid === point.uuid).map((card) => card.id),
    ]),
  )
}

function createVirtualDropSlots(
  root: HTMLElement,
  activeIds: ReadonlySet<string>,
  activeRect: { width: number; height: number },
): VirtualDropSlots {
  const result: VirtualDropSlots = new Map()
  const points = root.querySelectorAll<HTMLElement>('[data-yolo-kp-uuid]')

  points.forEach((point) => {
    const kpUuid = point.dataset.yoloKpUuid
    const grid = point.querySelector<HTMLElement>(
      '.yolo-learning-cards-point-grid',
    )
    if (!kpUuid || !grid) return

    const gridRect = grid.getBoundingClientRect()
    const cardElements = Array.from(
      grid.querySelectorAll<HTMLElement>(':scope > [data-yolo-card-id]'),
    )
    const cardRects = cardElements.map((element) =>
      element.getBoundingClientRect(),
    )
    const containsActive = cardElements.some(
      (element) =>
        element.dataset.yoloCardId && activeIds.has(element.dataset.yoloCardId),
    )
    const slots = cardRects.map((rect, index) => ({
      kpUuid,
      index,
      offsetX: rect.left - gridRect.left + activeRect.width / 2,
      offsetY: rect.top - gridRect.top + activeRect.height / 2,
    }))

    if (!containsActive || activeIds.size > 1) {
      const lastRect = cardRects.at(-1)
      if (!lastRect) {
        slots.push({
          kpUuid,
          index: 0,
          offsetX: activeRect.width / 2,
          offsetY: activeRect.height / 2,
        })
      } else {
        const styles = getComputedStyle(grid)
        const columnGap = Number.parseFloat(styles.columnGap) || 0
        const rowGap = Number.parseFloat(styles.rowGap) || 0
        const chapter = point.closest<HTMLElement>(
          '.yolo-learning-cards-chapter',
        )
        const chapterStyles = chapter ? getComputedStyle(chapter) : null
        const pointStyles = getComputedStyle(point)
        const availableRight = chapter
          ? chapter.getBoundingClientRect().right -
            (Number.parseFloat(chapterStyles?.paddingRight ?? '') || 0) -
            (Number.parseFloat(pointStyles.paddingRight) || 0)
          : gridRect.right
        const fitsCurrentRow =
          lastRect.right + columnGap + activeRect.width <= availableRight + 1
        const rowRects = cardRects.filter(
          (rect) => Math.abs(rect.top - lastRect.top) < 1,
        )
        const nextLeft = fitsCurrentRow
          ? lastRect.right + columnGap
          : gridRect.left
        const nextTop = fitsCurrentRow
          ? lastRect.top
          : Math.max(...rowRects.map((rect) => rect.bottom)) + rowGap
        slots.push({
          kpUuid,
          index: cardRects.length,
          offsetX: nextLeft - gridRect.left + activeRect.width / 2,
          offsetY: nextTop - gridRect.top + activeRect.height / 2,
        })
      }
    }

    result.set(kpUuid, { grid, slots })
  })

  return result
}

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
  mode,
  onModeChange,
  onStudyCountChange,
}: {
  project: VaultProject | null
  generation: CardGenerationWorkspace | null
  mode: CardMode
  onModeChange: (mode: CardMode) => void
  onStudyCountChange: (count: number) => void
}) {
  const {
    cards,
    loading,
    now,
    todayIntroducedCount,
    applyReviewResult,
    error,
    refresh,
    writing,
    setWriting,
  } = useProjectCards(project, generation)
  const initialReviewQueue = useMemo(
    () =>
      buildInitialReviewQueue(
        cards.filter((card) => !card.preview && !card.suspended),
        now,
        todayIntroducedCount,
      ),
    [cards, now, todayIntroducedCount],
  )

  useEffect(() => {
    if (mode === '浏览') onStudyCountChange(initialReviewQueue.length)
  }, [initialReviewQueue.length, mode, onStudyCountChange])

  return (
    <div className="yolo-learning-cards-view yolo-learning-scrollbar-thin">
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
          initialQueue={initialReviewQueue}
          onReviewed={applyReviewResult}
          onQueueCountChange={onStudyCountChange}
          onExit={() => onModeChange('浏览')}
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
          normalizePath(
            project.kind === 'cards'
              ? (chapter as VaultCardChapter).cardsFilePath
              : `${chapter.folderPath}/cards.md`,
          ),
        )
        if (!(file instanceof TFile)) continue
        const content = await app.vault.cachedRead(file)
        const parsedFile =
          project.kind === 'cards'
            ? parseCardFile(content, {
                mode: 'chapter-direct',
                path: file.path,
              })
            : parseCardFile(content, file.path)
        if (!parsedFile.complete) {
          throw new CardFileFormatError(file.path, parsedFile.errors)
        }
        for (const [sourceIndex, entry] of parsedFile.cards.entries()) {
          if (project.kind === 'cards') {
            const srsState = projectState.cards[entry.cardUuid] ?? null
            nextCards.push({
              id: entry.cardUuid,
              kpUuid: chapter.id,
              pointId: null,
              pointTitle: '',
              chapterId: chapter.id,
              chapterTitle: chapter.title,
              front: entry.front,
              back: entry.back,
              mastery: srsState ? fsrsStateToMastery(srsState.state) : 'new',
              dueAt: srsState?.due ?? null,
              srsState,
              filePath: file.path,
              startLine: entry.startLine,
              sourceIndex,
              preview: false,
              suspended: projectState.suspended.includes(entry.cardUuid),
            })
            continue
          }
          if (entry.kpUuid === null) {
            throw new CardFileFormatError(file.path, parsedFile.errors)
          }
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
            suspended: projectState.suspended.includes(entry.cardUuid),
          })
        }
      }
      const projectScan = await scanProjectCards(
        app,
        project.folderPath,
        project.chapters.map((chapter) =>
          project.kind === 'cards'
            ? (chapter as VaultCardChapter).cardsFilePath
            : `${chapter.folderPath}/cards.md`,
        ),
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
        suspended: false,
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

  return {
    cards: mergedCards,
    loading,
    now,
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
    const nextWakeAt = Math.min(
      nextDueAt,
      nextMidnight.getTime(),
      nowMs + 60_000,
    )
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
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null)
  const [batchSelectedCardIds, setBatchSelectedCardIds] = useState<Set<string>>(
    new Set(),
  )
  const [marqueeRect, setMarqueeRect] = useState<MarqueeRect | null>(null)
  const [inspectorCardId, setInspectorCardId] = useState<string | null>(null)
  const [inspectorClosing, setInspectorClosing] = useState(false)
  const [newCardDraft, setNewCardDraft] = useState<NewCardDraft | null>(null)
  const [optimisticInspectorCard, setOptimisticInspectorCard] =
    useState<Card | null>(null)
  const [activeCardId, setActiveCardId] = useState<string | null>(null)
  const [, setActiveCardHeight] = useState<number | null>(null)
  const [activeDragCardIds, setActiveDragCardIds] = useState<string[]>([])
  const [activeCardHeights, setActiveCardHeights] = useState<
    Record<string, number>
  >({})
  const [dragContainers, setDragContainers] = useState<CardContainers | null>(
    null,
  )
  const [pendingDrop, setPendingDrop] = useState<PendingDrop | null>(null)
  const originalContainersRef = useRef<CardContainers | null>(null)
  const dragContainersRef = useRef<CardContainers | null>(null)
  const dragAreaRef = useRef<HTMLDivElement | null>(null)
  const inspectorRef = useRef<CardInspectorHandle | null>(null)
  const pendingCardLayoutTransitionRef = useRef<CardLayoutTransition | null>(
    null,
  )
  const cardLayoutAnimationsRef = useRef(new Map<HTMLElement, Animation>())
  const newCardDraftKeyRef = useRef(0)
  const cardContainerByIdRef = useRef(new Map<string, string>())
  const dragCardIdsRef = useRef<string[]>([])
  const virtualDropSlotsRef = useRef<VirtualDropSlots>(new Map())
  const lastProjectionRef = useRef<DropProjection | null>(null)
  const pendingDragMoveRef = useRef<{
    active: DragMoveEvent['active']
    over: NonNullable<DragMoveEvent['over']>
  } | null>(null)
  const dragMoveFrameRef = useRef<number | null>(null)
  const marqueeScrollFrameRef = useRef<number | null>(null)
  const marqueeSessionRef = useRef<MarqueeSession | null>(null)
  const dropSettleTimerRef = useRef<number | null>(null)
  const dragCollisionRectRef = useRef<
    Parameters<CollisionDetection>[0]['collisionRect'] | null
  >(null)
  const lastContainerCollisionRef = useRef<Collision | null>(null)
  const containerCollisionStickyRef = useRef(false)
  const captureCardLayout = useCallback(
    (direction: CardLayoutTransition['direction']) => {
      const root = dragAreaRef.current
      const layout = root?.closest<HTMLElement>(
        '.yolo-learning-cards-browser-layout',
      )
      if (
        !root ||
        !layout ||
        getComputedStyle(layout).display !== 'grid' ||
        window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
        (direction !== 'drag' &&
          root.querySelector('.yolo-learning-cards-sortable.is-dragging'))
      ) {
        pendingCardLayoutTransitionRef.current = null
        return
      }

      const rects = new Map<string, DOMRect>()
      root
        .querySelectorAll<HTMLElement>('[data-yolo-card-id]')
        .forEach((element) => {
          const cardId = element.dataset.yoloCardId
          if (cardId) rects.set(cardId, element.getBoundingClientRect())
        })
      pendingCardLayoutTransitionRef.current = { direction, rects }
    },
    [],
  )
  const collisionDetection = useCallback<CollisionDetection>((args) => {
    dragCollisionRectRef.current = args.collisionRect
    const collisions = rectIntersection({
      ...args,
      droppableContainers: args.droppableContainers.filter(
        (container) => container.data.current?.kind === 'container',
      ),
    })
    const activeCenterY = args.collisionRect.top + args.collisionRect.height / 2
    const enteredCollision = collisions.find((collision) => {
      const rect = args.droppableRects.get(collision.id)
      return (
        rect &&
        activeCenterY >= rect.top + DROP_CONTAINER_ENTRY_THRESHOLD &&
        activeCenterY <= rect.bottom - DROP_CONTAINER_ENTRY_THRESHOLD
      )
    })
    if (enteredCollision) {
      lastContainerCollisionRef.current = enteredCollision
      containerCollisionStickyRef.current = false
      return [enteredCollision]
    }
    if (lastContainerCollisionRef.current) {
      containerCollisionStickyRef.current = true
      return [lastContainerCollisionRef.current]
    }
    const initialCollision = collisions[0]
    if (!initialCollision) return []
    lastContainerCollisionRef.current = initialCollision
    containerCollisionStickyRef.current = false
    return [initialCollision]
  }, [])
  useEffect(
    () => () => {
      if (dragMoveFrameRef.current !== null) {
        cancelAnimationFrame(dragMoveFrameRef.current)
      }
      if (dropSettleTimerRef.current !== null) {
        window.clearTimeout(dropSettleTimerRef.current)
      }
      if (marqueeScrollFrameRef.current !== null) {
        cancelAnimationFrame(marqueeScrollFrameRef.current)
      }
    },
    [],
  )
  useEffect(
    () => () => {
      cardLayoutAnimationsRef.current.forEach((animation) => {
        animation.cancel()
      })
      cardLayoutAnimationsRef.current.clear()
    },
    [],
  )
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
    已暂停: t('learning.cards.suspended', '已暂停'),
  }

  const masteryValue: Record<
    Exclude<(typeof masteryFilters)[number], '已暂停'>,
    Mastery | null
  > = {
    全部: null,
    已掌握: 'mastered',
    学习中: 'learning',
    未开始: 'new',
  }
  const filteredCards = cards.filter((card) =>
    mastery === '已暂停'
      ? card.suspended
      : !masteryValue[mastery] ||
        (!card.suspended && card.mastery === masteryValue[mastery]),
  )
  const activeCard = cards.find((card) => card.id === activeCardId)
  const activeDragCards = activeDragCardIds
    .map((cardId) => cards.find((card) => card.id === cardId))
    .filter((card): card is Card => Boolean(card))
  const persistedInspectorCard =
    cards.find((card) => card.id === inspectorCardId) ?? null
  const draftInspectorCard: Card | null = newCardDraft
    ? {
        id: `new-card-${newCardDraft.key}`,
        kpUuid: newCardDraft.point?.uuid ?? newCardDraft.chapter.id,
        pointId: newCardDraft.point?.id ?? null,
        pointTitle: newCardDraft.point?.title ?? '',
        chapterId: newCardDraft.chapter.id,
        chapterTitle: newCardDraft.chapter.title,
        front: '',
        back: '',
        mastery: 'new',
        dueAt: null,
        srsState: null,
        filePath: newCardDraft.filePath,
        startLine: 0,
        sourceIndex: Number.MAX_SAFE_INTEGER,
        preview: false,
        suspended: false,
      }
    : null
  const inspectorCard =
    persistedInspectorCard ?? optimisticInspectorCard ?? draftInspectorCard
  const inspectorOpen = Boolean(inspectorCard)
  const baseGroups = project
    ? project.kind === 'outline'
      ? groupCardsByProjectOrder(project, filteredCards)
      : project.chapters.map((chapter) => ({
          chapter,
          points: [
            {
              point: {
                id: chapter.id,
                uuid: chapter.id,
                chapterId: chapter.id,
                title: '',
              },
              cards: filteredCards.filter(
                (card) => card.chapterId === chapter.id,
              ),
            },
          ],
        }))
    : []
  const cardsById = new Map(cards.map((card) => [card.id, card]))
  const groups = dragContainers
    ? baseGroups.map((group) => ({
        ...group,
        points: group.points.map(({ point }) => ({
          point,
          cards: (dragContainers[point.uuid] ?? [])
            .map((id) => cardsById.get(id))
            .filter((card): card is Card => Boolean(card)),
        })),
      }))
    : baseGroups
  const visibleGroups = groups
    .filter(
      ({ chapter }) => chapterFilter === 'all' || chapter.id === chapterFilter,
    )
    .map((group) => ({
      ...group,
      points: group.points.filter(
        ({ point }) =>
          project?.kind === 'cards' ||
          pointFilter === 'all' ||
          point.id === pointFilter,
      ),
    }))
    .filter((group) => group.points.length > 0)
  const selectableCards = cards.filter((card) => card.filePath && !card.preview)
  const batchSelectedCards = selectableCards.filter((card) =>
    batchSelectedCardIds.has(card.id),
  )
  const updateMarqueeSelection = useCallback(
    (clientX: number, clientY: number) => {
      const session = marqueeSessionRef.current
      const root = dragAreaRef.current
      if (!session?.active || !root) return
      session.latestClientX = clientX
      session.latestClientY = clientY
      const rootRect = root.getBoundingClientRect()
      const current = {
        x: clientX - rootRect.left,
        y: clientY - rootRect.top,
      }
      const left = Math.min(session.origin.x, current.x)
      const top = Math.min(session.origin.y, current.y)
      const right = Math.max(session.origin.x, current.x)
      const bottom = Math.max(session.origin.y, current.y)
      setMarqueeRect({ left, top, width: right - left, height: bottom - top })

      const next = session.additive
        ? new Set(session.baseline)
        : new Set<string>()
      root
        .querySelectorAll<HTMLElement>('[data-yolo-marquee-selectable]')
        .forEach((element) => {
          const cardId = element.dataset.yoloCardId
          if (!cardId) return
          const rect = element.getBoundingClientRect()
          const centerX = rect.left + rect.width / 2 - rootRect.left
          const centerY = rect.top + rect.height / 2 - rootRect.top
          if (
            centerX >= left &&
            centerX <= right &&
            centerY >= top &&
            centerY <= bottom
          ) {
            next.add(cardId)
          }
        })
      setBatchSelectedCardIds((currentSelection) => {
        if (
          currentSelection.size === next.size &&
          [...currentSelection].every((cardId) => next.has(cardId))
        ) {
          return currentSelection
        }
        return next
      })
    },
    [],
  )
  const stopMarquee = useCallback(() => {
    const session = marqueeSessionRef.current
    const root = dragAreaRef.current
    if (session && root?.hasPointerCapture(session.pointerId)) {
      root.releasePointerCapture(session.pointerId)
    }
    if (marqueeScrollFrameRef.current !== null) {
      cancelAnimationFrame(marqueeScrollFrameRef.current)
      marqueeScrollFrameRef.current = null
    }
    marqueeSessionRef.current = null
    setMarqueeRect(null)
  }, [])
  const startMarqueeAutoScroll = useCallback(() => {
    if (marqueeScrollFrameRef.current !== null) return
    const tick = () => {
      const session = marqueeSessionRef.current
      if (!session?.active) {
        marqueeScrollFrameRef.current = null
        return
      }
      const container = session.scrollContainer
      const rect = container.getBoundingClientRect()
      const pointerY = session.latestClientY
      let speed = 0
      if (pointerY < rect.top + MARQUEE_SCROLL_EDGE) {
        const intensity = Math.min(
          1,
          (rect.top + MARQUEE_SCROLL_EDGE - pointerY) / MARQUEE_SCROLL_EDGE,
        )
        speed = -MARQUEE_MAX_SCROLL_SPEED * intensity * intensity
      } else if (pointerY > rect.bottom - MARQUEE_SCROLL_EDGE) {
        const intensity = Math.min(
          1,
          (pointerY - (rect.bottom - MARQUEE_SCROLL_EDGE)) /
            MARQUEE_SCROLL_EDGE,
        )
        speed = MARQUEE_MAX_SCROLL_SPEED * intensity * intensity
      }
      if (speed !== 0) {
        const previousScrollTop = container.scrollTop
        container.scrollTop += speed
        if (container.scrollTop !== previousScrollTop) {
          updateMarqueeSelection(session.latestClientX, session.latestClientY)
        }
      }
      marqueeScrollFrameRef.current = requestAnimationFrame(tick)
    }
    marqueeScrollFrameRef.current = requestAnimationFrame(tick)
  }, [updateMarqueeSelection])
  const handleMarqueePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const root = dragAreaRef.current
    if (
      !root ||
      event.button !== 0 ||
      event.pointerType !== 'mouse' ||
      !window.matchMedia('(hover: hover) and (pointer: fine)').matches ||
      activeCardId ||
      marqueeSessionRef.current
    ) {
      return
    }
    const target = event.target as Element | null
    if (
      !target?.closest ||
      target.closest(
        '[data-yolo-card-id], button, input, textarea, select, a, h1, h2, h3, p, span, [contenteditable="true"]',
      )
    ) {
      return
    }
    const scrollContainer = root.closest<HTMLElement>(
      '.yolo-learning-cards-view',
    )
    if (!scrollContainer) return
    const rootRect = root.getBoundingClientRect()
    const additive = event.metaKey || event.ctrlKey
    marqueeSessionRef.current = {
      active: false,
      additive,
      baseline: additive ? new Set(batchSelectedCardIds) : new Set(),
      origin: {
        x: event.clientX - rootRect.left,
        y: event.clientY - rootRect.top,
      },
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      latestClientX: event.clientX,
      latestClientY: event.clientY,
      scrollContainer,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
  }
  const handleMarqueePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const session = marqueeSessionRef.current
    if (!session || session.pointerId !== event.pointerId) return
    session.latestClientX = event.clientX
    session.latestClientY = event.clientY
    if (!session.active) {
      const distance = Math.hypot(
        event.clientX - session.startClientX,
        event.clientY - session.startClientY,
      )
      if (distance < MARQUEE_ACTIVATION_DISTANCE) return
      session.active = true
      startMarqueeAutoScroll()
    }
    event.preventDefault()
    updateMarqueeSelection(event.clientX, event.clientY)
  }
  const handleMarqueePointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const session = marqueeSessionRef.current
    if (!session || session.pointerId !== event.pointerId) return
    if (session.active) {
      updateMarqueeSelection(event.clientX, event.clientY)
    } else if (!session.additive) {
      setBatchSelectedCardIds(new Set())
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    stopMarquee()
  }
  const handleMarqueePointerCancel = (event: PointerEvent<HTMLDivElement>) => {
    const session = marqueeSessionRef.current
    if (!session || session.pointerId !== event.pointerId) return
    setBatchSelectedCardIds(new Set(session.baseline))
    stopMarquee()
  }
  useEffect(() => {
    setBatchSelectedCardIds(new Set())
  }, [chapterFilter, mastery, pointFilter])
  useEffect(() => {
    const existingIds = new Set(
      cards
        .filter((card) => card.filePath && !card.preview)
        .map((card) => card.id),
    )
    setBatchSelectedCardIds((current) => {
      const next = new Set(
        [...current].filter((cardId) => existingIds.has(cardId)),
      )
      return next.size === current.size ? current : next
    })
  }, [cards])
  useEffect(() => {
    const ownerDocument = dragAreaRef.current?.ownerDocument ?? document
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        (!marqueeSessionRef.current && batchSelectedCardIds.size === 0)
      ) {
        return
      }
      event.preventDefault()
      stopMarquee()
      setBatchSelectedCardIds(new Set())
    }
    ownerDocument.addEventListener('keydown', handleKeyDown)
    return () => ownerDocument.removeEventListener('keydown', handleKeyDown)
  }, [batchSelectedCardIds.size, stopMarquee])
  const selectedCardIsVisible = selectedCardId
    ? optimisticInspectorCard?.id === selectedCardId ||
      visibleGroups.some((group) =>
        group.points.some(({ cards: pointCards }) =>
          pointCards.some((card) => card.id === selectedCardId),
        ),
      )
    : false
  const settledIndexes = new Set(
    generation?.settled.map((item) => item.chapterIndex),
  )
  const generationActive = Boolean(
    generation && settledIndexes.size < (project?.chapters.length ?? 0),
  )
  const writeDisabled = Boolean(error || writing)
  useLayoutEffect(() => {
    const transition = pendingCardLayoutTransitionRef.current
    pendingCardLayoutTransitionRef.current = null
    const root = dragAreaRef.current
    if (!transition || !root) return

    cardLayoutAnimationsRef.current.forEach((animation) => animation.cancel())
    cardLayoutAnimationsRef.current.clear()

    const movements: Array<{
      distance: number
      dx: number
      dy: number
      element: HTMLElement
    }> = []
    root
      .querySelectorAll<HTMLElement>('[data-yolo-card-id]')
      .forEach((element) => {
        const cardId = element.dataset.yoloCardId
        const previousRect = cardId ? transition.rects.get(cardId) : undefined
        if (!previousRect) return
        const nextRect = element.getBoundingClientRect()
        const dx = previousRect.left - nextRect.left
        const dy = previousRect.top - nextRect.top
        const distance = Math.hypot(dx, dy)
        if (distance < 1) return
        movements.push({ distance, dx, dy, element })
      })

    const maxDistance = Math.max(
      ...movements.map(({ distance }) => distance),
      1,
    )
    movements.forEach(({ distance, dx, dy, element }) => {
      const animation = element.animate(
        [
          { transform: `translate3d(${dx}px, ${dy}px, 0)` },
          { transform: 'translate3d(0, 0, 0)' },
        ],
        {
          delay:
            transition.direction === 'drag'
              ? 0
              : 8 + (distance / maxDistance) * 8,
          duration:
            transition.direction === 'drag'
              ? 160
              : transition.direction === 'open'
                ? 250
                : 280,
          easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
          fill: 'both',
        },
      )
      cardLayoutAnimationsRef.current.set(element, animation)
      const clearAnimation = () => {
        if (cardLayoutAnimationsRef.current.get(element) !== animation) return
        cardLayoutAnimationsRef.current.delete(element)
        animation.cancel()
      }
      animation.onfinish = clearAnimation
      animation.oncancel = () => {
        if (cardLayoutAnimationsRef.current.get(element) === animation) {
          cardLayoutAnimationsRef.current.delete(element)
        }
      }
    })
  }, [dragContainers, inspectorOpen])
  const chapterMemoryRetention = useMemo(() => {
    const totals = new Map<string, { count: number; retrievability: number }>()
    const srsStore = plugin.getLearningSrsStore()
    const horizon = new Date(now.getTime() + MEMORY_RETENTION_HORIZON_MS)
    cards.forEach((card) => {
      if (card.preview) return
      const current = totals.get(card.chapterId) ?? {
        count: 0,
        retrievability: 0,
      }
      current.count += 1
      if (card.srsState) {
        current.retrievability += srsStore.getCardRetrievability(
          card.srsState,
          horizon,
        )
      }
      totals.set(card.chapterId, current)
    })
    return new Map(
      Array.from(totals, ([chapterId, total]) => [
        chapterId,
        total.retrievability / total.count,
      ]),
    )
  }, [cards, now, plugin])

  const withWrite = async (operation: () => Promise<void>) => {
    if (writeDisabled) return false
    setWriting(true)
    try {
      await operation()
      refresh()
      return true
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
      return false
    } finally {
      setWriting(false)
    }
  }

  const beginInspectorClose = useCallback(() => {
    setSelectedCardId(null)
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setInspectorCardId(null)
      setNewCardDraft(null)
      setOptimisticInspectorCard(null)
      setInspectorClosing(false)
      return
    }
    setInspectorClosing(true)
  }, [])

  const handleCloseInspector = useCallback(async (): Promise<boolean> => {
    if (inspectorRef.current && !(await inspectorRef.current.flush())) {
      return false
    }
    beginInspectorClose()
    return true
  }, [beginInspectorClose])

  useEffect(() => {
    if (!selectedCardId || selectedCardIsVisible) return
    void handleCloseInspector()
  }, [handleCloseInspector, selectedCardId, selectedCardIsVisible])

  const handleSelectCard = async (
    cardId: string,
    closeIfSelected = true,
  ): Promise<boolean> => {
    if (selectedCardId === cardId && !closeIfSelected) return true
    if (selectedCardId === cardId) return handleCloseInspector()
    if (inspectorRef.current && !(await inspectorRef.current.flush())) {
      return false
    }
    if (!inspectorCard) captureCardLayout('open')
    setInspectorClosing(false)
    setNewCardDraft(null)
    setOptimisticInspectorCard(null)
    setInspectorCardId(cardId)
    setSelectedCardId(cardId)
    return true
  }

  const handleUpdateCard = (
    card: Card,
    content: { front: string; back: string },
  ): Promise<boolean> => {
    if (!card.filePath) return Promise.resolve(false)
    return fileStore
      .updateCard(
        card.filePath,
        card.id,
        content,
        project?.kind === 'cards' ? 'chapter-direct' : 'knowledge-linked',
      )
      .then(() => {
        refresh()
        return true
      })
      .catch((operationError: unknown) => {
        console.error('[YOLO] Failed to update learning card:', operationError)
        new Notice(
          operationError instanceof CardFileConflictError
            ? t(
                'learning.cards.cardFileConflict',
                '卡片文件已在其他位置修改，请刷新后重试',
              )
            : t('learning.cards.cardUpdateFailed', '卡片更新失败，请重试'),
        )
        return false
      })
  }

  const handleCreateCard = (
    draft: NewCardDraft,
    card: Card,
    content: { front: string; back: string },
  ): Promise<boolean> => {
    if (!project || (!content.front.trim() && !content.back.trim())) {
      return Promise.resolve(true)
    }
    const create =
      project.kind === 'cards'
        ? fileStore.createChapterCard(
            project.folderPath,
            draft.filePath,
            draft.chapter.title,
            content,
          )
        : fileStore.createCard(
            project.folderPath,
            draft.filePath,
            draft.chapter.title,
            draft.point?.uuid ?? '',
            content,
          )
    return create
      .then((created) => {
        const createdCard: Card = {
          ...card,
          id: created.cardUuid,
          front: created.front,
          back: created.back,
          startLine: created.startLine,
          sourceIndex: created.startLine,
        }
        setNewCardDraft(null)
        setOptimisticInspectorCard(createdCard)
        setInspectorCardId(createdCard.id)
        setSelectedCardId(createdCard.id)
        refresh()
        return true
      })
      .catch((operationError: unknown) => {
        console.error('[YOLO] Failed to create learning card:', operationError)
        new Notice(
          operationError instanceof CardFileConflictError
            ? t(
                'learning.cards.cardFileConflict',
                '卡片文件已在其他位置修改，请刷新后重试',
              )
            : t('learning.cards.cardCreateFailed', '卡片创建失败，请重试'),
        )
        return false
      })
  }

  const handleCreate = async (
    chapter: VaultChapter | VaultCardChapter,
    point: VaultKnowledgePoint | null,
  ) => {
    if (inspectorRef.current && !(await inspectorRef.current.flush())) return
    setBatchSelectedCardIds(new Set())
    if (!inspectorCard) captureCardLayout('open')
    newCardDraftKeyRef.current += 1
    setSelectedCardId(null)
    setInspectorCardId(null)
    setOptimisticInspectorCard(null)
    setNewCardDraft({
      key: newCardDraftKeyRef.current,
      chapter,
      point,
      filePath: normalizePath(`${chapter.folderPath}/cards.md`),
    })
    setInspectorClosing(false)
  }

  const handleChapterChange = async (card: Card, chapterId: string) => {
    if (!project || project.kind !== 'cards') return false
    const chapter = project.chapters.find((item) => item.id === chapterId)
    if (!chapter) return false
    if (newCardDraft) {
      setNewCardDraft({
        ...newCardDraft,
        chapter,
        filePath: chapter.cardsFilePath,
      })
      return true
    }
    if (!card.filePath || card.chapterId === chapter.id) return true
    return withWrite(() =>
      fileStore.moveChapterCard({
        sourcePath: card.filePath ?? '',
        targetPath: chapter.cardsFilePath,
        cardUuid: card.id,
        targetChapterTitle: chapter.title,
      }),
    )
  }

  const resolveActionCards = (card: Card): Card[] =>
    batchSelectedCardIds.has(card.id) && batchSelectedCards.length > 0
      ? batchSelectedCards
      : [card]

  const handleDeleteCards = async (targetCards: Card[]) => {
    if (!project || targetCards.length === 0) return
    const persistedCards = targetCards.filter(
      (card): card is Card & { filePath: string } =>
        Boolean(card.filePath && !card.preview),
    )
    if (persistedCards.length === 0) return
    const deletesInspectorCard = persistedCards.some(
      (card) => card.id === inspectorCard?.id,
    )
    if (
      deletesInspectorCard &&
      inspectorRef.current &&
      !(await inspectorRef.current.flush())
    ) {
      return
    }
    const cardsByFile = new Map<string, string[]>()
    persistedCards.forEach((card) => {
      const cardIds = cardsByFile.get(card.filePath) ?? []
      cardIds.push(card.id)
      cardsByFile.set(card.filePath, cardIds)
    })
    const deleted = await withWrite(async () => {
      for (const [filePath, cardIds] of cardsByFile) {
        await fileStore.deleteCards(
          filePath,
          cardIds,
          project.kind === 'cards' ? 'chapter-direct' : 'knowledge-linked',
        )
      }
      try {
        await plugin.getLearningSrsStore().removeCards(
          project.slug,
          persistedCards.map((card) => card.id),
        )
      } catch {
        new Notice(
          t('learning.cards.srsDeleteFailed', '卡片已删除，但复习记录清理失败'),
        )
      }
    })
    if (!deleted) return
    const deletedIds = new Set(persistedCards.map((card) => card.id))
    setBatchSelectedCardIds(
      (current) =>
        new Set([...current].filter((cardId) => !deletedIds.has(cardId))),
    )
    if (deletesInspectorCard) beginInspectorClose()
  }

  const handleQuickReviewCards = async (
    targetCards: Card[],
    rating: Extract<ReviewRating, 'again' | 'easy'>,
  ) => {
    if (!project || targetCards.length === 0 || writeDisabled) return
    const cardIds = targetCards
      .filter((card) => card.filePath && !card.preview && !card.suspended)
      .map((card) => card.id)
    if (cardIds.length === 0) return
    setWriting(true)
    try {
      await plugin
        .getLearningSrsStore()
        .reviewCards(project.slug, cardIds, rating, new Date())
      refresh()
    } catch (reviewError) {
      console.error('[YOLO] Failed to update card review state:', reviewError)
      new Notice(
        t('learning.cards.quickReviewFailed', '学习状态更新失败，请重试'),
      )
    } finally {
      setWriting(false)
    }
  }

  const handleSuspendCards = async (
    targetCards: Card[],
    suspended: boolean,
  ) => {
    if (!project || targetCards.length === 0 || writeDisabled) return
    const cardIds = targetCards
      .filter((card) => card.filePath && !card.preview)
      .map((card) => card.id)
    if (cardIds.length === 0) return
    setWriting(true)
    try {
      const store = plugin.getLearningSrsStore()
      if (suspended) await store.suspendCards(project.slug, cardIds)
      else await store.resumeCards(project.slug, cardIds)
      refresh()
    } catch (srsError) {
      console.error('[YOLO] Failed to update card suspension:', srsError)
      new Notice(t('learning.cards.suspendFailed', '暂停状态更新失败，请重试'))
    } finally {
      setWriting(false)
    }
  }

  const handleBrowseCardClick = (
    card: Card,
    event: ReactMouseEvent<HTMLButtonElement>,
  ) => {
    if ((event.metaKey || event.ctrlKey) && card.filePath && !card.preview) {
      setBatchSelectedCardIds((current) => {
        const next = new Set(current)
        if (next.has(card.id)) next.delete(card.id)
        else next.add(card.id)
        return next
      })
      return
    }
    setBatchSelectedCardIds(new Set())
    void handleSelectCard(card.id)
  }

  const handleCardMenuOpen = (card: Card) => {
    if (batchSelectedCardIds.has(card.id)) return
    setBatchSelectedCardIds(new Set([card.id]))
  }

  const handleDragStart = ({ active }: DragStartEvent) => {
    const source = cards.find((card) => card.id === active.id)
    if (!source || !project) return
    const movingSelectedCards = batchSelectedCardIds.has(source.id)
    const dragCards = movingSelectedCards
      ? visibleGroups
          .flatMap(({ points }) => points.flatMap(({ cards }) => cards))
          .filter((card) => batchSelectedCardIds.has(card.id))
      : [source]
    if (dragCards.length === 0) return
    if (!movingSelectedCards) setBatchSelectedCardIds(new Set())
    const dragCardIds = dragCards.map((card) => card.id)
    const dragCardIdSet = new Set(dragCardIds)
    const initialRect =
      active.rect.current.initial ??
      document
        .querySelector(`[data-yolo-card-id="${String(active.id)}"]`)
        ?.getBoundingClientRect()
    if (!initialRect || !dragAreaRef.current) return
    const cardHeights = Object.fromEntries(
      dragCardIds.map((cardId) => {
        const element = dragAreaRef.current?.querySelector<HTMLElement>(
          `[data-yolo-card-id="${cardId}"]`,
        )
        return [
          cardId,
          element?.getBoundingClientRect().height ?? initialRect.height,
        ]
      }),
    )
    const containers = createCardContainers(project, cards)
    originalContainersRef.current = containers
    dragContainersRef.current = containers
    cardContainerByIdRef.current = new Map(
      Object.entries(containers).flatMap(([kpUuid, cardIds]) =>
        cardIds.map((cardId) => [cardId, kpUuid] as const),
      ),
    )
    virtualDropSlotsRef.current = createVirtualDropSlots(
      dragAreaRef.current,
      dragCardIdSet,
      initialRect,
    )
    lastProjectionRef.current = {
      kpUuid: source.kpUuid,
      index: containers[source.kpUuid]
        .slice(0, containers[source.kpUuid].indexOf(source.id))
        .filter((cardId) => !dragCardIdSet.has(cardId)).length,
      slotIndex: containers[source.kpUuid].indexOf(source.id),
    }
    lastContainerCollisionRef.current = { id: `kp:${source.kpUuid}` }
    containerCollisionStickyRef.current = false
    dragCardIdsRef.current = dragCardIds
    setActiveCardId(String(active.id))
    setActiveCardHeight(initialRect.height)
    setActiveDragCardIds(dragCardIds)
    setActiveCardHeights(cardHeights)
    setDragContainers(containers)
    setPendingDrop(null)
  }

  const clearDragSession = useCallback(() => {
    captureCardLayout('drag')
    if (dragMoveFrameRef.current !== null) {
      cancelAnimationFrame(dragMoveFrameRef.current)
    }
    if (dropSettleTimerRef.current !== null) {
      window.clearTimeout(dropSettleTimerRef.current)
    }
    setActiveCardId(null)
    setActiveCardHeight(null)
    setActiveDragCardIds([])
    setActiveCardHeights({})
    setDragContainers(null)
    setPendingDrop(null)
    originalContainersRef.current = null
    dragContainersRef.current = null
    cardContainerByIdRef.current.clear()
    dragCardIdsRef.current = []
    virtualDropSlotsRef.current.clear()
    lastProjectionRef.current = null
    pendingDragMoveRef.current = null
    dragMoveFrameRef.current = null
    dropSettleTimerRef.current = null
    dragCollisionRectRef.current = null
    lastContainerCollisionRef.current = null
    containerCollisionStickyRef.current = false
  }, [captureCardLayout])

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (dragMoveFrameRef.current !== null) {
      cancelAnimationFrame(dragMoveFrameRef.current)
      dragMoveFrameRef.current = null
    }
    pendingDragMoveRef.current = null
    if (over && !containerCollisionStickyRef.current) {
      updateDragPosition(active, over)
    }
    const containers = dragContainersRef.current
    const original = originalContainersRef.current
    const dragCardIds = dragCardIdsRef.current
    if (
      !over ||
      !containers ||
      !original ||
      !project ||
      dragCardIds.length === 0
    ) {
      clearDragSession()
      return
    }
    const unchanged = Object.keys(original).every((kpUuid) =>
      original[kpUuid].every(
        (cardId, index) => containers[kpUuid]?.[index] === cardId,
      ),
    )
    if (unchanged) {
      clearDragSession()
      return
    }
    const movingCards = dragCardIds
      .map((cardId) => cards.find((card) => card.id === cardId))
      .filter((card): card is Card & { filePath: string } =>
        Boolean(card?.filePath),
      )
    const targetKpUuid = cardContainerByIdRef.current.get(String(active.id))
    const point =
      project.kind === 'outline'
        ? project.knowledgePoints.find((item) => item.uuid === targetKpUuid)
        : undefined
    const chapter =
      project.kind === 'cards'
        ? project.chapters.find((item) => item.id === targetKpUuid)
        : point
          ? project.chapters.find((item) => item.id === point.chapterId)
          : undefined
    if (
      movingCards.length !== dragCardIds.length ||
      !targetKpUuid ||
      (project.kind === 'outline' && !point) ||
      !chapter
    ) {
      clearDragSession()
      return
    }
    const dragCardIdSet = new Set(dragCardIds)
    const chapterCards = cards.filter(
      (card) => card.chapterId === chapter.id && !card.preview,
    )
    const targetCardIds = containers[targetKpUuid] ?? []
    const targetVisualIndex = targetCardIds.findIndex((cardId) =>
      dragCardIdSet.has(cardId),
    )
    if (targetVisualIndex < 0) {
      clearDragSession()
      return
    }
    const targetVisibleIndex = targetCardIds
      .slice(0, targetVisualIndex)
      .map((id) => cardsById.get(id))
      .filter((card): card is Card => Boolean(card && !card.preview)).length
    const targetIndex =
      project.kind === 'cards'
        ? targetVisibleIndex
        : calculateTargetFileIndex(
            targetKpUuid,
            targetVisibleIndex,
            (chapter as VaultChapter).knowledgePointIds
              .map(
                (id) =>
                  project.knowledgePoints.find((item) => item.id === id)?.uuid,
              )
              .filter((uuid): uuid is string => Boolean(uuid)),
            chapterCards,
            dragCardIds,
          )
    setPendingDrop({
      cardIds: dragCardIds,
      kpUuid: targetKpUuid,
      persistedIndex: targetVisibleIndex,
    })
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setActiveCardId(null)
      setActiveCardHeight(null)
      setActiveDragCardIds([])
      setActiveCardHeights({})
    } else {
      dropSettleTimerRef.current = window.setTimeout(() => {
        dropSettleTimerRef.current = null
        setActiveCardId(null)
        setActiveCardHeight(null)
        setActiveDragCardIds([])
        setActiveCardHeights({})
      }, CARD_DROP_DURATION)
    }
    void (async () => {
      if (
        movingCards.some((card) => card.id === inspectorCard?.id) &&
        inspectorRef.current &&
        !(await inspectorRef.current.flush())
      ) {
        clearDragSession()
        return
      }
      const moved = await withWrite(() =>
        project.kind === 'cards'
          ? fileStore.moveChapterCards({
              cards: movingCards.map((card) => ({
                sourcePath: card.filePath,
                cardUuid: card.id,
              })),
              targetPath: (chapter as VaultCardChapter).cardsFilePath,
              targetIndex,
              targetChapterTitle: chapter.title,
            })
          : fileStore.moveCards({
              cards: movingCards.map((card) => ({
                sourcePath: card.filePath,
                cardUuid: card.id,
              })),
              targetPath: normalizePath(`${chapter.folderPath}/cards.md`),
              kpUuid: targetKpUuid,
              targetIndex,
              targetChapterTitle: chapter.title,
            }),
      )
      if (!moved) clearDragSession()
    })()
  }

  const updateDragPosition = (
    active: DragMoveEvent['active'],
    over: NonNullable<DragMoveEvent['over']>,
  ) => {
    const overId = String(over.id)
    const current = dragContainersRef.current
    const original = originalContainersRef.current
    const dragCardIds = dragCardIdsRef.current
    if (!current || !original || dragCardIds.length === 0) return
    const dragCardIdSet = new Set(dragCardIds)
    const targetKpUuid = overId.startsWith('kp:')
      ? overId.slice(3)
      : cardContainerByIdRef.current.get(overId)
    if (!targetKpUuid || !(targetKpUuid in current)) return

    const collisionRect = dragCollisionRectRef.current
    const targetSlots = virtualDropSlotsRef.current.get(targetKpUuid)
    if (!collisionRect || !targetSlots || targetSlots.slots.length === 0) return
    const gridRect = targetSlots.grid.getBoundingClientRect()
    const activeCenterX = collisionRect.left + collisionRect.width / 2
    const activeCenterY = collisionRect.top + collisionRect.height / 2
    const distanceTo = (slot: VirtualDropSlot) =>
      Math.hypot(
        activeCenterX - (gridRect.left + slot.offsetX),
        activeCenterY - (gridRect.top + slot.offsetY),
      )
    let targetSlot = targetSlots.slots.reduce((nearest, slot) =>
      distanceTo(slot) < distanceTo(nearest) ? slot : nearest,
    )
    const originalTargetItems = original[targetKpUuid] ?? []
    const resolveTargetIndex = (slot: VirtualDropSlot) =>
      Math.min(
        originalTargetItems
          .slice(0, slot.index)
          .filter((cardId) => !dragCardIdSet.has(cardId)).length,
        originalTargetItems.filter((cardId) => !dragCardIdSet.has(cardId))
          .length,
      )
    const previousProjection = lastProjectionRef.current
    const previousSlot =
      previousProjection?.kpUuid === targetKpUuid
        ? targetSlots.slots.find(
            (slot) => slot.index === previousProjection.slotIndex,
          )
        : undefined
    if (
      previousSlot &&
      distanceTo(targetSlot) + DROP_SLOT_HYSTERESIS >= distanceTo(previousSlot)
    ) {
      targetSlot = previousSlot
    }
    const targetIndex = resolveTargetIndex(targetSlot)
    const projection = {
      kpUuid: targetKpUuid,
      index: targetIndex,
      slotIndex: targetSlot.index,
    }
    if (
      previousProjection?.kpUuid === projection.kpUuid &&
      previousProjection.index === projection.index
    ) {
      lastProjectionRef.current = projection
      return
    }
    const next = Object.fromEntries(
      Object.entries(current).map(([kpUuid, cardIds]) => [
        kpUuid,
        cardIds.filter((cardId) => !dragCardIdSet.has(cardId)),
      ]),
    )
    next[targetKpUuid].splice(targetIndex, 0, ...dragCardIds)
    dragContainersRef.current = next
    dragCardIds.forEach((cardId) => {
      cardContainerByIdRef.current.set(cardId, targetKpUuid)
    })
    lastProjectionRef.current = projection
    captureCardLayout('drag')
    setDragContainers(next)
  }

  const handleDragMove = ({ active, collisions, over }: DragMoveEvent) => {
    const collisionId = collisions?.[0]?.id
    if (!collisionId || containerCollisionStickyRef.current) return
    if (!over || over.id !== collisionId) return
    pendingDragMoveRef.current = { active, over }
    if (dragMoveFrameRef.current !== null) return
    dragMoveFrameRef.current = requestAnimationFrame(() => {
      dragMoveFrameRef.current = null
      const pending = pendingDragMoveRef.current
      pendingDragMoveRef.current = null
      if (pending) updateDragPosition(pending.active, pending.over)
    })
  }

  const handleDragOver = ({ active, over }: DragOverEvent) => {
    if (!over || containerCollisionStickyRef.current) return
    if (dragMoveFrameRef.current !== null) {
      cancelAnimationFrame(dragMoveFrameRef.current)
      dragMoveFrameRef.current = null
    }
    pendingDragMoveRef.current = null
    updateDragPosition(active, over)
  }

  useEffect(() => {
    if (!pendingDrop) return
    if (error) {
      clearDragSession()
      return
    }
    const persistedCards = cards.filter(
      (card) => card.kpUuid === pendingDrop.kpUuid && !card.preview,
    )
    const persistedIds = persistedCards.map((card) => card.id)
    const movedCardsPersisted = pendingDrop.cardIds.every(
      (cardId, index) =>
        persistedIds[pendingDrop.persistedIndex + index] === cardId,
    )
    if (movedCardsPersisted) {
      if (dropSettleTimerRef.current !== null) return
      clearDragSession()
    }
  }, [activeCardId, cards, clearDragSession, error, pendingDrop])

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
        {project?.kind !== 'cards' && (
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
                    chapterFilter === 'all' ||
                    point.chapterId === chapterFilter,
                )
                .map((point) => ({ value: point.id, label: point.title })) ??
                []),
            ]}
          />
        )}
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
          collisionDetection={collisionDetection}
          onDragStart={handleDragStart}
          onDragMove={handleDragMove}
          onDragOver={handleDragOver}
          onDragCancel={() => {
            clearDragSession()
          }}
          onDragEnd={handleDragEnd}
        >
          <div className="yolo-learning-cards-browser-container">
            <div
              className={cx(
                'yolo-learning-cards-browser-layout',
                inspectorCard && 'has-selection',
              )}
            >
              <div
                ref={dragAreaRef}
                className={cx(
                  'yolo-learning-cards-chapters',
                  marqueeRect && 'is-marquee-selecting',
                )}
                onPointerDown={handleMarqueePointerDown}
                onPointerMove={handleMarqueePointerMove}
                onPointerUp={handleMarqueePointerUp}
                onPointerCancel={handleMarqueePointerCancel}
              >
                {marqueeRect && (
                  <div
                    className="yolo-learning-cards-marquee"
                    style={marqueeRect}
                  />
                )}
                {visibleGroups.map(({ chapter, points }) => {
                  const sourceChapterIndex = project.chapters.findIndex(
                    (item) => item.id === chapter.id,
                  )
                  const memoryRetention = chapterMemoryRetention.get(chapter.id)
                  const memoryPercent =
                    memoryRetention === undefined
                      ? null
                      : Math.round(memoryRetention * 100)
                  const chapterStyle =
                    memoryRetention === undefined
                      ? undefined
                      : ({
                          '--yolo-learning-chapter-memory': `${
                            Math.min(
                              memoryRetention / LEARNING_TARGET_RETENTION,
                              1,
                            ) * 100
                          }%`,
                        } as CSSProperties)
                  const settled = generation?.settled.find(
                    (item) => item.chapterIndex === sourceChapterIndex,
                  )
                  const generating = generationActive && !settled
                  return (
                    <section
                      key={chapter.id}
                      className={cx(
                        'yolo-learning-cards-chapter',
                        memoryRetention !== undefined && 'has-memory-retention',
                      )}
                      style={chapterStyle}
                    >
                      <header className="yolo-learning-cards-chapter-header">
                        <h2>
                          {chapter.title}
                          {memoryPercent !== null && (
                            <span className="yolo-learning-cards-chapter-memory-sr">
                              {`, ${t(
                                'learning.cards.chapterMemoryRetention',
                                '预计 30 天后记忆保持率 {{percent}}%',
                              ).replace('{{percent}}', String(memoryPercent))}`}
                            </span>
                          )}
                        </h2>
                        {generating && (
                          <span>
                            {t(
                              'learning.cards.chapterGenerating',
                              '正在生成卡片…',
                            )}
                          </span>
                        )}
                        {settled?.status === 'partial' && (
                          <span>
                            {t(
                              'learning.cards.chapterPartial',
                              '部分卡片已生成',
                            )}
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
                          chapterDirect={project.kind === 'cards'}
                          cards={pointCards}
                          placeholderCardIds={activeDragCardIds}
                          placeholderHeights={activeCardHeights}
                          dropTargetCardId={activeCardId}
                          readonly={generating || writeDisabled}
                          mastery={mastery}
                          now={now}
                          selectedCardId={selectedCardId}
                          batchSelectedCardIds={batchSelectedCardIds}
                          batchSelectionCount={batchSelectedCards.length}
                          onCreate={() =>
                            void handleCreate(
                              chapter,
                              project.kind === 'cards'
                                ? null
                                : (point as VaultKnowledgePoint),
                            )
                          }
                          onDelete={(card) =>
                            void handleDeleteCards(resolveActionCards(card))
                          }
                          onMenuOpen={handleCardMenuOpen}
                          onSuspend={(card, suspended) =>
                            void handleSuspendCards(
                              resolveActionCards(card),
                              suspended,
                            )
                          }
                          onQuickReview={(card, rating) =>
                            void handleQuickReviewCards(
                              resolveActionCards(card),
                              rating,
                            )
                          }
                          onSelect={handleBrowseCardClick}
                        />
                      ))}
                    </section>
                  )
                })}
              </div>
              {inspectorCard && (
                <CardInspector
                  key={inspectorCard.id}
                  ref={inspectorRef}
                  card={inspectorCard}
                  chapters={project.kind === 'cards' ? project.chapters : null}
                  due={Boolean(
                    inspectorCard.srsState &&
                      inspectorCard.dueAt &&
                      isDue(inspectorCard.dueAt, now),
                  )}
                  disabled={writeDisabled}
                  closing={inspectorClosing}
                  onClose={() => void handleCloseInspector()}
                  onExitComplete={() => {
                    if (!inspectorClosing) return
                    captureCardLayout('close')
                    setInspectorCardId(null)
                    setNewCardDraft(null)
                    setOptimisticInspectorCard(null)
                    setInspectorClosing(false)
                  }}
                  onSave={
                    newCardDraft
                      ? (card, content) =>
                          handleCreateCard(newCardDraft, card, content)
                      : handleUpdateCard
                  }
                  onChapterChange={handleChapterChange}
                />
              )}
            </div>
          </div>
          {createPortal(
            <DragOverlay
              dropAnimation={
                window.matchMedia('(prefers-reduced-motion: reduce)').matches
                  ? null
                  : CARD_DROP_ANIMATION
              }
            >
              {activeCard ? (
                <div className="yolo-learning yolo-learning-cards-drag-overlay">
                  <div
                    className={cx(
                      'yolo-learning-cards-drag-stack',
                      activeDragCards.length > 1 && 'is-multi',
                    )}
                  >
                    <BrowseCard
                      card={activeCard}
                      due={Boolean(
                        activeCard.srsState &&
                          activeCard.dueAt &&
                          isDue(activeCard.dueAt, now),
                      )}
                      onSelect={() => undefined}
                      selected={false}
                    />
                    {activeDragCards.length > 1 && (
                      <span className="yolo-learning-cards-drag-count">
                        {activeDragCards.length}
                      </span>
                    )}
                  </div>
                </div>
              ) : null}
            </DragOverlay>,
            document.body,
          )}
        </DndContext>
      )}
    </>
  )
}

function KnowledgePointDropZone({
  point,
  chapterDirect,
  cards,
  placeholderCardIds,
  placeholderHeights,
  dropTargetCardId,
  readonly,
  mastery,
  now,
  selectedCardId,
  batchSelectedCardIds,
  batchSelectionCount,
  onCreate,
  onDelete,
  onMenuOpen,
  onSuspend,
  onQuickReview,
  onSelect,
}: {
  point: { id: string; uuid: string; chapterId: string; title: string }
  chapterDirect: boolean
  cards: Card[]
  placeholderCardIds: string[]
  placeholderHeights: Record<string, number>
  dropTargetCardId: string | null
  readonly: boolean
  mastery: (typeof masteryFilters)[number]
  now: Date
  selectedCardId: string | null
  batchSelectedCardIds: ReadonlySet<string>
  batchSelectionCount: number
  onCreate: () => void
  onDelete: (card: Card) => void
  onMenuOpen: (card: Card) => void
  onSuspend: (card: Card, suspended: boolean) => void
  onQuickReview: (
    card: Card,
    rating: Extract<ReviewRating, 'again' | 'easy'>,
  ) => void
  onSelect: (card: Card, event: ReactMouseEvent<HTMLButtonElement>) => void
}) {
  const { t } = useLanguage()
  const { setNodeRef } = useDroppable({
    id: `kp:${point.uuid}`,
    disabled: readonly || mastery !== '全部',
    data: { kind: 'container', kpUuid: point.uuid },
  })
  const placeholderCardIdSet = new Set(placeholderCardIds)
  const containsPlaceholder = cards.some((card) => card.id === dropTargetCardId)
  return (
    <section
      ref={setNodeRef}
      data-yolo-kp-uuid={point.uuid}
      className={cx(
        'yolo-learning-cards-point',
        containsPlaceholder && 'is-over',
      )}
    >
      <header className="yolo-learning-cards-point-header">
        {!chapterDirect && <h3>{point.title}</h3>}
        <button
          type="button"
          disabled={readonly}
          onClick={onCreate}
          className="yolo-learning-cards-point-add"
        >
          <Plus size={14} />{' '}
          {chapterDirect
            ? t('learning.cards.addToChapter', '新增卡片')
            : t('learning.cards.addToKnowledgePoint', '新增卡片')}
        </button>
      </header>
      <SortableContext items={cards.map((card) => card.id)}>
        <div className="yolo-learning-cards-point-grid">
          {cards.map((card) => (
            <SortableBrowseCard
              key={card.id}
              card={card}
              containerKpUuid={point.uuid}
              placeholder={placeholderCardIdSet.has(card.id)}
              placeholderHeight={placeholderHeights[card.id] ?? null}
              projecting={placeholderCardIds.length > 0}
              disabled={isBrowseDragDisabled({
                masteryFilter: mastery,
                writeDisabled: readonly,
                chapterGenerating: false,
                preview: card.preview,
              })}
              due={Boolean(
                card.srsState && card.dueAt && isDue(card.dueAt, now),
              )}
              batchSelected={batchSelectedCardIds.has(card.id)}
              menuCardCount={
                batchSelectedCardIds.has(card.id) ? batchSelectionCount : 1
              }
              menuDisabled={readonly}
              onDelete={() => onDelete(card)}
              onForget={() => onQuickReview(card, 'again')}
              onMenuOpen={() => onMenuOpen(card)}
              onSuspend={() => onSuspend(card, !card.suspended)}
              selected={card.id === selectedCardId}
              onSelect={(event) => onSelect(card, event)}
              onRemember={() => onQuickReview(card, 'easy')}
            />
          ))}
          {cards.length === 0 && (
            <span className="yolo-learning-cards-point-empty">
              {t('learning.cards.emptyKnowledgePoint', '暂无卡片')}
            </span>
          )}
        </div>
      </SortableContext>
    </section>
  )
}

function SortableBrowseCard({
  card,
  batchSelected,
  containerKpUuid,
  due,
  disabled,
  menuCardCount,
  menuDisabled,
  onDelete,
  onForget,
  onMenuOpen,
  onSuspend,
  placeholder,
  placeholderHeight,
  projecting,
  selected,
  onSelect,
  onRemember,
}: {
  card: Card
  batchSelected: boolean
  containerKpUuid: string
  due: boolean
  disabled: boolean
  menuCardCount: number
  menuDisabled: boolean
  onDelete: () => void
  onForget: () => void
  onMenuOpen: () => void
  onSuspend: () => void
  placeholder: boolean
  placeholderHeight: number | null
  projecting: boolean
  selected: boolean
  onSelect: (event: ReactMouseEvent<HTMLButtonElement>) => void
  onRemember: () => void
}) {
  const sortable = useSortable({
    id: card.id,
    disabled,
    data: { kind: 'card', kpUuid: containerKpUuid },
  })
  return (
    <div
      ref={sortable.setNodeRef}
      data-yolo-card-id={card.id}
      data-yolo-marquee-selectable={
        card.filePath && !card.preview ? 'true' : undefined
      }
      style={{
        transform: projecting
          ? undefined
          : CSS.Transform.toString(sortable.transform),
        transition: projecting ? undefined : sortable.transition,
      }}
      className={cx(
        'yolo-learning-cards-sortable',
        sortable.isDragging && !placeholder && 'is-dragging',
        card.preview && 'is-preview',
      )}
      {...sortable.attributes}
      {...sortable.listeners}
    >
      {placeholder && placeholderHeight !== null ? (
        <div
          className="yolo-learning-cards-drop-placeholder"
          style={{ height: placeholderHeight }}
        />
      ) : (
        <BrowseCard
          card={card}
          batchSelected={batchSelected}
          due={due}
          menuCardCount={menuCardCount}
          menuDisabled={menuDisabled}
          onDelete={onDelete}
          onForget={onForget}
          onMenuOpen={onMenuOpen}
          onSuspend={onSuspend}
          onSelect={onSelect}
          onRemember={onRemember}
          selected={selected}
        />
      )}
    </div>
  )
}

function BrowseCard({
  card,
  batchSelected = false,
  due,
  menuCardCount = 1,
  menuDisabled = false,
  onDelete,
  onForget,
  onMenuOpen,
  onSuspend,
  onSelect,
  onRemember,
  selected,
}: {
  card: Card
  batchSelected?: boolean
  due: boolean
  menuCardCount?: number
  menuDisabled?: boolean
  onDelete?: () => void
  onForget?: () => void
  onMenuOpen?: () => void
  onSuspend?: () => void
  onSelect: (event: ReactMouseEvent<HTMLButtonElement>) => void
  onRemember?: () => void
  selected: boolean
}) {
  const { t } = useLanguage()
  const [menuOpen, setMenuOpen] = useState(false)
  const [deleteArmed, setDeleteArmed] = useState(false)
  const cardRef = useRef<HTMLElement>(null)
  const menuAnchorRef = useRef({
    getBoundingClientRect: () => DOMRect.fromRect(),
  })
  const hasMenu = Boolean(
    onDelete &&
      onForget &&
      onRemember &&
      onSuspend &&
      card.filePath &&
      !card.preview,
  )
  const count = String(menuCardCount)
  const rememberedLabel =
    menuCardCount > 1
      ? t('learning.cards.markRememberedCount', '熟记 {{count}} 张').replace(
          '{{count}}',
          count,
        )
      : t('learning.cards.markRemembered', '熟记')
  const forgottenLabel =
    menuCardCount > 1
      ? t('learning.cards.markForgottenCount', '遗忘 {{count}} 张').replace(
          '{{count}}',
          count,
        )
      : t('learning.cards.markForgotten', '遗忘')
  const deleteLabel =
    menuCardCount > 1
      ? t('learning.cards.deleteCount', '删除 {{count}} 张').replace(
          '{{count}}',
          count,
        )
      : t('common.delete', '删除')
  const confirmDeleteLabel =
    menuCardCount > 1
      ? t(
          'learning.cards.confirmDeleteCount',
          '确认删除 {{count}} 张？',
        ).replace('{{count}}', count)
      : t('learning.cards.confirmDelete', '确认删除？')
  const openMenuAt = (x: number, y: number) => {
    menuAnchorRef.current = {
      getBoundingClientRect: () => DOMRect.fromRect({ x, y }),
    }
    setDeleteArmed(false)
    setMenuOpen(true)
  }
  const runMenuAction = (action: (() => void) | undefined) => {
    setDeleteArmed(false)
    setMenuOpen(false)
    action?.()
  }

  return (
    <Popover.Root
      open={menuOpen}
      onOpenChange={(open) => {
        setMenuOpen(open)
        if (!open) setDeleteArmed(false)
      }}
    >
      <Popover.Anchor virtualRef={menuAnchorRef} />
      <article
        ref={cardRef}
        className={cx(
          'yolo-learning-cards-browse-card',
          card.preview && 'is-revealed',
          batchSelected && 'is-batch-selected',
          selected && 'is-selected',
        )}
        onContextMenu={
          hasMenu
            ? (event) => {
                event.preventDefault()
                onMenuOpen?.()
                openMenuAt(event.clientX, event.clientY)
              }
            : undefined
        }
      >
        <div className="yolo-learning-cards-browse-card-header">
          <span className="yolo-learning-cards-browse-card-point">
            {card.pointTitle
              ? `${card.chapterTitle} · ${card.pointTitle}`
              : card.chapterTitle}
          </span>
          <div className="yolo-learning-cards-browse-card-meta">
            {due && (
              <span className="yolo-learning-cards-due-label">
                {t('learning.cards.due', '待复习')}
              </span>
            )}
            {card.suspended && (
              <span className="yolo-learning-cards-due-label">
                {t('learning.cards.suspended', '已暂停')}
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
          onClick={onSelect}
          aria-pressed={selected}
          className="yolo-learning-cards-browse-card-body"
        >
          <CardMarkdown
            markdown={card.front}
            sourcePath={card.filePath ?? ''}
            className="yolo-learning-cards-front-text markdown-rendered"
          />
        </button>

        {hasMenu && (
          <button
            type="button"
            aria-label={t('learning.cards.moreActions', '更多操作')}
            title={t('learning.cards.moreActions', '更多操作')}
            data-no-dnd
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation()
              onMenuOpen?.()
              const rect = event.currentTarget.getBoundingClientRect()
              openMenuAt(rect.right, rect.bottom + 4)
            }}
            className="yolo-learning-cards-more-btn"
          >
            <Ellipsis size={15} />
          </button>
        )}
      </article>
      {hasMenu && (
        <YoloPopoverContent
          anchorRef={cardRef}
          variant="default"
          minWidth={156}
          maxWidth={220}
          sideOffset={4}
          align="start"
          collisionPadding={10}
          className="yolo-learning-card-menu"
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          <div className="yolo-learning-card-menu-list">
            <button
              type="button"
              className="yolo-learning-card-menu-item"
              disabled={menuDisabled}
              onClick={() => runMenuAction(onSuspend)}
            >
              {card.suspended ? (
                <PlayCircle size={15} />
              ) : (
                <PauseCircle size={15} />
              )}
              <span>
                {card.suspended
                  ? t('learning.cards.resume', '恢复卡片')
                  : t('learning.cards.suspend', '暂停卡片')}
              </span>
            </button>
            <button
              type="button"
              className="yolo-learning-card-menu-item"
              disabled={menuDisabled}
              onClick={() => runMenuAction(onRemember)}
            >
              <CircleCheck size={15} />
              <span>{rememberedLabel}</span>
            </button>
            <button
              type="button"
              className="yolo-learning-card-menu-item"
              disabled={menuDisabled}
              onClick={() => runMenuAction(onForget)}
            >
              <RotateCcw size={15} />
              <span>{forgottenLabel}</span>
            </button>
            <button
              type="button"
              className={cx(
                'yolo-learning-card-menu-item is-danger',
                deleteArmed && 'is-confirming',
              )}
              disabled={menuDisabled}
              onClick={() => {
                if (!deleteArmed) {
                  setDeleteArmed(true)
                  return
                }
                runMenuAction(onDelete)
              }}
            >
              <Trash2 size={15} />
              <span>{deleteArmed ? confirmDeleteLabel : deleteLabel}</span>
            </button>
          </div>
        </YoloPopoverContent>
      )}
    </Popover.Root>
  )
}

type CardInspectorHandle = {
  flush: () => Promise<boolean>
}

type CardSaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error'

const CardInspector = forwardRef<
  CardInspectorHandle,
  {
    card: Card
    chapters: VaultCardChapter[] | null
    due: boolean
    disabled: boolean
    closing: boolean
    onClose: () => void
    onExitComplete: () => void
    onSave: (
      card: Card,
      content: { front: string; back: string },
    ) => Promise<boolean>
    onChapterChange: (card: Card, chapterId: string) => Promise<boolean>
  }
>(function CardInspector(
  {
    card,
    chapters,
    due,
    disabled,
    closing,
    onClose,
    onExitComplete,
    onSave,
    onChapterChange,
  },
  ref,
) {
  const { t } = useLanguage()
  const [front, setFront] = useState(card.front)
  const [back, setBack] = useState(card.back)
  const [saveStatus, setSaveStatus] = useState<CardSaveStatus>('idle')
  const backRef = useRef<HTMLTextAreaElement>(null)
  const latestContentRef = useRef({ front: card.front, back: card.back })
  const savedContentRef = useRef({ front: card.front, back: card.back })
  const saveTimerRef = useRef<number | null>(null)
  const savePromiseRef = useRef<Promise<boolean> | null>(null)
  useEffect(() => {
    const hasLocalChanges =
      latestContentRef.current.front !== savedContentRef.current.front ||
      latestContentRef.current.back !== savedContentRef.current.back
    if (hasLocalChanges) return
    setFront(card.front)
    setBack(card.back)
    latestContentRef.current = { front: card.front, back: card.back }
    savedContentRef.current = { front: card.front, back: card.back }
  }, [card.back, card.front])

  const persistLatest = useCallback(async (): Promise<boolean> => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    while (true) {
      while (savePromiseRef.current) {
        if (!(await savePromiseRef.current)) return false
      }
      const content = { ...latestContentRef.current }
      if (
        content.front === savedContentRef.current.front &&
        content.back === savedContentRef.current.back
      ) {
        setSaveStatus('saved')
        return true
      }
      setSaveStatus('saving')
      const savePromise = onSave(card, content)
      savePromiseRef.current = savePromise
      const saved = await savePromise
      if (savePromiseRef.current === savePromise) {
        savePromiseRef.current = null
      }
      if (!saved) {
        setSaveStatus('error')
        return false
      }
      savedContentRef.current = content
      const hasNewerChanges =
        latestContentRef.current.front !== content.front ||
        latestContentRef.current.back !== content.back
      setSaveStatus(hasNewerChanges ? 'pending' : 'saved')
      if (!hasNewerChanges) return true
    }
  }, [card, onSave])

  useImperativeHandle(ref, () => ({ flush: persistLatest }), [persistLatest])

  useEffect(
    () => () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current)
      }
    },
    [],
  )

  const queueSave = (content: { front: string; back: string }) => {
    latestContentRef.current = content
    setSaveStatus('pending')
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current)
    }
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null
      void persistLatest()
    }, 600)
  }

  const statusText: Partial<Record<CardSaveStatus, string>> = {
    pending: t('learning.cards.savePending', '等待自动保存…'),
    saving: t('learning.cards.saving', '保存中…'),
    saved: t('learning.cards.saved', '已保存'),
    error: t('learning.cards.saveFailed', '保存失败'),
  }

  return (
    <aside
      className={cx('yolo-learning-cards-inspector', closing && 'is-closing')}
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget && closing) onExitComplete()
      }}
    >
      <header className="yolo-learning-cards-inspector-header">
        <div className="yolo-learning-cards-inspector-heading">
          <span className="yolo-learning-cards-browse-card-point">
            {card.pointTitle
              ? `${card.chapterTitle} · ${card.pointTitle}`
              : card.chapterTitle}
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
            {statusText[saveStatus] && (
              <span
                className={cx(
                  'yolo-learning-cards-inspector-status',
                  saveStatus === 'error' && 'is-error',
                )}
                aria-live="polite"
              >
                {statusText[saveStatus]}
              </span>
            )}
          </div>
        </div>
        <div className="yolo-learning-cards-inspector-actions">
          <button
            type="button"
            disabled={saveStatus === 'saving'}
            className="clickable-icon yolo-learning-cards-inspector-close"
            aria-label={t('common.close', '关闭')}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>
      </header>
      <div className="yolo-learning-cards-inspector-body">
        {chapters && (
          <section className="yolo-learning-cards-inspector-section">
            <div className="yolo-learning-cards-inspector-label">
              {t('learning.cards.targetChapter', '卡片章节')}
            </div>
            <SelectMenu
              value={card.chapterId}
              disabled={disabled}
              onChange={(chapterId) => {
                if (card.id.startsWith('new-card-')) {
                  void onChapterChange(card, chapterId)
                  return
                }
                void persistLatest().then((saved) => {
                  if (saved) return onChapterChange(card, chapterId)
                })
              }}
              options={chapters.map((chapter) => ({
                value: chapter.id,
                label: chapter.title,
              }))}
            />
          </section>
        )}
        <section className="yolo-learning-cards-inspector-section">
          <div className="yolo-learning-cards-inspector-label">
            {t('learning.cards.question', '问题')}
          </div>
          <textarea
            value={front}
            disabled={!card.filePath || disabled}
            onChange={(event) => {
              const nextFront = event.target.value
              setFront(nextFront)
              queueSave({ ...latestContentRef.current, front: nextFront })
            }}
            className="yolo-learning-cards-inspector-textarea is-question"
          />
        </section>
        <section className="yolo-learning-cards-inspector-section">
          <div className="yolo-learning-cards-inspector-label">
            {t('learning.cards.answer', '答案')}
          </div>
          <textarea
            ref={backRef}
            value={back}
            disabled={!card.filePath || disabled}
            onChange={(event) => {
              const nextBack = event.target.value
              setBack(nextBack)
              queueSave({ ...latestContentRef.current, back: nextBack })
            }}
            className="yolo-learning-cards-inspector-textarea is-answer"
          />
        </section>
      </div>
    </aside>
  )
})

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
  initialQueue,
  onReviewed,
  onQueueCountChange,
  onExit,
}: {
  projectSlug: string | null
  initialQueue: Card[]
  onReviewed: (
    cardUuid: string,
    state: SrsCardState,
    introduced: boolean,
  ) => void
  onQueueCountChange: (count: number) => void
  onExit: () => void
}) {
  const { t } = useLanguage()
  const plugin = usePlugin()
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

  useEffect(() => {
    onQueueCountChange(queue.length)
  }, [onQueueCountChange, queue.length])

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
      hint: formatSchedulingHint(scheduling?.again, new Date(), t),
      tone: 'danger',
    },
    hard: {
      label: t('learning.cards.reviewHard', '模糊'),
      hint: formatSchedulingHint(scheduling?.hard, new Date(), t),
      tone: 'warning',
    },
    good: {
      label: t('learning.cards.reviewGood', '会了'),
      hint: formatSchedulingHint(scheduling?.good, new Date(), t),
      tone: 'success',
    },
    easy: {
      label: t('learning.cards.reviewEasy', '简单'),
      hint: formatSchedulingHint(scheduling?.easy, new Date(), t),
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
                    {promoteCard.pointTitle
                      ? `${promoteCard.chapterTitle} · ${promoteCard.pointTitle}`
                      : promoteCard.chapterTitle}
                  </div>
                  <CardMarkdown
                    markdown={promoteCard.front}
                    sourcePath={promoteCard.filePath ?? ''}
                    className="yolo-learning-cards-review-card-front-text markdown-rendered"
                  />
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
                      {card.pointTitle
                        ? `${card.chapterTitle} · ${card.pointTitle}`
                        : card.chapterTitle}
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
                    <CardMarkdown
                      markdown={card.front}
                      sourcePath={card.filePath ?? ''}
                      className="yolo-learning-cards-review-card-front-text markdown-rendered"
                    />
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
                      {card.pointTitle
                        ? `${card.chapterTitle} · ${card.pointTitle}`
                        : card.chapterTitle}
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
                    <CardMarkdown
                      markdown={card.back}
                      sourcePath={card.filePath ?? ''}
                      className="yolo-learning-cards-review-card-back-text yolo-learning-scrollbar-thin markdown-rendered"
                    />

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
  t: (keyPath: string, fallback?: string) => string,
): string {
  if (!scheduling) return '…'
  const minutes = Math.max(
    1,
    Math.round((scheduling.due.getTime() - now.getTime()) / 60_000),
  )
  if (minutes < 60)
    return `${minutes} ${t('learning.cards.reviewMinuteUnit', '分钟')}`
  const hours = Math.round(minutes / 60)
  if (hours < 48)
    return `${hours} ${t('learning.cards.reviewHourUnit', '小时')}`
  return `${Math.max(1, scheduling.scheduledDays)} ${t(
    'learning.cards.reviewDayUnit',
    '天',
  )}`
}
