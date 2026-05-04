import { Ban, Check, CircleAlert, Loader2 } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import { useApp } from '../../contexts/app-context'
import { useLanguage } from '../../contexts/language-context'
import { useSettings } from '../../contexts/settings-context'
import type { AgentConversationRunSummary } from '../../core/agent/service'
import { readEditReviewSnapshot } from '../../database/json/chat/editReviewSnapshotStore'
import {
  AssistantToolMessageGroup,
  ChatAssistantMessage,
  ChatToolMessage,
} from '../../types/chat'
import { shouldRenderAssistantToolPreview } from '../../utils/chat/assistantToolPreview'
import type { GroupEditSummary } from '../../utils/chat/editSummary'
import {
  collectGroupEditSummary,
  countFileChangeStats,
} from '../../utils/chat/editSummary'

import AssistantEditSummary from './AssistantEditSummary'
import AssistantErrorCard from './AssistantErrorCard'
import AssistantMessageAnnotations from './AssistantMessageAnnotations'
import AssistantMessageContent from './AssistantMessageContent'
import AssistantMessageEditor from './AssistantMessageEditor'
import AssistantMessageReasoning from './AssistantMessageReasoning'
import AssistantToolMessageGroupActions from './AssistantToolMessageGroupActions'
import LLMResponseInlineInfo from './LLMResponseInlineInfo'
import { buildSynthToolMessageFromResult } from './tool-cards/externalAgentResultAdapter'
import ToolMessage from './ToolMessage'

const getBranchStateLabel = (
  state: 'streaming' | 'waiting-approval' | 'completed' | 'aborted' | 'error',
  t: (keyPath: string, fallback?: string) => string,
) => {
  if (state === 'streaming') {
    return t('chat.toolCall.status.running', '生成中')
  }
  if (state === 'waiting-approval') {
    return t('common.agentStatusWaitingApproval', '待审批')
  }
  if (state === 'error') {
    return t('chat.toolCall.status.failed', '失败')
  }
  if (state === 'aborted') {
    return t('chat.toolCall.status.aborted', '已中止')
  }
  return t('chat.toolCall.status.completed', '已完成')
}

const BranchStateIcon = ({
  state,
}: {
  state: 'streaming' | 'waiting-approval' | 'completed' | 'aborted' | 'error'
}) => {
  if (state === 'streaming') {
    return (
      <Loader2
        size={12}
        className="smtcmp-multi-model-tab__status-icon is-spinning"
      />
    )
  }
  if (state === 'waiting-approval') {
    return (
      <CircleAlert size={12} className="smtcmp-multi-model-tab__status-icon" />
    )
  }
  if (state === 'error') {
    return (
      <CircleAlert size={12} className="smtcmp-multi-model-tab__status-icon" />
    )
  }
  if (state === 'aborted') {
    return <Ban size={12} className="smtcmp-multi-model-tab__status-icon" />
  }
  return <Check size={12} className="smtcmp-multi-model-tab__status-icon" />
}

const getBranchTabState = (
  messages: AssistantToolMessageGroup,
): 'streaming' | 'waiting-approval' | 'completed' | 'aborted' | 'error' => {
  const latestMessage = messages.at(-1)
  const latestMetadata =
    latestMessage?.role !== 'external_agent_result'
      ? latestMessage?.metadata
      : undefined

  if (latestMetadata?.branchWaitingApproval) {
    return 'waiting-approval'
  }

  switch (latestMetadata?.branchRunStatus) {
    case 'running':
      return 'streaming'
    case 'completed':
      return 'completed'
    case 'aborted':
      return 'aborted'
    case 'error':
      return 'error'
  }

  const assistantMessage = messages.find(
    (message): message is ChatAssistantMessage => message.role === 'assistant',
  )
  return assistantMessage?.metadata?.generationState ?? 'completed'
}

const isBranchCompleted = (messages: AssistantToolMessageGroup): boolean => {
  return getBranchTabState(messages) === 'completed'
}

