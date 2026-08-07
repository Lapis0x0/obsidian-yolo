import * as Popover from '@radix-ui/react-popover'
import {
  AnimatePresence,
  motion,
  useIsPresent,
  useReducedMotion,
} from 'framer-motion'
import {
  Check,
  Download,
  Ellipsis,
  Pencil,
  RotateCcw,
  Search,
  Star,
  Trash2,
} from 'lucide-react'
import { Platform } from 'obsidian'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'

import { useLanguage } from '../../contexts/language-context'
import type { AgentConversationRunSummary } from '../../core/agent/service'
import {
  type ChatConversationMetadata,
  getChatConversationOrigin,
} from '../../database/json/chat/types'
import { getConversationDisplayTitle } from '../../hooks/useChatHistory'
import { useChatManager } from '../../hooks/useJsonManagers'
import {
  MOTION_DURATION_EXIT_S,
  MOTION_EASE_OUT,
  MOTION_LAYOUT_SPRING,
} from '../../styles/tokens/motion'
import type { SerializedChatMessage } from '../../types/chat'
import type { ContentPart } from '../../types/llm/request'
import { getNodeWindow } from '../../utils/dom/window-context'
import { YoloPopoverContent } from '../common/popover'

import {
  type ChatHistorySection,
  type ChatListOrderSnapshot,
  type TaskConversationOrigin,
  type TaskOriginFilter,
  captureChatListOrder,
  partitionChatHistory,
  sortChatListForDisplay,
} from './chat-history-list'
import { editorStateToPlainText } from './chat-input/utils/editor-state-to-plain-text'

let rememberedHistorySection: ChatHistorySection = 'user'
let rememberedTaskOriginFilter: TaskOriginFilter = 'all'

/**
 * 会话历史面板的动效令牌，与 popover.css 中 .yolo-chat-list-dropdown-content 上的
 * --yolo-chat-list-presence-* 一一对应，两处需保持一致。三层语汇与「只动 opacity
 * 和 transform」的硬规则见 tokens/motion.css 头注释。
 */
const CHAT_LIST_MOTION = {
  /** L2 退场：快速让位，注意力不该停在正在消失的东西上 */
  exit: { duration: MOTION_DURATION_EXIT_S, ease: MOTION_EASE_OUT },
  /**
   * L3 跟随：位移用 spring 而不是 tween。贝塞尔插值的是「某个值」，spring 插值的
   * 是加速度，眼睛读到的才是有质量的东西被推动。阻尼取到接近临界，几乎不回弹——
   * 列表条目回弹显得轻浮，相邻条目回弹不同步更会乱。
   */
  layout: MOTION_LAYOUT_SPRING,
} as const

// 待确认态不应无限挂着，否则下一次不经意的点击就直接删除
const DELETE_CONFIRM_TIMEOUT_MS = 3000

/**
 * 删除的两击确认。第一击只切换到待确认态，第二击才真的删；超时自动回到安全状态。
 * 刻意不给两击之间设最小间隔——点得快是正常操作，拦它只会让确认显得没反应。
 */
function useDeleteConfirmation(onConfirm: () => void) {
  const [isConfirming, setIsConfirming] = useState(false)
  const timerRef = useRef<number | null>(null)

  const reset = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    setIsConfirming(false)
  }, [])

  useEffect(() => reset, [reset])

  const request = useCallback(() => {
    if (!isConfirming) {
      setIsConfirming(true)
      timerRef.current = window.setTimeout(reset, DELETE_CONFIRM_TIMEOUT_MS)
      return
    }
    reset()
    onConfirm()
  }, [isConfirming, onConfirm, reset])

  return { isConfirming, request, reset }
}

function TitleInput({
  value,
  disabled,
  onChange,
  onSubmit,
}: {
  value: string
  disabled?: boolean
  onChange: (value: string) => void
  onSubmit: (title: string) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.select()
      inputRef.current.scrollLeft = 0
    }
  }, [])

  return (
    <input
      ref={inputRef}
      type="text"
      value={value}
      disabled={disabled}
      className="yolo-chat-list-dropdown-item-title-input"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter' && !disabled) {
          onSubmit(value)
        }
      }}
      maxLength={100}
    />
  )
}

function ChatRuntimeBadge({
  runtimeId,
}: {
  runtimeId: 'claude-code' | 'codex'
}) {
  const { t } = useLanguage()
  const fullLabel =
    runtimeId === 'claude-code'
      ? t('sidebar.runtimeSelector.claudeCodeLabel', 'Claude Code')
      : t('sidebar.runtimeSelector.codexLabel', 'Codex')

  return (
    <span
      className={`yolo-runtime-badge yolo-runtime-badge--${runtimeId}`}
      data-runtime-id={runtimeId}
      aria-label={fullLabel}
      title={fullLabel}
    >
      {runtimeId === 'claude-code'
        ? t('sidebar.runtimeSelector.claudeCodeShortLabel', 'CC')
        : fullLabel}
    </span>
  )
}

