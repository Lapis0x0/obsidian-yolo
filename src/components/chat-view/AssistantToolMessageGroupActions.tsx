import * as Tooltip from '@radix-ui/react-tooltip'
import { Check, CopyIcon, Import, Pencil, Trash2 } from 'lucide-react'
import { htmlToMarkdown, MarkdownView, Notice } from 'obsidian'
import { useMemo, useRef, useState } from 'react'

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
  onEdit,
  onDelete,
  isEditing = false,
  isDisabled = false,
}: {
  messages: AssistantToolMessageGroup
  onEdit?: () => void
  onDelete?: () => void
  isEditing?: boolean
  isDisabled?: boolean
}) {
  const { t } = useLanguage()
  const editLabel = t('common.edit', 'Edit')
  const deleteLabel = t('common.delete', 'Delete')
  const isEditDisabled = isDisabled || !onEdit || isEditing
  const isDeleteDisabled = isDisabled || !onDelete

  return (
    <div className="smtcmp-assistant-message-actions">
      <InsertButton messages={messages} />
      <CopyButton messages={messages} />
      <Tooltip.Provider delayDuration={0}>
        <Tooltip.Root>
          <Tooltip.Trigger asChild>
            <button
              type="button"
              onClick={isEditDisabled ? undefined : onEdit}
              className="clickable-icon"
              aria-label={editLabel}
              disabled={isEditDisabled}
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
      <Tooltip.Provider delayDuration={0}>
        <Tooltip.Root>
          <Tooltip.Trigger asChild>
            <button
              type="button"
              onClick={isDeleteDisabled ? undefined : onDelete}
              className="clickable-icon"
              aria-label={deleteLabel}
              disabled={isDeleteDisabled}
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
    </div>
  )
}
