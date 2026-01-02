import * as Popover from '@radix-ui/react-popover'
import { Pencil, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { ChatConversationMetadata } from '../../database/json/chat/types'

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
  const [open, setOpen] = useState(false)
  const [focusedIndex, setFocusedIndex] = useState<number>(0)
  const [editingId, setEditingId] = useState<string | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)

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
    }
  }, [open, chatList, currentConversationId])

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
      if (e.key === 'ArrowUp') {
        setFocusedIndex(Math.max(0, focusedIndex - 1))
      } else if (e.key === 'ArrowDown') {
        setFocusedIndex(Math.min(chatList.length - 1, focusedIndex + 1))
      } else if (e.key === 'Enter') {
        const conversationId = chatList[focusedIndex]?.id
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
    [chatList, focusedIndex, setFocusedIndex, onSelect],
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
          <ul className="smtcmp-model-select-list">
            {chatList.length === 0 ? (
              <li className="smtcmp-chat-list-dropdown-empty">
                No conversations
              </li>
            ) : (
              chatList.map((chat, index) => (
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