function ChatListItem({
  title,
  displayTitle,
  cliRuntimeId,
  runSummary,
  isCurrent,
  isFocused,
  shouldScrollIntoView,
  isEditing,
  isUpdatingTitle,
  isPinned,
  canPin,
  canRetryTitle,
  canExport,
  isRetrying,
  onMouseEnter,
  onMouseLeave,
  isMoreMenuOpen,
  onSelect,
  onDelete,
  onTogglePinned,
  onRetryTitle,
  onExport,
  onStartEdit,
  onFinishEdit,
  onToggleMoreMenu,
  onCloseMoreMenu,
  onLongPress,
  onContextMenu,
  isContextMenuOpen,
  isMobile,
  conversationId,
  shiftY,
}: {
  title: string
  displayTitle?: string
  cliRuntimeId?: 'claude-code' | 'codex'
  runSummary?: AgentConversationRunSummary
  isCurrent: boolean
  isFocused: boolean
  shouldScrollIntoView: boolean
  isEditing: boolean
  isUpdatingTitle: boolean
  isPinned: boolean
  canPin: boolean
  canRetryTitle: boolean
  canExport: boolean
  isRetrying: boolean
  onMouseEnter: () => void
  onMouseLeave: () => void
  isMoreMenuOpen: boolean
  onSelect: () => void
  onDelete: () => void
  onTogglePinned: () => void
  onRetryTitle: () => void
  onExport: () => void
  onStartEdit: () => void
  onFinishEdit: (title: string) => void
  onToggleMoreMenu: () => void
  onCloseMoreMenu: () => void
  onLongPress?: (cardEl: HTMLElement) => void
  onContextMenu?: (
    cardEl: HTMLElement,
    clientX: number,
    clientY: number,
  ) => void
  isContextMenuOpen?: boolean
  isMobile?: boolean
  conversationId: string
  /** FLIP 的 Invert 量：先把条目摁回删除前的位置，再由 CSS 过渡回 0 */
  shiftY: number
}) {
  const { t } = useLanguage()
  const moreActionsLabelId = useId()
  const itemRef = useRef<HTMLLIElement>(null)
  const pressTimerRef = useRef<number | null>(null)
  const pressStartRef = useRef<{ x: number; y: number; moved: boolean } | null>(
    null,
  )
  const [editingTitle, setEditingTitle] = useState(title)
  const reduceMotion = useReducedMotion()
  const isPresent = useIsPresent()
  const {
    isConfirming: isConfirmingDelete,
    request: requestDelete,
    reset: resetDeleteConfirmation,
  } = useDeleteConfirmation(() => {
    onCloseMoreMenu()
    onDelete()
  })
  const deleteActionLabel = isConfirmingDelete
    ? t('sidebar.chatList.confirmDelete', 'Click again to delete')
    : t('common.delete', 'Delete')

  const clearPress = useCallback(() => {
    if (pressTimerRef.current !== null) {
      window.clearTimeout(pressTimerRef.current)
      pressTimerRef.current = null
    }
    pressStartRef.current = null
  }, [])

  useEffect(() => {
    if (isFocused && shouldScrollIntoView && itemRef.current) {
      itemRef.current.scrollIntoView({
        block: 'nearest',
      })
    }
  }, [isFocused, shouldScrollIntoView])

  useEffect(() => {
    if (isEditing) {
      setEditingTitle(title)
    }
  }, [isEditing, title])

  // 收起更多操作（点击别处、指针移出条目、关闭面板）即撤销待确认的删除
  useEffect(() => {
    if (!isMoreMenuOpen) {
      resetDeleteConfirmation()
    }
  }, [isMoreMenuOpen, resetDeleteConfirmation])

  useEffect(() => clearPress, [clearPress])

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLLIElement>) => {
      if (!isMobile || !e.isPrimary || e.button !== 0 || isEditing) {
        return
      }
      if (e.target instanceof Element && e.target.closest('button, input')) {
        return
      }
      e.preventDefault()
      pressStartRef.current = { x: e.clientX, y: e.clientY, moved: false }
      pressTimerRef.current = window.setTimeout(() => {
        pressTimerRef.current = null
        pressStartRef.current = null
        if (itemRef.current) {
          onLongPress?.(itemRef.current)
        }
      }, 420)
    },
    [isEditing, isMobile, onLongPress],
  )

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLLIElement>) => {
      if (!isMobile || !pressStartRef.current) {
        return
      }
      const dx = Math.abs(e.clientX - pressStartRef.current.x)
      const dy = Math.abs(e.clientY - pressStartRef.current.y)
      if (dx > 8 || dy > 8) {
        pressStartRef.current.moved = true
        clearPress()
      }
    },
    [clearPress, isMobile],
  )

  const handlePointerUp = useCallback(() => {
    if (!isMobile) {
      return
    }
    if (pressTimerRef.current !== null) {
      clearPress()
      onSelect()
    }
  }, [clearPress, isMobile, onSelect])

  const handlePointerCancel = useCallback(() => {
    if (isMobile) {
      clearPress()
    }
  }, [clearPress, isMobile])

  return (
    <motion.li
      ref={itemRef}
      data-conversation-id={conversationId}
      // L2 显隐：退场切到 absolute，当帧就把空间让给后面的条目，「让位」和「补位」
      // 因此同一时刻发生，不会先淡完再跳。
      //
      // 补位刻意不用 framer-motion 的 layout：它的 projection 会逐个 measureScroll，
      // 几十条列表下这一项就吃掉 87ms（production 实测），比它替我们躲开的 height
      // reflow 贵得多。补位改由 L3 的 shiftY 手写 FLIP 完成，全列只测一次。
      exit={{ opacity: 0 }}
      style={
        isPresent
          ? shiftY
            ? { transform: `translateY(${shiftY}px)` }
            : undefined
          : { position: 'absolute', left: 0, right: 0 }
      }
      transition={reduceMotion ? { duration: 0 } : CHAT_LIST_MOTION.exit}
      tabIndex={-1}
      onMouseDown={(e) => {
        if (isMobile || e.button !== 0) {
          return
        }
        if (e.target instanceof Element && e.target.closest('button')) {
          return
        }
        onSelect()
      }}
      onContextMenu={
        isMobile
          ? undefined
          : (e) => {
              if (
                isEditing ||
                !itemRef.current ||
                (e.target instanceof Element &&
                  e.target.closest('button, input'))
              ) {
                return
              }
              e.preventDefault()
              e.stopPropagation()
              onContextMenu?.(itemRef.current, e.clientX, e.clientY)
            }
      }
      onPointerDown={isMobile ? handlePointerDown : undefined}
      onPointerMove={isMobile ? handlePointerMove : undefined}
      onPointerUp={isMobile ? handlePointerUp : undefined}
      onPointerCancel={isMobile ? handlePointerCancel : undefined}
      onMouseEnter={onMouseEnter}
      onPointerLeave={() => {
        if (isMobile) {
          clearPress()
        }
        onMouseLeave()
        if (isEditing || !itemRef.current) {
          return
        }
        const activeElement = itemRef.current.ownerDocument.activeElement
        if (
          activeElement instanceof HTMLElement &&
          itemRef.current.contains(activeElement)
        ) {
          activeElement.blur()
        }
      }}
      className={`yolo-chat-list-dropdown-item${isFocused ? ' selected' : ''}${
        isContextMenuOpen ? ' is-ctx-open' : ''
      }`}
      data-highlighted={isFocused ? 'true' : undefined}
    >
      {isEditing ? (
        <TitleInput
          value={editingTitle}
          disabled={isUpdatingTitle}
          onChange={setEditingTitle}
          onSubmit={onFinishEdit}
        />
      ) : (
        <div
          className={`yolo-chat-list-dropdown-item-title${
            isRetrying ? ' is-retrying' : ''
          }`}
        >
          <div className="yolo-chat-list-dropdown-item-title-group">
            <span className="yolo-chat-list-dropdown-item-title-text">
              {displayTitle ?? title}
            </span>
            {cliRuntimeId ? (
              <ChatRuntimeBadge runtimeId={cliRuntimeId} />
            ) : null}
            {isCurrent ? (
              <span className="yolo-chat-list-dropdown-item-current-badge">
                {t('sidebar.chatList.current', 'Current')}
              </span>
            ) : null}
          </div>
          {runSummary?.isActive ? (
            <span
              className={`yolo-chat-list-dropdown-item-status${
                runSummary.isWaitingApproval ? ' is-waiting' : ' is-running'
              }`}
              aria-label={
                runSummary.isWaitingApproval
                  ? 'Waiting approval'
                  : 'Conversation running'
              }
            />
          ) : null}
          {isRetrying && (
            <span
              className="yolo-chat-list-dropdown-item-title-skeleton"
              aria-hidden="true"
            />
          )}
        </div>
      )}
      <div
        className={`yolo-chat-list-dropdown-item-actions${
          isMoreMenuOpen ? ' is-more-open' : ''
        }`}
      >
        {isEditing ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              if (isUpdatingTitle) {
                return
              }
              onFinishEdit(editingTitle)
            }}
            className="clickable-icon yolo-chat-list-dropdown-item-icon"
            disabled={isUpdatingTitle}
            aria-label={t('common.save', 'Save')}
          >
            <Check />
          </button>
        ) : null}
        {!isMobile ? (
          <>
            {!isEditing ? (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  onCloseMoreMenu()
                  onStartEdit()
                }}
                className="clickable-icon yolo-chat-list-dropdown-item-icon"
                aria-label={t('common.edit', 'Edit')}
              >
                <Pencil size={16} />
              </button>
            ) : null}
            {canPin ? (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  onCloseMoreMenu()
                  onTogglePinned()
                }}
                className={`clickable-icon yolo-chat-list-pin-button${
                  isPinned ? ' is-pinned' : ''
                }`}
              >
                <Star />
              </button>
            ) : null}
            {!isEditing ? (
              <div
                className={`yolo-chat-list-inline-actions${
                  isMoreMenuOpen ? ' is-open' : ''
                }`}
                aria-hidden={isMoreMenuOpen ? undefined : 'true'}
              >
                <div className="yolo-chat-list-inline-actions-inner">
                  {canRetryTitle ? (
                    <button
                      type="button"
                      disabled={isRetrying}
                      onClick={(e) => {
                        e.stopPropagation()
                        onCloseMoreMenu()
                        onRetryTitle()
                      }}
                      className={`clickable-icon yolo-chat-list-dropdown-item-icon${
                        isRetrying ? ' is-pending' : ''
                      }`}
                      aria-label={t(
                        'sidebar.chatList.retryTitle',
                        'Retry title',
                      )}
                      aria-busy={isRetrying ? 'true' : undefined}
                      tabIndex={isMoreMenuOpen ? undefined : -1}
                    >
                      <RotateCcw
                        className={isRetrying ? 'yolo-spinner' : undefined}
                      />
                    </button>
                  ) : null}
                  {canExport ? (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        onCloseMoreMenu()
                        onExport()
                      }}
                      className="clickable-icon yolo-chat-list-dropdown-item-icon"
                      aria-label={t(
                        'sidebar.chatList.exportConversation',
                        'Export conversation to vault',
                      )}
                      tabIndex={isMoreMenuOpen ? undefined : -1}
                    >
                      <Download size={16} />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      requestDelete()
                    }}
                    className={`clickable-icon yolo-chat-list-dropdown-item-icon yolo-chat-list-delete-button${
                      isConfirmingDelete ? ' is-confirming' : ''
                    }`}
                    aria-label={deleteActionLabel}
                    title={deleteActionLabel}
                    tabIndex={isMoreMenuOpen ? undefined : -1}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>
            ) : null}
            {!isEditing ? (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  onToggleMoreMenu()
                }}
                className={`clickable-icon yolo-chat-list-dropdown-item-icon yolo-chat-list-more-button${
                  isMoreMenuOpen ? ' is-open' : ''
                }`}
                aria-labelledby={moreActionsLabelId}
                aria-expanded={isMoreMenuOpen ? 'true' : 'false'}
              >
                <Ellipsis size={16} />
                <span id={moreActionsLabelId} className="yolo-sr-only">
                  {t('sidebar.chatList.moreActions', 'More actions')}
                </span>
              </button>
            ) : null}
          </>
        ) : null}
      </div>
    </motion.li>
  )
}

