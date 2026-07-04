import cx from 'clsx'
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  GripVertical,
  Layers,
  ListTree,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type React from 'react'

import { useLanguage } from '../../contexts/language-context'
import { generateKnowledgePointsParallel } from '../../core/learning/generation/knowledgePointGenerator'
import { generateOutline } from '../../core/learning/generation/outlineGenerator'
import { writeProject } from '../../core/learning/generation/projectWriter'
import type {
  ChapterGenerationResult,
  GenerationProgress,
  OutlineChapter,
} from '../../core/learning/generation/types'
import { getYoloLearningDir } from '../../core/paths/yoloPaths'
import type YoloPlugin from '../../main'

type Phase = 'outline' | 'ready' | 'knowledge' | 'writing' | 'error'

type EditableChapter = OutlineChapter & {
  progress?: GenerationProgress
}

export function OutlineBuilder({
  plugin,
  topic,
  level,
  goal,
  referencesBlock,
  onCancel,
  onComplete,
}: {
  plugin: YoloPlugin
  topic: string
  level: string
  goal: string
  referencesBlock?: string
  onCancel: () => void
  onComplete: (projectId: string) => void
}) {
  const { t } = useLanguage()
  const [chapters, setChapters] = useState<EditableChapter[]>([])
  const [phase, setPhase] = useState<Phase>('outline')
  const [outlineText, setOutlineText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  const startOutlineGeneration = () => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setPhase('outline')
    setError(null)
    setOutlineText('')
    setChapters([])
    void generateOutline({
      plugin,
      topic,
      level,
      goal,
      referencesBlock,
      abortSignal: controller.signal,
      onProgress: (_delta, fullText) => setOutlineText(fullText),
    })
      .then(({ chapters }) => {
        setChapters(chapters)
        setPhase('ready')
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setError(err instanceof Error ? err.message : String(err))
        setPhase('error')
      })
  }

  useEffect(() => {
    startOutlineGeneration()
    return () => abortRef.current?.abort()
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

  const moveChapter = (index: number, direction: -1 | 1) => {
    setChapters((current) => {
      const target = index + direction
      if (target < 0 || target >= current.length) return current
      const next = [...current]
      const [item] = next.splice(index, 1)
      next.splice(target, 0, item)
      return next
    })
  }

  const deleteChapter = (index: number) => {
    setChapters((current) => current.filter((_, i) => i !== index))
  }

  const addChapter = () => {
    setChapters((current) => [
      ...current,
      { title: '新章节', contract: '说明本章覆盖范围、边界和预计知识点。' },
    ])
  }

  const confirmAndGenerate = async () => {
    const validChapters = chapters.filter(
      (chapter) => chapter.title.trim() && chapter.contract.trim(),
    )
    if (validChapters.length === 0) {
      setError('至少需要一个有效章节')
      setPhase('error')
      return
    }
    const controller = new AbortController()
    abortRef.current = controller
    setPhase('knowledge')
    setError(null)

    const validChapterKeys = validChapters.map(
      (chapter, index) => `${index}-${chapter.title}`,
    )

    let results: ChapterGenerationResult[]
    try {
      results = await generateKnowledgePointsParallel({
        plugin,
        projectTopic: topic,
        chapters: validChapters,
        level,
        abortSignal: controller.signal,
        onChapterProgress: (progress) => {
          const key = validChapterKeys[progress.chapterIndex]
          setChapters((current) => {
            let validIndex = 0
            return current.map((chapter) => {
              if (!chapter.title.trim() || !chapter.contract.trim()) {
                return chapter
              }
              const currentKey = validChapterKeys[validIndex]
              validIndex += 1
              return currentKey === key ? { ...chapter, progress } : chapter
            })
          })
        },
      })
    } catch (err: unknown) {
      if (controller.signal.aborted) return
      setError(err instanceof Error ? err.message : String(err))
      setPhase('error')
      return
    }

    setPhase('writing')
    let written: { projectPath: string; projectSlug: string }
    try {
      written = await writeProject({
        app: plugin.app,
        baseDir: getYoloLearningDir(plugin.settings),
        topic,
        level,
        chapters: results,
      })
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
      setPhase('error')
      return
    }
    onComplete(written.projectPath)
  }

  const generating = phase === 'outline'
  const busy =
    phase === 'outline' || phase === 'knowledge' || phase === 'writing'

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
          <h1 className="yolo-learning-outline-builder-title">{topic}</h1>
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
                {generating
                  ? t(
                      'learning.outlineBuilder.generatingHeading',
                      '正在为你规划学习路径...',
                    )
                  : t(
                      'learning.outlineBuilder.readyHeading',
                      '章节大纲与生成契约',
                    )}
              </h2>
            </div>
          </div>

          <div className="yolo-learning-outline-builder-chapters">
            {phase === 'error' && (
              <ErrorCard
                error={error ?? '生成失败'}
                onRetry={startOutlineGeneration}
              />
            )}

            {chapters.map((chapter, i) => (
              <ChapterCard
                key={`${chapter.title}-${i}`}
                index={i}
                chapter={chapter}
                disabled={busy}
                onUpdate={(patch) => updateChapter(i, patch)}
                onMove={moveChapter}
                onDelete={() => deleteChapter(i)}
                t={t}
              />
            ))}

            {generating && <SkeletonCard t={t} outlineText={outlineText} />}

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
                value={generating ? '-' : String(chapters.length)}
              />
            </dl>

            <div className="yolo-learning-outline-builder-map">
              <div className="yolo-learning-outline-builder-map-title">
                {t('learning.outlineBuilder.chapterNavigation', '章节导航')}
              </div>
              {generating ? (
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
              disabled={busy || phase === 'error'}
              className="yolo-learning-outline-builder-complete"
            >
              <Layers size={16} />
              {phase === 'writing'
                ? t('learning.outlineBuilder.writing', '正在写入文件')
                : t(
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
  if (phase === 'writing') {
    return t('learning.outlineBuilder.writing', '正在写入文件')
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
  onMove,
  onDelete,
  t,
}: {
  index: number
  chapter: EditableChapter
  disabled: boolean
  onUpdate: (patch: Partial<OutlineChapter>) => void
  onMove: (index: number, direction: -1 | 1) => void
  onDelete: () => void
  t: (keyPath: string, fallback?: string) => string
}) {
  return (
    <div
      id={`chapter-${index + 1}`}
      className="yolo-learning-outline-builder-card"
    >
      <div className="yolo-learning-outline-builder-card-row">
        <div className="yolo-learning-outline-builder-card-lead">
          <button
            type="button"
            aria-label={t('learning.outlineBuilder.dragSort', '拖拽排序')}
            className="yolo-learning-outline-builder-drag"
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
              onChange={(event) => onUpdate({ title: event.target.value })}
              className="yolo-learning-outline-builder-card-title"
            />
            <div className="yolo-learning-outline-builder-actions">
              <IconBtn
                aria-label={t('learning.outlineBuilder.moveUp', '上移')}
                disabled={disabled || index === 0}
                onClick={() => onMove(index, -1)}
              >
                <ChevronUp size={14} />
              </IconBtn>
              <IconBtn
                aria-label={t('learning.outlineBuilder.moveDown', '下移')}
                disabled={disabled}
                onClick={() => onMove(index, 1)}
              >
                <ChevronDown size={14} />
              </IconBtn>
              <IconBtn aria-label={t('common.edit', '编辑')} disabled>
                <Pencil size={14} />
              </IconBtn>
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
            value={chapter.contract}
            disabled={disabled}
            rows={5}
            onChange={(event) => onUpdate({ contract: event.target.value })}
            className="yolo-learning-outline-builder-contract"
          />
          {chapter.progress && <ProgressLine progress={chapter.progress} />}
        </div>
      </div>
    </div>
  )
}

function ProgressLine({ progress }: { progress: GenerationProgress }) {
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
        ? progress.error
        : isDone
          ? '知识点生成完成'
          : progress.currentKnowledgePointTitle
            ? `正在生成：${progress.currentKnowledgePointTitle}`
            : '知识点生成中...'}
    </div>
  )
}

function SkeletonCard({
  t,
  outlineText,
}: {
  t: (keyPath: string, fallback?: string) => string
  outlineText: string
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
          {outlineText && (
            <pre className="yolo-learning-outline-builder-contract">
              {outlineText}
            </pre>
          )}
        </div>
      </div>
    </div>
  )
}

function ErrorCard({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div className="yolo-learning-outline-builder-card">
      <div className="yolo-learning-outline-builder-card-row">
        <AlertCircle size={18} />
        <div className="yolo-learning-outline-builder-card-content">
          <h3 className="yolo-learning-outline-builder-card-title">生成失败</h3>
          <div className="yolo-learning-outline-builder-contract">{error}</div>
          <button
            type="button"
            onClick={onRetry}
            className="yolo-learning-outline-builder-add"
          >
            重试
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
