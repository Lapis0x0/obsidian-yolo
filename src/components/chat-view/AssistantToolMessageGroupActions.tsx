import {
  Check,
  CopyIcon,
  Ellipsis,
  GitFork,
  Import,
  Pencil,
  RotateCcw,
  Trash2,
} from 'lucide-react'
import { MarkdownView, Notice, htmlToMarkdown } from 'obsidian'
import type { ReactNode, Ref } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { useApp } from '../../contexts/app-context'
import { useLanguage } from '../../contexts/language-context'
import {
  AssistantToolMessageGroup,
  ChatAssistantMessage,
} from '../../types/chat'

import { getToolMessageContent } from './ToolMessage'

function ActionIconButton({
  label,
  className = 'clickable-icon',
  disabled = false,
  tabIndex,
  buttonRef,
  onClick,
  children,
}: {
  label: string
  className?: string
  disabled?: boolean
  tabIndex?: number
  buttonRef?: Ref<HTMLButtonElement>
  onClick?: () => void
  children: ReactNode
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={disabled ? undefined : onClick}
      className={className}
      aria-label={label}
      title={label}
      disabled={disabled}
      tabIndex={tabIndex}
    >
      {children}
    </button>
  )
}

function CopyButton({ messages }: { messages: AssistantToolMessageGroup }) {
  const [copied, setCopied] = useState(false)
  const { t } = useLanguage()

  const content = useMemo(() => {
    return messages
      .map((message) => {
        switch (message.role) {
          case 'assistant':
            return message.content === '' ? null : message.content
          case 'tool':
            return getToolMessageContent(message, t)
          default:
            return null
        }
      })
      .filter(Boolean)
      .join('\n\n')
  }, [messages, t])

  const handleCopy = () => {
    void navigator.clipboard
      .writeText(content)
      .then(() => {
        setCopied(true)
        setTimeout(() => {
          setCopied(false)
        }, 1500)
      })
      .catch((error) => {
        console.error('Failed to copy assistant/tool messages', error)
      })
  }

  return (
    <ActionIconButton
      label={t('chat.copyMessage', 'Copy message')}
      onClick={
        copied
          ? undefined
          : () => {
              handleCopy()
            }
      }
    >
      {copied ? <Check size={12} /> : <CopyIcon size={12} />}
    </ActionIconButton>
  )
}

function InsertButton({ messages }: { messages: AssistantToolMessageGroup }) {
  const app = useApp()
  const { t } = useLanguage()
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const content = useMemo(() => {
    return messages
      .filter(
        (message): message is ChatAssistantMessage =>
          message.role === 'assistant',
      )
      .map((message) => message.content.trim())
      .filter((value) => value.length > 0)
      .join('\n\n')
  }, [messages])

  const handleInsert = () => {
    const selectedText = (() => {
      const selection = window.getSelection()
      if (!selection || selection.rangeCount === 0) {
        return null
      }

      const rawText = selection.toString().trim()
      if (!rawText) {
        return null
      }

      const groupElement = buttonRef.current?.closest(
        '.smtcmp-assistant-tool-message-group',
      )
      if (!groupElement) {
        return null
      }

      const anchorNode = selection.anchorNode
      const focusNode = selection.focusNode
      if (!anchorNode || !focusNode) {
        return null
      }

      const isSelectionInCurrentGroup =
        groupElement.contains(anchorNode) && groupElement.contains(focusNode)

      if (!isSelectionInCurrentGroup) {
        return null
      }

      const range = selection.getRangeAt(0)
      const fragment = range.cloneContents()
      const container = document.createElement('div')
      container.append(fragment)

      const selectedMarkdown = htmlToMarkdown(container.innerHTML).trim()
      if (selectedMarkdown.length > 0) {
        return selectedMarkdown
      }

      return rawText
    })()

    const contentToInsert = selectedText ?? content

    if (!contentToInsert) {
      new Notice(t('chat.noAssistantContent', 'No assistant content to insert'))
      return
    }

    const activeMarkdownView = app.workspace.getActiveViewOfType(MarkdownView)
    const recentLeaf = app.workspace.getMostRecentLeaf()
    const recentMarkdownView =
      recentLeaf?.view instanceof MarkdownView ? recentLeaf.view : null
    const fallbackMarkdownView = (() => {
      if (activeMarkdownView || recentMarkdownView) {
        return null
      }
      const markdownLeaves = app.workspace.getLeavesOfType('markdown')
      const visibleLeaf =
        markdownLeaves.find((leaf) => {
          const el = (leaf.view as { containerEl?: HTMLElement }).containerEl
          return el ? el.isShown() : true
        }) ?? markdownLeaves[0]
      return visibleLeaf?.view instanceof MarkdownView
        ? visibleLeaf.view
        : null
    })()
    const markdownView =
      activeMarkdownView ?? recentMarkdownView ?? fallbackMarkdownView

    if (!markdownView) {
      new Notice(t('chat.insertUnavailable', 'No active markdown editor found'))
      return
    }

    const editor = markdownView.editor
    const selection = editor.getSelection()
    if (selection.length > 0) {
      editor.replaceSelection(contentToInsert)
    } else {
      const cursor = editor.getCursor()
      editor.replaceRange(contentToInsert, cursor, cursor)
    }
    editor.focus()
    new Notice(t('chat.insertSuccess', 'Message inserted into the active note'))
  }

  return (
    <ActionIconButton
      label={t('chat.insertAtCursor', 'Insert / Replace at cursor')}
      buttonRef={buttonRef}
      onClick={handleInsert}
    >
      <Import size={12} />
    </ActionIconButton>
  )
}

