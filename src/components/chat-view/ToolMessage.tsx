import cx from 'clsx'
import { Check, ChevronDown, ChevronRight, Loader2, X } from 'lucide-react'
import { Notice } from 'obsidian'
import { memo, useCallback, useEffect, useMemo, useState } from 'react'

import { useLanguage } from '../../contexts/language-context'
import { usePlugin } from '../../contexts/plugin-context'
import { getBuiltinToolUiMeta } from '../../core/agent/builtinToolUiMeta'
import { ALWAYS_ALLOW_DISABLED_TOOL_NAMES } from '../../core/agent/tool-preferences'
import { InvalidToolNameException } from '../../core/mcp/exception'
import {
  getLocalFileToolServerName,
  parseLocalFsActionFromToolArgs,
} from '../../core/mcp/localFileTools'
import { parseToolName } from '../../core/mcp/tool-name-utils'
import { ChatToolMessage } from '../../types/chat'
import {
  ToolCallRequest,
  ToolCallResponse,
  ToolCallResponseStatus,
  getToolCallArgumentsObject,
  getToolCallArgumentsText,
} from '../../types/tool-call.types'
import { SplitButton } from '../common/SplitButton'

import { ObsidianCodeBlock } from './ObsidianMarkdown'
import { ExternalAgentToolCard } from './tool-cards/ExternalAgentToolCard'
import {
  type ToolDisplayInfo,
  getToolHeadlineParts,
  getToolHeadlineText,
} from './toolHeadline'

export type TranslateFn = (keyPath: string, fallback?: string) => string

export type ToolLabels = {
  statusLabels: Record<ToolCallResponseStatus, string>
  unknownStatus: string
  displayNames: Record<string, string>
  writeActionLabels: Record<string, string>
  readFull: string
  readLineRange: (startLine: number, endLine: number, isPdf: boolean) => string
  target: string
  scope: string
  query: string
  path: string
  paths: string
  parameters: string
  noParameters: string
  result: string
  error: string
  allow: string
  reject: string
  abort: string
  allowForThisChat: string
}

const DEFAULT_STATUS_LABELS: Record<ToolCallResponseStatus, string> = {
  [ToolCallResponseStatus.PendingApproval]: 'Call',
  [ToolCallResponseStatus.Rejected]: 'Rejected',
  [ToolCallResponseStatus.Running]: 'Running',
  [ToolCallResponseStatus.Success]: '',
  [ToolCallResponseStatus.Error]: 'Failed',
  [ToolCallResponseStatus.Aborted]: 'Aborted',
}

type ToolRequestLike = {
  name: string
  arguments?: ToolCallRequest['arguments']
}

type FsReadOperationSummary =
  | {
      type: 'full'
      isPdf: boolean
    }
  | {
      type: 'lines'
      startLine: number
      endLine: number
      isPdf: boolean
    }

const DEFAULT_LOCAL_FILE_TOOL_DISPLAY_NAMES: Record<string, string> = {
  fs_create_file: 'Create file',
  fs_delete_file: 'Delete file',
  fs_create_dir: 'Create folder',
  fs_delete_dir: 'Delete folder',
  fs_move: 'Move path',
}

const DEFAULT_WRITE_ACTION_LABELS: Record<string, string> = {
  create_file: 'Create file',
  delete_file: 'Delete file',
  create_dir: 'Create folder',
  delete_dir: 'Delete folder',
  move: 'Move path',
}

