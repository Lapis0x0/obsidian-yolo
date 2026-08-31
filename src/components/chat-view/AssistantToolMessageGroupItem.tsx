import { Ban, Check, ChevronRight, CircleAlert, Loader2 } from 'lucide-react'
import {
  Fragment,
  memo,
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
import { isCliToolCallCapability } from '../../core/cli-runtime/tool-call'
import { InvalidToolNameException } from '../../core/mcp/exception'
import { parseToolName } from '../../core/mcp/tool-name-utils'
import { readEditReviewSnapshots } from '../../database/json/chat/editReviewSnapshotStore'
import {
  AssistantToolMessageGroup,
  ChatAssistantMessage,
  ChatMessage,
  ChatSubagentResultMessage,
  ChatTerminalCommandResultMessage,
  ChatToolMessage,
} from '../../types/chat'
import type { MentionableAssistantQuote } from '../../types/mentionable'
import type { ToolEditOperation } from '../../types/tool-call.types'
import { ToolCallResponseStatus } from '../../types/tool-call.types'
import {
  hasMatchingToolMessageForRequests,
  shouldRenderAssistantToolPreview,
} from '../../utils/chat/assistantToolPreview'
import type {
  FileChangeStats,
  GroupEditSummary,
} from '../../utils/chat/editSummary'
import {
  collectGroupEditSummary,
  countFileChangeStats,
} from '../../utils/chat/editSummary'

import AssistantEditSummary, { renderDeltaPair } from './AssistantEditSummary'
import AssistantErrorCard from './AssistantErrorCard'
import AssistantGroupEditor from './AssistantGroupEditor'
import AssistantMessageAnnotations from './AssistantMessageAnnotations'
import AssistantMessageContent from './AssistantMessageContent'
import AssistantMessageReasoning from './AssistantMessageReasoning'
import AssistantMessageSources from './AssistantMessageSources'
import AssistantToolMessageGroupActions from './AssistantToolMessageGroupActions'
import LLMResponseInlineInfo from './LLMResponseInlineInfo'
import { isReasoningActivityActive } from './reasoningActivity'
import { buildSynthToolMessageFromResult } from './tool-cards/externalAgentResultAdapter'
import { buildHostedWebSearchToolMessage } from './tool-cards/hostedWebSearchAdapter'
import ToolMessage from './ToolMessage'

// user message 之后的首条 thinking 用多行预览面板；工具轮之间的保持单行。
const LEAD_REASONING_PREVIEW_LINES = 5

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
        className="yolo-multi-model-tab__status-icon is-spinning"
      />
    )
  }
  if (state === 'waiting-approval') {
    return (
      <CircleAlert size={12} className="yolo-multi-model-tab__status-icon" />
    )
  }
  if (state === 'error') {
    return (
      <CircleAlert size={12} className="yolo-multi-model-tab__status-icon" />
    )
  }
  if (state === 'aborted') {
    return <Ban size={12} className="yolo-multi-model-tab__status-icon" />
  }
  return <Check size={12} className="yolo-multi-model-tab__status-icon" />
}

