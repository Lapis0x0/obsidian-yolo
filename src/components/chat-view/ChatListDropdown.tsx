import * as Popover from '@radix-ui/react-popover'
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
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'

import { useLanguage } from '../../contexts/language-context'
import type { AgentConversationRunSummary } from '../../core/agent/service'
import type { ChatConversationMetadata } from '../../database/json/chat/types'
import { useChatManager } from '../../hooks/useJsonManagers'
import type { SerializedChatMessage } from '../../types/chat'
import type { ContentPart } from '../../types/llm/request'
import { getNodeBody, getNodeWindow } from '../../utils/dom/window-context'

import { editorStateToPlainText } from './chat-input/utils/editor-state-to-plain-text'

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
      className="smtcmp-chat-list-dropdown-item-title-input"
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

function ChatListItem({
  title,
  runSummary,
  isFocused,
  shouldScrollIntoView,
  isEditing,
  isUpdatingTitle,
  isPinned,
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
}: {
  title: string
  runSummary?: AgentConversationRunSummary
  isFocused: boolean
  shouldScrollIntoView: boolean
  isEditing: boolean
  isUpdatingTitle: boolean
  isPinned: boolean
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
}) {
  const { t } = useLanguage()
  const moreActionsLabelId = useId()
  const itemRef = useRef<HTMLLIElement>(null)
  const [editingTitle, setEditingTitle] = useState(title)

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

  return (
    <li
      ref={itemRef}
      onMouseDown={(e) => {
        if (e.target instanceof Element && e.target.closest('button')) {
          return
        }
        onSelect()
      }}
      onMouseEnter={onMouseEnter}
      onPointerLeave={() => {
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
      className={`smtcmp-chat-list-dropdown-item${isFocused ? ' selected' : ''}`}
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
          className={`smtcmp-chat-list-dropdown-item-title${
            isRetrying ? ' is-retrying' : ''
          }`}
        >
          <span className="smtcmp-chat-list-dropdown-item-title-text">
            {title}
          </span>
          {runSummary &&
          (runSummary.isRunning || runSummary.isWaitingApproval) ? (
            <span
              className={`smtcmp-chat-list-dropdown-item-status${
                runSummary.isRunning ? ' is-running' : ' is-waiting'
              }`}
              aria-label={
                runSummary.isRunning
                  ? 'Conversation running'
                  : 'Waiting approval'
              }
              title={
                runSummary.isRunning
                  ? 'Conversation running'
                  : 'Waiting approval'
              }
            />
          ) : null}
          {isRetrying && (
            <span
              className="smtcmp-chat-list-dropdown-item-title-skeleton"
              aria-hidden="true"
            />
          )}
        </div>
      )}
      <div
        className={`smtcmp-chat-list-dropdown-item-actions${
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
            className="clickable-icon smtcmp-chat-list-dropdown-item-icon"
            disabled={isUpdatingTitle}
            aria-label={t('common.save', 'Save')}
            title={t('common.save', 'Save')}
          >
            <Check />
          </button>
        ) : null}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onCloseMoreMenu()
            onDelete()
          }}
          className="clickable-icon smtcmp-chat-list-dropdown-item-icon"
        >
          <Trash2 />
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onCloseMoreMenu()
            onTogglePinned()
          }}
          className={`clickable-icon smtcmp-chat-list-pin-button${
            isPinned ? ' is-pinned' : ''
          }`}
        >
          <Star />
        </button>
        {!isEditing ? (
          <div
            className={`smtcmp-chat-list-inline-actions${
              isMoreMenuOpen ? ' is-open' : ''
            }`}
            aria-hidden={isMoreMenuOpen ? undefined : 'true'}
          >
            <div className="smtcmp-chat-list-inline-actions-inner">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  onCloseMoreMenu()
                  onStartEdit()
                }}
                className="clickable-icon smtcmp-chat-list-dropdown-item-icon"
                aria-label={t('common.edit', 'Edit')}
                title={t('common.edit', 'Edit')}
                tabIndex={isMoreMenuOpen ? undefined : -1}
              >
                <Pencil size={16} />
              </button>
              <button
                type="button"
                disabled={isRetrying}
                onClick={(e) => {
                  e.stopPropagation()
                  onCloseMoreMenu()
                  onRetryTitle()
                }}
                className={`clickable-icon smtcmp-chat-list-dropdown-item-icon${
                  isRetrying ? ' is-pending' : ''
                }`}
                aria-label={t('sidebar.chatList.retryTitle', 'Retry title')}
                title={t('sidebar.chatList.retryTitle', 'Retry title')}
                aria-busy={isRetrying ? 'true' : undefined}
                tabIndex={isMoreMenuOpen ? undefined : -1}
              >
                <RotateCcw
                  className={isRetrying ? 'smtcmp-spinner' : undefined}
                />
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  onCloseMoreMenu()
                  onExport()
                }}
                className="clickable-icon smtcmp-chat-list-dropdown-item-icon"
                aria-label={t(
                  'sidebar.chatList.exportConversation',
                  'Export conversation to vault',
                )}
                title={t(
                  'sidebar.chatList.exportConversation',
                  'Export conversation to vault',
                )}
                tabIndex={isMoreMenuOpen ? undefined : -1}
              >
                <Download size={16} />
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
            className={`clickable-icon smtcmp-chat-list-dropdown-item-icon smtcmp-chat-list-more-button${
              isMoreMenuOpen ? ' is-open' : ''
            }`}
            aria-labelledby={moreActionsLabelId}
            aria-expanded={isMoreMenuOpen ? 'true' : 'false'}
          >
            <Ellipsis size={16} />
            <span id={moreActionsLabelId} className="smtcmp-sr-only">
              {t('sidebar.chatList.moreActions', 'More actions')}
            </span>
          </button>
        ) : null}
      </div>
    </li>
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
        const ragSnapshotText = (message.similaritySearchResults ?? [])
          .map((chunk) => `${chunk.path} ${chunk.content}`)
          .join(' ')
        return `${editorText} ${promptText} ${ragSnapshotText}`.trim()
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
  archiveEnabled,
  archiveThreshold,
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
  archiveEnabled: boolean
  archiveThreshold: number
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
  const triggerRef = useRef<HTMLButtonElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const searchCacheRef = useRef<
    Map<string, { updatedAt: number; text: string }>
  >(new Map())
  const searchIdRef = useRef(0)

  const normalizedQuery = useMemo(
    () => searchQuery.trim().toLowerCase(),
    [searchQuery],
  )

  const titleMatches = useMemo(() => {
    if (!normalizedQuery) return new Set<string>()
    const matches = new Set<string>()
    chatList.forEach((chat) => {
      if (chat.title.toLowerCase().includes(normalizedQuery)) {
        matches.add(chat.id)
      }
    })
    return matches
  }, [chatList, normalizedQuery])

  const pinnedSortedChatList = useMemo(() => {
    if (chatList.length === 0) return chatList
    return [...chatList].sort((a, b) => {
      const aPinned = a.isPinned ? 1 : 0
      const bPinned = b.isPinned ? 1 : 0
      if (aPinned !== bPinned) {
        return bPinned - aPinned
      }
      if (aPinned && bPinned) {
        const aPinnedAt = a.pinnedAt ?? 0
        const bPinnedAt = b.pinnedAt ?? 0
        if (aPinnedAt !== bPinnedAt) {
          return bPinnedAt - aPinnedAt
        }
      }
      return b.updatedAt - a.updatedAt
    })
  }, [chatList])

  const filteredChatList = useMemo(() => {
    if (!normalizedQuery) return chatList
    return chatList.filter(
      (chat) => titleMatches.has(chat.id) || contentMatches.has(chat.id),
    )
  }, [chatList, contentMatches, normalizedQuery, titleMatches])

  const baseDisplayChatList = useMemo(() => {
    if (normalizedQuery) return filteredChatList
    return pinnedSortedChatList
  }, [filteredChatList, normalizedQuery, pinnedSortedChatList])

  const normalizedArchiveThreshold = useMemo(
    () => Math.max(20, Math.min(500, Math.trunc(archiveThreshold || 50))),
    [archiveThreshold],
  )

  const shouldUseArchive =
    archiveEnabled &&
    normalizedQuery.length === 0 &&
    normalizedArchiveThreshold > 0

  const { activeChatList, archivedChatList } = useMemo(() => {
    if (!shouldUseArchive) {
      return {
        activeChatList: baseDisplayChatList,
        archivedChatList: [] as ChatConversationMetadata[],
      }
    }

    const pinnedChats: ChatConversationMetadata[] = []
    const nonPinnedChats: ChatConversationMetadata[] = []
    baseDisplayChatList.forEach((chat) => {
      if (chat.isPinned) {
        pinnedChats.push(chat)
      } else {
        nonPinnedChats.push(chat)
      }
    })

    const activeNonPinnedChats = nonPinnedChats.slice(
      0,
      normalizedArchiveThreshold,
    )
    const archivedNonPinnedChats = nonPinnedChats.slice(
      normalizedArchiveThreshold,
    )
    const currentArchivedIndex = archivedNonPinnedChats.findIndex(
      (chat) => chat.id === currentConversationId,
    )
    if (currentArchivedIndex !== -1) {
      const [currentConversation] = archivedNonPinnedChats.splice(
        currentArchivedIndex,
        1,
      )
      if (currentConversation) {
        activeNonPinnedChats.push(currentConversation)
      }
    }

    return {
      activeChatList: [...pinnedChats, ...activeNonPinnedChats],
      archivedChatList: archivedNonPinnedChats,
    }
  }, [
    baseDisplayChatList,
    currentConversationId,
    normalizedArchiveThreshold,
    shouldUseArchive,
  ])

  const renderedChatList = useMemo(() => {
    if (!shouldUseArchive) return activeChatList
    if (showArchived) return [...activeChatList, ...archivedChatList]
    return activeChatList
  }, [activeChatList, archivedChatList, shouldUseArchive, showArchived])

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
        const nextFocusedConversationId =
          pinnedSortedChatList.find((chat) => chat.id === currentConversationId)
            ?.id ??
          pinnedSortedChatList[0]?.id ??
          null
        setFocusedConversationId(nextFocusedConversationId)
        setScrollIntoViewConversationId(null)
        setEditingId(null)
        setSearchQuery('')
        setShowArchived(false)
        setIsHoveringArchiveRow(false)
        setMoreMenuConversationId(null)
        clearContentMatches()
      } else {
        setEditingId(null)
        setFocusedConversationId(null)
        setScrollIntoViewConversationId(null)
        setIsHoveringArchiveRow(false)
        setMoreMenuConversationId(null)
      }
      setOpen(nextOpen)
    },
    [clearContentMatches, currentConversationId, pinnedSortedChatList],
  )

  const syncPopoverWidth = useCallback(() => {
    const content = contentRef.current
    const trigger = triggerRef.current
    if (!content || !trigger) return
    const sidebar = trigger.closest('.smtcmp-chat-container')
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
      return
    }

    const hasFocusedConversation =
      focusedConversationId !== null &&
      displayChatIndexById.has(focusedConversationId)
    if (hasFocusedConversation) {
      return
    }

    if (!normalizedQuery) {
      setFocusedConversationId(
        displayChatIndexById.has(currentConversationId)
          ? currentConversationId
          : (renderedChatList[0]?.id ?? null),
      )
      setScrollIntoViewConversationId(null)
      return
    }

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
        for (const chat of chatList) {
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
    chatList,
    chatManager,
    clearContentMatches,
    normalizedQuery,
    open,
    titleMatches,
  ])

  useEffect(() => {
    if (!open) return
    syncPopoverWidth()
    const sidebar = triggerRef.current?.closest('.smtcmp-chat-container')
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

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const target = e.target
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement
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

      <Popover.Portal container={getNodeBody(triggerRef.current)}>
        <Popover.Content
          ref={contentRef}
          className="smtcmp-popover smtcmp-chat-sidebar-popover smtcmp-chat-list-dropdown-content"
          sideOffset={8}
          onKeyDown={handleKeyDown}
        >
          <div className="smtcmp-chat-list-search">
            <div className="smtcmp-chat-list-search-field">
              <Search size={13} className="smtcmp-chat-list-search-icon" />
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
                className="smtcmp-chat-list-search-input"
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => e.stopPropagation()}
              />
            </div>
          </div>
          <ul className="smtcmp-model-select-list">
            {chatList.length === 0 ? (
              <li className="smtcmp-chat-list-dropdown-empty">
                {t('sidebar.chatList.empty', 'No conversations')}
              </li>
            ) : filteredChatList.length === 0 ? (
              <li className="smtcmp-chat-list-dropdown-empty">
                {t('common.noResults', 'No matches found')}
              </li>
            ) : (
              <>
                {renderedChatList.map((chat) => (
                  <ChatListItem
                    key={chat.id}
                    title={chat.title}
                    runSummary={runSummariesByConversationId.get(chat.id)}
                    isFocused={
                      focusedConversationId === chat.id && !isHoveringArchiveRow
                    }
                    shouldScrollIntoView={
                      scrollIntoViewConversationId === chat.id
                    }
                    isEditing={editingId === chat.id}
                    isUpdatingTitle={updatingTitleIds.has(chat.id)}
                    isPinned={Boolean(chat.isPinned)}
                    isRetrying={retryingConversationIds.has(chat.id)}
                    isMoreMenuOpen={moreMenuConversationId === chat.id}
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
                      void Promise.resolve(onDelete(chat.id)).catch((error) => {
                        console.error('Failed to delete conversation', error)
                      })
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
                  />
                ))}
                {shouldUseArchive && archivedChatList.length > 0 && (
                  <li
                    className="smtcmp-chat-list-dropdown-archive-row"
                    onMouseEnter={() => {
                      setIsHoveringArchiveRow(true)
                    }}
                    onMouseLeave={() => {
                      setIsHoveringArchiveRow(false)
                    }}
                  >
                    <button
                      type="button"
                      className="smtcmp-chat-list-dropdown-archive-toggle"
                      onClick={() => {
                        setShowArchived((prev) => !prev)
                      }}
                    >
                      <span className="smtcmp-chat-list-dropdown-archive-toggle-label">
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
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
