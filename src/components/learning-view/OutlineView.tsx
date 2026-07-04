import cx from 'clsx'
import { ChevronDown, ChevronRight, Pencil, Plus, Search } from 'lucide-react'
import { App, Keymap, MarkdownRenderer, TFile, htmlToMarkdown } from 'obsidian'
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

import { useApp } from '../../contexts/app-context'
import { useLanguage } from '../../contexts/language-context'
import { usePlugin } from '../../contexts/plugin-context'
import { scanMarkdownEntries } from '../../core/learning/markdownScanner'
import type {
  Chapter as VaultChapter,
  KnowledgePoint as VaultKnowledgePoint,
  Project as VaultProject,
} from '../../core/learning/types'
import { openMarkdownFile } from '../../utils/obsidian'

import { formatLearningText } from './i18n'
import { MasteryDot, Pill } from './primitives'

const OUTLINE_SIDEBAR_WIDTH_STORAGE_KEY = 'yolo-learning-outline-sidebar-width'
const OUTLINE_SIDEBAR_DEFAULT_WIDTH = 280
const OUTLINE_SIDEBAR_MIN_WIDTH = 220
const OUTLINE_SIDEBAR_MAX_WIDTH = 420

function clampOutlineSidebarWidth(width: number): number {
  return Math.min(
    OUTLINE_SIDEBAR_MAX_WIDTH,
    Math.max(OUTLINE_SIDEBAR_MIN_WIDTH, Math.round(width)),
  )
}

function readOutlineSidebarWidth(): number {
  try {
    const stored = window.localStorage.getItem(
      OUTLINE_SIDEBAR_WIDTH_STORAGE_KEY,
    )
    if (!stored) return OUTLINE_SIDEBAR_DEFAULT_WIDTH
    const width = Number.parseInt(stored, 10)
    return Number.isFinite(width)
      ? clampOutlineSidebarWidth(width)
      : OUTLINE_SIDEBAR_DEFAULT_WIDTH
  } catch {
    return OUTLINE_SIDEBAR_DEFAULT_WIDTH
  }
}

