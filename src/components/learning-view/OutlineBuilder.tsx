import {
  DndContext,
  type DragEndEvent,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import cx from 'clsx'
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  GripVertical,
  Layers,
  ListTree,
  Plus,
  Sparkles,
  Trash2,
  Zap,
} from 'lucide-react'
import { Notice } from 'obsidian'
import { useEffect, useRef, useState } from 'react'
import type React from 'react'

import { useLanguage } from '../../contexts/language-context'
import { generateCardsParallel } from '../../core/learning/generation/cardGenerator'
import {
  type ChapterDebugData,
  emitChaptersDebugLog,
} from '../../core/learning/generation/debugLog'
import { generateKnowledgePointsForChapter } from '../../core/learning/generation/knowledgePointGenerator'
import { generateOutline } from '../../core/learning/generation/outlineGenerator'
import {
  type WrittenKnowledgePoint,
  appendKnowledgePointDraft,
  createKnowledgePointUuid,
  createProjectScaffold,
  markProjectStudying,
} from '../../core/learning/generation/projectWriter'
import {
  type StagedReference,
  moveStagingToProject,
} from '../../core/learning/generation/referenceStaging'
import type {
  CardGenerationEvent,
  CardGenerationResult,
  GenerationProgress,
  Outline,
  OutlineChapter,
} from '../../core/learning/generation/types'
import type { ProjectEventBus } from '../../core/learning/projectEventBus'
import { getYoloLearningDir } from '../../core/paths/yoloPaths'
import type YoloPlugin from '../../main'
import type { AssistantWorkspaceScope } from '../../types/assistant.types'

import { summarizeCardGeneration } from './cardsWorkspace'
import { formatLearningText } from './i18n'

type Phase = 'outline' | 'ready' | 'knowledge' | 'error'
type OutlineWaitingStage = 'preparing' | 'structuring'

type EditableChapter = OutlineChapter & {
  id: string
  progress?: GenerationProgress
}

