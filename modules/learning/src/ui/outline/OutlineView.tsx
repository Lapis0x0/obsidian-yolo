import cx from 'clsx'
import { ChevronDown, ChevronRight, Pencil, Plus, Search } from 'lucide-react'
import {
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import { scanMarkdownEntries } from '../../domain/markdownScanner'
import type {
  Chapter,
  KnowledgePoint,
  OutlineProject,
} from '../../domain/types'
import { MasteryDot, Pill } from '../primitives'
import type { LearningTranslate } from '../wizard/Wizard'

const STORAGE_KEY = 'yolo-learning-outline-sidebar-width'
export const OUTLINE_SIDEBAR_DEFAULT_WIDTH = 280
export const OUTLINE_SIDEBAR_MIN_WIDTH = 220
export const OUTLINE_SIDEBAR_MAX_WIDTH = 420

export type LearningMarkdownRenderer = {
  render: (
    content: string,
    container: HTMLElement,
    sourcePath: string,
  ) => Promise<void>
  unload: () => void
}

export type OutlineViewHost = {
  readText: (path: string) => Promise<string | null>
  openMarkdownAtLine: (path: string, line?: number) => void
  createMarkdownRenderer: () => LearningMarkdownRenderer
  htmlToMarkdown: (html: string) => string
  openLinkText: (
    linktext: string,
    sourcePath: string,
    newLeaf: boolean,
  ) => void | Promise<void>
  isModEvent: (event: MouseEvent) => boolean
  triggerHoverLink: (input: {
    event: MouseEvent
    targetEl: EventTarget | null
    linktext: string
    sourcePath: string
  }) => void
}

export function clampOutlineSidebarWidth(width: number): number {
  return Math.min(
    OUTLINE_SIDEBAR_MAX_WIDTH,
    Math.max(OUTLINE_SIDEBAR_MIN_WIDTH, Math.round(width)),
  )
}

function readSidebarWidth(ownerWin: Window): number {
  try {
    const width = Number.parseInt(
      ownerWin.localStorage.getItem(STORAGE_KEY) ?? '',
      10,
    )
    return Number.isFinite(width)
      ? clampOutlineSidebarWidth(width)
      : OUTLINE_SIDEBAR_DEFAULT_WIDTH
  } catch {
    return OUTLINE_SIDEBAR_DEFAULT_WIDTH
  }
}

function persistSidebarWidth(ownerWin: Window, width: number): void {
  try {
    ownerWin.localStorage.setItem(
      STORAGE_KEY,
      String(clampOutlineSidebarWidth(width)),
    )
  } catch {
    // Layout preference persistence is best-effort only.
  }
}

export function OutlineView({
  project,
  selectedPointId,
  host,
  t,
  onSelectPoint,
}: {
  project: OutlineProject
  selectedPointId: string | null
  host: OutlineViewHost
  t: LearningTranslate
  onSelectPoint: (id: string) => void
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const resizeStartRef = useRef<{
    x: number
    width: number
    currentWidth: number
  } | null>(null)
  const [sidebarWidth, setSidebarWidth] = useState(
    OUTLINE_SIDEBAR_DEFAULT_WIDTH,
  )
  const pointsByChapter = useMemo(() => {
    const result = new Map<string, KnowledgePoint[]>()
    for (const chapter of project.chapters) {
      result.set(
        chapter.id,
        project.knowledgePoints.filter(
          (point) => point.chapterId === chapter.id,
        ),
      )
    }
    return result
  }, [project])
  const firstPoint = project.knowledgePoints[0] ?? null
  const point =
    project.knowledgePoints.find((item) => item.id === selectedPointId) ??
    firstPoint
  const chapter = point
    ? (project.chapters.find((item) => item.id === point.chapterId) ?? null)
    : null

  useEffect(() => {
    const ownerWin = rootRef.current?.ownerDocument.defaultView
    if (ownerWin) setSidebarWidth(readSidebarWidth(ownerWin))
  }, [])

  useEffect(() => {
    if (!selectedPointId && firstPoint) onSelectPoint(firstPoint.id)
  }, [firstPoint, onSelectPoint, selectedPointId])

  const handleResizeStart = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    const ownerDoc = event.currentTarget.ownerDocument
    const ownerWin = ownerDoc.defaultView
    if (!ownerWin) return
    resizeStartRef.current = {
      x: event.clientX,
      width: sidebarWidth,
      currentWidth: sidebarWidth,
    }
    const handleMouseMove = (moveEvent: MouseEvent) => {
      const start = resizeStartRef.current
      if (!start) return
      const width = clampOutlineSidebarWidth(
        start.width + moveEvent.clientX - start.x,
      )
      start.currentWidth = width
      setSidebarWidth(width)
    }
    const handleMouseUp = () => {
      const width = resizeStartRef.current?.currentWidth
      resizeStartRef.current = null
      ownerWin.removeEventListener('mousemove', handleMouseMove)
      ownerWin.removeEventListener('mouseup', handleMouseUp)
      ownerDoc.body.classList.remove('yolo-learning-outline-global-resize')
      ownerDoc.body.setCssProps({
        '--yolo-learning-outline-global-cursor': '',
        '--yolo-learning-outline-global-user-select': '',
      })
      if (width != null) persistSidebarWidth(ownerWin, width)
    }
    ownerWin.addEventListener('mousemove', handleMouseMove)
    ownerWin.addEventListener('mouseup', handleMouseUp)
    ownerDoc.body.classList.add('yolo-learning-outline-global-resize')
    ownerDoc.body.setCssProps({
      '--yolo-learning-outline-global-cursor': 'col-resize',
      '--yolo-learning-outline-global-user-select': 'none',
    })
  }

  const handleResizeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const delta =
      event.key === 'ArrowLeft' ? -16 : event.key === 'ArrowRight' ? 16 : 0
    if (delta === 0) return
    event.preventDefault()
    const ownerWin = event.currentTarget.ownerDocument.defaultView
    setSidebarWidth((current) => {
      const width = clampOutlineSidebarWidth(current + delta)
      if (ownerWin) persistSidebarWidth(ownerWin, width)
      return width
    })
  }

  if (project.knowledgePoints.length === 0) {
    return (
      <div ref={rootRef} className="yolo-learning-outline-empty">
        {t(
          'learning.outline.emptyProject',
          '这个项目还没有知识点。生成完成后会在这里显示大纲。',
        )}
      </div>
    )
  }

  const outlineStyle = {
    '--yolo-learning-outline-sidebar-width': `${sidebarWidth}px`,
  } as CSSProperties

  return (
    <div ref={rootRef} className="yolo-learning-outline" style={outlineStyle}>
      <aside className="yolo-learning-outline-sidebar">
        <div className="yolo-learning-outline-search-wrap">
          <Search
            size={15}
            className="yolo-learning-outline-search-icon"
            aria-hidden
          />
          <input
            placeholder={t('learning.outline.searchPlaceholder', '搜索知识点…')}
            className="yolo-learning-outline-search-input"
          />
        </div>
        <div className="yolo-learning-outline-nav">
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
              <Plus size={14} aria-hidden />{' '}
              {t('learning.outline.addChapter', '添加章节')}
            </GhostBtn>
            <GhostBtn>
              <Plus size={14} aria-hidden />{' '}
              {t('learning.outline.addPoint', '添加知识点')}
            </GhostBtn>
          </div>
        </div>
        <div
          aria-label={t('learning.outline.resizeSidebar', '调整大纲侧栏宽度')}
          aria-orientation="vertical"
          aria-valuemax={OUTLINE_SIDEBAR_MAX_WIDTH}
          aria-valuemin={OUTLINE_SIDEBAR_MIN_WIDTH}
          aria-valuenow={sidebarWidth}
          className="yolo-learning-outline-resize-handle"
          onKeyDown={handleResizeKeyDown}
          onMouseDown={handleResizeStart}
          role="separator"
          tabIndex={0}
        />
      </aside>
      <section className="yolo-learning-outline-detail-panel yolo-learning-scrollbar-thin">
        {point && chapter ? (
          <Detail
            point={point}
            chapter={chapter}
            chapterIndex={
              project.chapters.findIndex((item) => item.id === chapter.id) + 1
            }
            pointIndex={
              (pointsByChapter
                .get(chapter.id)
                ?.findIndex((item) => item.id === point.id) ?? 0) + 1
            }
            host={host}
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
  chapter: Chapter
  chapterIndex: number
  points: KnowledgePoint[]
  selectedPointId: string | null
  onSelectPoint: (id: string) => void
}) {
  const [open, setOpen] = useState(true)
  return (
    <div className="yolo-learning-outline-chapter">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="yolo-learning-outline-chapter-trigger"
      >
        {open ? (
          <ChevronDown size={15} aria-hidden />
        ) : (
          <ChevronRight size={15} aria-hidden />
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
          {points.map((point, index) => {
            const active = point.id === selectedPointId
            return (
              <button
                key={point.id}
                type="button"
                aria-current={active ? 'true' : undefined}
                onClick={() => onSelectPoint(point.id)}
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
                  {chapterIndex}.{index + 1} {point.title}
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
  pointIndex,
  host,
  t,
}: {
  point: KnowledgePoint
  chapter: Chapter
  chapterIndex: number
  pointIndex: number
  host: OutlineViewHost
  t: LearningTranslate
}) {
  const [body, setBody] = useState('')
  const [startLine, setStartLine] = useState<number | undefined>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    void host
      .readText(point.knowledgeFilePath)
      .then((content) => {
        if (cancelled) return
        const entry = content
          ? scanMarkdownEntries(content).find(
              (item) => item.type === 'kp' && item.uuid === point.uuid,
            )
          : undefined
        setBody(entry?.body ?? '')
        setStartLine(entry?.startLine)
      })
      .catch((reason: unknown) => {
        if (!cancelled)
          setError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [host, point])

  return (
    <div className="yolo-learning-outline-detail">
      <div className="yolo-learning-outline-breadcrumb">
        <span>
          {t('learning.outline.chapterLabel', '章节 {index}').replace(
            '{index}',
            String(chapterIndex),
          )}
        </span>
        <span>·</span>
        <span>{chapter.title}</span>
        <ChevronRight size={12} aria-hidden />
        <span className="yolo-learning-outline-breadcrumb-current">
          {chapterIndex}.{pointIndex} {point.title}
        </span>
      </div>
      <div className="yolo-learning-outline-title-row">
        <h1 className="yolo-learning-outline-title">{point.title}</h1>
        <div className="yolo-learning-outline-actions">
          <button
            type="button"
            className="yolo-learning-outline-btn"
            onClick={() =>
              host.openMarkdownAtLine(point.knowledgeFilePath, startLine)
            }
          >
            <Pencil size={14} aria-hidden /> {t('common.edit', '编辑')}
          </button>
        </div>
      </div>
      <div className="yolo-learning-outline-meta">
        <Pill tone="primary">
          {t('learning.outline.masteryPct', '掌握度 {value}%').replace(
            '{value}',
            '0',
          )}
        </Pill>
        <Pill>
          {t('learning.outline.cardCount', '卡片 {count} 张').replace(
            '{count}',
            point.hasCards ? '1' : '0',
          )}
        </Pill>
        <Pill>
          {t('learning.outline.exerciseCount', '习题 {count} 道').replace(
            '{count}',
            point.hasExercises ? '1' : '0',
          )}
        </Pill>
      </div>
      <article className="yolo-learning-outline-markdown">
        {loading ? (
          <p>{t('learning.common.loading', '加载中…')}</p>
        ) : error ? (
          <p role="alert">{error}</p>
        ) : body ? (
          <LearningMarkdown
            content={body}
            sourcePath={point.knowledgeFilePath}
            host={host}
          />
        ) : (
          <p>{t('learning.outline.emptyBody', '这个知识点还没有正文内容')}</p>
        )}
      </article>
    </div>
  )
}

function LearningMarkdown({
  content,
  sourcePath,
  host,
}: {
  content: string
  sourcePath: string
  host: OutlineViewHost
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let cancelled = false
    const renderer = host.createMarkdownRenderer()
    void (async () => {
      const container = containerRef.current
      if (!container) return
      const staging = container.ownerDocument.createElement('div')
      await renderer.render(content, staging, sourcePath)
      if (cancelled || !containerRef.current) return
      containerRef.current.replaceChildren(...Array.from(staging.childNodes))
      setupLinks(host, containerRef.current, sourcePath)
    })()
    return () => {
      cancelled = true
      renderer.unload()
    }
  }, [content, host, sourcePath])
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const handleCopy = (event: ClipboardEvent) => {
      const selection = container.ownerDocument.defaultView?.getSelection()
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed)
        return
      if (
        !selection.anchorNode ||
        !selection.focusNode ||
        !container.contains(selection.anchorNode) ||
        !container.contains(selection.focusNode)
      )
        return
      const staging = container.ownerDocument.createElement('div')
      staging.append(selection.getRangeAt(0).cloneContents())
      const markdown = host.htmlToMarkdown(staging.innerHTML).trim()
      if (!markdown || !event.clipboardData) return
      event.preventDefault()
      event.clipboardData.setData('text/plain', markdown)
    }
    container.addEventListener('copy', handleCopy)
    return () => container.removeEventListener('copy', handleCopy)
  }, [host])
  return (
    <div
      ref={containerRef}
      className="markdown-rendered yolo-learning-outline-rendered-markdown"
    />
  )
}

function setupLinks(
  host: OutlineViewHost,
  container: HTMLElement,
  sourcePath: string,
) {
  container.querySelectorAll('a.internal-link').forEach((element) => {
    element.addEventListener('click', (event) => {
      event.preventDefault()
      const linktext = element.getAttribute('href')
      if (linktext)
        void host.openLinkText(
          linktext,
          sourcePath,
          host.isModEvent(event as MouseEvent),
        )
    })
    element.addEventListener('mouseover', (event) => {
      const linktext = element.getAttribute('href')
      if (linktext)
        host.triggerHoverLink({
          event: event as MouseEvent,
          targetEl: event.currentTarget,
          linktext,
          sourcePath,
        })
    })
  })
}

function GhostBtn({ children }: { children: ReactNode }) {
  return (
    <button type="button" className="yolo-learning-outline-ghost-btn">
      {children}
    </button>
  )
}