export const getToolLabels = (t?: TranslateFn): ToolLabels => {
  const translate: TranslateFn = t ?? ((_, fallback) => fallback ?? '')
  return {
    statusLabels: {
      [ToolCallResponseStatus.PendingApproval]: translate(
        'chat.toolCall.status.call',
        DEFAULT_STATUS_LABELS[ToolCallResponseStatus.PendingApproval],
      ),
      [ToolCallResponseStatus.Rejected]: translate(
        'chat.toolCall.status.rejected',
        DEFAULT_STATUS_LABELS[ToolCallResponseStatus.Rejected],
      ),
      [ToolCallResponseStatus.Running]: translate(
        'chat.toolCall.status.running',
        DEFAULT_STATUS_LABELS[ToolCallResponseStatus.Running],
      ),
      [ToolCallResponseStatus.Success]: '',
      [ToolCallResponseStatus.Error]: translate(
        'chat.toolCall.status.failed',
        DEFAULT_STATUS_LABELS[ToolCallResponseStatus.Error],
      ),
      [ToolCallResponseStatus.Aborted]: translate(
        'chat.toolCall.status.aborted',
        DEFAULT_STATUS_LABELS[ToolCallResponseStatus.Aborted],
      ),
    },
    unknownStatus: translate('chat.toolCall.status.unknown', 'Unknown'),
    displayNames: {
      fs_list: translateBuiltinToolLabel('fs_list', translate),
      fs_search: translateBuiltinToolLabel('fs_search', translate),
      fs_read: translateBuiltinToolLabel('fs_read', translate),
      context_prune_tool_results: translateBuiltinToolLabel(
        'context_prune_tool_results',
        translate,
      ),
      context_compact: translateBuiltinToolLabel('context_compact', translate),
      fs_edit: translateBuiltinToolLabel('fs_edit', translate),
      fs_create_file: translate(
        'chat.toolCall.writeAction.create_file',
        DEFAULT_LOCAL_FILE_TOOL_DISPLAY_NAMES.fs_create_file,
      ),
      fs_delete_file: translate(
        'chat.toolCall.writeAction.delete_file',
        DEFAULT_LOCAL_FILE_TOOL_DISPLAY_NAMES.fs_delete_file,
      ),
      fs_create_dir: translate(
        'chat.toolCall.writeAction.create_dir',
        DEFAULT_LOCAL_FILE_TOOL_DISPLAY_NAMES.fs_create_dir,
      ),
      fs_delete_dir: translate(
        'chat.toolCall.writeAction.delete_dir',
        DEFAULT_LOCAL_FILE_TOOL_DISPLAY_NAMES.fs_delete_dir,
      ),
      fs_move: translate(
        'chat.toolCall.writeAction.move',
        DEFAULT_LOCAL_FILE_TOOL_DISPLAY_NAMES.fs_move,
      ),
      memory_add: translateBuiltinToolLabel('memory_add', translate),
      memory_update: translateBuiltinToolLabel('memory_update', translate),
      memory_delete: translateBuiltinToolLabel('memory_delete', translate),
      web_search: translateBuiltinToolLabel('web_search', translate),
      web_scrape: translateBuiltinToolLabel('web_scrape', translate),
      delegate_external_agent: translateBuiltinToolLabel(
        'delegate_external_agent',
        translate,
      ),
    },
    writeActionLabels: {
      create_file: translate(
        'chat.toolCall.writeAction.create_file',
        DEFAULT_WRITE_ACTION_LABELS.create_file,
      ),
      delete_file: translate(
        'chat.toolCall.writeAction.delete_file',
        DEFAULT_WRITE_ACTION_LABELS.delete_file,
      ),
      create_dir: translate(
        'chat.toolCall.writeAction.create_dir',
        DEFAULT_WRITE_ACTION_LABELS.create_dir,
      ),
      delete_dir: translate(
        'chat.toolCall.writeAction.delete_dir',
        DEFAULT_WRITE_ACTION_LABELS.delete_dir,
      ),
      move: translate(
        'chat.toolCall.writeAction.move',
        DEFAULT_WRITE_ACTION_LABELS.move,
      ),
    },
    readFull: translate('chat.toolCall.readMode.full', 'Full'),
    readLineRange: (startLine: number, endLine: number, isPdf: boolean) =>
      `${startLine}-${endLine}${
        isPdf
          ? translate('chat.toolCall.readMode.pagesSuffix', ' pages')
          : translate('chat.toolCall.readMode.linesSuffix', ' lines')
      }`,
    target: translate('chat.toolCall.detail.target', 'Target'),
    scope: translate('chat.toolCall.detail.scope', 'Scope'),
    query: translate('chat.toolCall.detail.query', 'Query'),
    path: translate('chat.toolCall.detail.path', 'Path'),
    paths: translate('chat.toolCall.detail.paths', 'paths'),
    parameters: translate('chat.toolCall.parameters', 'Parameters'),
    noParameters: translate('chat.toolCall.noParameters', 'No parameters'),
    result: translate('chat.toolCall.result', 'Result'),
    error: translate('chat.toolCall.error', 'Error'),
    allow: translate('chat.toolCall.allow', 'Allow'),
    reject: translate('chat.toolCall.reject', 'Reject'),
    abort: translate('chat.toolCall.abort', 'Abort'),
    allowForThisChat: translate(
      'chat.toolCall.allowForThisChat',
      'Allow for this chat',
    ),
  }
}

/**
 * 判断工具调用是否为 delegate_external_agent。
 * 完整 tool name 形如 yolo_local__delegate_external_agent。
 */
const isDelegateExternalAgentRequest = (request: ToolRequestLike): boolean => {
  try {
    const { toolName } = parseToolName(request.name)
    return toolName === 'delegate_external_agent'
  } catch {
    return false
  }
}

