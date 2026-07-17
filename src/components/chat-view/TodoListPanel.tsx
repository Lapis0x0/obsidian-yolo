import cx from 'clsx'
import { Check, ChevronDown, Circle, ListTodo, Loader2, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { useLanguage } from '../../contexts/language-context'
import {
  type TodoItem,
  type TodoStatus,
  deriveTodosFromMessages,
  findLatestCompletedTodoWriteId,
  findTodoSeriesStartId,
} from '../../core/agent/todos-from-messages'
import type { ChatMessage } from '../../types/chat'

type Props = {
  messages: ReadonlyArray<ChatMessage>
  /**
   * Count of user messages currently queued for mid-run injection. When this
   * increases, the todo panel auto-collapses so the queued message bubble
   * (rendered above this panel) stays the most prominent signal. User can
   * still manually re-expand; subsequent enqueues will collapse again.
   */
  queuedMessageCount?: number
}

const MISSING_TODO_SERIES_DISMISS_KEY = '__missing_todo_series__'

export function TodoListPanel({ messages, queuedMessageCount = 0 }: Props) {
  const todos = useMemo(() => deriveTodosFromMessages(messages), [messages])
  const seriesStartId = useMemo(
    () => findTodoSeriesStartId(messages),
    [messages],
  )
  const completedWriteId = useMemo(
    () => findLatestCompletedTodoWriteId(messages),
    [messages],
  )
  const { t } = useLanguage()
  // Default to collapsed: when a conversation is freshly opened (Obsidian
  // reload, switching from the history list, opening a chat that already has
  // todos persisted), the full body is just noise above the input. The
  // collapsed header already carries the most useful signal ("Step 2/5:…",
  // "All N done"); explicit expand stays one click away. Chat.tsx remounts
  // this component per conversation via `key={conversationId}`, so this
  // initial value also resets on conversation switch.
  const [expanded, setExpanded] = useState(false)
  const [dismissedSeriesStartId, setDismissedSeriesStartId] = useState<
    string | null
  >(null)

  // Auto-expand only when a brand-new todo series starts WHILE the panel is
  // mounted — i.e. the user is watching the agent plan in real time.
  // Ref-based transition tracking is what distinguishes "series existed on
  // mount" (do nothing) from "series just appeared / changed" (expand).
  const previousSeriesStartIdRef = useRef<string | null>(seriesStartId)
  useEffect(() => {
    if (
      seriesStartId !== null &&
      seriesStartId !== previousSeriesStartIdRef.current
    ) {
      setExpanded(true)
    }
    previousSeriesStartIdRef.current = seriesStartId
  }, [seriesStartId])

  // Auto-collapse the moment a write lands that marks every item completed —
  // the body becomes informational rather than actionable. Fires only when
  // completedWriteId changes (i.e. a new "everything done" write), so user
  // re-expanding an all-completed list later won't be overridden.
  useEffect(() => {
    if (completedWriteId !== null) setExpanded(false)
  }, [completedWriteId])

  // Auto-collapse on each new queued user message so the queued bubble above
  // this panel stays the user's primary focus. Tracks transitions in count,
  // not absolute value, so the user's manual re-expand survives until the
  // next enqueue arrives.
  const previousQueuedCountRef = useRef(queuedMessageCount)
  useEffect(() => {
    if (queuedMessageCount > previousQueuedCountRef.current) {
      setExpanded(false)
    }
    previousQueuedCountRef.current = queuedMessageCount
  }, [queuedMessageCount])

  const dismissKey = seriesStartId ?? MISSING_TODO_SERIES_DISMISS_KEY
  if (todos.length === 0 || dismissedSeriesStartId === dismissKey) {
    return null
  }

  const total = todos.length
  const done = todos.filter((item) => item.status === 'completed').length
  const inProgressIndex = todos.findIndex(
    (item) => item.status === 'in_progress',
  )
  const summary = formatSummary({ todos, total, done, inProgressIndex, t })

  const collapseLabel = expanded
    ? t('chat.todoPanel.collapse', '收起')
    : t('chat.todoPanel.expand', '展开')
  const closeLabel = t('common.close', '关闭')

  return (
    <div
      className={cx(
        'yolo-todo-panel',
        expanded ? 'yolo-todo-panel--expanded' : 'yolo-todo-panel--collapsed',
      )}
    >
      <div className="yolo-todo-panel__header">
        <button
          type="button"
          className="yolo-todo-panel__toggle"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
        >
          <ListTodo
            className="yolo-todo-panel__header-icon"
            size={14}
            aria-hidden
          />
          <span className="yolo-todo-panel__summary">{summary}</span>
        </button>
        <button
          type="button"
          className="yolo-todo-panel__icon-button yolo-todo-panel__caret-button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
        >
          <ChevronDown
            className="yolo-todo-panel__caret"
            size={14}
            aria-hidden
          />
          <span className="yolo-sr-only">{collapseLabel}</span>
        </button>
        <button
          type="button"
          className="yolo-todo-panel__icon-button yolo-todo-panel__close"
          onClick={() => setDismissedSeriesStartId(dismissKey)}
        >
          <X size={14} strokeWidth={2} aria-hidden />
          <span className="yolo-sr-only">{closeLabel}</span>
        </button>
      </div>
      <div className="yolo-todo-panel__body">
        <div className="yolo-todo-panel__body-inner">
          <ol className="yolo-todo-panel__list">
            {todos.map((item, index) => (
              <TodoRow key={index} item={item} index={index} />
            ))}
          </ol>
        </div>
      </div>
    </div>
  )
}

/**
 * Compose the collapsed-state header summary. Branches on todo state so the
 * one-line text always carries the most relevant signal:
 *   - Just planned (all pending)         → "{n} tasks pending"
 *   - Has an in_progress item            → "Step {i}/{total}: {content}"
 *   - Mid-flight without in_progress     → "{done}/{total} done"
 *   - Everything completed               → "All {total} done"
 */
function formatSummary({
  todos,
  total,
  done,
  inProgressIndex,
  t,
}: {
  todos: ReadonlyArray<TodoItem>
  total: number
  done: number
  inProgressIndex: number
  t: (key: string, fallback: string) => string
}): string {
  if (inProgressIndex >= 0) {
    return interpolate(
      t('chat.todoPanel.summaryInProgress', 'Step {index}/{total}: {text}'),
      {
        index: String(inProgressIndex + 1),
        total: String(total),
        text: todos[inProgressIndex].content,
      },
    )
  }
  if (done === total) {
    return interpolate(t('chat.todoPanel.summaryAllDone', 'All {total} done'), {
      total: String(total),
    })
  }
  if (done === 0) {
    return interpolate(
      t('chat.todoPanel.summaryPlanning', '{count} tasks pending'),
      { count: String(total) },
    )
  }
  return interpolate(
    t('chat.todoPanel.summaryPartial', '{done}/{total} done'),
    { done: String(done), total: String(total) },
  )
}

/**
 * Replace all `{key}` placeholders in a template. Note: a single
 * `String.prototype.replace` only swaps the first occurrence, which broke the
 * `{total}/{total}` style summaries — always use the global form here.
 */
function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : match,
  )
}

function TodoRow({ item, index }: { item: TodoItem; index: number }) {
  const text = item.content
  return (
    <li
      className={cx(
        'yolo-todo-panel__item',
        `yolo-todo-panel__item--${item.status}`,
      )}
    >
      <span className="yolo-todo-panel__icon" aria-hidden>
        <StatusIcon status={item.status} />
      </span>
      <span className="yolo-todo-panel__index">{index + 1}.</span>
      <span className="yolo-todo-panel__text">{text}</span>
    </li>
  )
}

function StatusIcon({ status }: { status: TodoStatus }) {
  if (status === 'completed') {
    return <Check size={14} strokeWidth={2.5} />
  }
  if (status === 'in_progress') {
    return <Loader2 size={14} className="yolo-todo-panel__icon-spin" />
  }
  return <Circle size={14} />
}