export default function AssistantToolMessageGroupActions({
  messages,
  showRetry = true,
  showInsert = true,
  showCopy = true,
  showBranch = true,
  showEdit = true,
  showDelete = true,
  onRetry,
  onBranch,
  onEdit,
  onDelete,
  isEditing = false,
  isDisabled = false,
}: {
  messages: AssistantToolMessageGroup
  showRetry?: boolean
  showInsert?: boolean
  showCopy?: boolean
  showBranch?: boolean
  showEdit?: boolean
  showDelete?: boolean
  onRetry?: () => void
  onBranch?: () => void
  onEdit?: () => void
  onDelete?: () => void
  isEditing?: boolean
  isDisabled?: boolean
}) {
  const { t } = useLanguage()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [isMoreOpen, setIsMoreOpen] = useState(false)
  const retryLabel = t('chat.regenerate', 'Regenerate')
  const branchLabel = t('chat.createBranchFromHere', 'Create branch from here')
  const editLabel = t('common.edit', 'Edit')
  const deleteLabel = t('common.delete', 'Delete')
  const isRetryDisabled = isDisabled || !onRetry || isEditing
  const isBranchDisabled = isDisabled || !onBranch
  const isEditDisabled = isDisabled || !onEdit || isEditing
  const isDeleteDisabled = isDisabled || !onDelete
  const hasMoreActions = showBranch || showEdit || showDelete

  useEffect(() => {
    if (!isMoreOpen) {
      return
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (
        containerRef.current &&
        event.target instanceof Node &&
        !containerRef.current.contains(event.target)
      ) {
        setIsMoreOpen(false)
      }
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsMoreOpen(false)
      }
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isMoreOpen])

  useEffect(() => {
    if (!hasMoreActions || isDisabled || isEditing) {
      setIsMoreOpen(false)
    }
  }, [hasMoreActions, isDisabled, isEditing])

  return (
    <div
      ref={containerRef}
      className={`smtcmp-assistant-message-actions${
        isMoreOpen ? ' is-more-open' : ''
      }`}
    >
      {showRetry && (
        <ActionIconButton
          label={retryLabel}
          disabled={isRetryDisabled}
          onClick={onRetry}
        >
          <RotateCcw size={12} />
        </ActionIconButton>
      )}
      {showInsert && <InsertButton messages={messages} />}
      {showCopy && <CopyButton messages={messages} />}
      {hasMoreActions ? (
        <div className="smtcmp-assistant-message-more-group">
          <div
            className={`smtcmp-assistant-message-inline-actions${
              isMoreOpen ? ' is-open' : ''
            }`}
            aria-hidden={isMoreOpen ? undefined : 'true'}
          >
            <div className="smtcmp-assistant-message-inline-actions-inner">
              {showBranch && (
                <ActionIconButton
                  label={branchLabel}
                  className="clickable-icon smtcmp-assistant-message-action-btn"
                  disabled={isBranchDisabled}
                  tabIndex={isMoreOpen ? undefined : -1}
                  onClick={() => {
                    setIsMoreOpen(false)
                    onBranch?.()
                  }}
                >
                  <GitFork size={12} />
                </ActionIconButton>
              )}
              {showEdit && (
                <ActionIconButton
                  label={editLabel}
                  className="clickable-icon smtcmp-assistant-message-action-btn"
                  disabled={isEditDisabled}
                  tabIndex={isMoreOpen ? undefined : -1}
                  onClick={() => {
                    setIsMoreOpen(false)
                    onEdit?.()
                  }}
                >
                  <Pencil size={12} />
                </ActionIconButton>
              )}
              {showDelete && (
                <ActionIconButton
                  label={deleteLabel}
                  className="clickable-icon smtcmp-assistant-message-action-btn"
                  disabled={isDeleteDisabled}
                  tabIndex={isMoreOpen ? undefined : -1}
                  onClick={() => {
                    setIsMoreOpen(false)
                    onDelete?.()
                  }}
                >
                  <Trash2 size={12} />
                </ActionIconButton>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              if (isDisabled || isEditing) {
                return
              }
              setIsMoreOpen((current) => !current)
            }}
            className={`clickable-icon smtcmp-assistant-message-action-btn smtcmp-assistant-message-more-button${
              isMoreOpen ? ' is-open' : ''
            }`}
            aria-label={t('sidebar.chatList.moreActions', 'More actions')}
            title={t('sidebar.chatList.moreActions', 'More actions')}
            aria-expanded={isMoreOpen ? 'true' : 'false'}
            disabled={isDisabled || isEditing}
          >
            <Ellipsis size={12} />
          </button>
        </div>
      ) : null}
    </div>
  )
}