function extractPromptContent(
  promptContent: string | ContentPart[] | null | undefined,
): string {
  if (!promptContent) return ''
  if (typeof promptContent === 'string') return promptContent
  return promptContent
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join(' ')
}

function extractConversationText(messages: SerializedChatMessage[]): string {
  const text = messages
    .map((message) => {
      if (message.role === 'assistant') {
        return message.content ?? ''
      }
      if (message.role === 'user') {
        const editorText = message.content
          ? editorStateToPlainText(message.content)
          : ''
        const promptText = extractPromptContent(message.promptContent)
        return `${editorText} ${promptText}`.trim()
      }
      return ''
    })
    .filter(Boolean)
    .join(' ')
  return text.toLowerCase()
}

export function ChatListDropdown({
  chatList,
  currentConversationId,
  runSummariesByConversationId,
  onSelect,
  onDelete,
  onUpdateTitle,
  onTogglePinned,
  onRetryTitle,
  onExportConversation,
  children,
}: {
  chatList: ChatConversationMetadata[]
  currentConversationId: string
  runSummariesByConversationId: Map<string, AgentConversationRunSummary>
  onSelect: (conversationId: string) => void | Promise<void>
  onDelete: (conversationId: string) => void | Promise<void>
  onUpdateTitle: (
    conversationId: string,
    newTitle: string,
  ) => void | Promise<void>
  onTogglePinned: (conversationId: string) => void | Promise<void>
  onRetryTitle: (conversationId: string) => void | Promise<void>
  onExportConversation: (conversationId: string) => void | Promise<void>
  children: React.ReactNode
}) {
  const { t } = useLanguage()
  const chatManager = useChatManager()
  const [open, setOpen] = useState(false)
  const [focusedConversationId, setFocusedConversationId] = useState<
    string | null
  >(null)
  const [scrollIntoViewConversationId, setScrollIntoViewConversationId] =
    useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [activeSection, setActiveSection] = useState<ChatHistorySection>(
    rememberedHistorySection,
  )
  const [taskOriginFilter, setTaskOriginFilter] = useState<TaskOriginFilter>(
    rememberedTaskOriginFilter,
  )
  const [showArchived, setShowArchived] = useState(false)
  const [isHoveringArchiveRow, setIsHoveringArchiveRow] = useState(false)
  const [updatingTitleIds, setUpdatingTitleIds] = useState<Set<string>>(
    new Set(),
  )
  const [contentMatches, setContentMatches] = useState<Set<string>>(new Set())
  const [retryingConversationIds, setRetryingConversationIds] = useState<
    Set<string>
  >(new Set())
  const [moreMenuConversationId, setMoreMenuConversationId] = useState<
    string | null
  >(null)
  const [orderSnapshot, setOrderSnapshot] =
    useState<ChatListOrderSnapshot | null>(null)
  const [pendingDeletionIds, setPendingDeletionIds] = useState<Set<string>>(
    new Set(),
  )
  const [collapse, setCollapse] = useState<{
    fromIndex: number
    distance: number
  } | null>(null)
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null)
  const [menuPosition, setMenuPosition] = useState<{
    top: number
    left: number
  } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const contextMenuAnchorRef = useRef<HTMLElement | null>(null)
  const searchCacheRef = useRef<
    Map<string, { updatedAt: number; text: string }>
  >(new Map())
  const searchIdRef = useRef(0)
  // 焦点所在条目的位置，用于它被删除后把焦点继承给顶上来的那条
  const focusedIndexRef = useRef<number | null>(null)
  const isMobile = Platform.isMobileApp

  const deleteConversation = useCallback(
    (conversationId: string) => {
      // FLIP 的 First：删掉一条，它后面的条目一律上移「这一条的高度」，位移量对所有
      // 条目相同，所以整列只需在这里测这一次——framer-motion 的 layout 之所以贵，
      // 就是因为它不知道这个前提，逐个条目去 measureScroll。
      const items = listRef.current?.querySelectorAll('[data-conversation-id]')
      const removedElement = listRef.current?.querySelector(
        `[data-conversation-id="${CSS.escape(conversationId)}"]`,
      )
      const removedIndex = items
        ? Array.prototype.indexOf.call(items, removedElement)
        : -1
      if (removedElement && removedIndex !== -1) {
        setCollapse({
          fromIndex: removedIndex,
          distance: Math.round(removedElement.getBoundingClientRect().height),
        })
      }
      setPendingDeletionIds((previous) => new Set(previous).add(conversationId))
      void Promise.resolve(onDelete(conversationId)).catch((error) => {
        console.error('Failed to delete conversation', error)
        // 没删成就把条目放回列表，不能让它凭空消失
        setPendingDeletionIds((previous) => {
          if (!previous.has(conversationId)) return previous
          const next = new Set(previous)
          next.delete(conversationId)
          return next
        })
      })
    },
    [onDelete],
  )

  const {
    isConfirming: isMenuDeleteConfirming,
    request: requestMenuDelete,
    reset: resetMenuDeleteConfirmation,
  } = useDeleteConfirmation(() => {
    if (activeMenuId === null) return
    setActiveMenuId(null)
    setMenuPosition(null)
    setMoreMenuConversationId(null)
    deleteConversation(activeMenuId)
  })

  const normalizedQuery = useMemo(
    () => searchQuery.trim().toLowerCase(),
    [searchQuery],
  )

  const userChatList = useMemo(
    () => chatList.filter((chat) => getChatConversationOrigin(chat) === 'user'),
    [chatList],
  )
  const taskChatList = useMemo(
    () => chatList.filter((chat) => getChatConversationOrigin(chat) !== 'user'),
    [chatList],
  )
  const taskOrigins = useMemo(
    () =>
      Array.from(
        new Set(
          taskChatList.map(
            (chat) => getChatConversationOrigin(chat) as TaskConversationOrigin,
          ),
        ),
      ),
    [taskChatList],
  )
  const sectionChatList = activeSection === 'user' ? userChatList : taskChatList
  const scopedChatList = useMemo(() => {
    if (activeSection === 'user') return userChatList
    if (taskOriginFilter === 'all') return taskChatList
    return taskChatList.filter(
      (chat) => getChatConversationOrigin(chat) === taskOriginFilter,
    )
  }, [activeSection, taskChatList, taskOriginFilter, userChatList])

  useEffect(() => {
    if (taskOriginFilter !== 'all' && !taskOrigins.includes(taskOriginFilter)) {
      rememberedTaskOriginFilter = 'all'
      setTaskOriginFilter('all')
    }
  }, [taskOriginFilter, taskOrigins])

  const untitledFallback = t('chat.untitledConversation', 'New chat')
  const getDisplayTitle = useCallback(
    (chat: ChatConversationMetadata) =>
      getConversationDisplayTitle(chat.title, untitledFallback),
    [untitledFallback],
  )

  const titleMatches = useMemo(() => {
    if (!normalizedQuery) return new Set<string>()
    const matches = new Set<string>()
    scopedChatList.forEach((chat) => {
      if (getDisplayTitle(chat).toLowerCase().includes(normalizedQuery)) {
        matches.add(chat.id)
      }
    })
    return matches
  }, [getDisplayTitle, normalizedQuery, scopedChatList])

  const pinnedSortedChatList = useMemo(
    () =>
      sortChatListForDisplay({
        chatList: sectionChatList,
        section: activeSection,
        orderSnapshot,
      }),
    [activeSection, orderSnapshot, sectionChatList],
  )

  const filteredChatList = useMemo(() => {
    if (!normalizedQuery) return scopedChatList
    return scopedChatList.filter(
      (chat) => titleMatches.has(chat.id) || contentMatches.has(chat.id),
    )
  }, [contentMatches, normalizedQuery, scopedChatList, titleMatches])

  const baseDisplayChatList = useMemo(() => {
    if (normalizedQuery) return filteredChatList
    return pinnedSortedChatList
  }, [filteredChatList, normalizedQuery, pinnedSortedChatList])

  const shouldUseArchive = normalizedQuery.length === 0

  const { activeChatList, archivedChatList } = useMemo(() => {
    return partitionChatHistory({
      chatList: baseDisplayChatList,
      currentConversationId,
      section: activeSection,
      originFilter: taskOriginFilter,
      useArchive: shouldUseArchive,
    })
  }, [
    activeSection,
    taskOriginFilter,
    baseDisplayChatList,
    currentConversationId,
    shouldUseArchive,
  ])

  const renderedChatList = useMemo(() => {
    const list = !shouldUseArchive
      ? activeChatList
      : showArchived
        ? [...activeChatList, ...archivedChatList]
        : activeChatList
    // 已确认删除的会话立刻退出列表，不等磁盘：真正的删除要读写文件并重建整个
    // 会话索引，等它返回再开始退场，动画就会被这段同步开销卡在头几帧上
    if (pendingDeletionIds.size === 0) return list
    return list.filter((chat) => !pendingDeletionIds.has(chat.id))
  }, [
    activeChatList,
    archivedChatList,
    pendingDeletionIds,
    shouldUseArchive,
    showArchived,
  ])

  const displayChatIndexById = useMemo(() => {
    const map = new Map<string, number>()
    renderedChatList.forEach((chat, index) => {
      map.set(chat.id, index)
    })
    return map
  }, [renderedChatList])

  const clearContentMatches = useCallback(() => {
    setContentMatches((prev) => (prev.size === 0 ? prev : new Set()))
  }, [])

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (nextOpen) {
        // 每次打开重新采样排序时间，这是列表顺序唯一的更新时机
        setOrderSnapshot(null)
        setActiveSection(rememberedHistorySection)
        setTaskOriginFilter(rememberedTaskOriginFilter)
        const nextFocusedConversationId =
          pinnedSortedChatList.find((chat) => chat.id === currentConversationId)
            ?.id ??
          pinnedSortedChatList[0]?.id ??
          null
        setFocusedConversationId(nextFocusedConversationId)
        focusedIndexRef.current = null
        setScrollIntoViewConversationId(null)
        setEditingId(null)
        setSearchQuery('')
        setShowArchived(false)
        setIsHoveringArchiveRow(false)
        setMoreMenuConversationId(null)
        setActiveMenuId(null)
        setMenuPosition(null)
        resetMenuDeleteConfirmation()
        setPendingDeletionIds((previous) =>
          previous.size === 0 ? previous : new Set(),
        )
        clearContentMatches()
      } else {
        setEditingId(null)
        setFocusedConversationId(null)
        setScrollIntoViewConversationId(null)
        setIsHoveringArchiveRow(false)
        setMoreMenuConversationId(null)
        setActiveMenuId(null)
        setMenuPosition(null)
      }
      setOpen(nextOpen)
    },
    [
      clearContentMatches,
      currentConversationId,
      pinnedSortedChatList,
      resetMenuDeleteConfirmation,
    ],
  )

  const openContextMenu = useCallback(
    (
      chatId: string,
      cardEl: HTMLElement,
      pointer?: { clientX: number; clientY: number },
    ) => {
      const contentEl = contentRef.current
      if (!contentEl) {
        return
      }
      const contentRect = contentEl.getBoundingClientRect()
      const cardRect = cardEl.getBoundingClientRect()
      const menuWidth = 176
      const menuHeight = 168
      const maxLeft = Math.max(8, contentRect.width - menuWidth - 8)
      const maxTop = Math.max(8, contentRect.height - menuHeight - 8)
      const anchorLeft = (pointer?.clientX ?? cardRect.left) - contentRect.left
      const anchorTop =
        (pointer?.clientY ?? cardRect.bottom + 6) - contentRect.top
      const left = Math.min(Math.max(8, anchorLeft), maxLeft)
      let top = Math.min(Math.max(8, anchorTop), maxTop)
      if (!pointer && anchorTop + menuHeight > contentRect.height) {
        top = Math.min(
          Math.max(8, cardRect.top - contentRect.top - menuHeight - 6),
          maxTop,
        )
      }
      setMoreMenuConversationId(null)
      setFocusedConversationId(chatId)
      contextMenuAnchorRef.current = cardEl
      setMenuPosition({ top, left })
      setActiveMenuId(chatId)
    },
    [],
  )

  useEffect(() => {
    resetMenuDeleteConfirmation()
    if (activeMenuId !== null) {
      contextMenuRef.current?.focus({ preventScroll: true })
    }
  }, [activeMenuId, resetMenuDeleteConfirmation])

  // 面板打开期间新出现的会话补录一次排序时间，之后它同样不再随运行状态换位
  useEffect(() => {
    if (!open) return
    setOrderSnapshot((previous) => captureChatListOrder(chatList, previous))
  }, [chatList, open])

  // FLIP 的 Play：条目已经被摁回删除前的位置（Invert），下一帧松手，交给 CSS 过渡
  // 平移回 0。全程只动 transform，不触发 layout。
  useEffect(() => {
    if (!collapse) return
    const frame = window.requestAnimationFrame(() => setCollapse(null))
    return () => window.cancelAnimationFrame(frame)
  }, [collapse])

  // 磁盘上真的删掉之后，乐观移除的记录就没用了
  useEffect(() => {
    setPendingDeletionIds((previous) => {
      if (previous.size === 0) return previous
      let next = previous
      previous.forEach((id) => {
        if (chatList.some((chat) => chat.id === id)) return
        next = next === previous ? new Set(previous) : next
        next.delete(id)
      })
      return next
    })
  }, [chatList])

  const handleContextMenuKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const menu = contextMenuRef.current
      if (!menu) return
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setActiveMenuId(null)
        setMenuPosition(null)
        contextMenuAnchorRef.current?.focus({ preventScroll: true })
        return
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
        e.stopPropagation()
        return
      }
      e.preventDefault()
      e.stopPropagation()
      const items = Array.from(
        menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
      )
      if (items.length === 0) return
      const currentIndex = items.findIndex(
        (item) => item === menu.ownerDocument.activeElement,
      )
      let nextIndex = 0
      if (e.key === 'End') {
        nextIndex = items.length - 1
      } else if (e.key === 'ArrowUp') {
        nextIndex = currentIndex <= 0 ? items.length - 1 : currentIndex - 1
      } else if (e.key === 'ArrowDown') {
        nextIndex =
          currentIndex === -1 || currentIndex === items.length - 1
            ? 0
            : currentIndex + 1
      }
      items[nextIndex]?.focus({ preventScroll: true })
    },
    [],
  )

  const syncPopoverWidth = useCallback(() => {
    const content = contentRef.current
    const trigger = triggerRef.current
    if (!content || !trigger) return
    const sidebar = trigger.closest('.yolo-chat-container')
    if (!sidebar) return
    const { width } = sidebar.getBoundingClientRect()
    if (width > 0) {
      const maxWidth = 420
      const nextWidth = `${Math.round(Math.min(width, maxWidth))}px`
      content.style.width = nextWidth
    }
  }, [])

  useEffect(() => {
    if (!open) return
    if (renderedChatList.length === 0) {
      setFocusedConversationId(null)
      focusedIndexRef.current = null
      return
    }

    const currentFocusedIndex =
      focusedConversationId === null
        ? undefined
        : displayChatIndexById.get(focusedConversationId)
    if (currentFocusedIndex !== undefined) {
      focusedIndexRef.current = currentFocusedIndex
      return
    }

    if (!normalizedQuery) {
      // 焦点所在的会话消失了，通常是刚被删除。把焦点交给顶上来占据同一位置的
      // 那条，视线锚点才是连续的，也才能接着删下一条；否则焦点会跳去当前会话，
      // 而指针仍停在原处——鼠标没移动时浏览器不会补发 mouseenter，错位会一直挂着。
      const inheritedIndex = focusedIndexRef.current
      if (inheritedIndex !== null) {
        setFocusedConversationId(
          renderedChatList[
            Math.min(inheritedIndex, renderedChatList.length - 1)
          ]?.id ?? null,
        )
        setScrollIntoViewConversationId(null)
        return
      }
      setFocusedConversationId(
        displayChatIndexById.has(currentConversationId)
          ? currentConversationId
          : (renderedChatList[0]?.id ?? null),
      )
      setScrollIntoViewConversationId(null)
      return
    }

    // 搜索期间列表是整体换掉的，沿用旧索引没有意义，回到第一条结果
    setFocusedConversationId(renderedChatList[0]?.id ?? null)
    setScrollIntoViewConversationId(null)
  }, [
    currentConversationId,
    displayChatIndexById,
    focusedConversationId,
    normalizedQuery,
    open,
    renderedChatList,
  ])

  useEffect(() => {
    if (!open) return
    if (!normalizedQuery) {
      clearContentMatches()
      return
    }

    const currentSearchId = searchIdRef.current + 1
    searchIdRef.current = currentSearchId
    const timeoutId = window.setTimeout(() => {
      void (async () => {
        const nextMatches = new Set<string>()
        for (const chat of scopedChatList) {
          if (titleMatches.has(chat.id)) continue
          const cached = searchCacheRef.current.get(chat.id)
          if (cached && cached.updatedAt === chat.updatedAt) {
            if (cached.text.includes(normalizedQuery)) {
              nextMatches.add(chat.id)
            }
            continue
          }
          const conversation = await chatManager.findById(chat.id)
          if (!conversation) continue
          const text = extractConversationText(conversation.messages)
          searchCacheRef.current.set(chat.id, {
            updatedAt: chat.updatedAt,
            text,
          })
          if (text.includes(normalizedQuery)) {
            nextMatches.add(chat.id)
          }
          if (searchIdRef.current !== currentSearchId) {
            return
          }
        }
        if (searchIdRef.current === currentSearchId) {
          setContentMatches(nextMatches)
        }
      })()
    }, 160)

    return () => {
      window.clearTimeout(timeoutId)
      searchIdRef.current += 1
    }
  }, [
    chatManager,
    clearContentMatches,
    normalizedQuery,
    open,
    scopedChatList,
    titleMatches,
  ])

  useEffect(() => {
    if (!open) return
    syncPopoverWidth()
    const sidebar = triggerRef.current?.closest('.yolo-chat-container')
    if (!sidebar) return
    const ownerWindow = getNodeWindow(triggerRef.current)
    const handleResize = () => {
      syncPopoverWidth()
    }
    let resizeObserver: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        syncPopoverWidth()
      })
      resizeObserver.observe(sidebar)
    }
    ownerWindow.addEventListener('resize', handleResize)
    return () => {
      ownerWindow.removeEventListener('resize', handleResize)
      resizeObserver?.disconnect()
    }
  }, [open, syncPopoverWidth])

  const focusedIndex = useMemo(
    () =>
      focusedConversationId === null
        ? -1
        : (displayChatIndexById.get(focusedConversationId) ?? -1),
    [displayChatIndexById, focusedConversationId],
  )

  const activeMenuChat = useMemo(
    () => renderedChatList.find((chat) => chat.id === activeMenuId) ?? null,
    [activeMenuId, renderedChatList],
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const target = e.target
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLButtonElement
      ) {
        return
      }
      const activeList = renderedChatList
      if (e.key === 'ArrowUp') {
        if (activeList.length === 0) return
        const currentIndex = focusedIndex === -1 ? 0 : focusedIndex
        const nextIndex = Math.max(0, currentIndex - 1)
        const nextConversationId = activeList[nextIndex]?.id ?? null
        setFocusedConversationId(nextConversationId)
        setScrollIntoViewConversationId(nextConversationId)
      } else if (e.key === 'ArrowDown') {
        if (activeList.length === 0) return
        const currentIndex = focusedIndex === -1 ? 0 : focusedIndex
        const nextIndex = Math.min(activeList.length - 1, currentIndex + 1)
        const nextConversationId = activeList[nextIndex]?.id ?? null
        setFocusedConversationId(nextConversationId)
        setScrollIntoViewConversationId(nextConversationId)
      } else if (e.key === 'Enter') {
        const conversationId =
          focusedConversationId ??
          activeList[focusedIndex]?.id ??
          activeList[0]?.id
        if (!conversationId) return
        void Promise.resolve(onSelect(conversationId))
          .then(() => {
            setOpen(false)
          })
          .catch((error) => {
            console.error('Failed to select conversation from list', error)
          })
      }
    },
    [renderedChatList, focusedConversationId, focusedIndex, onSelect],
  )

  return (
    <Popover.Root open={open} onOpenChange={handleOpenChange}>
      <Popover.Trigger asChild>
        <button
          type="button"
          ref={triggerRef}
          className="clickable-icon"
          aria-label="Chat History"
        >
          {children}
        </button>
      </Popover.Trigger>

      <YoloPopoverContent
        ref={contentRef}
        anchorRef={triggerRef}
        variant="default"
        minWidth={280}
        maxHeight={400}
        className="yolo-chat-list-dropdown-content"
        sideOffset={8}
        onKeyDown={handleKeyDown}
      >
        <div className="yolo-chat-list-search">
          <div className="yolo-chat-list-search-field">
            <Search size={13} className="yolo-chat-list-search-icon" />
            <input
              type="search"
              value={searchQuery}
              placeholder={t(
                'sidebar.chatList.searchPlaceholder',
                'Search conversations',
              )}
              aria-label={t(
                'sidebar.chatList.searchPlaceholder',
                'Search conversations',
              )}
              className="yolo-chat-list-search-input"
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
            />
          </div>
        </div>
        <div
          className="yolo-chat-list-section-tabs"
          role="group"
          aria-label={t(
            'sidebar.chatList.historySections',
            'Conversation categories',
          )}
        >
          <button
            type="button"
            aria-pressed={activeSection === 'user'}
            className={`yolo-chat-list-section-tab${
              activeSection === 'user' ? ' is-active' : ''
            }`}
            onClick={() => {
              rememberedHistorySection = 'user'
              setActiveSection('user')
              setShowArchived(false)
              setMoreMenuConversationId(null)
              setActiveMenuId(null)
              setMenuPosition(null)
            }}
          >
            <span>
              {t('sidebar.chatList.myConversations', 'My conversations')}
            </span>
            <span className="yolo-chat-list-section-count">
              {userChatList.length}
            </span>
          </button>
          <button
            type="button"
            aria-pressed={activeSection === 'task'}
            className={`yolo-chat-list-section-tab${
              activeSection === 'task' ? ' is-active' : ''
            }`}
            onClick={() => {
              rememberedHistorySection = 'task'
              setActiveSection('task')
              setShowArchived(false)
              setMoreMenuConversationId(null)
              setActiveMenuId(null)
              setMenuPosition(null)
            }}
          >
            <span>
              {t('sidebar.chatList.taskConversations', 'Task conversations')}
            </span>
            <span className="yolo-chat-list-section-count">
              {taskChatList.length}
            </span>
          </button>
        </div>
        {activeSection === 'task' && taskOrigins.length > 1 ? (
          <div
            className="yolo-chat-list-origin-filters"
            aria-label={t(
              'sidebar.chatList.taskConversationSources',
              'Task conversation sources',
            )}
          >
            <button
              type="button"
              className={`yolo-chat-list-origin-filter${
                taskOriginFilter === 'all' ? ' is-active' : ''
              }`}
              aria-pressed={taskOriginFilter === 'all'}
              onClick={() => {
                rememberedTaskOriginFilter = 'all'
                setTaskOriginFilter('all')
                setShowArchived(false)
              }}
            >
              {t('sidebar.chatList.allSources', 'All')}
            </button>
            {taskOrigins.map((origin) => (
              <button
                key={origin}
                type="button"
                className={`yolo-chat-list-origin-filter${
                  taskOriginFilter === origin ? ' is-active' : ''
                }`}
                aria-pressed={taskOriginFilter === origin}
                onClick={() => {
                  rememberedTaskOriginFilter = origin
                  setTaskOriginFilter(origin)
                  setShowArchived(false)
                }}
              >
                {origin === 'external-agent'
                  ? t('sidebar.chatList.externalAgent', 'External Agent')
                  : origin}
              </button>
            ))}
          </div>
        ) : null}
        <ul
          ref={listRef}
          className={`yolo-model-select-list${
            collapse ? ' is-collapsing' : ''
          }`}
          onPointerDownCapture={(e) => {
            if (activeMenuId === null) {
              return
            }
            if (
              e.target instanceof Element &&
              e.target.closest('.yolo-chat-list-ctx-menu')
            ) {
              return
            }
            setActiveMenuId(null)
            setMenuPosition(null)
          }}
          onScroll={() => {
            setActiveMenuId(null)
            setMenuPosition(null)
          }}
        >
          {scopedChatList.length === 0 ? (
            <li className="yolo-chat-list-dropdown-empty">
              {activeSection === 'user'
                ? t('sidebar.chatList.empty', 'No conversations')
                : t(
                    'sidebar.chatList.noTaskConversations',
                    'No task conversations',
                  )}
            </li>
          ) : filteredChatList.length === 0 ? (
            <li className="yolo-chat-list-dropdown-empty">
              {t('common.noResults', 'No matches found')}
            </li>
          ) : (
            <>
              {/* initial={false} 让面板打开时条目直接就位，只有删除才播放退场 */}
              <AnimatePresence initial={false}>
                {renderedChatList.map((chat) => (
                  <ChatListItem
                    key={chat.id}
                    title={chat.title}
                    displayTitle={getDisplayTitle(chat)}
                    cliRuntimeId={chat.cliSession?.runtimeId}
                    runSummary={runSummariesByConversationId.get(chat.id)}
                    isCurrent={chat.id === currentConversationId}
                    isFocused={
                      focusedConversationId === chat.id &&
                      !isHoveringArchiveRow &&
                      activeMenuId === null
                    }
                    shouldScrollIntoView={
                      scrollIntoViewConversationId === chat.id
                    }
                    isEditing={editingId === chat.id}
                    isUpdatingTitle={updatingTitleIds.has(chat.id)}
                    isPinned={Boolean(chat.isPinned)}
                    canPin={activeSection === 'user'}
                    canRetryTitle={!chat.cliSession}
                    canExport={!chat.cliSession}
                    isRetrying={retryingConversationIds.has(chat.id)}
                    isMoreMenuOpen={moreMenuConversationId === chat.id}
                    isContextMenuOpen={activeMenuId === chat.id}
                    isMobile={isMobile}
                    conversationId={chat.id}
                    shiftY={
                      collapse &&
                      (displayChatIndexById.get(chat.id) ?? -1) >=
                        collapse.fromIndex
                        ? collapse.distance
                        : 0
                    }
                    onMouseEnter={() => {
                      setFocusedConversationId(chat.id)
                      setScrollIntoViewConversationId(null)
                      if (
                        moreMenuConversationId != null &&
                        moreMenuConversationId !== chat.id
                      ) {
                        setMoreMenuConversationId(null)
                      }
                    }}
                    onMouseLeave={() => {
                      if (moreMenuConversationId === chat.id) {
                        setMoreMenuConversationId(null)
                      }
                    }}
                    onSelect={() => {
                      void Promise.resolve(onSelect(chat.id))
                        .then(() => {
                          setOpen(false)
                        })
                        .catch((error) => {
                          console.error('Failed to select conversation', error)
                        })
                    }}
                    onDelete={() => {
                      setMoreMenuConversationId(null)
                      deleteConversation(chat.id)
                    }}
                    onRetryTitle={() => {
                      if (retryingConversationIds.has(chat.id)) {
                        return
                      }
                      const retryStartedAt = Date.now()
                      setRetryingConversationIds((prev) => {
                        const next = new Set(prev)
                        next.add(chat.id)
                        return next
                      })
                      void Promise.resolve(onRetryTitle(chat.id))
                        .catch((error) => {
                          console.error(
                            'Failed to retry conversation title generation',
                            error,
                          )
                        })
                        .finally(() => {
                          const elapsed = Date.now() - retryStartedAt
                          const remaining = Math.max(0, 320 - elapsed)
                          window.setTimeout(() => {
                            setRetryingConversationIds((prev) => {
                              if (!prev.has(chat.id)) {
                                return prev
                              }
                              const next = new Set(prev)
                              next.delete(chat.id)
                              return next
                            })
                          }, remaining)
                        })
                    }}
                    onTogglePinned={() => {
                      setMoreMenuConversationId(null)
                      void Promise.resolve(onTogglePinned(chat.id)).catch(
                        (error) => {
                          console.error('Failed to toggle pin', error)
                        },
                      )
                    }}
                    onExport={() => {
                      setMoreMenuConversationId(null)
                      void Promise.resolve(onExportConversation(chat.id)).catch(
                        (error) => {
                          console.error('Failed to export conversation', error)
                        },
                      )
                    }}
                    onStartEdit={() => {
                      setMoreMenuConversationId(null)
                      setEditingId(chat.id)
                    }}
                    onFinishEdit={(title) => {
                      if (updatingTitleIds.has(chat.id)) {
                        return
                      }
                      setUpdatingTitleIds((prev) => {
                        const next = new Set(prev)
                        next.add(chat.id)
                        return next
                      })
                      void Promise.resolve(onUpdateTitle(chat.id, title))
                        .then(() => {
                          setEditingId(null)
                        })
                        .catch((error) => {
                          console.error(
                            'Failed to update conversation title',
                            error,
                          )
                        })
                        .finally(() => {
                          setUpdatingTitleIds((prev) => {
                            if (!prev.has(chat.id)) {
                              return prev
                            }
                            const next = new Set(prev)
                            next.delete(chat.id)
                            return next
                          })
                        })
                    }}
                    onToggleMoreMenu={() => {
                      setMoreMenuConversationId((prev) =>
                        prev === chat.id ? null : chat.id,
                      )
                    }}
                    onCloseMoreMenu={() => {
                      setMoreMenuConversationId((prev) =>
                        prev === chat.id ? null : prev,
                      )
                    }}
                    onLongPress={(cardEl) => {
                      if (!isMobile) {
                        return
                      }
                      openContextMenu(chat.id, cardEl)
                    }}
                    onContextMenu={(cardEl, clientX, clientY) => {
                      if (isMobile) {
                        return
                      }
                      openContextMenu(chat.id, cardEl, { clientX, clientY })
                    }}
                  />
                ))}
              </AnimatePresence>
              {shouldUseArchive && archivedChatList.length > 0 && (
                <li
                  className="yolo-chat-list-dropdown-archive-row"
                  onMouseEnter={() => {
                    setIsHoveringArchiveRow(true)
                  }}
                  onMouseLeave={() => {
                    setIsHoveringArchiveRow(false)
                  }}
                >
                  <button
                    type="button"
                    className="yolo-chat-list-dropdown-archive-toggle"
                    onClick={() => {
                      setShowArchived((prev) => !prev)
                    }}
                  >
                    <span className="yolo-chat-list-dropdown-archive-toggle-label">
                      {showArchived
                        ? t('sidebar.chatList.hideArchived', 'Hide archived')
                        : `${t('sidebar.chatList.archived', 'Archived')} (${archivedChatList.length})`}
                    </span>
                  </button>
                </li>
              )}
            </>
          )}
        </ul>
        {activeMenuChat && menuPosition ? (
          <div
            ref={contextMenuRef}
            className="yolo-chat-list-ctx-menu is-open"
            style={{ top: menuPosition.top, left: menuPosition.left }}
            role="menu"
            tabIndex={-1}
            aria-label={t('sidebar.chatList.moreActions', 'More actions')}
            onKeyDown={handleContextMenuKeyDown}
          >
            {activeSection === 'user' ? (
              <button
                type="button"
                role="menuitem"
                data-act="pin"
                onClick={(e) => {
                  e.stopPropagation()
                  setActiveMenuId(null)
                  setMenuPosition(null)
                  setMoreMenuConversationId(null)
                  void Promise.resolve(onTogglePinned(activeMenuChat.id)).catch(
                    (error) => {
                      console.error('Failed to toggle pin', error)
                    },
                  )
                }}
              >
                <Star size={16} />
                <span>
                  {activeMenuChat.isPinned
                    ? t('sidebar.chatList.unpinConversation', 'Unpin')
                    : t('sidebar.chatList.pinConversation', 'Pin')}
                </span>
              </button>
            ) : null}
            <button
              type="button"
              role="menuitem"
              data-act="rename"
              onClick={(e) => {
                e.stopPropagation()
                setActiveMenuId(null)
                setMenuPosition(null)
                setMoreMenuConversationId(null)
                setEditingId(activeMenuChat.id)
              }}
            >
              <Pencil size={16} />
              <span>{t('common.edit', 'Edit')}</span>
            </button>
            {!activeMenuChat.cliSession ? (
              <button
                type="button"
                role="menuitem"
                data-act="retitle"
                disabled={retryingConversationIds.has(activeMenuChat.id)}
                onClick={(e) => {
                  e.stopPropagation()
                  if (retryingConversationIds.has(activeMenuChat.id)) {
                    return
                  }
                  setActiveMenuId(null)
                  setMenuPosition(null)
                  const retryStartedAt = Date.now()
                  setRetryingConversationIds((prev) => {
                    const next = new Set(prev)
                    next.add(activeMenuChat.id)
                    return next
                  })
                  void Promise.resolve(onRetryTitle(activeMenuChat.id))
                    .catch((error) => {
                      console.error(
                        'Failed to retry conversation title generation',
                        error,
                      )
                    })
                    .finally(() => {
                      const elapsed = Date.now() - retryStartedAt
                      const remaining = Math.max(0, 320 - elapsed)
                      window.setTimeout(() => {
                        setRetryingConversationIds((prev) => {
                          if (!prev.has(activeMenuChat.id)) {
                            return prev
                          }
                          const next = new Set(prev)
                          next.delete(activeMenuChat.id)
                          return next
                        })
                      }, remaining)
                    })
                }}
              >
                <RotateCcw size={16} />
                <span>{t('sidebar.chatList.retryTitle', 'Retry title')}</span>
              </button>
            ) : null}
            {!activeMenuChat.cliSession ? (
              <button
                type="button"
                role="menuitem"
                data-act="export"
                onClick={(e) => {
                  e.stopPropagation()
                  setActiveMenuId(null)
                  setMenuPosition(null)
                  setMoreMenuConversationId(null)
                  void Promise.resolve(
                    onExportConversation(activeMenuChat.id),
                  ).catch((error) => {
                    console.error('Failed to export conversation', error)
                  })
                }}
              >
                <Download size={16} />
                <span>
                  {t(
                    'sidebar.chatList.exportConversation',
                    'Export conversation to vault',
                  )}
                </span>
              </button>
            ) : null}
            <hr />
            <button
              type="button"
              role="menuitem"
              data-act="delete"
              className={`danger${
                isMenuDeleteConfirming ? ' is-confirming' : ''
              }`}
              onClick={(e) => {
                e.stopPropagation()
                requestMenuDelete()
              }}
            >
              <Trash2 size={16} />
              <span>
                {isMenuDeleteConfirming
                  ? t('sidebar.chatList.confirmDelete', 'Click again to delete')
                  : t('common.delete', 'Delete')}
              </span>
            </button>
          </div>
        ) : null}
      </YoloPopoverContent>
    </Popover.Root>
  )
}
