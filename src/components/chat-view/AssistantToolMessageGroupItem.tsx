import {
  AssistantToolMessageGroup,
  ChatAssistantMessage,
  ChatMessage,
  ChatToolMessage,
} from '../../types/chat'

import AssistantMessageAnnotations from './AssistantMessageAnnotations'
import AssistantMessageContent from './AssistantMessageContent'
import AssistantMessageEditor from './AssistantMessageEditor'
import AssistantMessageReasoning from './AssistantMessageReasoning'
import AssistantToolMessageGroupActions from './AssistantToolMessageGroupActions'
import LLMResponseInlineInfo from './LLMResponseInlineInfo'
import ToolMessage from './ToolMessage'

export type AssistantToolMessageGroupItemProps = {
  messages: AssistantToolMessageGroup
  contextMessages: ChatMessage[]
  conversationId: string
  isApplying: boolean // TODO: isApplying should be a boolean for each assistant message
  onApply: (blockToApply: string, chatMessages: ChatMessage[]) => void
  onToolMessageUpdate: (message: ChatToolMessage) => void
  editingAssistantMessageId?: string | null
  onEditStart: (messageId: string) => void
  onEditCancel: () => void
  onEditSave: (messageId: string, content: string) => void
  onDeleteGroup: (messageIds: string[]) => void
}

export default function AssistantToolMessageGroupItem({
  messages,
  contextMessages,
  conversationId,
  isApplying,
  onApply,
  onToolMessageUpdate,
  editingAssistantMessageId,
  onEditStart,
  onEditCancel,
  onEditSave,
  onDeleteGroup,
}: AssistantToolMessageGroupItemProps) {
  const assistantMessages = messages.filter(
    (message): message is ChatAssistantMessage => message.role === 'assistant',
  )
  const editableAssistantMessage =
    [...assistantMessages]
      .reverse()
      .find((message) => message.content.length > 0) ??
    assistantMessages.at(-1) ??
    null
  const editableAssistantMessageId = editableAssistantMessage?.id ?? null
  const isEditingGroup = messages.some(
    (message) => message.id === editingAssistantMessageId,
  )
  const isStreaming = messages.some(
    (message) =>
      message.role === 'assistant' &&
      message.metadata?.generationState === 'streaming',
  )

  return (
    <div className="smtcmp-assistant-tool-message-group">
      {messages.map((message) =>
        message.role === 'assistant' ? (
          message.reasoning || message.annotations || message.content ? (
            <div key={message.id} className="smtcmp-chat-messages-assistant">
              {message.reasoning && (
                <AssistantMessageReasoning
                  reasoning={message.reasoning}
                  content={message.content}
                  generationState={message.metadata?.generationState}
                />
              )}
              {message.annotations && (
                <AssistantMessageAnnotations
                  annotations={message.annotations}
                />
              )}
              {message.id === editingAssistantMessageId ? (
                <AssistantMessageEditor
                  initialContent={message.content}
                  onCancel={onEditCancel}
                  onSave={(content) => {
                    onEditSave(message.id, content)
                  }}
                />
              ) : (
                <AssistantMessageContent
                  content={message.content}
                  contextMessages={contextMessages}
                  handleApply={onApply}
                  isApplying={isApplying}
                  generationState={message.metadata?.generationState}
                />
              )}
            </div>
          ) : null
        ) : (
          <div key={message.id}>
            <ToolMessage
              message={message}
              conversationId={conversationId}
              onMessageUpdate={onToolMessageUpdate}
            />
          </div>
        ),
      )}
      {messages.length > 0 && (
        <div className="smtcmp-assistant-message-footer">
          <LLMResponseInlineInfo messages={messages} />
          <AssistantToolMessageGroupActions
            messages={messages}
            onEdit={
              editableAssistantMessageId && !isStreaming
                ? () => {
                    onEditStart(editableAssistantMessageId)
                  }
                : undefined
            }
            onDelete={
              !isStreaming
                ? () => {
                    onDeleteGroup(messages.map((message) => message.id))
                  }
                : undefined
            }
            isEditing={isEditingGroup}
            isDisabled={isStreaming}
          />
        </div>
      )}
    </div>
  )
}