const extractExternalAgentArgs = (
  rawArguments?: ToolCallRequest['arguments'],
): { provider?: string; model?: string; workingDirectory?: string } | undefined => {
  const parsed = getToolCallArgumentsObject(rawArguments)
  if (!parsed) return undefined
  const provider = typeof parsed.provider === 'string' ? parsed.provider : undefined
  const model = typeof parsed.model === 'string' ? parsed.model : undefined
  const workingDirectory =
    typeof parsed.workingDirectory === 'string'
      ? parsed.workingDirectory
      : undefined
  if (!provider && !model && !workingDirectory) return undefined
  return { provider, model, workingDirectory }
}

const translateBuiltinToolLabel = (
  toolName: string,
  translate: TranslateFn,
): string => {
  const meta = getBuiltinToolUiMeta(toolName)
  if (!meta) {
    return toolName
  }

  return translate(meta.labelKey, meta.labelFallback)
}

const truncateText = (text: string, maxLength: number): string => {
  if (text.length <= maxLength) {
    return text
  }
  return `${text.slice(0, maxLength - 1)}...`
}

const parseToolArguments = (
  rawArguments?: ToolCallRequest['arguments'],
): Record<string, unknown> | null => {
  return getToolCallArgumentsObject(rawArguments) ?? null
}

const asStringArray = (value: unknown): string[] | null => {
  if (!Array.isArray(value)) {
    return null
  }
  if (value.some((item) => typeof item !== 'string')) {
    return null
  }
  return value
}

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  return value as Record<string, unknown>
}

const asRecordArray = (value: unknown): Record<string, unknown>[] | null => {
  if (!Array.isArray(value)) {
    return null
  }
  if (value.some((item) => !asRecord(item))) {
    return null
  }
  return value as Record<string, unknown>[]
}

const asInteger = (value: unknown): number | undefined => {
  return Number.isInteger(value) ? (value as number) : undefined
}

const getParentPath = (path: string): string => {
  const normalizedPath = path.trim().replace(/\/+$/, '')
  if (!normalizedPath || !normalizedPath.includes('/')) {
    return '/'
  }

  const lastSlashIndex = normalizedPath.lastIndexOf('/')
  return lastSlashIndex <= 0 ? '/' : normalizedPath.slice(0, lastSlashIndex)
}

const getSharedParentPath = (paths: string[]): string | undefined => {
  if (paths.length === 0) {
    return undefined
  }

  const parentPath = getParentPath(paths[0])
  if (paths.every((path) => getParentPath(path) === parentPath)) {
    return parentPath
  }

  return undefined
}

const formatBatchPathSummary = ({
  actionLabel,
  noun,
  paths,
}: {
  actionLabel: string
  noun: string
  paths: string[]
}): string => {
  const sharedParentPath = getSharedParentPath(paths)
  if (sharedParentPath) {
    return `${actionLabel} ${sharedParentPath} 下 ${paths.length} 个${noun}`
  }

  return `${actionLabel} ${paths.length} 个${noun}`
}

const formatBatchMoveSummary = (
  items: Record<string, unknown>[],
): string | undefined => {
  const newPaths = items
    .map((item) => (typeof item.newPath === 'string' ? item.newPath : ''))
    .filter((path) => path.length > 0)

  if (newPaths.length !== items.length) {
    return undefined
  }

  const targetParentPath = getSharedParentPath(newPaths)
  if (targetParentPath) {
    return `移动 ${items.length} 项到 ${targetParentPath}`
  }

  return `移动 ${items.length} 项`
}

const getFsReadOperationSummary = ({
  request,
  response,
}: {
  request: ToolRequestLike
  response?: ToolCallResponse
}): FsReadOperationSummary | undefined => {
  // Single source of truth: the backend response. Pre-response we omit the
  // range entirely — better to render no range for half a second than to
  // guess from request defaults that the backend may override (e.g. PDFs
  // ignore `maxLines`, image mode forces single page).
  if (response?.status !== ToolCallResponseStatus.Success) {
    return undefined
  }

  // Determine isPdf from the first request path (used purely for the label
  // suffix — "页" vs "行"). Mixed batches use the first path's extension; the
  // headline only renders a single batch summary anyway, not per-file ranges.
  const requestArguments = parseToolArguments(request.arguments)
  const rawPaths = requestArguments?.paths
  const firstPath =
    Array.isArray(rawPaths) && typeof rawPaths[0] === 'string'
      ? rawPaths[0]
      : null
  const isPdf =
    typeof firstPath === 'string' && firstPath.toLowerCase().endsWith('.pdf')

  try {
    const payload = JSON.parse(response.data.text) as unknown
    const payloadRecord = asRecord(payload)
    const requestedOperation = asRecord(payloadRecord?.requestedOperation)
    const type = requestedOperation?.type

    if (type === 'full') {
      return { type: 'full', isPdf }
    }

    if (type === 'lines') {
      // The truth about what was read lives in `results[0].returnedRange` —
      // not in `requestedOperation`, which echoes resolved defaults that may
      // not reflect actual behavior (PDF ignores maxLines, image mode forces
      // single page, etc.).
      const results = payloadRecord?.results
      if (!Array.isArray(results) || results.length === 0) {
        return undefined
      }
      const firstResult = asRecord(results[0])
      const returnedRange = asRecord(firstResult?.returnedRange)
      const startLine = asInteger(returnedRange?.startLine)
      const endLine = asInteger(returnedRange?.endLine)
      if (typeof startLine === 'number' && typeof endLine === 'number') {
        return { type: 'lines', startLine, endLine, isPdf }
      }
    }
  } catch {
    // Malformed payload — drop the range silently.
  }

  return undefined
}

