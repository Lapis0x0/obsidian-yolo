import * as Tooltip from '@radix-ui/react-tooltip'
import { Check, CopyIcon, Pencil, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'

import { useLanguage } from '../../contexts/language-context'
import { AssistantToolMessageGroup } from '../../types/chat'

import LLMResponseInfoPopover from './LLMResponseInfoPopover'
import { getToolMessageContent } from './ToolMessage'
import { useLLMResponseInfo } from './useLLMResponseInfo'

function CopyButton({ messages }: { messages: AssistantToolMessageGroup }) {
  const [copied, setCopied] = useState(false)

  const content = useMemo(() => {
    return messages
      .map((message) => {
        switch (message.role) {
          case 'assistant':
            return message.content === '' ? null : message.content
          case 'tool':
            return getToolMessageContent(message)
        }
      })
      .filter(Boolean)
      .join('\n\n')
  }, [messages])

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
            Copy message
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  )
}

function LLMResponseInfoButton({
  messages,
}: {
  messages: AssistantToolMessageGroup
}) {
  const { usage, model, cost } = useLLMResponseInfo(messages)

  return (
    <Tooltip.Provider delayDuration={0}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <div>
            <LLMResponseInfoPopover
              usage={usage}
              estimatedPrice={cost}
              model={model?.model ?? null}
            />
          </div>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content className="smtcmp-tooltip-content">
            View details
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
      <LLMResponseInfoButton messages={messages} />
      <CopyButton messages={messages} />
      <Tooltip.Provider delayDuration={0}>
        <Tooltip.Root>
          <Tooltip.Trigger asChild>
            <button
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