const getMessageGroupRunState = ({
  messages,
  conversationRunSummary,
}: {
  messages: AssistantToolMessageGroup
  conversationRunSummary?: AgentConversationRunSummary
}): 'streaming' | 'waiting-approval' | 'completed' | 'aborted' | 'error' => {
  const latestMessage = messages.at(-1)
  const latestMetadata =
    latestMessage?.role !== 'external_agent_result'
      ? latestMessage?.metadata
      : undefined

  if (latestMetadata?.branchWaitingApproval) {
    return 'waiting-approval'
  }

  switch (latestMetadata?.branchRunStatus) {
    case 'running':
      return 'streaming'
    case 'completed':
      return 'completed'
    case 'aborted':
      return 'aborted'
    case 'error':
      return 'error'
  }

  if (conversationRunSummary?.isWaitingApproval) {
    return 'waiting-approval'
  }

  switch (conversationRunSummary?.status) {
    case 'running':
      return 'streaming'
    case 'completed':
      return 'completed'
    case 'aborted':
      return 'aborted'
    case 'error':
      return 'error'
  }

  const assistantMessage = messages.find(
    (message): message is ChatAssistantMessage => message.role === 'assistant',
  )
  return assistantMessage?.metadata?.generationState ?? 'completed'
}

export type AssistantToolMessageGroupItemProps = {
  messages: AssistantToolMessageGroup
  conversationId: string
  conversationRunSummary?: AgentConversationRunSummary
  activeBranchKey?: string | null
  suppressFooter?: boolean
  showInlineInfo?: boolean
  showRetryAction?: boolean
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
  onRecoverToolCall?: (payload: {
    conversationId: string
    toolMessageId: string
    request: ChatToolMessage['toolCalls'][number]['request']
    allowForConversation?: boolean
  }) => Promise<boolean>
  editingAssistantMessageId?: string | null
  onEditStart: (messageId: string) => void
  onEditCancel: () => void
  onEditSave: (messageId: string, content: string) => void
  onDeleteGroup: (messageIds: string[]) => void
  onRetryGroup: (messageIds: string[]) => void
  onBranchGroup: (messageIds: string[]) => void
  onActiveBranchChange?: (branchKey: string | null) => void
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
  showRunningToolFooter?: boolean
  showPendingAssistantSpacer?: boolean
}

