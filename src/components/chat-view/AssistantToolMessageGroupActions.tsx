import * as Tooltip from '@radix-ui/react-tooltip'
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
import { useEffect, useMemo, useRef, useState } from 'react'

import { useApp } from '../../contexts/app-context'
import { useLanguage } from '../../contexts/language-context'
import {
  AssistantToolMessageGroup,
  ChatAssistantMessage,
} from '../../types/chat'

import { getToolMessageContent } from './ToolMessage'

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
    <Tooltip.Provider delayDuration={0}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <button
            type="button"
            onClick={
              copied
                ? undefined
                : () => {
                    handleCopy()
                  }
            }
            className="clickable-icon"
          >
            {copied ? <Check size={12} /> : <CopyIcon size={12} />}
          </button>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content className="smtcmp-tooltip-content">
            {t('chat.copyMessage', 'Copy message')}
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
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
    const markdownView = activeMarkdownView ?? recentMarkdownView

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
    <Tooltip.Provider delayDuration={0}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <button
            ref={buttonRef}
            type="button"
            onClick={handleInsert}
            className="clickable-icon"
          >
            <Import size={12} />
          </button>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content className="smtcmp-tooltip-content">
            {t('chat.insertAtCursor', 'Insert / Replace at cursor')}
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
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
        <Tooltip.Provider delayDuration={0}>
          <Tooltip.Root>
            <Tooltip.Trigger asChild>
              <button
                type="button"
                onClick={isRetryDisabled ? undefined : onRetry}
                className="clickable-icon"
                aria-label={retryLabel}
                disabled={isRetryDisabled}
              >
                <RotateCcw size={12} />
              </button>
            </Tooltip.Trigger>
            <Tooltip.Portal>
              <Tooltip.Content className="smtcmp-tooltip-content">
                {retryLabel}
              </Tooltip.Content>
            </Tooltip.Portal>
          </Tooltip.Root>
        </Tooltip.Provider>
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
                <Tooltip.Provider delayDuration={0}>
                  <Tooltip.Root>
                    <Tooltip.Trigger asChild>
                      <button
                        type="button"
                        onClick={
                          isBranchDisabled
                            ? undefined
                            : () => {
                                setIsMoreOpen(false)
                                onBranch?.()
                              }
                        }
                        className="clickable-icon smtcmp-assistant-message-action-btn"
                        aria-label={branchLabel}
                        disabled={isBranchDisabled}
                        tabIndex={isMoreOpen ? undefined : -1}
                      >
                        <GitFork size={12} />
                      </button>
                    </Tooltip.Trigger>
                    <Tooltip.Portal>
                      <Tooltip.Content className="smtcmp-tooltip-content">
                        {branchLabel}
                      </Tooltip.Content>
                    </Tooltip.Portal>
                  </Tooltip.Root>
                </Tooltip.Provider>
              )}
              {showEdit && (
                <Tooltip.Provider delayDuration={0}>
                  <Tooltip.Root>
                    <Tooltip.Trigger asChild>
                      <button
                        type="button"
                        onClick={
                          isEditDisabled
                            ? undefined
                            : () => {
                                setIsMoreOpen(false)
                                onEdit?.()
                              }
                        }
                        className="clickable-icon smtcmp-assistant-message-action-btn"
                        aria-label={editLabel}
                        disabled={isEditDisabled}
                        tabIndex={isMoreOpen ? undefined : -1}
                      >
                        <Pencil size={12} />
                      </button>
                    </Tooltip.Trigger>
                    <Tooltip.Portal>
                      <Tooltip.Content className="smtcmp-tooltip-content">
                        {editLabel}
                      </Tooltip.Content>
                    </Tooltip.Portal>
                  </Tooltip.Root>
                </Tooltip.Provider>
              )}
              {showDelete && (
                <Tooltip.Provider delayDuration={0}>
                  <Tooltip.Root>
                    <Tooltip.Trigger asChild>
                      <button
                        type="button"
                        onClick={
                          isDeleteDisabled
                            ? undefined
                            : () => {
                                setIsMoreOpen(false)
                                onDelete?.()
                              }
                        }
                        className="clickable-icon smtcmp-assistant-message-action-btn"
                        aria-label={deleteLabel}
                        disabled={isDeleteDisabled}
                        tabIndex={isMoreOpen ? undefined : -1}
                      >
                        <Trash2 size={12} />
                      </button>
                    </Tooltip.Trigger>
                    <Tooltip.Portal>
                      <Tooltip.Content className="smtcmp-tooltip-content">
                        {deleteLabel}
                      </Tooltip.Content>
                    </Tooltip.Portal>
                  </Tooltip.Root>
                </Tooltip.Provider>
              )}
            </div>
          </div>
          <Tooltip.Provider delayDuration={0}>
            <Tooltip.Root>
              <Tooltip.Trigger asChild>
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
                  aria-expanded={isMoreOpen ? 'true' : 'false'}
                  disabled={isDisabled || isEditing}
                >
                  <Ellipsis size={12} />
                </button>
              </Tooltip.Trigger>
              <Tooltip.Portal>
                <Tooltip.Content className="smtcmp-tooltip-content">
                  {t('sidebar.chatList.moreActions', 'More actions')}
                </Tooltip.Content>
              </Tooltip.Portal>
            </Tooltip.Root>
          </Tooltip.Provider>
        </div>
      ) : null}
    </div>
  )
}
