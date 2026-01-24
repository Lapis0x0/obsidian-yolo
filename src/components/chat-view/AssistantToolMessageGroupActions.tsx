import * as Tooltip from '@radix-ui/react-tooltip'
import { Check, CopyIcon } from 'lucide-react'
import { useMemo, useState } from 'react'

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
}: {
  messages: AssistantToolMessageGroup
}) {
  return (
    <div className="smtcmp-assistant-message-actions">
      <LLMResponseInfoButton messages={messages} />
      <CopyButton messages={messages} />
    </div>
  )
}