const formatFsReadHeadlineMode = (
  operation: FsReadOperationSummary | undefined,
  labels: ToolLabels,
): string | undefined => {
  if (!operation) {
    return undefined
  }

  if (operation.type === 'full') {
    return labels.readFull
  }
  return labels.readLineRange(
    operation.startLine,
    operation.endLine,
    operation.isPdf,
  )
}

export const getHeadlineDisplayInfo = ({
  request,
  response,
  labels,
}: {
  request: ToolRequestLike
  response?: ToolCallResponse
  labels: ToolLabels
}): ToolDisplayInfo => {
  const displayInfo = getToolDisplayInfo(request, labels)

  try {
    const { serverName, toolName } = parseToolName(request.name)
    if (serverName !== getLocalFileToolServerName() || toolName !== 'fs_read') {
      return displayInfo
    }
  } catch (error) {
    if (!(error instanceof InvalidToolNameException)) {
      throw error
    }
    return displayInfo
  }

  const modeText = formatFsReadHeadlineMode(
    getFsReadOperationSummary({ request, response }),
    labels,
  )
  if (!modeText) {
    return displayInfo
  }

  return {
    ...displayInfo,
    summaryText: displayInfo.summaryText
      ? `${displayInfo.summaryText} | ${modeText}`
      : modeText,
  }
}

const getLocalToolSummaryText = ({
  toolName,
  argumentsObject,
  rawArguments,
  labels,
}: {
  toolName: string
  argumentsObject: Record<string, unknown> | null
  rawArguments?: ToolCallRequest['arguments']
  labels: ToolLabels
}): string | undefined => {
  const batchItems = asRecordArray(argumentsObject?.items)

  if (toolName === 'fs_list') {
    const targetPath =
      typeof argumentsObject?.path === 'string' &&
      argumentsObject.path.trim().length > 0
        ? argumentsObject.path
        : '/'
    return targetPath
  }

  if (toolName === 'fs_search') {
    const scope =
      typeof argumentsObject?.scope === 'string' ? argumentsObject.scope : 'all'
    const query =
      typeof argumentsObject?.query === 'string' ? argumentsObject.query : ''
    if (query.trim().length === 0) {
      return scope
    }
    return `${scope} | ${truncateText(query, 60)}`
  }

  if (toolName === 'web_search') {
    const query =
      typeof argumentsObject?.query === 'string' ? argumentsObject.query : ''
    if (query.trim().length === 0) {
      return undefined
    }
    const topic =
      typeof argumentsObject?.topic === 'string'
        ? argumentsObject.topic.trim()
        : ''
    const queryText = truncateText(query, 60)
    return topic ? `${topic} | ${queryText}` : queryText
  }

  if (toolName === 'web_scrape') {
    const url =
      typeof argumentsObject?.url === 'string' ? argumentsObject.url : ''
    return url ? truncateText(url, 80) : undefined
  }

  if (toolName === 'fs_read') {
    const paths = asStringArray(argumentsObject?.paths)
    if (!paths || paths.length === 0) {
      return undefined
    }
    if (paths.length === 1) {
      return paths[0]
    }
    return `${paths.length} ${labels.paths}`
  }

  if (toolName === 'fs_edit') {
    const path =
      typeof argumentsObject?.path === 'string' ? argumentsObject.path : ''
    return path || undefined
  }

  if (
    toolName === 'fs_create_file' ||
    toolName === 'fs_delete_file' ||
    toolName === 'fs_create_dir' ||
    toolName === 'fs_delete_dir'
  ) {
    if (batchItems && batchItems.length > 0) {
      const pathKey =
        toolName === 'fs_create_file' || toolName === 'fs_delete_file'
          ? '文件'
          : '文件夹'
      const actionLabel =
        toolName === 'fs_create_file' || toolName === 'fs_create_dir'
          ? '在'
          : '删除'
      const paths = batchItems
        .map((item) => (typeof item.path === 'string' ? item.path : ''))
        .filter((path) => path.length > 0)

      if (paths.length === batchItems.length) {
        if (actionLabel === '在') {
          const sharedParentPath = getSharedParentPath(paths)
          if (sharedParentPath) {
            return `在 ${sharedParentPath} 下创建 ${paths.length} 个${pathKey}`
          }
          return `创建 ${paths.length} 个${pathKey}`
        }

        return formatBatchPathSummary({
          actionLabel,
          noun: pathKey,
          paths,
        })
      }

      return undefined
    }

    const path =
      typeof argumentsObject?.path === 'string' ? argumentsObject.path : ''
    return path || undefined
  }

  if (toolName === 'fs_move') {
    if (batchItems && batchItems.length > 0) {
      return formatBatchMoveSummary(batchItems)
    }

    const oldPath =
      typeof argumentsObject?.oldPath === 'string'
        ? argumentsObject.oldPath
        : ''
    const newPath =
      typeof argumentsObject?.newPath === 'string'
        ? argumentsObject.newPath
        : ''

    if (oldPath && newPath) {
      return `${oldPath} -> ${newPath}`
    }

    return oldPath || newPath || undefined
  }

  const action = parseLocalFsActionFromToolArgs({
    toolName,
    args: getToolCallArgumentsObject(rawArguments),
  })
  if (action) {
    const actionLabel = labels.writeActionLabels[action] ?? action
    return actionLabel
  }

  return undefined
}