const getBranchTabState = (
  messages: AssistantToolMessageGroup,
): 'streaming' | 'waiting-approval' | 'completed' | 'aborted' | 'error' => {
  const latestMessage = messages.at(-1)
  const latestMetadata =
    latestMessage?.role !== 'external_agent_result' &&
    latestMessage?.role !== 'subagent_result' &&
    latestMessage?.role !== 'terminal_command_result'
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
    latestMessage?.role !== 'external_agent_result' &&
    latestMessage?.role !== 'subagent_result' &&
    latestMessage?.role !== 'terminal_command_result'
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

  if (conversationRunSummary?.isActive) {
    return 'streaming'
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

type AssistantMessageRenderPlan = {
  hostedWebSearchMessage: ChatToolMessage | null
  shouldShowAssistantToolPreview: boolean
  hasToolResponseForThis: boolean
  hidden: boolean
  visible: boolean
  rendersOnlyReasoning: boolean
}

// Single source of truth for "does this assistant message render anything",
// shared by the render loop and the tool-run collapsing segmentation below so
// the two can never drift apart.
const getAssistantMessageRenderPlan = ({
  message,
  nextMessage,
  groupMessages,
  hidePendingAssistantPlaceholders,
}: {
  message: ChatAssistantMessage
  nextMessage: AssistantToolMessageGroup[number] | undefined
  groupMessages: AssistantToolMessageGroup
  hidePendingAssistantPlaceholders: boolean
}): AssistantMessageRenderPlan => {
  const hasVisibleContent = message.content.trim().length > 0
  const hasVisibleReasoning = (message.reasoning ?? '').trim().length > 0
  const hasVisibleAnnotations = Boolean(message.annotations)
  const hasToolResponseForThis =
    nextMessage?.role === 'tool' ||
    hasMatchingToolMessageForRequests(
      message.toolCallRequests?.map((request) => request.id) ?? [],
      groupMessages,
    )
  const shouldShowAssistantToolPreview = shouldRenderAssistantToolPreview({
    generationState: message.metadata?.generationState,
    toolCallRequestCount: message.toolCallRequests?.length ?? 0,
    hasToolMessages: hasToolResponseForThis,
  })
  // A search the provider ran on its own servers. It produced no tool call,
  // so it is rebuilt here purely for display.
  const hostedWebSearchMessage = buildHostedWebSearchToolMessage(message)

  const hidden =
    (hasToolResponseForThis || hidePendingAssistantPlaceholders) &&
    !hasVisibleContent &&
    !hasVisibleReasoning &&
    !hasVisibleAnnotations &&
    !hostedWebSearchMessage &&
    !shouldShowAssistantToolPreview

  const visible =
    !hidden &&
    Boolean(
      message.reasoning ||
        message.annotations ||
        message.content ||
        hostedWebSearchMessage ||
        (message.metadata?.generationState === 'error' &&
          Boolean(message.metadata?.errorMessage)) ||
        (message.metadata?.generationState === 'streaming' &&
          !message.content &&
          !message.reasoning) ||
        shouldShowAssistantToolPreview,
    )

  // Renders nothing but a thinking block — foldable into a tool-run summary
  // alongside the tool cards it interleaves with.
  const rendersOnlyReasoning =
    visible &&
    hasVisibleReasoning &&
    !message.content &&
    !message.annotations &&
    !hostedWebSearchMessage &&
    !(
      message.metadata?.generationState === 'error' &&
      Boolean(message.metadata?.errorMessage)
    ) &&
    !shouldShowAssistantToolPreview

  return {
    hostedWebSearchMessage,
    shouldShowAssistantToolPreview,
    hasToolResponseForThis,
    hidden,
    visible,
    rendersOnlyReasoning,
  }
}

const TOOL_RUN_SUMMARY_BUCKET_ORDER = [
  'read',
  'search',
  'web',
  'edit',
  'virtualTerminal',
  'terminal',
  'command',
  'analysis',
  'other',
] as const

type ToolRunSummaryBucket = (typeof TOOL_RUN_SUMMARY_BUCKET_ORDER)[number]

const TOOL_RUN_SUMMARY_BUCKET_BY_TOOL: Record<string, ToolRunSummaryBucket> = {
  fs_read: 'read',
  fs_list: 'search',
  fs_search: 'search',
  web_search: 'web',
  web_scrape: 'web',
  fs_write: 'edit',
  fs_edit: 'edit',
  fs_move: 'edit',
  fs_delete: 'edit',
  fs_create_dir: 'edit',
  // Legacy tool names — keep summarizing historical conversations.
  fs_create_file: 'edit',
  fs_delete_file: 'edit',
  fs_delete_dir: 'edit',
  bash: 'virtualTerminal',
  terminal_command: 'terminal',
  js_eval: 'analysis',
}

const CLI_TOOL_RUN_SUMMARY_BUCKET_BY_NAME: Record<
  string,
  ToolRunSummaryBucket
> = {
  bash: 'command',
  exec: 'command',
  exec_command: 'command',
  shell: 'command',
  terminal: 'command',
  terminal_command: 'command',
  read: 'read',
  glob: 'search',
  grep: 'search',
  search: 'search',
  find: 'search',
  edit: 'edit',
  write: 'edit',
  apply_patch: 'edit',
  websearch: 'web',
  web_search: 'web',
  fetch: 'web',
  scrape: 'web',
}

type ToolCallRequestLike = ChatToolMessage['toolCalls'][number]['request']

const getToolRunSummaryBucket = (
  request: ToolCallRequestLike,
): ToolRunSummaryBucket => {
  const cliToolCall = request.metadata?.cliToolCall
  if (cliToolCall) {
    if (isCliToolCallCapability(request, 'file_change')) {
      return 'edit'
    }
    if (isCliToolCallCapability(request, 'command_execution')) {
      return 'command'
    }
    const cliBucket =
      CLI_TOOL_RUN_SUMMARY_BUCKET_BY_NAME[cliToolCall.name.toLowerCase()]
    if (cliBucket) {
      return cliBucket
    }
    return 'other'
  }

  let toolName = request.name
  try {
    toolName = parseToolName(request.name).toolName
  } catch (error) {
    if (!(error instanceof InvalidToolNameException)) {
      throw error
    }
  }
  return TOOL_RUN_SUMMARY_BUCKET_BY_TOOL[toolName] ?? 'other'
}

const TOOL_RUN_SUMMARY_LABELS: Record<
  ToolRunSummaryBucket,
  { key: string; fallback: string }
> = {
  read: { key: 'chat.toolRunSummary.read', fallback: 'Read {count} file(s)' },
  search: {
    key: 'chat.toolRunSummary.search',
    fallback: 'Searched {count} time(s)',
  },
  web: { key: 'chat.toolRunSummary.web', fallback: '{count} web lookup(s)' },
  edit: { key: 'chat.toolRunSummary.edit', fallback: 'Edited {count} file(s)' },
  virtualTerminal: {
    key: 'chat.toolRunSummary.virtualTerminal',
    fallback: 'Virtual terminal {count} time(s)',
  },
  terminal: {
    key: 'chat.toolRunSummary.terminal',
    fallback: 'Terminal {count} time(s)',
  },
  command: {
    key: 'chat.toolRunSummary.command',
    fallback: 'Ran {count} command(s)',
  },
  analysis: {
    key: 'chat.toolRunSummary.analysis',
    fallback: '{count} sandbox run(s)',
  },
  other: {
    key: 'chat.toolRunSummary.other',
    fallback: '{count} other action(s)',
  },
}

type ToolRunSegment = {
  key: string
  startIndex: number
  endIndex: number
  /**
   * Index of the visible assistant message that settled this run. Its
   * thinking block belongs to the run narratively, so it collapses and
   * expands together with the run.
   */
  boundaryIndex: number | null
  bucketCounts: Partial<Record<ToolRunSummaryBucket, number>>
  /**
   * 本段里已成功完成的文件编辑聚合（复用 footer 用的同一套按路径去重 + 净差异
   * 逻辑）。为 null 表示本段没有任何编辑调用已经成功返回——可能是纯只读段，
   * 也可能是编辑还在跑/失败了，这两种情况都退回普通的分桶计数文案。
   */
  editSummary: GroupEditSummary | null
  requiresUserAction: boolean
}

const getFileBaseName = (path: string): string => {
  const segments = path.split('/')
  return segments[segments.length - 1] || path
}

const EDIT_FILE_SUMMARY_LABELS: Record<
  ToolEditOperation,
  { key: string; fallback: string }
> = {
  edit: { key: 'chat.toolRunSummary.editedFile', fallback: 'Edited {name}' },
  create: {
    key: 'chat.toolRunSummary.createdFile',
    fallback: 'Created {name}',
  },
  delete: {
    key: 'chat.toolRunSummary.deletedFile',
    fallback: 'Deleted {name}',
  },
}

/**
 * 摘要行的文案分两部分：`clauses`（纯文本短语，逗号/·拼接）和 `stats`
 * （行尾带色的 +N/-M，渲染成 JSX 而不是字符串)。是否点名文件、要不要带数字，
 * 完全由 `editSummary` 是否存在、`totalFiles`、`totalLineStatsAvailable` 决定：
 * - 没有已完成的编辑 → 跟以前完全一样的分桶计数，`·` 拼接。
 * - 恰好 1 个文件 → 点名该文件（按 create/edit/delete 换动词），逗号拼接。
 * - ≥2 个文件 → 不点名，只报数量，逗号拼接。
 * - 数字是否可信只看 `totalLineStatsAvailable`（footer 已验证过这个字段在
 *   「CLI 只按 turn 报总量」的场景下依然准确，不能逐文件判断）。
 */
const buildToolRunSummaryDisplay = (
  segment: ToolRunSegment,
  t: (keyPath: string, fallback?: string) => string,
): { clauses: string[]; separator: string; stats: [number, number] | null } => {
  const { editSummary } = segment
  const clauses: string[] = []

  if (editSummary && editSummary.totalFiles === 1) {
    const file = editSummary.files[0]
    const label = EDIT_FILE_SUMMARY_LABELS[file.operation]
    clauses.push(
      t(label.key, label.fallback).replace(
        '{name}',
        getFileBaseName(file.path),
      ),
    )
  } else if (editSummary && editSummary.totalFiles >= 2) {
    const label = TOOL_RUN_SUMMARY_LABELS.edit
    clauses.push(
      t(label.key, label.fallback).replace(
        '{count}',
        String(editSummary.totalFiles),
      ),
    )
  }

  TOOL_RUN_SUMMARY_BUCKET_ORDER.forEach((bucket) => {
    if (bucket === 'edit' && editSummary) {
      return
    }
    const count = segment.bucketCounts[bucket]
    if (!count) {
      return
    }
    const label = TOOL_RUN_SUMMARY_LABELS[bucket]
    clauses.push(t(label.key, label.fallback).replace('{count}', String(count)))
  })

  return {
    clauses,
    separator: editSummary ? ', ' : ' · ',
    stats:
      editSummary && editSummary.totalLineStatsAvailable
        ? [editSummary.totalAddedLines, editSummary.totalRemovedLines]
        : null,
  }
}

export type AssistantToolMessageGroupItemProps = {
  messages: AssistantToolMessageGroup
  inlineInfoMessages?: AssistantToolMessageGroup
  conversationId: string
  conversationRunSummary?: AgentConversationRunSummary
  activeBranchKey?: string | null
  sourceUserMessageId?: string | null
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
  onToolCallResponseUpdate?: (
    toolMessageId: string,
    toolCallId: string,
    response: ChatToolMessage['toolCalls'][number]['response'],
  ) => void
  terminalCommandResultsByToolCallId?: ReadonlyMap<
    string,
    ChatTerminalCommandResultMessage
  >
  subagentResultsByToolCallId?: ReadonlyMap<string, ChatSubagentResultMessage>
  onRecoverToolCall?: (payload: {
    conversationId: string
    toolMessageId: string
    request: ChatToolMessage['toolCalls'][number]['request']
    allowForConversation?: boolean
  }) => Promise<boolean>
  onRecoverAnswerUserQuestion?: (payload: {
    resolvedMessages: ChatMessage[]
    toolCallId: string
  }) => void
  editingAssistantMessageId?: string | null
  onEditStart: (messageId: string) => void
  onEditCancel: () => void
  onEditSave: (messageId: string, replacementMessages: ChatMessage[]) => void
  onDeleteGroup: (messageIds: string[]) => void
  onRetryGroup: (messageIds: string[]) => void
  continuableErrorMessageIds?: ReadonlySet<string>
  onContinueError?: (assistantMessageId: string) => void
  onBranchGroup: (messageIds: string[]) => void
  onActiveBranchChange?: (
    sourceUserMessageId: string,
    branchKey: string | null,
  ) => void
  onQuoteAssistantSelection: (payload: {
    id?: string
    annotationNumber?: number
    messageId: string
    conversationId: string
    content: string
    comment?: string
    selector?: MentionableAssistantQuote['selector']
  }) => void
  assistantQuotes?: readonly MentionableAssistantQuote[]
  onDeleteAssistantQuote?: (id: string) => void
  onOpenEditSummaryFile: (file: GroupEditSummary['files'][number]) => void
  onUndoEditSummary?: (summary: GroupEditSummary) => void
  undoingEditSummaryTarget?: string | null
  pendingCompactionAnchorMessageId?: string | null
  hidePendingAssistantPlaceholders?: boolean
  showRunningToolFooter?: boolean
}

function AssistantToolMessageGroupItem({
  messages,
  inlineInfoMessages,
  conversationId,
  conversationRunSummary,
  activeBranchKey: controlledActiveBranchKey,
  sourceUserMessageId,
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
  onToolCallResponseUpdate,
  terminalCommandResultsByToolCallId,
  subagentResultsByToolCallId,
  onRecoverToolCall,
  onRecoverAnswerUserQuestion,
  editingAssistantMessageId,
  onEditStart,
  onEditCancel,
  onEditSave,
  onDeleteGroup,
  onRetryGroup,
  continuableErrorMessageIds,
  onContinueError,
  onBranchGroup,
  onActiveBranchChange,
  onQuoteAssistantSelection,
  assistantQuotes,
  onDeleteAssistantQuote,
  onOpenEditSummaryFile,
  onUndoEditSummary,
  undoingEditSummaryTarget,
  pendingCompactionAnchorMessageId,
  hidePendingAssistantPlaceholders = false,
  showRunningToolFooter = true,
}: AssistantToolMessageGroupItemProps) {
  const app = useApp()
  const { t } = useLanguage()
  const { settings } = useSettings()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const pendingScrollRestoreRef = useRef<{
    scrollContainer: HTMLElement
    scrollTop: number
  } | null>(null)
  const pendingEditLayoutAnchorRef = useRef<{
    scrollContainer: HTMLElement
    bottom: number
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
        message.role !== 'external_agent_result' &&
        message.role !== 'subagent_result' &&
        message.role !== 'terminal_command_result'
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
  const emitActiveBranchChange = useCallback(
    (branchKey: string | null) => {
      if (!sourceUserMessageId) {
        return
      }
      onActiveBranchChange?.(sourceUserMessageId, branchKey)
    },
    [onActiveBranchChange, sourceUserMessageId],
  )

  const handleBranchSwitch = useCallback(
    (branchKey: string) => {
      if (branchKey === resolvedActiveBranchKey) {
        return
      }

      const scrollContainer = containerRef.current?.closest<HTMLElement>(
        '.yolo-chat-messages',
      )
      if (scrollContainer) {
        pendingScrollRestoreRef.current = {
          scrollContainer,
          scrollTop: scrollContainer.scrollTop,
        }
      }
      setUncontrolledActiveBranchKey(branchKey)
      emitActiveBranchChange(branchKey)
    },
    [emitActiveBranchChange, resolvedActiveBranchKey],
  )

  useEffect(() => {
    if (!hasMultipleBranches) {
      setUncontrolledActiveBranchKey(null)
      emitActiveBranchChange(null)
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
    emitActiveBranchChange(nextActiveBranchKey)
  }, [
    activeBranchKey,
    branchGroups,
    emitActiveBranchChange,
    hasMultipleBranches,
  ])

  const displayedMessages = useMemo(() => {
    const selectedMessages = !hasMultipleBranches
      ? messages
      : (branchGroups.find((group) => group.key === resolvedActiveBranchKey)
          ?.messages ??
        branchGroups[0]?.messages ??
        messages)
    return selectedMessages
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
  const groupAnchorMessageId = displayedMessages[0]?.id ?? null
  const isEditingGroup = displayedMessages.some(
    (message) => message.id === editingAssistantMessageId,
  )
  const groupRunState = getMessageGroupRunState({
    messages: displayedMessages,
    conversationRunSummary,
  })
  const isRunActive =
    groupRunState === 'streaming' || groupRunState === 'waiting-approval'

  const messageRenderPlans = useMemo(
    () =>
      displayedMessages.map((message, index) =>
        message.role === 'assistant'
          ? getAssistantMessageRenderPlan({
              message,
              nextMessage: displayedMessages[index + 1],
              groupMessages: displayedMessages,
              hidePendingAssistantPlaceholders,
            })
          : null,
      ),
    [displayedMessages, hidePendingAssistantPlaceholders],
  )

  // A run of two or more tool calls — plus any thinking-only assistant
  // messages interleaved with them — gets a stable summary as soon as it is
  // observed. Details stay collapsed by default; only a run requiring user
  // action expands automatically so approval and answer controls remain
  // immediately available.
  const toolRunSegments = useMemo(() => {
    const segments: ToolRunSegment[] = []
    let firstMemberIndex = -1
    let lastMemberIndex = -1
    let toolMessages: ChatToolMessage[] = []

    const addMember = (index: number) => {
      if (firstMemberIndex === -1) {
        firstMemberIndex = index
      }
      lastMemberIndex = index
    }

    const close = (boundaryIndex: number | null) => {
      if (toolMessages.length > 0) {
        const toolCalls = toolMessages.flatMap((message) => message.toolCalls)
        if (toolCalls.length >= 2) {
          const bucketCounts: ToolRunSegment['bucketCounts'] = {}
          for (const call of toolCalls) {
            const bucket = getToolRunSummaryBucket(call.request)
            bucketCounts[bucket] = (bucketCounts[bucket] ?? 0) + 1
          }
          segments.push({
            key: toolMessages[0].id,
            startIndex: firstMemberIndex,
            endIndex: lastMemberIndex,
            boundaryIndex,
            bucketCounts,
            editSummary: collectGroupEditSummary(toolMessages),
            requiresUserAction: toolCalls.some(
              (call) =>
                call.response.status ===
                  ToolCallResponseStatus.PendingApproval ||
                call.response.status ===
                  ToolCallResponseStatus.AwaitingUserInput,
            ),
          })
        }
      }
      firstMemberIndex = -1
      lastMemberIndex = -1
      toolMessages = []
    }

    displayedMessages.forEach((message, index) => {
      if (message.role === 'tool') {
        addMember(index)
        toolMessages.push(message)
        return
      }
      const plan =
        message.role === 'assistant' ? messageRenderPlans[index] : null
      if (plan?.rendersOnlyReasoning) {
        addMember(index)
        return
      }
      const rendersNothing =
        message.role === 'subagent_result' ||
        message.role === 'terminal_command_result' ||
        (message.role === 'assistant' && !plan?.visible)
      if (rendersNothing) {
        return
      }
      close(index)
    })
    close(null)

    return segments
  }, [displayedMessages, messageRenderPlans])

  const toolRunSegmentByIndex = useMemo(() => {
    const byIndex = new Map<number, ToolRunSegment>()
    for (const segment of toolRunSegments) {
      for (let index = segment.startIndex; index <= segment.endIndex; index++) {
        byIndex.set(index, segment)
      }
    }
    return byIndex
  }, [toolRunSegments])

  const toolRunBoundaryByIndex = useMemo(() => {
    const byIndex = new Map<number, ToolRunSegment>()
    for (const segment of toolRunSegments) {
      if (segment.boundaryIndex !== null) {
        byIndex.set(segment.boundaryIndex, segment)
      }
    }
    return byIndex
  }, [toolRunSegments])

  const [expandedToolRunKeys, setExpandedToolRunKeys] = useState<
    ReadonlySet<string>
  >(() => new Set())
  const toggleToolRunSegment = useCallback((key: string) => {
    setExpandedToolRunKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }, [])

  // Keep the action area stationary while the rendered group and its capped
  // editor exchange heights, without preserving the full message height.
  const captureEditLayoutAnchor = useCallback(() => {
    const container = containerRef.current
    const scrollContainer = container?.closest<HTMLElement>(
      '.yolo-chat-messages',
    )
    if (!container || !scrollContainer) {
      pendingEditLayoutAnchorRef.current = null
      return
    }

    pendingEditLayoutAnchorRef.current = {
      scrollContainer,
      bottom: container.getBoundingClientRect().bottom,
    }
  }, [])

  const handleEditStart = useCallback(() => {
    if (!groupAnchorMessageId || isRunActive) {
      return
    }

    captureEditLayoutAnchor()
    onEditStart(groupAnchorMessageId)
  }, [captureEditLayoutAnchor, groupAnchorMessageId, isRunActive, onEditStart])

  useLayoutEffect(() => {
    const pendingAnchor = pendingEditLayoutAnchorRef.current
    if (!pendingAnchor) {
      return
    }

    pendingEditLayoutAnchorRef.current = null
    const container = containerRef.current
    if (!container || !pendingAnchor.scrollContainer.contains(container)) {
      return
    }

    const nextBottom = container.getBoundingClientRect().bottom
    pendingAnchor.scrollContainer.scrollTop += nextBottom - pendingAnchor.bottom
  }, [isEditingGroup])
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

  // Cached per-file stats derived from the cumulative first→latest snapshot
  // diff. Keyed by snapshotFetchKey entries so it survives re-renders of
  // baseGroupEditSummary that don't touch the file set (e.g. tool-call entries
  // appended during the same round). Carries `lineStatsAvailable` along with
  // the numbers: the recomputation can come back unavailable (oversized file
  // or diff timeout), and applying its 0/0 while leaving the original
  // availability flag alone would render a confident, wrong "0".
  const [enrichedFileCounts, setEnrichedFileCounts] = useState<
    Record<string, FileChangeStats>
  >({})

  useEffect(() => {
    if (!snapshotFetchKey || !baseGroupEditSummary) {
      return
    }

    let cancelled = false
    const files = baseGroupEditSummary.files

    void (async () => {
      // 一次读盘取出所有需要的快照。逐个 readEditReviewSnapshot 会把整个会话
      // 的快照库（含每个文件的前后全文）读盘并 JSON.parse 2×N 遍，全在主线程。
      const snapshots = await readEditReviewSnapshots({
        app,
        conversationId,
        keys: files.flatMap((file) => [
          { roundId: file.firstRoundId, filePath: file.path },
          { roundId: file.latestRoundId, filePath: file.path },
        ]),
        settings,
      })

      if (cancelled) {
        return
      }

      const entries = files.map((file, index) => {
        const firstSnapshot = snapshots[index * 2]
        const latestSnapshot = snapshots[index * 2 + 1]

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
      })

      const next: Record<string, FileChangeStats> = {}
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
        lineStatsAvailable: enriched.lineStatsAvailable,
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
      // 合计跟着补齐后的逐文件数字一起重算，所以补齐结果算不出行数时合计也就
      // 残缺了。只看「被补齐覆盖过的」文件：没被覆盖的文件其可用性已经体现在
      // baseGroupEditSummary.totalLineStatsAvailable 里，而用 files.every()
      // 会误伤只报告整轮增删的 provider（Claude CLI 把每个文件都标成不可用，
      // 合计却是准确的）。
      totalLineStatsAvailable:
        baseGroupEditSummary.totalLineStatsAvailable &&
        baseGroupEditSummary.files.every((file) => {
          const enriched =
            enrichedFileCounts[
              `${file.path}::${file.firstRoundId}::${file.latestRoundId}`
            ]
          return !enriched || enriched.lineStatsAvailable
        }),
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
    <div className="yolo-assistant-tool-message-group" ref={containerRef}>
      {hasMultipleBranches && (
        <div className="yolo-multi-model-tabs" role="tablist">
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
                className={`yolo-multi-model-tab yolo-multi-model-tab--${state}${isActive ? ' is-active' : ''}`}
                onClick={() => handleBranchSwitch(group.key)}
                title={`${group.label} · ${stateLabel}`}
              >
                <span className="yolo-multi-model-tab__label">
                  {group.label}
                </span>
                <span
                  className={`yolo-multi-model-tab__status${state === 'completed' ? ' is-icon-only' : ''}`}
                  title={stateLabel}
                >
                  <BranchStateIcon state={state} />
                  {state !== 'completed' && (
                    <span className="yolo-multi-model-tab__status-text">
                      {stateLabel}
                    </span>
                  )}
                </span>
              </button>
            )
          })}
        </div>
      )}
      <div className="yolo-assistant-group-body">
        {isEditingGroup ? (
          <AssistantGroupEditor
            messages={displayedMessages}
            onCancel={() => {
              captureEditLayoutAnchor()
              onEditCancel()
            }}
            onSave={(replacementMessages) => {
              if (!groupAnchorMessageId) return
              captureEditLayoutAnchor()
              onEditSave(groupAnchorMessageId, replacementMessages)
            }}
          />
        ) : (
          displayedMessages.map((message, messageIndex) => {
            const renderPlan =
              message.role === 'assistant'
                ? messageRenderPlans[messageIndex]
                : null
            const isReasoningActive = isReasoningActivityActive({
              messages: displayedMessages,
              messageIndex,
              isRunActive,
            })
            const reasoningGenerationState =
              message.role === 'assistant' && message.reasoning
                ? isReasoningActive
                  ? 'streaming'
                  : message.metadata?.generationState === 'aborted' ||
                      message.metadata?.generationState === 'error'
                    ? message.metadata.generationState
                    : 'completed'
                : message.role === 'assistant'
                  ? message.metadata?.generationState
                  : undefined
            const shouldShowAssistantToolPreview =
              renderPlan?.shouldShowAssistantToolPreview ?? false
            const hostedWebSearchMessage =
              renderPlan?.hostedWebSearchMessage ?? null

            if (renderPlan?.hidden) {
              return null
            }

            // The thinking block right before the answer belongs to the
            // preceding tool run — fold and unfold it with that run.
            const boundaryToolRunSegment =
              toolRunBoundaryByIndex.get(messageIndex)
            const isReasoningFoldedIntoRun =
              boundaryToolRunSegment !== undefined &&
              !expandedToolRunKeys.has(boundaryToolRunSegment.key)

            const renderedMessage =
              message.role === 'assistant' ? (
                renderPlan?.visible ? (
                  <div
                    key={message.id}
                    className={`yolo-chat-messages-assistant${
                      message.content.trim().length > 0
                        ? ' yolo-assistant-answer-item'
                        : ''
                    }${
                      !isReasoningFoldedIntoRun &&
                      (message.reasoning ?? '').trim().length > 0
                        ? ' has-visible-reasoning'
                        : ''
                    }`}
                  >
                    {!isReasoningFoldedIntoRun &&
                      (message.reasoning ||
                        (message.metadata?.generationState === 'streaming' &&
                          !message.content &&
                          !message.annotations &&
                          !message.toolCallRequests?.length)) && (
                        <AssistantMessageReasoning
                          reasoning={message.reasoning ?? ''}
                          conversationId={effectiveConversationId}
                          messageId={message.id}
                          isGenerating={
                            message.metadata?.generationState === 'streaming'
                          }
                          hasAnswerContent={message.content.trim().length > 0}
                          generationState={reasoningGenerationState}
                          reasoningDurationMs={
                            message.metadata?.reasoningDurationMs
                          }
                          previewLines={
                            messageIndex === 0
                              ? LEAD_REASONING_PREVIEW_LINES
                              : undefined
                          }
                        />
                      )}
                    {hostedWebSearchMessage && (
                      <ToolMessage
                        message={hostedWebSearchMessage}
                        conversationId={effectiveConversationId}
                        showRunningFooter={false}
                        onMessageUpdate={() => {
                          // 服务端已执行完毕的只读卡片，没有可更新的状态。
                        }}
                        onRecoverAnswerUserQuestion={
                          onRecoverAnswerUserQuestion
                        }
                      />
                    )}
                    {/* 生成中的正文走 assistant render stream，快照里只有
                        最近一次结构折回值。因此只要这条消息还在生成就必须挂着
                        内容叶子——否则第一段流没有订阅者，正文要等到下一个语义
                        事件才会出现。 */}
                    {(message.metadata?.generationState === 'streaming' ||
                      message.content.trim().length > 0 ||
                      shouldShowAssistantToolPreview) && (
                      <AssistantMessageContent
                        messageId={message.id}
                        conversationId={effectiveConversationId}
                        content={message.content}
                        annotations={message.annotations}
                        sources={message.metadata?.sources}
                        handleApply={onApply}
                        isApplying={isApplying}
                        activeApplyRequestKey={activeApplyRequestKey}
                        generationState={message.metadata?.generationState}
                        reasoningDurationMs={
                          message.metadata?.reasoningDurationMs
                        }
                        toolCallRequests={message.toolCallRequests}
                        showToolCallPreview={shouldShowAssistantToolPreview}
                        onQuote={onQuoteAssistantSelection}
                        assistantQuotes={assistantQuotes}
                        onDeleteQuote={onDeleteAssistantQuote}
                        enableSelectionQuote={showQuoteAction}
                      />
                    )}
                    {message.annotations && (
                      <AssistantMessageAnnotations
                        annotations={message.annotations}
                      />
                    )}
                    {message.metadata?.sources &&
                      message.metadata.sources.length > 0 && (
                        <AssistantMessageSources
                          sources={message.metadata.sources}
                        />
                      )}
                    {message.metadata?.generationState === 'error' &&
                      message.metadata.errorMessage && (
                        <AssistantErrorCard
                          errorMessage={message.metadata.errorMessage}
                          errorDetail={message.metadata.errorDetail}
                          onContinue={
                            continuableErrorMessageIds?.has(message.id) &&
                            onContinueError &&
                            !isRunActive
                              ? () => onContinueError(message.id)
                              : undefined
                          }
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
                    onRecoverAnswerUserQuestion={onRecoverAnswerUserQuestion}
                  />
                </div>
              ) : message.role === 'subagent_result' ||
                message.role === 'terminal_command_result' ? null : (
                <div key={message.id}>
                  <ToolMessage
                    message={message}
                    conversationId={effectiveConversationId}
                    isCompactionPending={
                      message.id === pendingCompactionAnchorMessageId
                    }
                    showRunningFooter={showRunningToolFooter}
                    terminalCommandResultsByToolCallId={
                      terminalCommandResultsByToolCallId
                    }
                    subagentResultsByToolCallId={subagentResultsByToolCallId}
                    onMessageUpdate={onToolMessageUpdate}
                    onToolCallResponseUpdate={onToolCallResponseUpdate}
                    onRecoverToolCall={onRecoverToolCall}
                    onRecoverAnswerUserQuestion={onRecoverAnswerUserQuestion}
                  />
                </div>
              )

            const toolRunSegment = toolRunSegmentByIndex.get(messageIndex)
            if (!toolRunSegment) {
              return renderedMessage
            }
            const isSegmentExpanded =
              expandedToolRunKeys.has(toolRunSegment.key) ||
              toolRunSegment.requiresUserAction
            if (messageIndex !== toolRunSegment.startIndex) {
              return isSegmentExpanded ? renderedMessage : null
            }
            const summaryDisplay = buildToolRunSummaryDisplay(toolRunSegment, t)
            return (
              <Fragment key={`tool-run-${toolRunSegment.key}`}>
                <button
                  type="button"
                  className={`yolo-tool-run-summary${
                    isSegmentExpanded ? ' is-expanded' : ''
                  }`}
                  aria-expanded={isSegmentExpanded}
                  onClick={() => toggleToolRunSegment(toolRunSegment.key)}
                >
                  <span className="yolo-tool-run-summary__text">
                    {summaryDisplay.clauses.join(summaryDisplay.separator)}
                  </span>
                  {summaryDisplay.stats && (
                    <span className="yolo-tool-run-summary__stats">
                      {renderDeltaPair(...summaryDisplay.stats)}
                    </span>
                  )}
                  <ChevronRight
                    size={14}
                    className="yolo-tool-run-summary__chevron"
                  />
                </button>
                {isSegmentExpanded ? renderedMessage : null}
              </Fragment>
            )
          })
        )}
      </div>
      {groupEditSummary &&
        !suppressFooter &&
        !hasPendingAssistantShell &&
        !isRunActive && (
          <AssistantEditSummary
            summary={groupEditSummary}
            showUndo={onUndoEditSummary !== undefined}
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
          <div className="yolo-assistant-message-footer">
            {showInlineInfo && (
              <LLMResponseInlineInfo
                messages={inlineInfoMessages ?? displayedMessages}
              />
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
                groupAnchorMessageId && !isRunActive
                  ? handleEditStart
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

export default memo(AssistantToolMessageGroupItem)
