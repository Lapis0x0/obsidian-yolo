import cx from 'clsx'
import {
  ArrowLeft,
  Clock,
  GripVertical,
  Layers,
  ListTree,
  Pencil,
  Plus,
  Sparkles,
  Target,
  Trash2,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type React from 'react'

import { useLanguage } from '../../contexts/language-context'
import { formatLearningText } from './i18n'

const initialChapters = [
  {
    title: '所有权基础',
    contract:
      '目标：理解 Rust 内存模型的核心——所有权系统，以及值如何在变量间转移。\n范围：重点覆盖所有权三原则、移动语义（Move）、Copy 与 Clone 的区别。暂不涉及借用与生命周期。\n规模：预计生成 3-4 个知识点，包含概念解释与简单代码示例。',
  },
  {
    title: '引用与借用',
    contract:
      '目标：在不转移所有权的前提下访问数据，并理解借用检查器如何保证内存安全。\n范围：详细讲解不可变引用（&T）与可变引用（&mut T）的互斥规则、借用检查器（Borrow Checker）的工作原理，以及悬垂引用的防范。\n规模：预计生成 4-5 个知识点，需包含导致编译错误的典型反面案例。',
  },
]

type Chapter = { title: string; contract: string }

/** 从契约的「规模」条款里解析预计知识点数量区间 */
function parseScale(contract: string): { min: number; max: number } {
  const line = contract.split('\n').find((l) => l.includes('规模')) ?? ''
  const m = line.match(/(\d+)(?:\s*[-–~至]\s*(\d+))?\s*个知识点/)
  if (!m) return { min: 0, max: 0 }
  const min = Number(m[1])
  const max = m[2] ? Number(m[2]) : min
  return { min, max }
}

export function OutlineBuilder({
  onCancel,
  onComplete,
}: {
  onCancel: () => void
  onComplete: () => void
}) {
  const { t } = useLanguage()
  const [chapters, setChapters] = useState<Chapter[]>(initialChapters)
  const [generating, setGenerating] = useState(true)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Simulate AI generation process.
  useEffect(() => {
    const timer = setTimeout(() => {
      setGenerating(false)
      setChapters([
        ...initialChapters,
        {
          title: '生命周期注解',
          contract:
            "目标：掌握生命周期注解的语法，向编译器描述引用的有效范围。\n范围：讲解函数签名中的生命周期参数（'a）、结构体中的生命周期，以及静态生命周期（'static）。不涉及高级生命周期约束（如 HRTB）。\n规模：预计生成 3 个知识点，重点解释生命周期省略规则（Elision Rules）。",
        },
        {
          title: '智能指针初探',
          contract:
            '目标：了解 Rust 中超越普通引用的数据结构，掌握堆内存分配与多所有权。\n范围：介绍 Box<T> 用于堆分配，Rc<T> 用于单线程多所有权。简要提及 RefCell<T> 的内部可变性。\n规模：预计生成 3-4 个知识点，需对比智能指针与普通引用的差异。',
        },
      ])
    }, 2000)
    return () => clearTimeout(timer)
  }, [])

  const scale = useMemo(() => {
    return chapters.reduce(
      (acc, c) => {
        const s = parseScale(c.contract)
        return { min: acc.min + s.min, max: acc.max + s.max }
      },
      { min: 0, max: 0 },
    )
  }, [chapters])

  const scrollToChapter = (index: number) => {
    const el = scrollRef.current?.querySelector<HTMLElement>(
      `#chapter-${index}`,
    )
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

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
            Rust 所有权与生命周期
          </h1>
          <span className="yolo-learning-outline-builder-badge">
            {t('learning.outlineBuilder.draftBadge', '大纲草稿')}
          </span>
        </div>
        <span className="yolo-learning-outline-builder-status">
          {generating
            ? t('learning.outlineBuilder.subagentPending', 'Sub-Agent 待命中')
            : t(
                'learning.outlineBuilder.subagentReady',
                '确认后将交由 Sub-Agent 生成',
              )}
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
            {chapters.map((c, i) => (
              <ChapterCard
                key={c.title}
                index={i + 1}
                title={c.title}
                contract={c.contract}
                t={t}
              />
            ))}

            {generating && <SkeletonCard t={t} />}

            {!generating && (
              <button
                type="button"
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
                value={generating ? '—' : String(chapters.length)}
              />
              <Stat
                icon={<Target size={14} />}
                label={t(
                  'learning.outlineBuilder.estimatedPoints',
                  '预计知识点',
                )}
                value={
                  generating
                    ? '—'
                    : scale.min === scale.max
                      ? String(scale.max)
                      : `${scale.min}–${scale.max}`
                }
              />
              <Stat
                icon={<Layers size={14} />}
                label={t('learning.outlineBuilder.estimatedCards', '预计卡片')}
                value={generating ? '—' : `${scale.min * 3}–${scale.max * 3}`}
                hint={t(
                  'learning.outlineBuilder.cardsHint',
                  '按每个知识点 ≈3 张估算',
                )}
              />
              <Stat
                icon={<Clock size={14} />}
                label={t(
                  'learning.outlineBuilder.estimatedGeneration',
                  '预估生成',
                )}
                value={
                  generating
                    ? '—'
                    : formatLearningText(
                        t('learning.outlineBuilder.minutes', '~{count} 分钟'),
                        { count: Math.max(1, Math.round(scale.max * 0.6)) },
                      )
                }
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
                  {chapters.map((c, i) => (
                    <li key={c.title}>
                      <button
                        type="button"
                        onClick={() => scrollToChapter(i + 1)}
                        className="yolo-learning-outline-builder-map-item"
                      >
                        <span className="yolo-learning-outline-builder-map-index">
                          {i + 1}
                        </span>
                        <span className="yolo-learning-outline-builder-map-label">
                          {c.title}
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
              onClick={onComplete}
              disabled={generating}
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

function Stat({
  icon,
  label,
  value,
  hint,
}: {
  icon: React.ReactNode
  label: string
  value: string
  hint?: string
}) {
  return (
    <div className="yolo-learning-outline-builder-stat">
      <div className="yolo-learning-outline-builder-stat-label">
        {icon}
        {label}
      </div>
      <div className="yolo-learning-outline-builder-stat-value">{value}</div>
      {hint && (
        <div className="yolo-learning-outline-builder-stat-hint">{hint}</div>
      )}
    </div>
  )
}

function ContractLine({ line }: { line: string }) {
  const sep = line.indexOf('：')
  if (sep === -1) return <p>{line}</p>
  return (
    <p>
      <span className="yolo-learning-outline-builder-contract-key">
        {line.slice(0, sep + 1)}
      </span>
      {line.slice(sep + 1)}
    </p>
  )
}

function ChapterCard({
  index,
  title,
  contract,
  t,
}: {
  index: number
  title: string
  contract: string
  t: (keyPath: string, fallback?: string) => string
}) {
  return (
    <div id={`chapter-${index}`} className="yolo-learning-outline-builder-card">
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
            {index}
          </span>
        </div>

        <div className="yolo-learning-outline-builder-card-content">
          <div className="yolo-learning-outline-builder-card-top">
            <h3 className="yolo-learning-outline-builder-card-title">
              {title}
            </h3>
            <div className="yolo-learning-outline-builder-actions">
              <IconBtn aria-label={t('common.edit', '编辑')}>
                <Pencil size={14} />
              </IconBtn>
              <IconBtn aria-label={t('common.delete', '删除')}>
                <Trash2 size={14} />
              </IconBtn>
            </div>
          </div>
          <div className="yolo-learning-outline-builder-contract">
            {contract.split('\n').map((line) => (
              <ContractLine key={line} line={line} />
            ))}
          </div>
        </div>
      </div>
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