export const getToolDisplayInfo = (
  request: ToolRequestLike,
  labels: ToolLabels = getToolLabels(),
): ToolDisplayInfo => {
  const localServerName = getLocalFileToolServerName()
  const argumentsObject = parseToolArguments(request.arguments)
  try {
    const { serverName, toolName } = parseToolName(request.name)

    if (serverName === localServerName) {
      const action = parseLocalFsActionFromToolArgs({
        toolName,
        args: argumentsObject ?? undefined,
      })
      const displayName = action
        ? (labels.writeActionLabels[action] ?? labels.displayNames[toolName])
        : (labels.displayNames[toolName] ?? toolName)

      return {
        displayName,
        summaryText: getLocalToolSummaryText({
          toolName,
          argumentsObject,
          rawArguments: request.arguments,
          labels,
        }),
      }
    }

    return {
      displayName: `${serverName}:${toolName}`,
    }
  } catch (error) {
    if (!(error instanceof InvalidToolNameException)) {
      throw error
    }
    return {
      displayName: request.name,
    }
  }
}

export const getToolMessageContent = (
  message: ChatToolMessage,
  t?: TranslateFn,
): string => {
  const labels = getToolLabels(t)
  return message.toolCalls
    ?.map((toolCall) => {
      const displayInfo = getHeadlineDisplayInfo({
        request: toolCall.request,
        response: toolCall.response,
        labels,
      })
      return [
        getToolHeadlineText({
          status: toolCall.response.status,
          displayInfo,
          labels,
          editSummary:
            toolCall.response.status === ToolCallResponseStatus.Success
              ? toolCall.response.data.metadata?.editSummary
              : undefined,
        }),
        ...(toolCall.request.arguments
          ? [
              `${labels.parameters}: ${getToolCallArgumentsText(toolCall.request.arguments) ?? ''}`,
            ]
          : []),
      ].join('\n')
    })
    .join('\n')
}

const ToolMessage = memo(function ToolMessage({
  message,
  conversationId,
  isCompactionPending = false,
  showRunningFooter = true,
  onMessageUpdate,
  onRecoverToolCall,
}: {
  message: ChatToolMessage
  conversationId: string
  isCompactionPending?: boolean
  showRunningFooter?: boolean
  onMessageUpdate: (message: ChatToolMessage) => void
  onRecoverToolCall?: (payload: {
    conversationId: string
    toolMessageId: string
    request: ToolCallRequest
    allowForConversation?: boolean
  }) => Promise<boolean>
}) {
  return (
    <div className="smtcmp-toolcall-container">
      {message.toolCalls.map((toolCall, index) => (
        <div
          key={toolCall.request.id}
          className={cx(index > 0 && 'smtcmp-toolcall-border-top')}
        >
          <ToolCallItem
            request={toolCall.request}
            response={toolCall.response}
            conversationId={conversationId}
            toolMessageId={message.id}
            showCompactionPendingHint={
              isCompactionPending && index === message.toolCalls.length - 1
            }
            showRunningFooter={showRunningFooter}
            onRecoverToolCall={onRecoverToolCall}
            onResponseUpdate={(response) =>
              onMessageUpdate({
                ...message,
                toolCalls: message.toolCalls.map((t) =>
                  t.request.id === toolCall.request.id ? { ...t, response } : t,
                ),
              })
            }
          />
        </div>
      ))}
    </div>
  )
})

