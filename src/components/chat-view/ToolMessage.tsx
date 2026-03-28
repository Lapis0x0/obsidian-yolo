import cx from 'clsx'
import { Check, ChevronDown, ChevronRight, Loader2, X } from 'lucide-react'
import { Notice } from 'obsidian'
import { memo, useCallback, useEffect, useMemo, useState } from 'react'

import { useLanguage } from '../../contexts/language-context'
import { usePlugin } from '../../contexts/plugin-context'
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

const DEFAULT_LOCAL_FILE_TOOL_DISPLAY_NAMES: Record<string, string> = {
  fs_list: 'Read Vault',
  fs_search: 'Search Vault',
  fs_read: 'Read File',
  fs_edit: 'Text editing',
  fs_create_file: 'Create file',
  fs_delete_file: 'Delete file',
  fs_create_dir: 'Create folder',
  fs_delete_dir: 'Delete folder',
  fs_move: 'Move path',
  memory_add: 'Add memory',
  memory_update: 'Update memory',
  memory_delete: 'Delete memory',
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
      fs_list: translate(
        'settings.agent.builtinFsListLabel',
        DEFAULT_LOCAL_FILE_TOOL_DISPLAY_NAMES.fs_list,
      ),
      fs_search: translate(
        'settings.agent.builtinFsSearchLabel',
        DEFAULT_LOCAL_FILE_TOOL_DISPLAY_NAMES.fs_search,
      ),
      fs_read: translate(
        'settings.agent.builtinFsReadLabel',
        DEFAULT_LOCAL_FILE_TOOL_DISPLAY_NAMES.fs_read,
      ),
      fs_edit: translate(
        'settings.agent.builtinFsEditLabel',
        DEFAULT_LOCAL_FILE_TOOL_DISPLAY_NAMES.fs_edit,
      ),
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
      memory_add: translate(
        'chat.toolCall.displayName.memory_add',
        DEFAULT_LOCAL_FILE_TOOL_DISPLAY_NAMES.memory_add,
      ),
      memory_update: translate(
        'chat.toolCall.displayName.memory_update',
        DEFAULT_LOCAL_FILE_TOOL_DISPLAY_NAMES.memory_update,
      ),
      memory_delete: translate(
        'chat.toolCall.displayName.memory_delete',
        DEFAULT_LOCAL_FILE_TOOL_DISPLAY_NAMES.memory_delete,
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
      const displayInfo = getToolDisplayInfo(toolCall.request, labels)
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
  onMessageUpdate,
}: {
  message: ChatToolMessage
  conversationId: string
  onMessageUpdate: (message: ChatToolMessage) => void
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
  onResponseUpdate,
}: {
  request: ToolCallRequest
  response: ToolCallResponse
  conversationId: string
  onResponseUpdate: (response: ToolCallResponse) => void
}) {
  const STATUS_TRANSITION_MS = 180
  const {
    handleToolCall,
    handleAllowForConversation,
    handleReject,
    handleAbort,
  } = useToolCall(request, conversationId, onResponseUpdate)

  const [isOpen, setIsOpen] = useState(
    // Open by default if the tool call requires approval
    response.status === ToolCallResponseStatus.PendingApproval,
  )

  const { t } = useLanguage()
  const toolLabels = useMemo(() => getToolLabels(t), [t])
  const displayInfo = useMemo(
    () => getToolDisplayInfo(request, toolLabels),
    [request, toolLabels],
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

  useEffect(() => {
    if (response.status !== ToolCallResponseStatus.Running) {
      setShowRunningActions(false)
      return
    }

    const timer = window.setTimeout(() => {
      setShowRunningActions(true)
    }, 1000)

    return () => {
      window.clearTimeout(timer)
    }
  }, [response.status])

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
    response.status === ToolCallResponseStatus.Running && showRunningActions
  const footerMode: 'pending' | 'running' | null = shouldShowPendingFooter
    ? 'pending'
    : shouldShowRunningFooter
      ? 'running'
      : null

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
              typeof headlineParts.removedLines === 'number' && (
                <span className="smtcmp-toolcall-header-edit-deltas">
                  <span className="smtcmp-toolcall-header-edit-added">
                    +{headlineParts.addedLines}
                  </span>
                  <span className="smtcmp-toolcall-header-edit-removed">
                    -{headlineParts.removedLines}
                  </span>
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
  onResponseUpdate: (response: ToolCallResponse) => void,
) {
  const plugin = usePlugin()
  const showReloadNotice = useCallback(() => {
    new Notice(
      '该工具调用来自已结束或已重载的会话，无法继续执行，请重新发起请求。',
    )
  }, [])

  const handleToolCall = useCallback(async () => {
    const approved = await plugin.getAgentService().approveToolCall({
      conversationId,
      toolCallId: request.id,
    })
    if (!approved) {
      showReloadNotice()
    }
  }, [conversationId, plugin, request.id, showReloadNotice])

  const handleAllowForConversation = useCallback(async () => {
    const approved = await plugin.getAgentService().approveToolCall({
      conversationId,
      toolCallId: request.id,
      allowForConversation: true,
    })
    if (!approved) {
      showReloadNotice()
    }
  }, [conversationId, plugin, request.id, showReloadNotice])

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