export default function AssistantToolMessageGroupItem({
  messages,
  conversationId,
  conversationRunSummary,
  activeBranchKey: controlledActiveBranchKey,
  suppressFooter = false,
  showInlineInfo = true,
  showRetryAction = false,
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
  onRecoverToolCall,
  editingAssistantMessageId,
  onEditStart,
  onEditCancel,
  onEditSave,
  onDeleteGroup,
  onRetryGroup,
  onBranchGroup,
  onActiveBranchChange,
  onQuoteAssistantSelection,
  onOpenEditSummaryFile,
  onUndoEditSummary,
  undoingEditSummaryTarget,
  pendingCompactionAnchorMessageId,
  hidePendingAssistantPlaceholders = false,
  showRunningToolFooter = true,
  showPendingAssistantSpacer = true,
}: AssistantToolMessageGroupItemProps) {
  const app = useApp()
  const { t } = useLanguage()
  const { settings } = useSettings()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const pendingScrollRestoreRef = useRef<{
    scrollContainer: HTMLElement
    scrollTop: number
  } | null>(null)
  const branchGroups = useMemo(() => {
    const groups = new Map<
      string,
      {
        key: string
        label: string
        conversationId: string
        messages: AssistantToolMessageGroup
      }
    >()
    messages.forEach((message) => {
      const branchId = message.metadata?.branchId
      if (!branchId) {
        return
      }
      const branchLabel =
        message.role !== 'external_agent_result'
          ? message.metadata?.branchLabel
          : undefined
      const branchConversationId = message.metadata?.branchConversationId
      const existing = groups.get(branchId)
      if (existing) {
        existing.messages.push(message)
        return
      }
      groups.set(branchId, {
        key: branchId,
        label: branchLabel ?? branchId,
        conversationId: branchConversationId ?? conversationId,
        messages: [message],
      })
    })
    return Array.from(groups.values())
  }, [conversationId, messages])
  const hasMultipleBranches = branchGroups.length > 1
  const [uncontrolledActiveBranchKey, setUncontrolledActiveBranchKey] =
    useState<string | null>(null)
  const activeBranchKey =
    controlledActiveBranchKey ?? uncontrolledActiveBranchKey
  const resolvedActiveBranchKey =
    activeBranchKey ?? branchGroups[0]?.key ?? null

  const handleBranchSwitch = useCallback(
    (branchKey: string) => {
      if (branchKey === resolvedActiveBranchKey) {
        return
      }

      const scrollContainer = containerRef.current?.closest<HTMLElement>(
        '.smtcmp-chat-messages',
      )
      if (scrollContainer) {
        pendingScrollRestoreRef.current = {
          scrollContainer,
          scrollTop: scrollContainer.scrollTop,
        }
      }
      setUncontrolledActiveBranchKey(branchKey)
      onActiveBranchChange?.(branchKey)
    },
    [onActiveBranchChange, resolvedActiveBranchKey],
  )

  useEffect(() => {
    if (!hasMultipleBranches) {
      setUncontrolledActiveBranchKey(null)
      onActiveBranchChange?.(null)
      return
    }
    if (
      activeBranchKey &&
      branchGroups.some((group) => group.key === activeBranchKey)
    ) {
      return
    }
    const firstCompletedBranch = branchGroups.find((group) =>
      isBranchCompleted(group.messages),
    )
    const nextActiveBranchKey =
      firstCompletedBranch?.key ?? branchGroups[0]?.key ?? null
    setUncontrolledActiveBranchKey(nextActiveBranchKey)
    onActiveBranchChange?.(nextActiveBranchKey)
  }, [activeBranchKey, branchGroups, hasMultipleBranches, onActiveBranchChange])

  const displayedMessages = useMemo(() => {
    if (!hasMultipleBranches) {
      return messages
    }
    return (
      branchGroups.find((group) => group.key === resolvedActiveBranchKey)
        ?.messages ??
      branchGroups[0]?.messages ??
      messages
    )
  }, [branchGroups, hasMultipleBranches, messages, resolvedActiveBranchKey])
  const effectiveConversationId = useMemo(() => {
    if (!hasMultipleBranches) {
      return conversationId
    }
    return (
      branchGroups.find((group) => group.key === resolvedActiveBranchKey)
        ?.conversationId ??
      branchGroups[0]?.conversationId ??
      conversationId
    )
  }, [
    branchGroups,
    conversationId,
    hasMultipleBranches,
    resolvedActiveBranchKey,
  ])
  useLayoutEffect(() => {
    if (activeBranchKey === null) {
      return
    }

    const pendingRestore = pendingScrollRestoreRef.current
    if (!pendingRestore) {
      return
    }

    pendingScrollRestoreRef.current = null
    pendingRestore.scrollContainer.scrollTop = pendingRestore.scrollTop
  }, [activeBranchKey])
  const assistantMessages = displayedMessages.filter(
    (message): message is ChatAssistantMessage => message.role === 'assistant',
  )
  const editableAssistantMessage =
    [...assistantMessages]
      .reverse()
      .find((message) => message.content.length > 0) ??
    assistantMessages.at(-1) ??
    null
  const editableAssistantMessageId = editableAssistantMessage?.id ?? null
  const isEditingGroup = displayedMessages.some(
    (message) => message.id === editingAssistantMessageId,
  )
  const groupRunState = getMessageGroupRunState({
    messages: displayedMessages,
    conversationRunSummary,
  })
  const isRunActive =
    groupRunState === 'streaming' || groupRunState === 'waiting-approval'
  const hasPendingAssistantShell = assistantMessages.some(
    (message) =>
      message.metadata?.generationState === 'streaming' &&
      !message.content &&
      !message.reasoning &&
      !message.annotations &&
      !message.toolCallRequests?.length,
  )
  const baseGroupEditSummary = useMemo(
    () => collectGroupEditSummary(displayedMessages),
    [displayedMessages],
  )

  // Stable key identifying the set of files × rounds that need snapshot reads.
  // Changes only when a file is added / removed / gets a new round, so the
  // snapshot-fetch effect below doesn't re-run on every streaming frame —
  // previously this re-ran ~60Hz and re-parsed the full snapshot JSON on each
  // frame, producing GB-scale transient allocations on long conversations.
  const snapshotFetchKey = useMemo(() => {
    if (!baseGroupEditSummary || baseGroupEditSummary.files.length === 0) {
      return null
    }
    return baseGroupEditSummary.files
      .map(
        (file) => `${file.path}::${file.firstRoundId}::${file.latestRoundId}`,
      )
      .join('|')
  }, [baseGroupEditSummary])

  // Cached per-file {addedLines, removedLines} derived from the cumulative
  // first→latest snapshot diff. Keyed by snapshotFetchKey entries so it
  // survives re-renders of baseGroupEditSummary that don't touch the file
  // set (e.g. tool-call entries appended during the same round).
  const [enrichedFileCounts, setEnrichedFileCounts] = useState<
    Record<string, { addedLines: number; removedLines: number }>
  >({})

  useEffect(() => {
    if (!snapshotFetchKey || !baseGroupEditSummary) {
      return
    }

    let cancelled = false
    const files = baseGroupEditSummary.files

    void (async () => {
      const entries = await Promise.all(
        files.map(async (file) => {
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
            return null
          }

          const counts = countFileChangeStats({
            beforeContent: firstSnapshot.beforeContent,
            afterContent: latestSnapshot.afterContent,
            beforeExists: firstSnapshot.beforeExists,
            afterExists: latestSnapshot.afterExists,
          })

          const key = `${file.path}::${file.firstRoundId}::${file.latestRoundId}`
          return [key, counts] as const
        }),
      )

      if (cancelled) {
        return
      }

      const next: Record<string, { addedLines: number; removedLines: number }> =
        {}
      for (const entry of entries) {
        if (entry) {
          next[entry[0]] = entry[1]
        }
      }
      setEnrichedFileCounts(next)
    })()

    return () => {
      cancelled = true
    }
    // snapshotFetchKey encodes the files × rounds identity we read here;
    // baseGroupEditSummary changes every streaming frame and MUST NOT be a
    // dep — it would retrigger this effect at ~60Hz and re-parse the full
    // snapshot JSON on every frame.
  }, [snapshotFetchKey, app, conversationId, settings])

  const groupEditSummary = useMemo<GroupEditSummary | null>(() => {
    if (!baseGroupEditSummary) {
      return null
    }
    const files = baseGroupEditSummary.files.map((file) => {
      const key = `${file.path}::${file.firstRoundId}::${file.latestRoundId}`
      const enriched = enrichedFileCounts[key]
      if (!enriched) {
        return file
      }
      return {
        ...file,
        addedLines: enriched.addedLines,
        removedLines: enriched.removedLines,
      }
    })
    return {
      ...baseGroupEditSummary,
      files,
      totalAddedLines: files.reduce((sum, file) => sum + file.addedLines, 0),
      totalRemovedLines: files.reduce(
        (sum, file) => sum + file.removedLines,
        0,
      ),
    }
  }, [baseGroupEditSummary, enrichedFileCounts])

  const groupEditSummaryKey = useMemo(
    () =>
      groupEditSummary
        ? groupEditSummary.entries.map((entry) => entry.toolCallId).join(':')
        : null,
    [groupEditSummary],
  )
  const effectiveGroupEditSummaryKey = groupEditSummaryKey ?? ''

  return (
    <div className="smtcmp-assistant-tool-message-group" ref={containerRef}>
      {hasMultipleBranches && (
        <div className="smtcmp-multi-model-tabs" role="tablist">
          {branchGroups.map((group) => {
            const isActive = group.key === resolvedActiveBranchKey
            const state = getBranchTabState(group.messages)
            const stateLabel = getBranchStateLabel(state, t)
            return (
              <button
                key={group.key}
                type="button"
                role="tab"
                aria-selected={isActive}
                className={`smtcmp-multi-model-tab smtcmp-multi-model-tab--${state}${isActive ? ' is-active' : ''}`}
                onClick={() => handleBranchSwitch(group.key)}
                title={`${group.label} · ${stateLabel}`}
              >
                <span className="smtcmp-multi-model-tab__label">
                  {group.label}
                </span>
                <span
                  className={`smtcmp-multi-model-tab__status${state === 'completed' ? ' is-icon-only' : ''}`}
                  title={stateLabel}
                >
                  <BranchStateIcon state={state} />
                  {state !== 'completed' && (
                    <span className="smtcmp-multi-model-tab__status-text">
                      {stateLabel}
                    </span>
                  )}
                </span>
              </button>
            )
          })}
        </div>
      )}
      {displayedMessages.map((message, messageIndex) => {
        const hasVisibleAssistantContent =
          message.role === 'assistant' && message.content.trim().length > 0
        const hasVisibleAssistantReasoning =
          message.role === 'assistant' &&
          (message.reasoning ?? '').trim().length > 0
        const hasVisibleAssistantAnnotations =
          message.role === 'assistant' && Boolean(message.annotations)
        const hasToolResponseForThis =
          message.role === 'assistant' &&
          displayedMessages[messageIndex + 1]?.role === 'tool'
        const shouldShowAssistantToolPreview =
          message.role === 'assistant' &&
          shouldRenderAssistantToolPreview({
            generationState: message.metadata?.generationState,
            toolCallRequestCount: message.toolCallRequests?.length ?? 0,
            hasToolMessages: hasToolResponseForThis,
          })
        const shouldHideAssistantPendingState =
          message.role === 'assistant' &&
          (hasToolResponseForThis || hidePendingAssistantPlaceholders) &&
          !hasVisibleAssistantContent &&
          !hasVisibleAssistantReasoning &&
          !hasVisibleAssistantAnnotations &&
          !shouldShowAssistantToolPreview

        if (shouldHideAssistantPendingState) {
          const shouldRenderPendingPlaceholder =
            message.metadata?.generationState === 'streaming'

          if (!shouldRenderPendingPlaceholder || !showPendingAssistantSpacer) {
            return null
          }

          return (
            <div
              key={message.id}
              className="smtcmp-chat-messages-assistant smtcmp-assistant-pending-spacer"
              aria-hidden="true"
            />
          )
        }

        return message.role === 'assistant' ? (
          message.reasoning ||
          message.annotations ||
          message.content ||
          (message.metadata?.generationState === 'error' &&
            Boolean(message.metadata?.errorMessage)) ||
          (message.metadata?.generationState === 'streaming' &&
            !message.content &&
            !message.reasoning) ||
          shouldShowAssistantToolPreview ? (
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
                  conversationId={effectiveConversationId}
                  content={message.content}
                  handleApply={onApply}
                  isApplying={isApplying}
                  activeApplyRequestKey={activeApplyRequestKey}
                  generationState={message.metadata?.generationState}
                  toolCallRequests={message.toolCallRequests}
                  showToolCallPreview={shouldShowAssistantToolPreview}
                  onQuote={onQuoteAssistantSelection}
                  enableSelectionQuote={showQuoteAction}
                />
              )}
              {message.metadata?.generationState === 'error' &&
                message.metadata.errorMessage && (
                  <AssistantErrorCard
                    errorMessage={message.metadata.errorMessage}
                  />
                )}
            </div>
          ) : null
        ) : message.role === 'external_agent_result' ? (
          <div key={message.id}>
            <ToolMessage
              message={buildSynthToolMessageFromResult(message)}
              conversationId={effectiveConversationId}
              showRunningFooter={false}
              onMessageUpdate={() => {
                // 异步派遣结果是终态消息，UI 内部不会触发 update；
                // 万一调到这里也不持久化（result message 有自己的存储路径）。
              }}
            />
          </div>
        ) : (
          <div key={message.id}>
            <ToolMessage
              message={message}
              conversationId={effectiveConversationId}
              isCompactionPending={
                message.id === pendingCompactionAnchorMessageId
              }
              showRunningFooter={showRunningToolFooter}
              onMessageUpdate={onToolMessageUpdate}
              onRecoverToolCall={onRecoverToolCall}
            />
          </div>
        )
      })}
      {groupEditSummary &&
        !suppressFooter &&
        !hasPendingAssistantShell &&
        !isRunActive && (
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
      {displayedMessages.length > 0 &&
        !hasPendingAssistantShell &&
        !isRunActive &&
        !suppressFooter && (
          <div className="smtcmp-assistant-message-footer">
            {showInlineInfo && (
              <LLMResponseInlineInfo messages={displayedMessages} />
            )}
            <AssistantToolMessageGroupActions
              messages={displayedMessages}
              showRetry={showRetryAction}
              showInsert={showInsertAction}
              showCopy={showCopyAction}
              showBranch={showBranchAction}
              showEdit={showEditAction}
              showDelete={showDeleteAction}
              onRetry={
                !isRunActive && !isEditingGroup
                  ? () => {
                      onRetryGroup(
                        displayedMessages.map((message) => message.id),
                      )
                    }
                  : undefined
              }
              onBranch={
                !isRunActive
                  ? () => {
                      onBranchGroup(messages.map((message) => message.id))
                    }
                  : undefined
              }
              onEdit={
                editableAssistantMessageId && !isRunActive
                  ? () => {
                      onEditStart(editableAssistantMessageId)
                    }
                  : undefined
              }
              onDelete={
                !isRunActive
                  ? () => {
                      onDeleteGroup(
                        displayedMessages.map((message) => message.id),
                      )
                    }
                  : undefined
              }
              isEditing={isEditingGroup}
              isDisabled={isRunActive}
            />
          </div>
        )}
    </div>
  )
}