function ToolCallItem({
  request,
  response,
  conversationId,
  toolMessageId,
  showCompactionPendingHint = false,
  showRunningFooter = true,
  onRecoverToolCall,
  onResponseUpdate,
}: {
  request: ToolCallRequest
  response: ToolCallResponse
  conversationId: string
  toolMessageId: string
  showCompactionPendingHint?: boolean
  showRunningFooter?: boolean
  onRecoverToolCall?: (payload: {
    conversationId: string
    toolMessageId: string
    request: ToolCallRequest
    allowForConversation?: boolean
  }) => Promise<boolean>
  onResponseUpdate: (response: ToolCallResponse) => void
}) {
  const STATUS_TRANSITION_MS = 180
  const COMPACTION_PENDING_EXIT_MS = 180
  const {
    handleToolCall,
    handleAllowForConversation,
    handleReject,
    handleAbort,
  } = useToolCall(
    request,
    conversationId,
    toolMessageId,
    onResponseUpdate,
    onRecoverToolCall,
  )

  const [isOpen, setIsOpen] = useState(
    // Open by default if the tool call requires approval
    response.status === ToolCallResponseStatus.PendingApproval,
  )

  const { t } = useLanguage()
  const toolLabels = useMemo(() => getToolLabels(t), [t])
  const displayInfo = useMemo(
    () =>
      getHeadlineDisplayInfo({
        request,
        response,
        labels: toolLabels,
      }),
    [request, response, toolLabels],
  )
  const editSummary =
    response.status === ToolCallResponseStatus.Success
      ? response.data.metadata?.editSummary
      : undefined
  const headlineParts = useMemo(
    () =>
      getToolHeadlineParts({
        status: response.status,
        displayInfo,
        labels: toolLabels,
        editSummary,
      }),
    [displayInfo, editSummary, response.status, toolLabels],
  )
  const parameters = useMemo(() => {
    if (!request.arguments) {
      return toolLabels.noParameters
    }
    const parsed = getToolCallArgumentsObject(request.arguments)
    if (parsed) {
      return JSON.stringify(parsed, null, 2)
    }
    return (
      getToolCallArgumentsText(request.arguments) ?? toolLabels.noParameters
    )
  }, [request.arguments, toolLabels.noParameters])
  // 是否禁用"始终允许"按钮（某些高危工具每次必须人审）
  const isAlwaysAllowDisabled = useMemo(() => {
    try {
      const { toolName } = parseToolName(request.name)
      return ALWAYS_ALLOW_DISABLED_TOOL_NAMES.includes(toolName)
    } catch {
      return false
    }
  }, [request.name])
  const [showRunningActions, setShowRunningActions] = useState(false)
  const [isStatusTransitioning, setIsStatusTransitioning] = useState(false)
  const [renderFooter, setRenderFooter] = useState(
    response.status === ToolCallResponseStatus.PendingApproval,
  )
  const [isFooterVisible, setIsFooterVisible] = useState(
    response.status === ToolCallResponseStatus.PendingApproval,
  )
  const [displayFooterMode, setDisplayFooterMode] = useState<
    'pending' | 'running' | null
  >(
    response.status === ToolCallResponseStatus.PendingApproval
      ? 'pending'
      : null,
  )
  const [renderCompactionPendingHint, setRenderCompactionPendingHint] =
    useState(
      showCompactionPendingHint &&
        response.status === ToolCallResponseStatus.Success,
    )
  const [isCompactionPendingHintExiting, setIsCompactionPendingHintExiting] =
    useState(false)
  useEffect(() => {
    if (
      !showRunningFooter ||
      response.status !== ToolCallResponseStatus.Running
    ) {
      setShowRunningActions(false)
      return
    }

    const timer = window.setTimeout(() => {
      setShowRunningActions(true)
    }, 1000)

    return () => {
      window.clearTimeout(timer)
    }
  }, [response.status, showRunningFooter])

  useEffect(() => {
    const statusAtTransitionStart = response.status
    setIsStatusTransitioning(true)
    const timer = window.setTimeout(() => {
      if (statusAtTransitionStart === response.status) {
        setIsStatusTransitioning(false)
      }
    }, STATUS_TRANSITION_MS)

    return () => {
      window.clearTimeout(timer)
    }
  }, [response.status])

  const shouldShowPendingFooter =
    response.status === ToolCallResponseStatus.PendingApproval
  const shouldShowRunningFooter =
    showRunningFooter &&
    response.status === ToolCallResponseStatus.Running &&
    showRunningActions
  const footerMode: 'pending' | 'running' | null = shouldShowPendingFooter
    ? 'pending'
    : shouldShowRunningFooter
      ? 'running'
      : null

  useEffect(() => {
    const shouldShowCompactionPendingHint =
      showCompactionPendingHint &&
      response.status === ToolCallResponseStatus.Success

    if (shouldShowCompactionPendingHint) {
      setRenderCompactionPendingHint(true)
      setIsCompactionPendingHintExiting(false)
      return
    }

    if (!renderCompactionPendingHint) {
      return
    }

    setIsCompactionPendingHintExiting(true)
    const timer = window.setTimeout(() => {
      setRenderCompactionPendingHint(false)
      setIsCompactionPendingHintExiting(false)
    }, COMPACTION_PENDING_EXIT_MS)

    return () => {
      window.clearTimeout(timer)
    }
  }, [renderCompactionPendingHint, response.status, showCompactionPendingHint])

  useEffect(() => {
    if (footerMode) {
      setDisplayFooterMode(footerMode)
      setRenderFooter(true)
      setIsFooterVisible(true)
      return
    }

    if (!renderFooter) {
      setDisplayFooterMode(null)
      return
    }

    setIsFooterVisible(false)
    const timer = window.setTimeout(() => {
      setRenderFooter(false)
      setDisplayFooterMode(null)
    }, STATUS_TRANSITION_MS)

    return () => {
      window.clearTimeout(timer)
    }
  }, [footerMode, renderFooter])

  return (
    <div className="smtcmp-toolcall">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="smtcmp-toolcall-header"
        aria-expanded={isOpen}
        aria-controls={`smtcmp-toolcall-content-${request.id}`}
      >
        <div
          className={cx(
            'smtcmp-toolcall-header-icon smtcmp-toolcall-header-icon--status-inline',
            isStatusTransitioning && 'smtcmp-toolcall-status-transition',
          )}
        >
          <StatusIcon status={response.status} />
        </div>
        <div className="smtcmp-toolcall-header-content">
          <span
            className={cx(
              'smtcmp-toolcall-header-tool-name',
              isStatusTransitioning && 'smtcmp-toolcall-status-transition',
            )}
          >
            <span className="smtcmp-toolcall-header-title">
              {headlineParts.titleText}
            </span>
            {headlineParts.summaryText && (
              <>
                <span className="smtcmp-toolcall-header-separator">: </span>
                <span
                  className="smtcmp-toolcall-header-summary"
                  title={headlineParts.summaryText}
                >
                  {headlineParts.summaryText}
                </span>
              </>
            )}
            {typeof headlineParts.addedLines === 'number' &&
              typeof headlineParts.removedLines === 'number' &&
              (headlineParts.addedLines > 0 ||
                headlineParts.removedLines > 0) && (
                <span className="smtcmp-toolcall-header-edit-deltas">
                  {headlineParts.addedLines > 0 && (
                    <span className="smtcmp-toolcall-header-edit-added">
                      +{headlineParts.addedLines}
                    </span>
                  )}
                  {headlineParts.removedLines > 0 && (
                    <span className="smtcmp-toolcall-header-edit-removed">
                      -{headlineParts.removedLines}
                    </span>
                  )}
                </span>
              )}
          </span>
        </div>
        <div className="smtcmp-toolcall-header-icon smtcmp-toolcall-header-icon--expand">
          {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </div>
      </button>
      {isOpen && (
        <div
          id={`smtcmp-toolcall-content-${request.id}`}
          className="smtcmp-toolcall-content"
        >
          <div className="smtcmp-toolcall-content-section">
            <div>{toolLabels.parameters}:</div>
            <ObsidianCodeBlock language="json" content={parameters} />
          </div>
          {isDelegateExternalAgentRequest(request) ? (
            // delegate_external_agent 专属卡片：流式输出 + 状态徽章
            <ExternalAgentToolCard
              toolCallId={request.id}
              response={response}
              args={extractExternalAgentArgs(request.arguments)}
              onAbort={handleAbort}
            />
          ) : (
            <>
              {response.status === ToolCallResponseStatus.Success && (
                <div className="smtcmp-toolcall-content-section">
                  <div>{toolLabels.result}:</div>
                  <ObsidianCodeBlock content={response.data.text} />
                </div>
              )}
              {response.status === ToolCallResponseStatus.Error && (
                <div className="smtcmp-toolcall-content-section">
                  <div>{toolLabels.error}:</div>
                  <ObsidianCodeBlock content={response.error} />
                </div>
              )}
            </>
          )}
        </div>
      )}
      {renderCompactionPendingHint && (
        <div
          className={cx(
            'smtcmp-toolcall-compaction-pending',
            isCompactionPendingHintExiting &&
              'smtcmp-toolcall-compaction-pending--exiting',
          )}
          aria-live="polite"
        >
          <Loader2
            size={12}
            className="smtcmp-toolcall-compaction-pending-icon"
          />
          <span>
            {t(
              'chat.compaction.pendingStatus',
              '正在整理上下文，稍后将从新的上下文继续。',
            )}
          </span>
        </div>
      )}
      {renderFooter && (
        <div
          className={cx(
            'smtcmp-toolcall-footer',
            isFooterVisible
              ? 'smtcmp-toolcall-footer--visible'
              : 'smtcmp-toolcall-footer--hiding',
          )}
        >
          {displayFooterMode === 'pending' && (
            <div className="smtcmp-toolcall-footer-actions">
              {isAlwaysAllowDisabled ? (
                // 始终允许已禁用：直接渲染普通按钮，不展示下拉菜单
                <button
                  type="button"
                  onClick={() => {
                    void handleToolCall()
                    setIsOpen(false)
                  }}
                >
                  {toolLabels.allow}
                </button>
              ) : (
                <SplitButton
                  primaryText={toolLabels.allow}
                  onPrimaryClick={() => {
                    void handleToolCall()
                    setIsOpen(false)
                  }}
                  menuOptions={[
                    {
                      label: toolLabels.allowForThisChat,
                      onClick: () => {
                        void handleAllowForConversation()
                        setIsOpen(false)
                      },
                    },
                  ]}
                />
              )}
              <button
                type="button"
                onClick={() => {
                  handleReject()
                  setIsOpen(false)
                }}
              >
                {toolLabels.reject}
              </button>
            </div>
          )}
          {displayFooterMode === 'running' && (
            <div className="smtcmp-toolcall-footer-actions">
              <button
                type="button"
                onClick={() => {
                  void handleAbort()
                }}
              >
                {toolLabels.abort}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function useToolCall(
  request: ToolCallRequest,
  conversationId: string,
  toolMessageId: string,
  onResponseUpdate: (response: ToolCallResponse) => void,
  onRecoverToolCall?: (payload: {
    conversationId: string
    toolMessageId: string
    request: ToolCallRequest
    allowForConversation?: boolean
  }) => Promise<boolean>,
) {
  const plugin = usePlugin()
  const showReloadNotice = useCallback(() => {
    new Notice(
      '该工具调用来自已结束或已重载的会话，无法继续执行，请重新发起请求。',
    )
  }, [])

  const tryRecoverToolCall = useCallback(
    async (allowForConversation = false): Promise<boolean> => {
      if (!onRecoverToolCall) {
        return false
      }

      return onRecoverToolCall({
        conversationId,
        toolMessageId,
        request,
        allowForConversation,
      })
    },
    [conversationId, onRecoverToolCall, request, toolMessageId],
  )

  const handleToolCall = useCallback(async () => {
    const approved = await plugin.getAgentService().approveToolCall({
      conversationId,
      toolCallId: request.id,
    })
    if (!approved) {
      const recovered = await tryRecoverToolCall()
      if (!recovered) {
        showReloadNotice()
      }
    }
  }, [conversationId, plugin, request.id, showReloadNotice, tryRecoverToolCall])

  const handleAllowForConversation = useCallback(async () => {
    const approved = await plugin.getAgentService().approveToolCall({
      conversationId,
      toolCallId: request.id,
      allowForConversation: true,
    })
    if (!approved) {
      const recovered = await tryRecoverToolCall(true)
      if (!recovered) {
        showReloadNotice()
      }
    }
  }, [conversationId, plugin, request.id, showReloadNotice, tryRecoverToolCall])

  const handleReject = useCallback(() => {
    const rejected = plugin.getAgentService().rejectToolCall({
      conversationId,
      toolCallId: request.id,
    })
    if (!rejected) {
      onResponseUpdate({
        status: ToolCallResponseStatus.Rejected,
      })
    }
  }, [conversationId, onResponseUpdate, plugin, request.id])

  const handleAbort = useCallback(async () => {
    const aborted = plugin.getAgentService().abortToolCall({
      conversationId,
      toolCallId: request.id,
    })
    if (!aborted) {
      onResponseUpdate({
        status: ToolCallResponseStatus.Aborted,
      })
    }
  }, [conversationId, onResponseUpdate, plugin, request.id])

  return {
    handleToolCall,
    handleAllowForConversation,
    handleReject,
    handleAbort,
  }
}

function StatusIcon({ status }: { status: ToolCallResponseStatus }) {
  switch (status) {
    case ToolCallResponseStatus.PendingApproval:
      return <span className="smtcmp-toolcall-status-dot" />
    case ToolCallResponseStatus.Rejected:
    case ToolCallResponseStatus.Aborted:
    case ToolCallResponseStatus.Error:
      return <X size={16} className="smtcmp-icon-error" />
    case ToolCallResponseStatus.Running:
      return <Loader2 size={16} className="smtcmp-spinner" />
    case ToolCallResponseStatus.Success:
      return (
        <span className="smtcmp-toolcall-status-success-ring">
          <Check size={11} className="smtcmp-toolcall-status-success-check" />
        </span>
      )
    default:
      return null
  }
}

export default ToolMessage
