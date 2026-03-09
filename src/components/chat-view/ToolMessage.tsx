import cx from 'clsx'
import { Check, ChevronDown, ChevronRight, Loader2, X } from 'lucide-react'
import { memo, useCallback, useMemo, useState } from 'react'

import { useLanguage } from '../../contexts/language-context'
import { useMcp } from '../../contexts/mcp-context'
import { useSettings } from '../../contexts/settings-context'
import { InvalidToolNameException } from '../../core/mcp/exception'
import {
  getLocalFileToolServerName,
  parseLocalFsFileOpActionFromArgs,
} from '../../core/mcp/localFileTools'
import { parseToolName } from '../../core/mcp/tool-name-utils'
import { ChatToolMessage } from '../../types/chat'
import {
  ToolCallRequest,
  ToolCallResponse,
  ToolCallResponseStatus,
} from '../../types/tool-call.types'
import { SplitButton } from '../common/SplitButton'

import { ObsidianCodeBlock } from './ObsidianMarkdown'

type TranslateFn = (keyPath: string, fallback?: string) => string

type ToolLabels = {
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
  alwaysAllowThisTool: string
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

type ToolDisplayInfo = {
  displayName: string
  summaryText?: string
}

const DEFAULT_LOCAL_FILE_TOOL_DISPLAY_NAMES: Record<string, string> = {
  fs_list: 'Read Vault',
  fs_search: 'Search Vault',
  fs_read: 'Read File',
  fs_edit: 'Text editing',
  fs_file_ops: 'File operations',
}

const DEFAULT_WRITE_ACTION_LABELS: Record<string, string> = {
  create_file: 'Create file',
  delete_file: 'Delete file',
  create_dir: 'Create folder',
  delete_dir: 'Delete folder',
  move: 'Move path',
}

const getToolLabels = (t?: TranslateFn): ToolLabels => {
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
      fs_file_ops: translate(
        'settings.agent.builtinFsFileOpsLabel',
        DEFAULT_LOCAL_FILE_TOOL_DISPLAY_NAMES.fs_file_ops,
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
    alwaysAllowThisTool: translate(
      'chat.toolCall.alwaysAllowThisTool',
      'Always allow this tool',
    ),
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
  rawArguments?: string,
): Record<string, unknown> | null => {
  if (!rawArguments) {
    return null
  }
  try {
    const parsed = JSON.parse(rawArguments) as unknown
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return null
    }
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
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
  rawArguments?: string
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

  if (toolName === 'fs_file_ops') {
    const action = parseLocalFsFileOpActionFromArgs(rawArguments)
    if (!action) {
      return undefined
    }
    const itemCount = Array.isArray(argumentsObject?.items)
      ? argumentsObject.items.length
      : 0
    const actionLabel = labels.writeActionLabels[action] ?? action
    if (itemCount <= 0) {
      return actionLabel
    }
    return `${actionLabel} x${itemCount}`
  }

  return undefined
}

const getToolDisplayInfo = (
  request: ToolCallRequest,
  labels: ToolLabels = getToolLabels(),
): ToolDisplayInfo => {
  const localServerName = getLocalFileToolServerName()
  const argumentsObject = parseToolArguments(request.arguments)
  try {
    const { serverName, toolName } = parseToolName(request.name)

    if (serverName === localServerName) {
      const isFsFileOps = toolName === 'fs_file_ops'
      const action = isFsFileOps
        ? parseLocalFsFileOpActionFromArgs(request.arguments)
        : null
      const displayName =
        isFsFileOps && action
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

const getToolHeadlineText = ({
  status,
  displayInfo,
  labels,
}: {
  status: ToolCallResponseStatus
  displayInfo: ToolDisplayInfo
  labels: ToolLabels
}): string => {
  const detailSuffix = displayInfo.summaryText
    ? `: ${displayInfo.summaryText}`
    : ''
  if (status === ToolCallResponseStatus.Success) {
    return `${displayInfo.displayName}${detailSuffix}`
  }
  const statusLabels = labels.statusLabels
  const statusLabel = statusLabels[status] || labels.unknownStatus
  return `${statusLabel} ${displayInfo.displayName}${detailSuffix}`
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
        }),
        ...(toolCall.request.arguments
          ? [`${labels.parameters}: ${toolCall.request.arguments}`]
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
  const {
    handleToolCall,
    handleAllowForConversation,
    handleAllowAutoExecution,
    handleReject,
    handleAbort,
  } = useToolCall(request, conversationId, onResponseUpdate)

  const [isOpen, setIsOpen] = useState(
    // Open by default if the tool call requires approval
    response.status === ToolCallResponseStatus.PendingApproval,
  )

  const { serverName } = useMemo(() => {
    try {
      const parsed = parseToolName(request.name)
      return { serverName: parsed.serverName }
    } catch (error) {
      if (error instanceof InvalidToolNameException) {
        return {
          serverName: null,
        }
      }
      throw error
    }
  }, [request.name])
  const { t } = useLanguage()
  const toolLabels = useMemo(() => getToolLabels(t), [t])
  const displayInfo = useMemo(
    () => getToolDisplayInfo(request, toolLabels),
    [request, toolLabels],
  )
  const parameters = useMemo(() => {
    if (!request.arguments) {
      return toolLabels.noParameters
    }
    try {
      return JSON.stringify(JSON.parse(request.arguments), null, 2)
    } catch {
      return request.arguments
    }
  }, [request.arguments, toolLabels.noParameters])
  const supportsAutoAllow = useMemo(
    () => Boolean(serverName) && serverName !== getLocalFileToolServerName(),
    [serverName],
  )

  return (
    <div className="smtcmp-toolcall">
      <div
        onClick={() => setIsOpen(!isOpen)}
        className="smtcmp-toolcall-header"
      >
        <div className="smtcmp-toolcall-header-icon smtcmp-toolcall-header-icon--status-inline">
          <StatusIcon status={response.status} />
        </div>
        <div className="smtcmp-toolcall-header-content">
          <span className="smtcmp-toolcall-header-tool-name">
            {getToolHeadlineText({
              status: response.status,
              displayInfo,
              labels: toolLabels,
            })}
          </span>
        </div>
        <div className="smtcmp-toolcall-header-icon smtcmp-toolcall-header-icon--expand">
          {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </div>
      </div>
      {isOpen && (
        <div className="smtcmp-toolcall-content">
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
      {(response.status === ToolCallResponseStatus.PendingApproval ||
        response.status === ToolCallResponseStatus.Running) && (
        <div className="smtcmp-toolcall-footer">
          {response.status === ToolCallResponseStatus.PendingApproval && (
            <div className="smtcmp-toolcall-footer-actions">
              <SplitButton
                primaryText={toolLabels.allow}
                onPrimaryClick={() => {
                  void handleToolCall()
                  setIsOpen(false)
                }}
                menuOptions={
                  supportsAutoAllow
                    ? [
                        {
                          label: toolLabels.alwaysAllowThisTool,
                          onClick: () => {
                            void handleToolCall()
                            handleAllowAutoExecution()
                            setIsOpen(false)
                          },
                        },
                        {
                          label: toolLabels.allowForThisChat,
                          onClick: () => {
                            void handleToolCall()
                            void handleAllowForConversation()
                            setIsOpen(false)
                          },
                        },
                      ]
                    : [
                        {
                          label: toolLabels.allowForThisChat,
                          onClick: () => {
                            void handleToolCall()
                            void handleAllowForConversation()
                            setIsOpen(false)
                          },
                        },
                      ]
                }
              />
              <button
                onClick={() => {
                  handleReject()
                  setIsOpen(false)
                }}
              >
                {toolLabels.reject}
              </button>
            </div>
          )}
          {response.status === ToolCallResponseStatus.Running && (
            <div className="smtcmp-toolcall-footer-actions">
              <button
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
  const { settings, setSettings } = useSettings()
  const { getMcpManager } = useMcp()

  const handleToolCall = useCallback(async () => {
    const mcpManager = await getMcpManager()
    onResponseUpdate({
      status: ToolCallResponseStatus.Running,
    })
    const toolCallResponse: ToolCallResponse = await mcpManager.callTool({
      name: request.name,
      args: request.arguments,
      id: request.id,
    })
    onResponseUpdate(toolCallResponse)
  }, [request, onResponseUpdate, getMcpManager])

  const handleAllowForConversation = useCallback(async () => {
    const mcpManager = await getMcpManager()
    mcpManager.allowToolForConversation(
      request.name,
      conversationId,
      request.arguments,
    )
  }, [request, conversationId, getMcpManager])

  const handleAllowAutoExecution = useCallback(() => {
    const { serverName, toolName } = parseToolName(request.name)
    const server = settings.mcp.servers.find((s) => s.id === serverName)
    if (!server) {
      console.error(`Server ${serverName} not found`)
      return
    }
    const toolOptions = { ...server.toolOptions }
    if (!toolOptions[toolName]) {
      // If the tool is not in the toolOptions, add it with default values
      toolOptions[toolName] = {
        allowAutoExecution: false,
        disabled: false,
      }
    }
    toolOptions[toolName] = {
      ...toolOptions[toolName],
      allowAutoExecution: true,
    }

    void (async () => {
      try {
        await setSettings({
          ...settings,
          mcp: {
            ...settings.mcp,
            servers: settings.mcp.servers.map((s) =>
              s.id === server.id
                ? {
                    ...s,
                    toolOptions: toolOptions,
                  }
                : s,
            ),
          },
        })
      } catch (error: unknown) {
        console.error('Failed to allow tool auto execution', error)
      }
    })()
  }, [request, settings, setSettings])

  const handleReject = useCallback(() => {
    onResponseUpdate({
      status: ToolCallResponseStatus.Rejected,
    })
  }, [onResponseUpdate])

  const handleAbort = useCallback(async () => {
    const mcpManager = await getMcpManager()
    mcpManager.abortToolCall(request.id)
    onResponseUpdate({
      status: ToolCallResponseStatus.Aborted,
    })
  }, [request, onResponseUpdate, getMcpManager])

  return {
    handleToolCall,
    handleAllowForConversation,
    handleAllowAutoExecution,
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