export function OutlineBuilder({
  plugin,
  eventBus,
  topic,
  level,
  goal,
  referencesBlock,
  stagingDir,
  referenceFiles,
  onCancel,
  onProjectStarted,
  onComplete,
  onCardGenerationStarted,
  onCard,
  onChapterSettled,
  onCardGenerationFinished,
}: {
  plugin: YoloPlugin
  eventBus: ProjectEventBus
  topic: string
  level: string
  goal: string
  referencesBlock?: string
  stagingDir?: string
  referenceFiles?: StagedReference[]
  onCancel: () => void
  onProjectStarted: (projectId: string) => void | Promise<void>
  onComplete: (projectId: string) => void
  onCardGenerationStarted: (runId: string, projectId: string) => void
  onCard: (event: CardGenerationEvent) => void
  onChapterSettled: (
    runId: string,
    projectId: string,
    result: CardGenerationResult,
  ) => void
  onCardGenerationFinished: (
    runId: string,
    projectId: string,
    failed: boolean,
  ) => void
}) {
  const { t } = useLanguage()
  const [chapters, setChapters] = useState<EditableChapter[]>([])
  const [projectName, setProjectName] = useState('')
  const [projectGoal, setProjectGoal] = useState('')
  const [estimatedKnowledgePoints, setEstimatedKnowledgePoints] = useState(0)
  const [phase, setPhase] = useState<Phase>('outline')
  const [outlineWaitingStage, setOutlineWaitingStage] =
    useState<OutlineWaitingStage>('preparing')
  const scrollRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const abortOnUnmountRef = useRef(true)
  const nextChapterIdRef = useRef(0)
  const dragSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
  )
  const workspaceScope: AssistantWorkspaceScope | undefined =
    stagingDir && referenceFiles && referenceFiles.length > 0
      ? { enabled: true, include: [stagingDir], exclude: [] }
      : undefined
  const learningModelId =
    plugin.settings.learningOptions.modelId || plugin.settings.chatModelId

  const createChapter = (chapter: OutlineChapter): EditableChapter => ({
    ...chapter,
    id: `chapter-${nextChapterIdRef.current++}`,
  })

  const reconcileOutline = (outline: Outline) => {
    setProjectName(outline.projectName)
    setProjectGoal(outline.projectGoal)
    setEstimatedKnowledgePoints(outline.estimatedKnowledgePoints)
    setChapters((current) =>
      outline.chapters.map((chapter, index) => ({
        ...chapter,
        id: current[index]?.id ?? `chapter-${nextChapterIdRef.current++}`,
        progress: current[index]?.progress,
      })),
    )
  }

  const startOutlineGeneration = () => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setPhase('outline')
    setOutlineWaitingStage('preparing')
    nextChapterIdRef.current = 0
    setChapters([])
    setProjectName('')
    setProjectGoal('')
    setEstimatedKnowledgePoints(0)
    void generateOutline({
      plugin,
      modelId: learningModelId,
      topic,
      level,
      goal,
      referencesBlock,
      referenceFiles,
      workspaceScope,
      abortSignal: controller.signal,
      activity: {
        kind: 'learning-agent',
        title: t('learning.wizard.modeLabel', '学习模式'),
        detail: t('learning.outlineBuilder.planningPath', '正在规划学习路径'),
        action: 'open-learning-view',
      },
      onOutline: reconcileOutline,
      onProgress: (delta, fullText) => {
        if (!controller.signal.aborted && (delta || fullText)) {
          setOutlineWaitingStage('structuring')
        }
      },
    })
      .then(({ outline }) => {
        reconcileOutline(outline)
        setPhase('ready')
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        console.error('[YOLO] Failed to generate learning outline:', err)
        setPhase('error')
      })
  }

  useEffect(() => {
    startOutlineGeneration()
    return () => {
      if (abortOnUnmountRef.current) abortRef.current?.abort()
    }
  }, [])

  const scrollToChapter = (index: number) => {
    const el = scrollRef.current?.querySelector<HTMLElement>(
      `#chapter-${index}`,
    )
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const updateChapter = (index: number, patch: Partial<OutlineChapter>) => {
    setChapters((current) =>
      current.map((chapter, i) =>
        i === index ? { ...chapter, ...patch } : chapter,
      ),
    )
  }

  const deleteChapter = (index: number) => {
    setChapters((current) => current.filter((_, i) => i !== index))
  }

  const addChapter = () => {
    setChapters((current) => [
      ...current,
      createChapter({
        title: '',
        contract: '',
      }),
    ])
  }

  const handleChapterDragEnd = ({ active, over }: DragEndEvent) => {
    if (busy || !over || active.id === over.id) return
    setChapters((current) => {
      const oldIndex = current.findIndex((chapter) => chapter.id === active.id)
      const newIndex = current.findIndex((chapter) => chapter.id === over.id)
      if (oldIndex < 0 || newIndex < 0) return current
      return arrayMove(current, oldIndex, newIndex)
    })
  }

  const confirmAndGenerate = async () => {
    if (
      chapters.length === 0 ||
      chapters.some(
        (chapter) => !chapter.title.trim() || !chapter.contract.trim(),
      )
    ) {
      return
    }
    const validChapters = chapters.filter(
      (chapter) => chapter.title.trim() && chapter.contract.trim(),
    )
    const controller = new AbortController()
    plugin.trackLearningGeneration(controller)
    abortRef.current = controller
    setPhase('knowledge')

    const baseDir = getYoloLearningDir(plugin.settings)
    const resolvedProjectName = projectName || topic
    let scaffold: Awaited<ReturnType<typeof createProjectScaffold>>
    let projectRefPath: string | undefined
    try {
      scaffold = await createProjectScaffold({
        app: plugin.app,
        baseDir,
        topic: resolvedProjectName,
        goal: projectGoal,
        chapters: validChapters,
      })
      if (stagingDir && referenceFiles && referenceFiles.length > 0) {
        projectRefPath = await moveStagingToProject(
          plugin.app,
          stagingDir,
          scaffold.projectPath,
        )
      }
      await eventBus.setActiveProject(baseDir, scaffold.projectPath)
      abortOnUnmountRef.current = false
      await onProjectStarted(scaffold.projectPath)
    } catch (err: unknown) {
      plugin.releaseLearningGeneration(controller)
      if (controller.signal.aborted) return
      console.error('[YOLO] Failed to create learning project:', err)
      setPhase('error')
      return
    }

    try {
      const knowledgeWorkspaceScope: AssistantWorkspaceScope | undefined =
        projectRefPath
          ? { enabled: true, include: [projectRefPath], exclude: [] }
          : workspaceScope
      const chapterDebugData: ChapterDebugData[] = []
      const knowledgeResults = await Promise.all(
        validChapters.map(async (chapter, index) => {
          const target = scaffold.chapters[index]
          if (!target) {
            return {
              chapterTitle: chapter.title,
              error: `Missing scaffold target for chapter: ${chapter.title}`,
            }
          }
          const draftedPoints: WrittenKnowledgePoint[] = []
          let completedCount = 0

          const draftKnowledgePoint = (
            title: string,
          ): WrittenKnowledgePoint => {
            const uuid = createKnowledgePointUuid()
            const knowledgePoint: WrittenKnowledgePoint = {
              id: `${target.chapterPath}/${uuid}`,
              projectId: scaffold.projectPath,
              chapterId: target.chapterPath,
              uuid,
              title,
              knowledgeFilePath: target.knowledgePath,
              relations: [],
              hasCards: false,
              hasExercises: false,
              mtime: Date.now(),
            }
            draftedPoints.push(knowledgePoint)
            eventBus.emitSynthetic({
              type: 'knowledge_point_drafted',
              projectId: scaffold.projectPath,
              knowledgePoint,
            })
            eventBus.emitSynthetic({
              type: 'knowledge_point_focused',
              projectId: scaffold.projectPath,
              knowledgePointId: knowledgePoint.id,
            })
            return knowledgePoint
          }

          try {
            const { drafts, debugData } =
              await generateKnowledgePointsForChapter({
                plugin,
                modelId: learningModelId,
                chapterIndex: index,
                projectTopic: resolvedProjectName,
                chapterTitle: chapter.title,
                chapterContract: chapter.contract,
                level,
                workspaceScope: knowledgeWorkspaceScope,
                referenceDir: projectRefPath,
                abortSignal: controller.signal,
                activity: {
                  kind: 'learning-agent',
                  title: t('learning.wizard.modeLabel', '学习模式'),
                  detail: `${t(
                    'learning.outlineBuilder.knowledgeGenerating',
                    '正在生成知识点',
                  )}：${chapter.title}`,
                  action: 'open-learning-view',
                },
                onKnowledgePointTitle: (title) => {
                  draftKnowledgePoint(title)
                },
                onKnowledgePoint: async (point) => {
                  const drafted =
                    draftedPoints[completedCount] ??
                    draftKnowledgePoint(point.title)
                  const knowledgePoint = await appendKnowledgePointDraft({
                    app: plugin.app,
                    projectPath: scaffold.projectPath,
                    chapter: target,
                    point,
                    uuid: drafted.uuid,
                  })
                  completedCount += 1
                  eventBus.emitSynthetic({
                    type: 'knowledge_point_added',
                    projectId: scaffold.projectPath,
                    knowledgePoint,
                  })
                  eventBus.emitSynthetic({
                    type: 'knowledge_point_focused',
                    projectId: scaffold.projectPath,
                    knowledgePointId: knowledgePoint.id,
                  })
                },
              })
            if (drafts.length === 0) {
              throw new Error(`No knowledge points generated: ${chapter.title}`)
            }
            chapterDebugData.push(debugData)
            return { chapterTitle: chapter.title }
          } catch (error) {
            if (controller.signal.aborted) {
              return {
                chapterTitle: chapter.title,
                error: 'Generation aborted',
              }
            }
            console.error('[YOLO] Failed to generate chapter knowledge:', error)
            return {
              chapterTitle: chapter.title,
              error: error instanceof Error ? error.message : String(error),
            }
          }
        }),
      )
      if (controller.signal.aborted) {
        plugin.releaseLearningGeneration(controller)
        return
      }
      emitChaptersDebugLog(chapterDebugData)
      const failedKnowledgeChapters = knowledgeResults.filter(
        (result) => result.error,
      )
      if (failedKnowledgeChapters.length > 0) {
        eventBus.emitSynthetic({
          type: 'knowledge_point_focused',
          projectId: scaffold.projectPath,
          knowledgePointId: null,
        })
        await eventBus.refreshSnapshot({ emitInitial: false })
        if (controller.signal.aborted) {
          plugin.releaseLearningGeneration(controller)
          return
        }
        new Notice(
          formatLearningText(
            t(
              'learning.outlineBuilder.failedKnowledgeChapters',
              '知识点生成失败：{chapters}',
            ),
            {
              chapters: failedKnowledgeChapters
                .map((result) => result.chapterTitle)
                .join(', '),
            },
          ),
        )
        plugin.releaseLearningGeneration(controller)
        return
      }
      await markProjectStudying({
        app: plugin.app,
        indexPath: scaffold.indexPath,
      })
      eventBus.emitSynthetic({
        type: 'knowledge_point_focused',
        projectId: scaffold.projectPath,
        knowledgePointId: null,
      })
      await eventBus.refreshSnapshot({ emitInitial: false })
      if (controller.signal.aborted) {
        plugin.releaseLearningGeneration(controller)
        return
      }
      onComplete(scaffold.projectPath)

      const runId = `cards-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const showGenerationResult = (results: CardGenerationResult[]) => {
        const summary = summarizeCardGeneration(results)
        const canStartLearning = summary.outcome !== 'failed'
        const title =
          summary.outcome === 'success'
            ? t('learning.cards.generationCompleteTitle', '学习卡片已生成')
            : summary.outcome === 'partial'
              ? t('learning.cards.generationPartialTitle', '部分卡片生成完成')
              : t('learning.cards.generationFailedTitle', '学习卡片生成失败')
        const message =
          summary.outcome === 'success'
            ? summary.skippedChapterCount > 0
              ? formatLearningText(
                  t(
                    'learning.cards.generationExistingSummary',
                    '{chapters} 个章节的学习卡片已准备好，本次新增 {cards} 张。',
                  ),
                  {
                    chapters: summary.chapterCount,
                    cards: summary.cardCount,
                  },
                )
              : formatLearningText(
                  t(
                    'learning.cards.generationCompleteSummary',
                    '已生成 {chapters} 个章节、{cards} 张卡片。',
                  ),
                  {
                    chapters: summary.chapterCount,
                    cards: summary.cardCount,
                  },
                )
            : summary.outcome === 'partial'
              ? formatLearningText(
                  t(
                    'learning.cards.generationPartialSummary',
                    '已生成 {cards} 张卡片，{count} 个章节未完整生成。',
                  ),
                  {
                    cards: summary.cardCount,
                    count: summary.incompleteChapterCount,
                  },
                )
              : t(
                  'learning.cards.generationFailedSummary',
                  '未能生成学习卡片，请查看章节状态。',
                )

        plugin.showActionToast({
          id: `learning-card-generation:${scaffold.projectPath}`,
          tone:
            summary.outcome === 'success'
              ? 'success'
              : summary.outcome === 'partial'
                ? 'warning'
                : 'error',
          title,
          message,
          actionLabel: canStartLearning
            ? t('learning.cards.startLearning', '开始学习')
            : t('learning.cards.viewGenerationDetails', '查看详情'),
          dismissLabel: t('common.close', '关闭'),
          onAction: () =>
            plugin.openLearningView({
              type: 'project',
              projectId: scaffold.projectPath,
              tab: '卡片',
              cardMode: canStartLearning ? '学习' : '浏览',
            }),
        })
      }

      onCardGenerationStarted(runId, scaffold.projectPath)
      void generateCardsParallel({
        plugin,
        modelId: learningModelId,
        projectTopic: resolvedProjectName,
        projectPath: scaffold.projectPath,
        chapters: validChapters.map((chapter, index) => ({
          title: chapter.title,
          contract: chapter.contract,
          knowledgePath: scaffold.chapters[index].knowledgePath,
          cardsPath: scaffold.chapters[index].cardsPath,
        })),
        level,
        workspaceScope: knowledgeWorkspaceScope,
        abortSignal: controller.signal,
        activity: {
          kind: 'learning-agent',
          title: t('learning.wizard.modeLabel', '学习模式'),
          detail: t('learning.cards.generating', '正在生成学习卡片'),
          action: 'open-learning-view',
        },
        runId,
        projectId: scaffold.projectPath,
        onCard,
        onChapterSettled: (result) =>
          onChapterSettled(runId, scaffold.projectPath, result),
      })
        .then(async (results) => {
          if (controller.signal.aborted) return
          await eventBus.refreshSnapshot({ emitInitial: false })
          if (controller.signal.aborted) return
          onCardGenerationFinished(runId, scaffold.projectPath, false)
          showGenerationResult(results)
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return
          onCardGenerationFinished(runId, scaffold.projectPath, true)
          console.error('[YOLO] Card generation failed:', error)
          showGenerationResult([])
        })
        .finally(() => plugin.releaseLearningGeneration(controller))
    } catch (err: unknown) {
      plugin.releaseLearningGeneration(controller)
      if (!controller.signal.aborted) {
        console.error(
          '[YOLO] Failed to finalize generated learning project:',
          err,
        )
      }
      return
    }
  }

  const generating = phase === 'outline'
  const busy = phase === 'outline' || phase === 'knowledge'
  const hasIncompleteChapters =
    chapters.length === 0 ||
    chapters.some(
      (chapter) => !chapter.title.trim() || !chapter.contract.trim(),
    )
  const generationHeading =
    chapters.length > 0
      ? formatLearningText(
          t(
            'learning.outlineBuilder.refiningHeading',
            '已规划 {count} 个章节，正在继续完善...',
          ),
          { count: chapters.length },
        )
      : outlineWaitingStage === 'structuring'
        ? t('learning.outlineBuilder.structuringHeading', '正在组织章节结构...')
        : t('learning.outlineBuilder.generatingHeading', '正在准备学习规划...')

  return (
    <div className="yolo-learning-outline-builder">
      <header className="yolo-learning-outline-builder-header">
        <div className="yolo-learning-outline-builder-header-main">
          <button
            type="button"
            onClick={onCancel}
            className="yolo-learning-outline-builder-back"
          >
            <ArrowLeft size={18} />
          </button>
          <div className="yolo-learning-outline-builder-divider" />
          <h1 className="yolo-learning-outline-builder-title">
            {generating && !projectName ? (
              <span className="yolo-learning-outline-builder-title-skeleton yolo-learning-outline-builder-pulse" />
            ) : (
              projectName
            )}
          </h1>
          <span className="yolo-learning-outline-builder-badge">
            {t('learning.outlineBuilder.draftBadge', '大纲草稿')}
          </span>
        </div>
        <span className="yolo-learning-outline-builder-status">
          {resolveStatusLabel(phase, t)}
        </span>
      </header>

      <div className="yolo-learning-outline-builder-layout">
        <div
          ref={scrollRef}
          className="yolo-learning-outline-builder-main yolo-learning-scrollbar-thin"
        >
          <div className="yolo-learning-outline-builder-intro">
            <div className="yolo-learning-outline-builder-sparkles">
              <Sparkles size={20} />
            </div>
            <div>
              <h2 className="yolo-learning-outline-builder-heading">
                {generating ? (
                  <span
                    key={generationHeading}
                    className="yolo-learning-outline-builder-heading-status"
                  >
                    {generationHeading}
                  </span>
                ) : (
                  t(
                    'learning.outlineBuilder.readyHeading',
                    '章节大纲与生成契约',
                  )
                )}
              </h2>
            </div>
          </div>

          <div className="yolo-learning-outline-builder-chapters">
            {phase === 'error' && (
              <ErrorCard onRetry={startOutlineGeneration} t={t} />
            )}

            <DndContext
              sensors={dragSensors}
              collisionDetection={closestCenter}
              onDragEnd={handleChapterDragEnd}
            >
              <SortableContext
                items={chapters.map((chapter) => chapter.id)}
                strategy={verticalListSortingStrategy}
              >
                {chapters.map((chapter, i) => (
                  <ChapterCard
                    key={chapter.id}
                    index={i}
                    chapter={chapter}
                    disabled={busy}
                    onUpdate={(patch) => updateChapter(i, patch)}
                    onDelete={() => deleteChapter(i)}
                    t={t}
                  />
                ))}
              </SortableContext>
            </DndContext>

            {generating && <SkeletonCard t={t} />}

            {phase === 'ready' && (
              <button
                type="button"
                onClick={addChapter}
                className="yolo-learning-outline-builder-add"
              >
                <Plus size={16} />
                {t(
                  'learning.outlineBuilder.addCustomChapter',
                  '添加自定义章节',
                )}
              </button>
            )}
          </div>
        </div>

        <aside className="yolo-learning-outline-builder-rail">
          <div className="yolo-learning-outline-builder-rail-scroll yolo-learning-scrollbar-thin">
            <h3 className="yolo-learning-outline-builder-rail-title">
              {t('learning.outlineBuilder.overview', '本次生成概览')}
            </h3>

            <dl className="yolo-learning-outline-builder-stats">
              <Stat
                icon={<ListTree size={14} />}
                label={t('learning.outlineBuilder.chapters', '章节')}
                value={
                  generating && chapters.length === 0
                    ? '-'
                    : String(chapters.length)
                }
              />
              <Stat
                icon={<Zap size={14} />}
                label={t(
                  'learning.outlineBuilder.estimatedKnowledgePoints',
                  '预计知识点',
                )}
                value={
                  generating && chapters.length === 0
                    ? '-'
                    : String(estimatedKnowledgePoints)
                }
              />
            </dl>

            <div className="yolo-learning-outline-builder-map">
              <div className="yolo-learning-outline-builder-map-title">
                {t('learning.outlineBuilder.chapterNavigation', '章节导航')}
              </div>
              {generating && chapters.length === 0 ? (
                <div className="yolo-learning-outline-builder-map-skeletons">
                  {['a', 'b', 'c'].map((k) => (
                    <div
                      key={k}
                      className="yolo-learning-outline-builder-map-skeleton yolo-learning-outline-builder-pulse"
                    />
                  ))}
                </div>
              ) : (
                <ol className="yolo-learning-outline-builder-map-list">
                  {chapters.map((chapter, i) => (
                    <li key={`${chapter.title}-${i}`}>
                      <button
                        type="button"
                        onClick={() => scrollToChapter(i + 1)}
                        className="yolo-learning-outline-builder-map-item"
                      >
                        <span className="yolo-learning-outline-builder-map-index">
                          {i + 1}
                        </span>
                        <span className="yolo-learning-outline-builder-map-label">
                          {chapter.title}
                        </span>
                      </button>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </div>

          <div className="yolo-learning-outline-builder-rail-footer">
            <button
              type="button"
              onClick={() => void confirmAndGenerate()}
              disabled={busy || phase === 'error' || hasIncompleteChapters}
              className="yolo-learning-outline-builder-complete"
            >
              <Layers size={16} />
              {t(
                'learning.outlineBuilder.confirmGenerate',
                '确认大纲并生成知识点',
              )}
            </button>
          </div>
        </aside>
      </div>
    </div>
  )
}

function resolveStatusLabel(
  phase: Phase,
  t: (keyPath: string, fallback?: string) => string,
): string {
  if (phase === 'outline') {
    return t('learning.outlineBuilder.outlineGenerating', '正在生成大纲')
  }
  if (phase === 'knowledge') {
    return t('learning.outlineBuilder.knowledgeGenerating', '正在生成知识点')
  }
  if (phase === 'error') {
    return t('learning.outlineBuilder.failed', '生成失败')
  }
  return t(
    'learning.outlineBuilder.subagentReady',
    '确认后将交由 Sub-Agent 生成',
  )
}

function Stat({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode
  label: string
  value: string
}) {
  return (
    <div className="yolo-learning-outline-builder-stat">
      <div className="yolo-learning-outline-builder-stat-label">
        {icon}
        {label}
      </div>
      <div className="yolo-learning-outline-builder-stat-value">{value}</div>
    </div>
  )
}

function ChapterCard({
  index,
  chapter,
  disabled,
  onUpdate,
  onDelete,
  t,
}: {
  index: number
  chapter: EditableChapter
  disabled: boolean
  onUpdate: (patch: Partial<OutlineChapter>) => void
  onDelete: () => void
  t: (keyPath: string, fallback?: string) => string
}) {
  const contractRef = useRef<HTMLTextAreaElement>(null)
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: chapter.id, disabled })

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  useEffect(() => {
    const textarea = contractRef.current
    if (!textarea) return
    textarea.setCssProps({ height: 'auto' })
    textarea.setCssProps({ height: `${textarea.scrollHeight}px` })
  }, [chapter.contract])

  return (
    <div
      ref={setNodeRef}
      id={`chapter-${index + 1}`}
      style={style}
      className={cx(
        'yolo-learning-outline-builder-card',
        isDragging && 'is-dragging',
      )}
      {...attributes}
    >
      <div className="yolo-learning-outline-builder-card-row">
        <div className="yolo-learning-outline-builder-card-lead">
          <button
            type="button"
            aria-label={t('learning.outlineBuilder.dragSort', '拖拽排序')}
            className="yolo-learning-outline-builder-drag"
            disabled={disabled}
            {...listeners}
          >
            <GripVertical size={14} />
          </button>
          <span className="yolo-learning-outline-builder-card-index">
            {index + 1}
          </span>
        </div>

        <div className="yolo-learning-outline-builder-card-content">
          <div className="yolo-learning-outline-builder-card-top">
            <input
              value={chapter.title}
              disabled={disabled}
              placeholder={t(
                'learning.outlineBuilder.chapterTitlePlaceholder',
                '章节标题',
              )}
              onChange={(event) => onUpdate({ title: event.target.value })}
              className="yolo-learning-outline-builder-card-title"
            />
            <div className="yolo-learning-outline-builder-actions">
              <IconBtn
                aria-label={t('common.delete', '删除')}
                disabled={disabled}
                onClick={onDelete}
              >
                <Trash2 size={14} />
              </IconBtn>
            </div>
          </div>
          <textarea
            ref={contractRef}
            value={chapter.contract}
            disabled={disabled}
            placeholder={t(
              'learning.outlineBuilder.chapterContractPlaceholder',
              '说明本章覆盖范围、边界和预计知识点',
            )}
            rows={1}
            onChange={(event) => onUpdate({ contract: event.target.value })}
            className="yolo-learning-outline-builder-contract"
          />
          {chapter.progress && (
            <ProgressLine progress={chapter.progress} t={t} />
          )}
        </div>
      </div>
    </div>
  )
}

function ProgressLine({
  progress,
  t,
}: {
  progress: GenerationProgress
  t: (keyPath: string, fallback?: string) => string
}) {
  const isError = progress.status === 'error'
  const isDone = progress.status === 'completed'
  return (
    <div className="yolo-learning-outline-builder-generating">
      {isError ? (
        <AlertCircle size={12} />
      ) : isDone ? (
        <CheckCircle2 size={12} />
      ) : (
        <Sparkles size={12} className="yolo-learning-outline-builder-pulse" />
      )}
      {isError
        ? t(
            'learning.outlineBuilder.knowledgeGenerationFailed',
            '知识点生成失败',
          )
        : isDone
          ? t(
              'learning.outlineBuilder.knowledgeGenerationComplete',
              '知识点生成完成',
            )
          : progress.currentKnowledgePointTitle
            ? formatLearningText(
                t(
                  'learning.outlineBuilder.knowledgeGeneratingCurrent',
                  '正在生成：{title}',
                ),
                { title: progress.currentKnowledgePointTitle },
              )
            : t(
                'learning.outlineBuilder.knowledgeGenerating',
                '正在生成知识点',
              )}
    </div>
  )
}

function SkeletonCard({
  t,
}: {
  t: (keyPath: string, fallback?: string) => string
}) {
  return (
    <div className="yolo-learning-outline-builder-skeleton-card">
      <div className="yolo-learning-outline-builder-card-row">
        <span className="yolo-learning-outline-builder-skeleton-index" />
        <div className="yolo-learning-outline-builder-skeleton-content">
          <div className="yolo-learning-outline-builder-skeleton-title-row">
            <div className="yolo-learning-outline-builder-skeleton-title yolo-learning-outline-builder-pulse" />
            <span className="yolo-learning-outline-builder-generating">
              <Sparkles
                size={10}
                className="yolo-learning-outline-builder-pulse"
              />
              {t('learning.outlineBuilder.generating', '生成中...')}
            </span>
          </div>
          <div className="yolo-learning-outline-builder-skeleton-lines">
            <div className="yolo-learning-outline-builder-skeleton-line yolo-learning-outline-builder-pulse" />
            <div className="yolo-learning-outline-builder-skeleton-line yolo-learning-outline-builder-skeleton-line-short yolo-learning-outline-builder-pulse" />
          </div>
        </div>
      </div>
    </div>
  )
}

function ErrorCard({
  onRetry,
  t,
}: {
  onRetry: () => void
  t: (keyPath: string, fallback?: string) => string
}) {
  return (
    <div className="yolo-learning-outline-builder-card">
      <div className="yolo-learning-outline-builder-card-row">
        <AlertCircle size={18} />
        <div className="yolo-learning-outline-builder-card-content">
          <h3 className="yolo-learning-outline-builder-card-title">
            {t('learning.outlineBuilder.failed', '生成失败')}
          </h3>
          <div className="yolo-learning-outline-builder-contract">
            {t(
              'learning.outlineBuilder.failedDescription',
              '无法继续生成，请重试。',
            )}
          </div>
          <button
            type="button"
            onClick={onRetry}
            className="yolo-learning-outline-builder-add"
          >
            {t('common.retry', '重试')}
          </button>
        </div>
      </div>
    </div>
  )
}

function IconBtn({
  children,
  className,
  ...props
}: React.ComponentProps<'button'>) {
  return (
    <button
      type="button"
      className={cx('yolo-learning-outline-builder-icon-btn', className)}
      {...props}
    >
      {children}
    </button>
  )
}
