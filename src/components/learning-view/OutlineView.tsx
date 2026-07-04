import cx from 'clsx'
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Pencil,
  Plus,
  RotateCcw,
  Search,
} from 'lucide-react'
import { TFile } from 'obsidian'
import { type ReactNode, useEffect, useMemo, useState } from 'react'

import { useApp } from '../../contexts/app-context'
import { useLanguage } from '../../contexts/language-context'
import { scanMarkdownEntries } from '../../core/learning/markdownScanner'
import type {
  Chapter as VaultChapter,
  KnowledgePoint as VaultKnowledgePoint,
  Project as VaultProject,
} from '../../core/learning/types'

import { formatLearningText } from './i18n'
import { MasteryDot, Pill } from './primitives'

export function OutlineView({
  project,
  selectedPointId,
  onSelectPoint,
}: {
  project: VaultProject
  selectedPointId: string | null
  onSelectPoint: (id: string) => void
}) {
  const { t } = useLanguage()
  const pointsByChapter = useMemo(() => {
    const map = new Map<string, VaultKnowledgePoint[]>()
    for (const chapter of project.chapters) {
      map.set(
        chapter.id,
        project.knowledgePoints.filter(
          (point) => point.chapterId === chapter.id,
        ),
      )
    }
    return map
  }, [project])
  const firstPoint = project.knowledgePoints[0] ?? null
  const point =
    project.knowledgePoints.find((item) => item.id === selectedPointId) ??
    firstPoint
  const chapter = point
    ? (project.chapters.find((item) => item.id === point.chapterId) ?? null)
    : null

  useEffect(() => {
    if (!selectedPointId && firstPoint) onSelectPoint(firstPoint.id)
  }, [firstPoint, onSelectPoint, selectedPointId])

  if (project.knowledgePoints.length === 0) {
    return (
      <div className="yolo-learning-outline-empty">
        {t(
          'learning.outline.emptyProject',
          '这个项目还没有知识点。生成完成后会在这里显示大纲。',
        )}
      </div>
    )
  }

  return (
    <div className="yolo-learning-outline">
      <aside className="yolo-learning-outline-sidebar">
        <div className="yolo-learning-outline-search-wrap">
          <Search size={15} className="yolo-learning-outline-search-icon" />
          <input
            placeholder={t('learning.outline.searchPlaceholder', '搜索知识点…')}
            className="yolo-learning-outline-search-input"
          />
        </div>

        <div className="yolo-learning-outline-tree">
          {project.chapters.map((item, index) => (
            <ChapterNode
              key={item.id}
              chapter={item}
              chapterIndex={index + 1}
              points={pointsByChapter.get(item.id) ?? []}
              selectedPointId={point?.id ?? null}
              onSelectPoint={onSelectPoint}
            />
          ))}
        </div>

        <div className="yolo-learning-outline-add-actions">
          <GhostBtn>
            <Plus size={14} /> {t('learning.outline.addChapter', '添加章节')}
          </GhostBtn>
          <GhostBtn>
            <Plus size={14} /> {t('learning.outline.addPoint', '添加知识点')}
          </GhostBtn>
        </div>
      </aside>

      <section className="yolo-learning-outline-detail-panel">
        {point && chapter ? (
          <Detail
            point={point}
            chapter={chapter}
            chapterIndex={
              project.chapters.findIndex((c) => c.id === chapter.id) + 1
            }
            t={t}
          />
        ) : (
          <div className="yolo-learning-outline-empty">
            {t('learning.outline.noPointSelected', '请选择一个知识点')}
          </div>
        )}
      </section>
    </div>
  )
}

