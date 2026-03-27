import { useMemo } from 'react'

import {
  AssistantToolMessageGroup,
  ChatAssistantMessage,
  ChatToolMessage,
} from '../../types/chat'
import type { GroupEditSummary } from '../../utils/chat/editSummary'
import { collectGroupEditSummary } from '../../utils/chat/editSummary'

import AssistantEditSummary from './AssistantEditSummary'
import AssistantMessageAnnotations from './AssistantMessageAnnotations'
import AssistantMessageContent from './AssistantMessageContent'
import AssistantMessageEditor from './AssistantMessageEditor'
import AssistantMessageReasoning from './AssistantMessageReasoning'
import AssistantToolMessageGroupActions from './AssistantToolMessageGroupActions'
import LLMResponseInlineInfo from './LLMResponseInlineInfo'
import ToolMessage from './ToolMessage'

export type AssistantToolMessageGroupItemProps = {
  messages: AssistantToolMessageGroup
  conversationId: string
  suppressFooter?: boolean
  showInlineInfo?: boolean
  showInsertAction?: boolean
  showCopyAction?: boolean
  showBranchAction?: boolean
  showEditAction?: boolean
  showDeleteAction?: boolean
  showQuoteAction?: boolean
  isApplying: boolean // TODO: isApplying should be a boolean for each assistant message
  activeApplyRequestKey: string | null
  onApply: (
    blockToApply: string,
    applyRequestKey: string,
    targetFilePath?: string,
  ) => void
  onToolMessageUpdate: (message: ChatToolMessage) => void
  editingAssistantMessageId?: string | null
  onEditStart: (messageId: string) => void
  onEditCancel: () => void
  onEditSave: (messageId: string, content: string) => void
  onDeleteGroup: (messageIds: string[]) => void
  onBranchGroup: (messageIds: string[]) => void
  onQuoteAssistantSelection: (payload: {
    messageId: string
    conversationId: string
    content: string
  }) => void
  onOpenEditSummaryFile: (path: string) => void
  onUndoEditSummary?: (summary: GroupEditSummary) => void
  undoingEditSummaryTarget?: string | null
}

export default function AssistantToolMessageGroupItem({
  messages,
  conversationId,
  suppressFooter = false,
  showInlineInfo = true,
  showInsertAction = true,
  showCopyAction = true,
  showBranchAction = true,
  showEditAction = true,
  showDeleteAction = true,
  showQuoteAction = true,
  isApplying,
  activeApplyRequestKey,
  onApply,
  onToolMessageUpdate,
  editingAssistantMessageId,
  onEditStart,
  onEditCancel,
  onEditSave,
  onDeleteGroup,
  onBranchGroup,
  onQuoteAssistantSelection,
  onOpenEditSummaryFile,
  onUndoEditSummary,
  undoingEditSummaryTarget,
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
  const hasPendingAssistantShell = assistantMessages.some(
    (message) =>
      message.metadata?.generationState === 'streaming' &&
      !message.content &&
      !message.reasoning &&
      !message.annotations &&
      !message.toolCallRequests?.length,
  )
  const groupEditSummary = useMemo(
    () => collectGroupEditSummary(messages),
    [messages],
  )
  const groupEditSummaryKey = useMemo(
    () =>
      groupEditSummary
        ? groupEditSummary.entries.map((entry) => entry.toolCallId).join(':')
        : null,
    [groupEditSummary],
  )
  const effectiveGroupEditSummaryKey = groupEditSummaryKey ?? ''

  return (
    <div className="smtcmp-assistant-tool-message-group">
      {messages.map((message) =>
        message.role === 'assistant' ? (
          message.reasoning ||
          message.annotations ||
          message.content ||
          (message.metadata?.generationState === 'streaming' &&
            !message.content &&
            !message.reasoning) ||
          (message.metadata?.generationState === 'streaming' &&
            Boolean(message.toolCallRequests?.length)) ? (
            <div key={message.id} className="smtcmp-chat-messages-assistant">
              {(message.reasoning ||
                (message.metadata?.generationState === 'streaming' &&
                  !message.content &&
                  !message.annotations)) && (
                <AssistantMessageReasoning
                  reasoning={message.reasoning ?? ''}
                  hasAnswerContent={message.content.trim().length > 0}
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
                  messageId={message.id}
                  conversationId={conversationId}
                  content={message.content}
                  handleApply={onApply}
                  isApplying={isApplying}
                  activeApplyRequestKey={activeApplyRequestKey}
                  generationState={message.metadata?.generationState}
                  toolCallRequests={message.toolCallRequests}
                  onQuote={onQuoteAssistantSelection}
                  enableSelectionQuote={showQuoteAction}
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
      {groupEditSummary &&
        !suppressFooter &&
        !hasPendingAssistantShell &&
        !isStreaming && (
          <AssistantEditSummary
            summary={groupEditSummary}
            undoingTargetKey={
              undoingEditSummaryTarget?.startsWith(
                `${effectiveGroupEditSummaryKey}::`,
              )
                ? undoingEditSummaryTarget.slice(
                    effectiveGroupEditSummaryKey.length + 2,
                  )
                : null
            }
            onUndo={() => onUndoEditSummary?.(groupEditSummary)}
            onOpenFile={onOpenEditSummaryFile}
            onUndoFile={(path) =>
              onUndoEditSummary?.({
                ...groupEditSummary,
                files: groupEditSummary.files.filter(
                  (file) => file.path === path,
                ),
              })
            }
          />
        )}
      {messages.length > 0 &&
        !hasPendingAssistantShell &&
        !isStreaming &&
        !suppressFooter && (
          <div className="smtcmp-assistant-message-footer">
            {showInlineInfo && <LLMResponseInlineInfo messages={messages} />}
            <AssistantToolMessageGroupActions
              messages={messages}
              showInsert={showInsertAction}
              showCopy={showCopyAction}
              showBranch={showBranchAction}
              showEdit={showEditAction}
              showDelete={showDeleteAction}
              onBranch={
                !isStreaming
                  ? () => {
                      onBranchGroup(messages.map((message) => message.id))
                    }
                  : undefined
              }
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
