import * as Popover from '@radix-ui/react-popover'
import { Search, Pencil, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useLanguage } from '../../contexts/language-context'
import { ChatConversationMetadata } from '../../database/json/chat/types'
import { ContentPart } from '../../types/llm/request'
import { SerializedChatMessage } from '../../types/chat'
import { editorStateToPlainText } from './chat-input/utils/editor-state-to-plain-text'
import { useChatManager } from '../../hooks/useJsonManagers'

function TitleInput({
  title,
  onSubmit,
}: {
  title: string
  onSubmit: (title: string) => void
}) {
  const [value, setValue] = useState(title)
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
      className="smtcmp-chat-list-dropdown-item-title-input"
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') {
          onSubmit(value)
        }
      }}
      autoFocus
      maxLength={100}
    />
  )
}

function ChatListItem({
  title,
  isFocused,
  isEditing,
  onMouseEnter,
  onSelect,
  onDelete,
  onStartEdit,
  onFinishEdit,
}: {
  title: string
  isFocused: boolean
  isEditing: boolean
  onMouseEnter: () => void
  onSelect: () => void
  onDelete: () => void
  onStartEdit: () => void
  onFinishEdit: (title: string) => void
}) {
  const itemRef = useRef<HTMLLIElement>(null)

  useEffect(() => {
    if (isFocused && itemRef.current) {
      itemRef.current.scrollIntoView({
        block: 'nearest',
      })
    }
  }, [isFocused])

  return (
    <li
      ref={itemRef}
      onClick={() => {
        onSelect()
      }}
      onMouseEnter={onMouseEnter}
      className={`smtcmp-chat-list-dropdown-item${isFocused ? ' selected' : ''}`}
      data-highlighted={isFocused ? 'true' : undefined}
    >
      {isEditing ? (
        <TitleInput title={title} onSubmit={onFinishEdit} />
      ) : (
        <div className="smtcmp-chat-list-dropdown-item-title">{title}</div>
      )}
      <div className="smtcmp-chat-list-dropdown-item-actions">
        <button
          onClick={(e) => {
            e.stopPropagation()
            onStartEdit()
          }}
          className="clickable-icon smtcmp-chat-list-dropdown-item-icon"
        >
          <Pencil />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
          className="clickable-icon smtcmp-chat-list-dropdown-item-icon"
        >
          <Trash2 />
        </button>
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
  onSelect,
  onDelete,
  onUpdateTitle,
  children,
}: {
  chatList: ChatConversationMetadata[]
  currentConversationId: string
  onSelect: (conversationId: string) => void | Promise<void>
  onDelete: (conversationId: string) => void | Promise<void>
  onUpdateTitle: (
    conversationId: string,
    newTitle: string,
  ) => void | Promise<void>
  children: React.ReactNode
}) {
  const { t } = useLanguage()
  const chatManager = useChatManager()
  const [open, setOpen] = useState(false)
  const [focusedIndex, setFocusedIndex] = useState<number>(0)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [contentMatches, setContentMatches] = useState<Set<string>>(new Set())
  const triggerRef = useRef<HTMLButtonElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const searchCacheRef = useRef<Map<string, { updatedAt: number; text: string }>>(
    new Map(),
  )
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

  const filteredChatList = useMemo(() => {
    if (!normalizedQuery) return chatList
    return chatList.filter(
      (chat) => titleMatches.has(chat.id) || contentMatches.has(chat.id),
    )
  }, [chatList, contentMatches, normalizedQuery, titleMatches])

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
    if (open) {
      const currentIndex = chatList.findIndex(
        (chat) => chat.id === currentConversationId,
      )
      setFocusedIndex(currentIndex === -1 ? 0 : currentIndex)
      setEditingId(null)
      setSearchQuery('')
      setContentMatches(new Set())
    }
  }, [open, chatList, currentConversationId])

  useEffect(() => {
    if (!open) return
    if (!normalizedQuery) {
      const currentIndex = chatList.findIndex(
        (chat) => chat.id === currentConversationId,
      )
      setFocusedIndex(currentIndex === -1 ? 0 : currentIndex)
      return
    }
    setFocusedIndex(0)
  }, [chatList, currentConversationId, normalizedQuery, open])

  useEffect(() => {
    if (!open) return
    const activeList = normalizedQuery ? filteredChatList : chatList
    if (activeList.length === 0) {
      setFocusedIndex(0)
      return
    }
    if (focusedIndex >= activeList.length) {
      setFocusedIndex(activeList.length - 1)
    }
  }, [chatList, filteredChatList, focusedIndex, normalizedQuery, open])

  useEffect(() => {
    if (!open) return
    if (!normalizedQuery) {
      setContentMatches(new Set())
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
  }, [chatList, chatManager, normalizedQuery, open, titleMatches])

  useEffect(() => {
    if (!open) return
    syncPopoverWidth()
    const sidebar = triggerRef.current?.closest('.smtcmp-chat-container')
    if (!sidebar) return
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
    window.addEventListener('resize', handleResize)
    return () => {
      window.removeEventListener('resize', handleResize)
      resizeObserver?.disconnect()
    }
  }, [open, syncPopoverWidth])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const activeList = normalizedQuery ? filteredChatList : chatList
      if (e.key === 'ArrowUp') {
        setFocusedIndex(Math.max(0, focusedIndex - 1))
      } else if (e.key === 'ArrowDown') {
        setFocusedIndex(Math.min(activeList.length - 1, focusedIndex + 1))
      } else if (e.key === 'Enter') {
        const conversationId = activeList[focusedIndex]?.id
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
    [
      chatList,
      filteredChatList,
      focusedIndex,
      normalizedQuery,
      onSelect,
    ],
  )

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          ref={triggerRef}
          className="clickable-icon"
          aria-label="Chat History"
        >
          {children}
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          ref={contentRef}
          className="smtcmp-popover smtcmp-chat-sidebar-popover smtcmp-chat-list-dropdown-content"
          sideOffset={8}
          onKeyDown={handleKeyDown}
        >
          <div className="smtcmp-chat-list-search">
            <div className="smtcmp-chat-list-search-field">
              <Search size={16} className="smtcmp-chat-list-search-icon" />
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
              filteredChatList.map((chat, index) => (
                <ChatListItem
                  key={chat.id}
                  title={chat.title}
                  isFocused={focusedIndex === index}
                  isEditing={editingId === chat.id}
                  onMouseEnter={() => {
                    setFocusedIndex(index)
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
                    void Promise.resolve(onDelete(chat.id)).catch((error) => {
                      console.error('Failed to delete conversation', error)
                    })
                  }}
                  onStartEdit={() => {
                    setEditingId(chat.id)
                  }}
                  onFinishEdit={(title) => {
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
                  }}
                />
              ))
            )}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
