import { useEffect, useMemo, useState } from 'react'

import { useApp } from '../../contexts/app-context'
import { useSettings } from '../../contexts/settings-context'
import { readEditReviewSnapshot } from '../../database/json/chat/editReviewSnapshotStore'
import {
  AssistantToolMessageGroup,
  ChatAssistantMessage,
  ChatToolMessage,
} from '../../types/chat'
import type { GroupEditSummary } from '../../utils/chat/editSummary'
import {
  collectGroupEditSummary,
  countChangedLines,
} from '../../utils/chat/editSummary'

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
  onOpenEditSummaryFile: (file: GroupEditSummary['files'][number]) => void
  onUndoEditSummary?: (summary: GroupEditSummary) => void
  undoingEditSummaryTarget?: string | null
  pendingCompactionAnchorMessageId?: string | null
  hidePendingAssistantPlaceholders?: boolean
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
  pendingCompactionAnchorMessageId,
  hidePendingAssistantPlaceholders = false,
}: AssistantToolMessageGroupItemProps) {
  const app = useApp()
  const { settings } = useSettings()
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
  const hasToolMessages = messages.some((message) => message.role === 'tool')
  const hasPendingAssistantShell = assistantMessages.some(
    (message) =>
      message.metadata?.generationState === 'streaming' &&
      !message.content &&
      !message.reasoning &&
      !message.annotations &&
      !message.toolCallRequests?.length,
  )
  const baseGroupEditSummary = useMemo(
    () => collectGroupEditSummary(messages),
    [messages],
  )
  const [groupEditSummary, setGroupEditSummary] =
    useState<GroupEditSummary | null>(baseGroupEditSummary)

  useEffect(() => {
    if (!baseGroupEditSummary) {
      setGroupEditSummary(null)
      return
    }

    let cancelled = false
    setGroupEditSummary(baseGroupEditSummary)

    void (async () => {
      const snapshotEntries = await Promise.all(
        baseGroupEditSummary.files.map(async (file) => {
          const [firstSnapshot, latestSnapshot] = await Promise.all([
            readEditReviewSnapshot({
              app,
              conversationId,
              roundId: file.firstRoundId,
              filePath: file.path,
              settings,
            }),
            readEditReviewSnapshot({
              app,
              conversationId,
              roundId: file.latestRoundId,
              filePath: file.path,
              settings,
            }),
          ])

          if (!firstSnapshot || !latestSnapshot) {
            return file
          }

          const counts = countChangedLines(
            firstSnapshot.beforeContent,
            latestSnapshot.afterContent,
          )

          return {
            ...file,
            addedLines: counts.addedLines,
            removedLines: counts.removedLines,
          }
        }),
      )

      if (cancelled) {
        return
      }

      setGroupEditSummary({
        ...baseGroupEditSummary,
        files: snapshotEntries,
        totalAddedLines: snapshotEntries.reduce(
          (sum, file) => sum + file.addedLines,
          0,
        ),
        totalRemovedLines: snapshotEntries.reduce(
          (sum, file) => sum + file.removedLines,
          0,
        ),
      })
    })()

    return () => {
      cancelled = true
    }
  }, [app, baseGroupEditSummary, conversationId, settings])

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
      {messages.map((message) => {
        const hasVisibleAssistantContent =
          message.role === 'assistant' && message.content.trim().length > 0
        const hasVisibleAssistantReasoning =
          message.role === 'assistant' &&
          (message.reasoning ?? '').trim().length > 0
        const hasVisibleAssistantAnnotations =
          message.role === 'assistant' && Boolean(message.annotations)
        const shouldHideAssistantPendingState =
          message.role === 'assistant' &&
          (hasToolMessages || hidePendingAssistantPlaceholders) &&
          !hasVisibleAssistantContent &&
          !hasVisibleAssistantReasoning &&
          !hasVisibleAssistantAnnotations

        if (shouldHideAssistantPendingState) {
          return null
        }

        return message.role === 'assistant' ? (
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
                  !message.annotations &&
                  !message.toolCallRequests?.length)) && (
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
              isCompactionPending={
                message.id === pendingCompactionAnchorMessageId
              }
              onMessageUpdate={onToolMessageUpdate}
            />
          </div>
        )
      })}
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
