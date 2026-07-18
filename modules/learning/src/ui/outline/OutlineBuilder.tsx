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
import type React from 'react'
import { useEffect, useRef, useState } from 'react'

import type { StagedReference } from '../../generation/referenceStaging'
import type {
  GenerationProgress,
  Outline,
  OutlineChapter,
} from '../../generation/types'
import type { LearningTranslate } from '../wizard/Wizard'

type Phase = 'outline' | 'ready' | 'knowledge' | 'error'
type EditableChapter = OutlineChapter & {
  id: string
  progress?: GenerationProgress
}

export type OutlineBuilderWorkflow = {
  generateOutline: (input: {
    topic: string
    level: string
    goal: string
    referencesBlock?: string
    stagingDir?: string
    referenceFiles?: readonly StagedReference[]
    signal: AbortSignal
    onOutline: (outline: Outline) => void
    onProgress: () => void
  }) => Promise<Outline>
  generateProject: (input: {
    topic: string
    level: string
    goal: string
    projectName: string
    projectGoal: string
    chapters: readonly OutlineChapter[]
    stagingDir?: string
    referenceFiles?: readonly StagedReference[]
    signal: AbortSignal
    onProjectStarted: (projectId: string) => void | Promise<void>
    onChapterProgress: (progress: GenerationProgress) => void
    onComplete: (projectId: string) => void
  }) => Promise<void>
}