function ChapterNode({
  chapter,
  chapterIndex,
  points,
  selectedPointId,
  onSelectPoint,
}: {
  chapter: VaultChapter
  chapterIndex: number
  points: VaultKnowledgePoint[]
  selectedPointId: string | null
  onSelectPoint: (id: string) => void
}) {
  const [open, setOpen] = useState(true)

  return (
    <div className="yolo-learning-outline-chapter">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="yolo-learning-outline-chapter-trigger"
      >
        {open ? (
          <ChevronDown size={15} className="yolo-learning-outline-muted-icon" />
        ) : (
          <ChevronRight
            size={15}
            className="yolo-learning-outline-muted-icon"
          />
        )}
        <span className="yolo-learning-outline-chapter-index">
          {chapterIndex}
        </span>
        <span className="yolo-learning-outline-chapter-title">
          {chapter.title}
        </span>
        <span className="yolo-learning-outline-chapter-count">
          0/{points.length}
        </span>
      </button>

      {open && (
        <div className="yolo-learning-outline-points">
          {points.map((p, index) => {
            const active = p.id === selectedPointId
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => onSelectPoint(p.id)}
                className={cx(
                  'yolo-learning-outline-point',
                  active && 'is-active',
                )}
              >
                {active && (
                  <span className="yolo-learning-outline-active-bar" />
                )}
                <MasteryDot mastery="new" />
                <span className="yolo-learning-outline-point-title">
                  {chapterIndex}.{index + 1} {p.title}
                </span>
                <span className="yolo-learning-outline-point-progress">0%</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function Detail({
  point,
  chapter,
  chapterIndex,
  t,
}: {
  point: VaultKnowledgePoint
  chapter: VaultChapter
  chapterIndex: number
  t: (keyPath: string, fallback?: string) => string
}) {
  const app = useApp()
  const [body, setBody] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      setLoading(true)
      const file = app.vault.getAbstractFileByPath(point.knowledgeFilePath)
      if (!(file instanceof TFile)) {
        if (!cancelled) {
          setBody('')
          setLoading(false)
        }
        return
      }
      const content = await app.vault.cachedRead(file)
      const entry = scanMarkdownEntries(content).find(
        (item) => item.type === 'kp' && item.uuid === point.uuid,
      )
      if (!cancelled) {
        setBody(entry?.body ?? '')
        setLoading(false)
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [app, point])

  return (
    <div className="yolo-learning-outline-detail">
      <div className="yolo-learning-outline-breadcrumb">
        <span>
          {formatLearningText(
            t('learning.outline.chapterLabel', '章节 {index}'),
            {
              index: chapterIndex,
            },
          )}
        </span>
        <span>·</span>
        <span>{chapter.title}</span>
        <ChevronRight size={12} />
        <span className="yolo-learning-outline-breadcrumb-current">
          {formatLearningText(
            t('learning.outline.pointLabel', '知识点 {index} {title}'),
            {
              index: point.uuid,
              title: point.title,
            },
          )}
        </span>
      </div>

      <div className="yolo-learning-outline-title-row">
        <h1 className="yolo-learning-outline-title">{point.title}</h1>
        <div className="yolo-learning-outline-actions">
          <OutlineBtn>
            <ExternalLink size={14} />{' '}
            {t('learning.outline.openInObsidian', '在 Obsidian 中打开')}
          </OutlineBtn>
          <OutlineBtn>
            <Pencil size={14} /> {t('common.edit', '编辑')}
          </OutlineBtn>
          <OutlineBtn>
            <RotateCcw size={14} />{' '}
            {t('learning.outline.regenerate', '重新生成')}
          </OutlineBtn>
        </div>
      </div>

      <div className="yolo-learning-outline-meta">
        <Pill tone="primary">
          {formatLearningText(
            t('learning.outline.masteryPct', '掌握度 {value}%'),
            {
              value: 0,
            },
          )}
        </Pill>
        <Pill>
          {formatLearningText(
            t('learning.outline.cardCount', '卡片 {count} 张'),
            {
              count: point.hasCards ? 1 : 0,
            },
          )}
        </Pill>
        <Pill>
          {formatLearningText(
            t('learning.outline.exerciseCount', '习题 {count} 道'),
            {
              count: point.hasExercises ? 1 : 0,
            },
          )}
        </Pill>
      </div>

      <article className="yolo-learning-outline-markdown">
        {loading ? (
          <p>{t('learning.common.loading', '加载中…')}</p>
        ) : body ? (
          <pre>{body}</pre>
        ) : (
          <p>{t('learning.outline.emptyBody', '这个知识点还没有正文内容')}</p>
        )}
      </article>
    </div>
  )
}

function GhostBtn({ children }: { children: ReactNode }) {
  return (
    <button type="button" className="yolo-learning-outline-ghost-btn">
      {children}
    </button>
  )
}

function OutlineBtn({ children }: { children: ReactNode }) {
  return (
    <button type="button" className="yolo-learning-outline-btn">
      {children}
    </button>
  )
}
