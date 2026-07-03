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
import { type ReactNode, useState } from 'react'

import { useLanguage } from '../../contexts/language-context'
import { formatLearningText } from './i18n'
import { type KnowledgePoint, chapters } from './mockLearningData'
import { MasteryDot, Pill } from './primitives'

export function OutlineView({
  selectedPointId,
  onSelectPoint,
}: {
  selectedPointId: string | null
  onSelectPoint: (id: string) => void
}) {
  const { t } = useLanguage()
  const point = findPoint(selectedPointId) ?? chapters[1].points[1]
  const chapter = chapters.find((c) => c.points.some((p) => p.id === point.id))!

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
          {chapters.map((c) => (
            <ChapterNode
              key={c.id}
              chapter={c}
              selectedPointId={point.id}
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
        <Detail
          point={point}
          chapterTitle={chapter.title}
          chapterIndex={chapter.index}
          t={t}
        />
      </section>
    </div>
  )
}

function ChapterNode({
  chapter,
  selectedPointId,
  onSelectPoint,
}: {
  chapter: (typeof chapters)[number]
  selectedPointId: string
  onSelectPoint: (id: string) => void
}) {
  const [open, setOpen] = useState(true)
  const mastered = chapter.points.filter((p) => p.mastery === 'mastered').length

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
          {chapter.index}
        </span>
        <span className="yolo-learning-outline-chapter-title">
          {chapter.title}
        </span>
        <span className="yolo-learning-outline-chapter-count">
          {mastered}/{chapter.points.length}
        </span>
      </button>

      {open && (
        <div className="yolo-learning-outline-points">
          {chapter.points.map((p) => {
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
                <MasteryDot mastery={p.mastery} />
                <span className="yolo-learning-outline-point-title">
                  {p.title}
                </span>
                <span className="yolo-learning-outline-point-progress">
                  {p.masteryPct}%
                </span>
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
  chapterTitle,
  chapterIndex,
  t,
}: {
  point: KnowledgePoint
  chapterTitle: string
  chapterIndex: number
  t: (keyPath: string, fallback?: string) => string
}) {
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
        <span>{chapterTitle}</span>
        <ChevronRight size={12} />
        <span className="yolo-learning-outline-breadcrumb-current">
          {formatLearningText(
            t('learning.outline.pointLabel', '知识点 {index} {title}'),
            { index: point.index, title: point.title },
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
              value: point.masteryPct,
            },
          )}
        </Pill>
        <Pill>
          {formatLearningText(
            t('learning.outline.cardCount', '卡片 {count} 张'),
            {
              count: point.cardCount,
            },
          )}
        </Pill>
        <Pill>
          {formatLearningText(
            t('learning.outline.exerciseCount', '习题 {count} 道'),
            {
              count: point.exerciseCount,
            },
          )}
        </Pill>
      </div>

      <article className="yolo-learning-outline-markdown">
        <p>
          <strong>可变引用（mutable reference）</strong>
          允许你在不获取所有权的情况下修改借用的数据，写作{' '}
          <code>&amp;mut T</code>。它是 Rust
          借用系统中最容易触发编译错误、却也最能体现安全设计的部分。
        </p>
        <p>
          与不可变引用 <code>&amp;T</code> 不同，可变引用对同一份数据具有
          <strong>独占性</strong>
          ：在一个可变引用存活的作用域内，既不能再创建另一个可变引用，也不能创建任何不可变引用。借用检查器在编译期强制这一规则，从根源上杜绝数据竞争。
        </p>
        <p>下面的代码可以正常编译并运行，因为同一时间只存在一个可变引用：</p>
        <pre>
          <code>{`fn main() {
    let mut s = String::from("hello");
    let r = &mut s;        // 唯一的可变引用
    r.push_str(", world");
    println!("{}", r);     // hello, world
}`}</code>
        </pre>
        <p>
          一旦尝试同时持有两个可变引用，编译器会立即报错{' '}
          <code>cannot borrow `s` as mutable more than once at a time</code>
          。这种限制看似严格，却把许多在 C/C++
          中只能靠运行时调试发现的别名问题，提前暴露在了编译阶段。
        </p>
        <p>
          值得注意的是 <strong>NLL（Non-Lexical Lifetimes）</strong>
          ：引用的生命周期在它<em>最后一次被使用</em>
          后即结束，而非延续到作用域末尾。因此先用完一个可变引用，再创建下一个，是完全合法的。
        </p>
        <p>
          理解可变引用的独占性，是后续掌握<strong>借用检查器规则</strong>与
          <strong>生命周期注解</strong>
          的前提。建议结合本知识点的卡片与习题反复练习，直到能凭直觉判断一段代码是否会通过借用检查。
        </p>
      </article>
    </div>
  )
}

function findPoint(id: string | null): KnowledgePoint | undefined {
  if (!id) return undefined

  for (const c of chapters) {
    const p = c.points.find((point) => point.id === id)
    if (p) return p
  }

  return undefined
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