export function OutlineBuilder({
  topic,
  level,
  goal,
  referencesBlock,
  stagingDir,
  referenceFiles,
  workflow,
  t,
  onCancel,
  onProjectStarted,
  onComplete,
}: {
  topic: string
  level: string
  goal: string
  referencesBlock?: string
  stagingDir?: string
  referenceFiles?: readonly StagedReference[]
  workflow: OutlineBuilderWorkflow
  t: LearningTranslate
  onCancel: () => void
  onProjectStarted: (projectId: string) => void | Promise<void>
  onComplete: (projectId: string) => void
}) {
  const [chapters, setChapters] = useState<EditableChapter[]>([])
  const [projectName, setProjectName] = useState('')
  const [projectGoal, setProjectGoal] = useState('')
  const [estimatedKnowledgePoints, setEstimatedKnowledgePoints] = useState(0)
  const [phase, setPhase] = useState<Phase>('outline')
  const [structuring, setStructuring] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const abortOnUnmountRef = useRef(true)
  const nextChapterIdRef = useRef(0)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  )
  const busy = phase === 'outline' || phase === 'knowledge'

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
    setStructuring(false)
    setError(null)
    setChapters([])
    setProjectName('')
    setProjectGoal('')
    setEstimatedKnowledgePoints(0)
    nextChapterIdRef.current = 0
    void workflow
      .generateOutline({
        topic,
        level,
        goal,
        referencesBlock,
        stagingDir,
        referenceFiles,
        signal: controller.signal,
        onOutline: reconcileOutline,
        onProgress: () => {
          if (!controller.signal.aborted) setStructuring(true)
        },
      })
      .then((outline) => {
        if (controller.signal.aborted) return
        reconcileOutline(outline)
        setPhase('ready')
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return
        setError(reason instanceof Error ? reason.message : String(reason))
        setPhase('error')
      })
  }

  useEffect(() => {
    startOutlineGeneration()
    return () => {
      if (abortOnUnmountRef.current) abortRef.current?.abort()
    }
  }, [])

  const confirmAndGenerate = async () => {
    const validChapters = chapters.filter(
      (chapter) => chapter.title.trim() && chapter.contract.trim(),
    )
    if (validChapters.length === 0) {
      setError(
        t('learning.outlineBuilder.chapterRequired', '至少需要一个有效章节'),
      )
      setPhase('error')
      return
    }
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setPhase('knowledge')
    setError(null)
    try {
      await workflow.generateProject({
        topic,
        level,
        goal,
        projectName: projectName || topic,
        projectGoal,
        chapters: validChapters,
        stagingDir,
        referenceFiles,
        signal: controller.signal,
        onProjectStarted: async (projectId) => {
          abortOnUnmountRef.current = false
          await onProjectStarted(projectId)
        },
        onChapterProgress: (progress) => {
          setChapters((current) =>
            current.map((chapter, index) =>
              index === progress.chapterIndex
                ? { ...chapter, progress }
                : chapter,
            ),
          )
        },
        onComplete,
      })
    } catch (reason) {
      if (controller.signal.aborted) return
      setError(reason instanceof Error ? reason.message : String(reason))
      setPhase('error')
    }
  }

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (busy || !over || active.id === over.id) return
    setChapters((current) => {
      const oldIndex = current.findIndex((chapter) => chapter.id === active.id)
      const newIndex = current.findIndex((chapter) => chapter.id === over.id)
      return oldIndex < 0 || newIndex < 0
        ? current
        : arrayMove(current, oldIndex, newIndex)
    })
  }
  const generationHeading =
    chapters.length > 0
      ? t(
          'learning.outlineBuilder.refiningHeading',
          '已规划 {count} 个章节，正在继续完善...',
        ).replace('{count}', String(chapters.length))
      : structuring
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
            aria-label={t('common.back', '返回')}
          >
            <ArrowLeft size={18} aria-hidden />
          </button>
          <div className="yolo-learning-outline-builder-divider" />
          <h1 className="yolo-learning-outline-builder-title">
            {phase === 'outline' && !projectName ? (
              <span className="yolo-learning-outline-builder-title-skeleton yolo-learning-outline-builder-pulse" />
            ) : (
              projectName
            )}
          </h1>
          <span className="yolo-learning-outline-builder-badge">
            {t('learning.outlineBuilder.draftBadge', '大纲草稿')}
          </span>
        </div>
        <span className="yolo-learning-outline-builder-status" role="status">
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
              <Sparkles size={20} aria-hidden />
            </div>
            <h2 className="yolo-learning-outline-builder-heading">
              {phase === 'outline'
                ? generationHeading
                : t(
                    'learning.outlineBuilder.readyHeading',
                    '章节大纲与生成契约',
                  )}
            </h2>
          </div>
          <div className="yolo-learning-outline-builder-chapters">
            {phase === 'error' && (
              <ErrorCard
                error={error ?? t('learning.outlineBuilder.failed', '生成失败')}
                retryLabel={t('common.retry', '重试')}
                onRetry={startOutlineGeneration}
              />
            )}
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={chapters.map((chapter) => chapter.id)}
                strategy={verticalListSortingStrategy}
              >
                {chapters.map((chapter, index) => (
                  <ChapterCard
                    key={chapter.id}
                    index={index}
                    chapter={chapter}
                    disabled={busy}
                    t={t}
                    onUpdate={(patch) =>
                      setChapters((current) =>
                        current.map((item, itemIndex) =>
                          itemIndex === index ? { ...item, ...patch } : item,
                        ),
                      )
                    }
                    onDelete={() =>
                      setChapters((current) =>
                        current.filter((_, itemIndex) => itemIndex !== index),
                      )
                    }
                  />
                ))}
              </SortableContext>
            </DndContext>
            {phase === 'outline' && <SkeletonCard t={t} />}
            {phase === 'ready' && (
              <button
                type="button"
                className="yolo-learning-outline-builder-add"
                onClick={() =>
                  setChapters((current) => [
                    ...current,
                    {
                      id: `chapter-${nextChapterIdRef.current++}`,
                      title: t('learning.outlineBuilder.newChapter', '新章节'),
                      contract: t(
                        'learning.outlineBuilder.newChapterContract',
                        '说明本章覆盖范围、边界和预计知识点。',
                      ),
                    },
                  ])
                }
              >
                <Plus size={16} aria-hidden />
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
                icon={<ListTree size={14} aria-hidden />}
                label={t('learning.outlineBuilder.chapters', '章节')}
                value={String(chapters.length)}
              />
              <Stat
                icon={<Zap size={14} aria-hidden />}
                label={t(
                  'learning.outlineBuilder.estimatedKnowledgePoints',
                  '预计知识点',
                )}
                value={String(estimatedKnowledgePoints)}
              />
            </dl>
            <div className="yolo-learning-outline-builder-map">
              <div className="yolo-learning-outline-builder-map-title">
                {t('learning.outlineBuilder.chapterNavigation', '章节导航')}
              </div>
              <ol className="yolo-learning-outline-builder-map-list">
                {chapters.map((chapter, index) => (
                  <li key={chapter.id}>
                    <button
                      type="button"
                      className="yolo-learning-outline-builder-map-item"
                      onClick={() =>
                        scrollRef.current
                          ?.querySelector<HTMLElement>(`#chapter-${index + 1}`)
                          ?.scrollIntoView({
                            behavior: 'smooth',
                            block: 'start',
                          })
                      }
                    >
                      <span className="yolo-learning-outline-builder-map-index">
                        {index + 1}
                      </span>
                      <span className="yolo-learning-outline-builder-map-label">
                        {chapter.title}
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
            </div>
          </div>
          <div className="yolo-learning-outline-builder-rail-footer">
            <button
              type="button"
              onClick={() => void confirmAndGenerate()}
              disabled={busy || phase === 'error'}
              className="yolo-learning-outline-builder-complete"
            >
              <Layers size={16} aria-hidden />
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

export function resolveStatusLabel(phase: Phase, t: LearningTranslate) {
  if (phase === 'outline')
    return t('learning.outlineBuilder.outlineGenerating', '正在生成大纲')
  if (phase === 'knowledge')
    return t('learning.outlineBuilder.knowledgeGenerating', '正在生成知识点')
  if (phase === 'error') return t('learning.outlineBuilder.failed', '生成失败')
  return t(
    'learning.outlineBuilder.subagentReady',
    '确认后将交由 Sub-Agent 生成',
  )
}

function ChapterCard({
  index,
  chapter,
  disabled,
  t,
  onUpdate,
  onDelete,
}: {
  index: number
  chapter: EditableChapter
  disabled: boolean
  t: LearningTranslate
  onUpdate: (patch: Partial<OutlineChapter>) => void
  onDelete: () => void
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
      style={{ transform: CSS.Transform.toString(transform), transition }}
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
            <GripVertical size={14} aria-hidden />
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
              onChange={(event) => onUpdate({ title: event.target.value })}
              className="yolo-learning-outline-builder-card-title"
            />
            <button
              type="button"
              aria-label={t('common.delete', '删除')}
              disabled={disabled}
              onClick={onDelete}
              className="yolo-learning-outline-builder-icon-btn"
            >
              <Trash2 size={14} aria-hidden />
            </button>
          </div>
          <textarea
            ref={contractRef}
            value={chapter.contract}
            disabled={disabled}
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
  t: LearningTranslate
}) {
  const error = progress.status === 'error'
  const done = progress.status === 'completed'
  return (
    <div className="yolo-learning-outline-builder-generating" role="status">
      {error ? (
        <AlertCircle size={12} aria-hidden />
      ) : done ? (
        <CheckCircle2 size={12} aria-hidden />
      ) : (
        <Sparkles
          size={12}
          className="yolo-learning-outline-builder-pulse"
          aria-hidden
        />
      )}
      {error
        ? progress.error
        : done
          ? t('learning.outlineBuilder.knowledgeComplete', '知识点生成完成')
          : progress.currentKnowledgePointTitle
            ? `${t('learning.outlineBuilder.generatingPoint', '正在生成')}：${progress.currentKnowledgePointTitle}`
            : t(
                'learning.outlineBuilder.knowledgeGenerating',
                '知识点生成中...',
              )}
    </div>
  )
}

function SkeletonCard({ t }: { t: LearningTranslate }) {
  return (
    <div
      className="yolo-learning-outline-builder-skeleton-card"
      aria-label={t('learning.outlineBuilder.generating', '生成中...')}
    >
      <div className="yolo-learning-outline-builder-card-row">
        <span className="yolo-learning-outline-builder-skeleton-index" />
        <div className="yolo-learning-outline-builder-skeleton-content">
          <div className="yolo-learning-outline-builder-skeleton-title yolo-learning-outline-builder-pulse" />
          <div className="yolo-learning-outline-builder-skeleton-line yolo-learning-outline-builder-pulse" />
        </div>
      </div>
    </div>
  )
}

function ErrorCard({
  error,
  retryLabel,
  onRetry,
}: {
  error: string
  retryLabel: string
  onRetry: () => void
}) {
  return (
    <div className="yolo-learning-outline-builder-card" role="alert">
      <div className="yolo-learning-outline-builder-card-row">
        <AlertCircle size={18} aria-hidden />
        <div className="yolo-learning-outline-builder-card-content">
          <div className="yolo-learning-outline-builder-contract">{error}</div>
          <button
            type="button"
            onClick={onRetry}
            className="yolo-learning-outline-builder-add"
          >
            {retryLabel}
          </button>
        </div>
      </div>
    </div>
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