function persistOutlineSidebarWidth(width: number): void {
  try {
    window.localStorage.setItem(
      OUTLINE_SIDEBAR_WIDTH_STORAGE_KEY,
      String(clampOutlineSidebarWidth(width)),
    )
  } catch {
    // Layout preference persistence is best-effort only.
  }
}

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
  const sidebarResizeStartRef = useRef<{
    x: number
    width: number
    currentWidth: number
  } | null>(null)
  const [sidebarWidth, setSidebarWidth] = useState(readOutlineSidebarWidth)
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

  const outlineStyle = {
    '--yolo-learning-outline-sidebar-width': `${sidebarWidth}px`,
  } as CSSProperties & {
    '--yolo-learning-outline-sidebar-width': string
  }

  const handleSidebarResizeStart = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()

    const ownerDoc = event.currentTarget.ownerDocument ?? document
    const ownerWin = ownerDoc.defaultView ?? window
    sidebarResizeStartRef.current = {
      x: event.clientX,
      width: sidebarWidth,
      currentWidth: sidebarWidth,
    }

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const resizeStart = sidebarResizeStartRef.current
      if (!resizeStart) return

      const nextWidth = clampOutlineSidebarWidth(
        resizeStart.width + moveEvent.clientX - resizeStart.x,
      )
      resizeStart.currentWidth = nextWidth
      setSidebarWidth(nextWidth)
    }

    const handleMouseUp = () => {
      const finalWidth = sidebarResizeStartRef.current?.currentWidth
      sidebarResizeStartRef.current = null
      ownerWin.removeEventListener('mousemove', handleMouseMove)
      ownerWin.removeEventListener('mouseup', handleMouseUp)
      ownerDoc.body.classList.remove('yolo-learning-outline-global-resize')
      ownerDoc.body.setCssProps({
        '--yolo-learning-outline-global-cursor': '',
        '--yolo-learning-outline-global-user-select': '',
      })
      if (finalWidth != null) persistOutlineSidebarWidth(finalWidth)
    }

    ownerWin.addEventListener('mousemove', handleMouseMove)
    ownerWin.addEventListener('mouseup', handleMouseUp)
    ownerDoc.body.classList.add('yolo-learning-outline-global-resize')
    ownerDoc.body.setCssProps({
      '--yolo-learning-outline-global-cursor': 'col-resize',
      '--yolo-learning-outline-global-user-select': 'none',
    })
  }

  const handleSidebarResizeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const delta =
      event.key === 'ArrowLeft' ? -16 : event.key === 'ArrowRight' ? 16 : 0
    if (delta === 0) return

    event.preventDefault()
    setSidebarWidth((currentWidth) => {
      const nextWidth = clampOutlineSidebarWidth(currentWidth + delta)
      persistOutlineSidebarWidth(nextWidth)
      return nextWidth
    })
  }

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
    <div className="yolo-learning-outline" style={outlineStyle}>
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

        <div
          aria-orientation="vertical"
          aria-valuemax={OUTLINE_SIDEBAR_MAX_WIDTH}
          aria-valuemin={OUTLINE_SIDEBAR_MIN_WIDTH}
          aria-valuenow={sidebarWidth}
          className="yolo-learning-outline-resize-handle"
          onKeyDown={handleSidebarResizeKeyDown}
          onMouseDown={handleSidebarResizeStart}
          role="separator"
          tabIndex={0}
        />
      </aside>

      <section className="yolo-learning-outline-detail-panel">
        {point && chapter ? (
          <Detail
            point={point}
            chapter={chapter}
            chapterIndex={
              project.chapters.findIndex((c) => c.id === chapter.id) + 1
            }
            pointIndex={
              (pointsByChapter
                .get(chapter.id)
                ?.findIndex((item) => item.id === point.id) ?? 0) + 1
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
  pointIndex,
  t,
}: {
  point: VaultKnowledgePoint
  chapter: VaultChapter
  chapterIndex: number
  pointIndex: number
  t: (keyPath: string, fallback?: string) => string
}) {
  const app = useApp()
  const [body, setBody] = useState('')
  const [startLine, setStartLine] = useState<number | undefined>()
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      setLoading(true)
      const file = app.vault.getAbstractFileByPath(point.knowledgeFilePath)
      if (!(file instanceof TFile)) {
        if (!cancelled) {
          setBody('')
          setStartLine(undefined)
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
        setStartLine(entry?.startLine)
        setLoading(false)
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [app, point])

  const handleEdit = () => {
    openMarkdownFile(app, point.knowledgeFilePath, startLine)
  }

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
          {chapterIndex}.{pointIndex} {point.title}
        </span>
      </div>

      <div className="yolo-learning-outline-title-row">
        <h1 className="yolo-learning-outline-title">{point.title}</h1>
        <div className="yolo-learning-outline-actions">
          <OutlineBtn onClick={handleEdit}>
            <Pencil size={14} /> {t('common.edit', '编辑')}
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
          <LearningMarkdown
            content={body}
            sourcePath={point.knowledgeFilePath}
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
}: {
  content: string
  sourcePath: string
}) {
  const app = useApp()
  const plugin = usePlugin()
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false

    const renderMarkdown = async () => {
      const containerEl = containerRef.current
      if (!containerEl) return

      const staging = document.createElement('div')
      await MarkdownRenderer.render(app, content, staging, sourcePath, plugin)
      if (cancelled || !containerRef.current) return

      containerRef.current.replaceChildren(...Array.from(staging.childNodes))
      setupLearningMarkdownLinks(app, containerRef.current, sourcePath)
    }

    void renderMarkdown()
    return () => {
      cancelled = true
    }
  }, [app, content, plugin, sourcePath])

  useEffect(() => {
    const containerEl = containerRef.current
    if (!containerEl) return

    const handleCopy = (event: ClipboardEvent) => {
      const selection = (
        containerEl.ownerDocument.defaultView ?? window
      ).getSelection()
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        return
      }

      const anchorNode = selection.anchorNode
      const focusNode = selection.focusNode
      if (
        !anchorNode ||
        !focusNode ||
        !containerEl.contains(anchorNode) ||
        !containerEl.contains(focusNode)
      ) {
        return
      }

      const range = selection.getRangeAt(0)
      const fragment = range.cloneContents()
      const staging = document.createElement('div')
      staging.append(fragment)

      const selectedMarkdown = htmlToMarkdown(staging.innerHTML).trim()
      if (!selectedMarkdown || !event.clipboardData) return

      event.preventDefault()
      event.clipboardData.setData('text/plain', selectedMarkdown)
    }

    containerEl.addEventListener('copy', handleCopy)
    return () => {
      containerEl.removeEventListener('copy', handleCopy)
    }
  }, [])

  return (
    <div
      ref={containerRef}
      className="markdown-rendered yolo-learning-outline-rendered-markdown"
    />
  )
}

function setupLearningMarkdownLinks(
  app: App,
  containerEl: HTMLElement,
  sourcePath: string,
) {
  containerEl.querySelectorAll('a.internal-link').forEach((el) => {
    el.addEventListener('click', (event: MouseEvent) => {
      event.preventDefault()
      const linktext = el.getAttribute('href')
      if (linktext) {
        void app.workspace.openLinkText(
          linktext,
          sourcePath,
          Keymap.isModEvent(event),
        )
      }
    })

    el.addEventListener('mouseover', (event: MouseEvent) => {
      event.preventDefault()
      const linktext = el.getAttribute('href')
      if (linktext) {
        app.workspace.trigger('hover-link', {
          event,
          source: 'preview',
          hoverParent: { hoverPopover: null },
          targetEl: event.currentTarget,
          linktext,
          sourcePath,
        })
      }
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

function OutlineBtn({
  children,
  onClick,
}: {
  children: ReactNode
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      className="yolo-learning-outline-btn"
      onClick={onClick}
    >
      {children}
    </button>
  )
}
