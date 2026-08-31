import cx from 'clsx'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react'
import { Notice } from 'obsidian'
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react'

import { useLanguage } from '../../contexts/language-context'
import {
  getPendingDangerousBashApproval,
  resolveDangerousBashApproval,
  subscribeDangerousBashApproval,
} from '../../core/agent/bash/dangerousOperationGate'
import { CLAUDE_EXIT_PLAN_MODE_TOOL } from '../../core/cli-runtime/claude/exitPlanMode'
import {
  getCliToolCallDisplayName,
  getCliToolPresentationArguments,
  isCliToolCallCapability,
} from '../../core/cli-runtime/tool-call'
import { InvalidToolNameException } from '../../core/mcp/exception'
import {
  getLocalFileToolServerName,
  isAskUserQuestionToolName,
  parseLocalFsActionFromToolArgs,
} from '../../core/mcp/localFileTools'
import { parseToolName } from '../../core/mcp/tool-name-utils'
import {
  LOAD_TOOL_SCHEMAS_CHAT_LABEL,
  LOAD_TOOL_SCHEMAS_TOOL_NAME,
  getLoadToolSchemasChatSummary,
} from '../../core/tools/internal/load_tool_schemas/definition'
import {
  getCapabilityForTool,
  isBuiltinToolName,
  listBuiltinTools,
} from '../../core/tools/registry'
import { summarizeShellCommand } from '../../core/tools/shell-command-summary'
import {
  MOTION_DURATION_ENTER_S,
  MOTION_DURATION_EXIT_S,
  MOTION_EASE_OUT,
} from '../../styles/tokens/motion'
import {
  ChatMessage,
  ChatSubagentResultMessage,
  ChatTerminalCommandResultMessage,
  ChatToolMessage,
} from '../../types/chat'
import {
  ToolCallRequest,
  ToolCallResponse,
  ToolCallResponseStatus,
  type ToolFsReadOperationSummary,
  createCompleteToolCallArguments,
  getToolCallArgumentsObject,
  getToolCallArgumentsText,
} from '../../types/tool-call.types'
import { SplitButton } from '../common/SplitButton'

import { AskUserQuestionPanel } from './AskUserQuestionPanel'
import { useChatRuntimeActions } from './chat-runtime-actions-context'
import { useCliSubagent } from './cli-subagent-context'
import { ObsidianCodeBlock } from './ObsidianMarkdown'
import {
  handleRuntimeToolAbort,
  handleRuntimeToolApproval,
  handleRuntimeToolRejection,
} from './runtime-action-handlers'
import { CliSubagentCard } from './tool-cards/CliSubagentCard'
import { LiveTaskCard } from './tool-cards/LiveTaskCard'
import { type ToolRenderer, getToolRenderer } from './tool-renderers'
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
  rejectionReason: string
  allow: string
  reject: string
  abort: string
  allowForThisChat: string
  approvePlan: string
  stayInPlan: string
  todoWriteCleared: string
  todoWriteAllCompleted: (count: number) => string
  todoWriteCreated: (count: number) => string
  todoWriteProgress: (done: number, total: number) => string
  terminalCommandSessionPoll: (sessionId: number) => string
  terminalCommandSessionKill: (sessionId: number) => string
  terminalCommandSessionInput: (
    sessionId: number,
    inputPreview: string,
  ) => string
}

const DEFAULT_STATUS_LABELS: Record<ToolCallResponseStatus, string> = {
  [ToolCallResponseStatus.PendingApproval]: 'Call',
  [ToolCallResponseStatus.Rejected]: 'Rejected',
  [ToolCallResponseStatus.Running]: 'Running',
  [ToolCallResponseStatus.Success]: '',
  [ToolCallResponseStatus.Error]: 'Failed',
  [ToolCallResponseStatus.Aborted]: 'Aborted',
  [ToolCallResponseStatus.AwaitingUserInput]: 'Awaiting',
}

type ToolRequestLike = {
  name: string
  arguments?: ToolCallRequest['arguments']
  metadata?: ToolCallRequest['metadata']
}

const DEFAULT_WRITE_ACTION_LABELS: Record<string, string> = {
  write: 'Write file',
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
      [ToolCallResponseStatus.AwaitingUserInput]: translate(
        'chat.toolCall.status.awaitingUserInput',
        DEFAULT_STATUS_LABELS[ToolCallResponseStatus.AwaitingUserInput],
      ),
    },
    unknownStatus: translate('chat.toolCall.status.unknown', 'Unknown'),
    // Every registered tool's `chatLabel` (core/tools/registry.ts) is wired
    // here automatically, so adding a new built-in tool only needs its
    // `chatLabel` field (+ i18n keys), not a manual update of this map.
    // `load_tool_schemas` isn't a registered tool (it's a protocol-internal
    // tool — see its own doc comment) but is still user-visible mid-chat, so
    // its label is folded in next to the registry-derived ones from its own
    // standalone `LOAD_TOOL_SCHEMAS_CHAT_LABEL` export. `fs_write`'s own
    // `chatLabel` already resolves to the same
    // `chat.toolCall.writeAction.write` key/fallback this map used to
    // hardcode, so it is not repeated below.
    //
    // Retired fs_* write-action tool names (fs_list, fs_search, fs_delete,
    // fs_create_dir, fs_move, and their even older fs_create_file /
    // fs_delete_file / fs_delete_dir aliases) used to get their own explicit
    // overrides here purely to keep historical conversations rendering a
    // friendly label. D8/D10 (master.md decision 10) deliberately drop that:
    // they now fall through to the `?? toolName` default just below, same as
    // any other retired or third-party tool name — self-consistent with how
    // module tools and remote MCP tools have always rendered, and with how
    // this same map already treats every OTHER retired tool. The only
    // user-visible effect is on conversations from before 2026-08-08 (schema
    // v79, when the virtual `bash` tool retired these): their headline shows
    // the bare tool name instead of a translated label. Parameters, results,
    // and status render unaffected either way.
    displayNames: {
      ...Object.fromEntries(
        listBuiltinTools().map((tool) => [
          tool.name,
          translate(tool.chatLabel.key, tool.chatLabel.fallback),
        ]),
      ),
      [LOAD_TOOL_SCHEMAS_TOOL_NAME]: translate(
        LOAD_TOOL_SCHEMAS_CHAT_LABEL.key,
        LOAD_TOOL_SCHEMAS_CHAT_LABEL.fallback,
      ),
      // Skill bodies are read through fs_read, but expose their product-level
      // meaning in the transcript rather than the transport implementation.
      open_skill: translate(
        'chat.toolCall.displayName.open_skill',
        'Open skill',
      ),
    },
    // Only `write` remains: it's the sole action `parseLocalFsActionFromToolArgs`
    // can still produce (`fs_write` is the only entry left in
    // `LOCAL_FS_SPLIT_ACTION_TOOL_TO_ACTION`). The retired delete/create_dir/move
    // (and even older create_file/delete_file/delete_dir) action labels are
    // dropped for the same reason as the retired `displayNames` entries above.
    writeActionLabels: {
      write: translate(
        'chat.toolCall.writeAction.write',
        DEFAULT_WRITE_ACTION_LABELS.write,
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
    rejectionReason: translate(
      'chat.toolCall.rejectionReason',
      'Rejection reason',
    ),
    allow: translate('chat.toolCall.allow', 'Allow'),
    reject: translate('chat.toolCall.reject', 'Reject'),
    abort: translate('chat.toolCall.abort', 'Abort'),
    allowForThisChat: translate(
      'chat.toolCall.allowForThisChat',
      'Allow for this chat',
    ),
    approvePlan: translate('chat.toolCall.approvePlan', 'Approve plan'),
    stayInPlan: translate('chat.toolCall.stayInPlan', 'Stay in plan'),
    todoWriteCleared: translate(
      'chat.toolSummary.todoWrite.cleared',
      'Cleared list',
    ),
    todoWriteAllCompleted: (count: number) =>
      translate(
        'chat.toolSummary.todoWrite.allCompleted',
        'All completed ({count})',
      ).replace('{count}', String(count)),
    todoWriteCreated: (count: number) =>
      translate(
        'chat.toolSummary.todoWrite.created',
        'Planned {count} tasks',
      ).replace('{count}', String(count)),
    todoWriteProgress: (done: number, total: number) =>
      translate(
        'chat.toolSummary.todoWrite.progress',
        'Progress {done}/{total}',
      )
        .replace('{done}', String(done))
        .replace('{total}', String(total)),
    terminalCommandSessionPoll: (sessionId: number) =>
      translate(
        'chat.toolSummary.terminalCommand.sessionPoll',
        'Session {id} · Poll',
      ).replace('{id}', String(sessionId)),
    terminalCommandSessionKill: (sessionId: number) =>
      translate(
        'chat.toolSummary.terminalCommand.sessionKill',
        'Session {id} · Kill',
      ).replace('{id}', String(sessionId)),
    terminalCommandSessionInput: (sessionId: number, inputPreview: string) =>
      translate(
        'chat.toolSummary.terminalCommand.sessionInput',
        'Session {id} · Input: {preview}',
      )
        .replace('{id}', String(sessionId))
        .replace('{preview}', inputPreview),
  }
}

const isLegacyDelegateExternalAgentRequest = (
  request: ToolRequestLike,
): boolean => {
  try {
    const { toolName } = parseToolName(request.name)
    return toolName === 'delegate_external_agent'
  } catch {
    return false
  }
}

const isDelegateSubagentRequest = (request: ToolRequestLike): boolean => {
  try {
    const { toolName } = parseToolName(request.name)
    return toolName === 'delegate_subagent'
  } catch {
    return false
  }
}

const isTerminalCommandRequest = (request: ToolRequestLike): boolean => {
  if (isCliToolCallCapability(request, 'command_execution')) return true
  try {
    const { toolName } = parseToolName(request.name)
    return toolName === 'terminal_command'
  } catch {
    return false
  }
}

// The virtual vault bash tool shares the terminal card's header presentation
// (mono command summary, terminal icon) but not its live-session machinery
// (result hydration, running-footer suppression, LiveTaskCard) — bash returns
// one plain text result and hosts its own dangerous-op confirmation footer.
const isVirtualBashRequest = (request: ToolRequestLike): boolean => {
  try {
    const { toolName } = parseToolName(request.name)
    return toolName === 'bash'
  } catch {
    return false
  }
}

/**
 * Looks up this request's `TOOL_RENDERERS` entry — but only for local
 * built-in tools, mirroring the `serverName === localServerName` gate
 * `getToolDisplayInfo` already uses (D8: "内置工具查 TOOL_RENDERERS，其余走
 * generic", master.md's own framing for this gate after D8). Returns `null`
 * for remote MCP tools, retired local tool names, and any request whose name
 * doesn't parse — `getToolRenderer` itself already degrades unknown names to
 * `genericRenderer`, but that's the wrong answer here: a *remote* tool that
 * happens to share a short name with a built-in one (e.g. some other
 * server's own "bash") must never pick up the built-in's custom card.
 */
const getLocalBuiltinToolRenderer = (
  request: ToolRequestLike,
): ToolRenderer | null => {
  try {
    const { serverName, toolName } = parseToolName(request.name)
    if (serverName !== getLocalFileToolServerName()) {
      return null
    }
    return getToolRenderer(toolName)
  } catch (error) {
    if (!(error instanceof InvalidToolNameException)) {
      throw error
    }
    return null
  }
}

const extractLegacyExternalAgentArgs = (
  rawArguments?: ToolCallRequest['arguments'],
): { command?: string; workingDirectory?: string } | undefined => {
  const parsed = getToolCallArgumentsObject(rawArguments)
  if (!parsed) return undefined
  const prompt =
    typeof parsed.prompt === 'string' ? parsed.prompt.trim() : undefined
  const workingDirectory =
    typeof parsed.workingDirectory === 'string'
      ? parsed.workingDirectory
      : undefined
  if (!prompt && !workingDirectory) return undefined
  return { command: prompt, workingDirectory }
}

const extractTerminalCommandArgs = (
  rawArguments?: ToolCallRequest['arguments'],
): { command?: string; workingDirectory?: string } | undefined => {
  const parsed = getToolCallArgumentsObject(rawArguments)
  if (!parsed) return undefined
  const command =
    typeof parsed.command === 'string' ? parsed.command : undefined
  const workingDirectory =
    typeof parsed.cwd === 'string' ? parsed.cwd : undefined
  if (!command && !workingDirectory) return undefined
  return { command, workingDirectory }
}

const extractSyntheticLiveTaskOutput = (
  rawArguments?: ToolCallRequest['arguments'],
): { stdout?: string; stderr?: string } => {
  const parsed = getToolCallArgumentsObject(rawArguments)
  if (!parsed) return {}
  return {
    stdout: typeof parsed.stdout === 'string' ? parsed.stdout : undefined,
    stderr: typeof parsed.stderr === 'string' ? parsed.stderr : undefined,
  }
}

const truncateText = (text: string, maxLength: number): string => {
  if (text.length <= maxLength) {
    return text
  }
  return `${text.slice(0, maxLength - 1)}...`
}

const TOOL_RESULT_DISPLAY_MAX_CHARS = 12000

/**
 * 工具进入 Running 后，等待这么久仍未结束才展示中止按钮。
 * 更短的调用由用户输入框的整体停止按钮兜底，不必为其闪现一次卡片内按钮。
 */
const RUNNING_ABORT_ACTION_DELAY_MS = 5000

export const getToolResultDisplayText = ({
  response,
}: {
  response: ToolCallResponse
}): string => {
  if (response.status !== ToolCallResponseStatus.Success) {
    return ''
  }

  const text = response.data.text
  if (text.length <= TOOL_RESULT_DISPLAY_MAX_CHARS) {
    return text
  }

  const hiddenChars = text.length - TOOL_RESULT_DISPLAY_MAX_CHARS
  return `${text.slice(
    0,
    TOOL_RESULT_DISPLAY_MAX_CHARS,
  )}\n\n[Display shortened by ${hiddenChars} characters. The assistant received the full tool result.]`
}

const mapTerminalCommandResultStatus = (
  status: ChatTerminalCommandResultMessage['status'],
): ToolCallResponseStatus => {
  switch (status) {
    case 'running':
      return ToolCallResponseStatus.Running
    case 'completed':
      return ToolCallResponseStatus.Success
    case 'cancelled':
    case 'killed_by_shutdown':
      return ToolCallResponseStatus.Aborted
    case 'failed':
    case 'timed_out':
      return ToolCallResponseStatus.Error
  }
}

const buildHydratedTerminalCommandResponse = (
  result: ChatTerminalCommandResultMessage,
  fallback: ToolCallResponse,
): ToolCallResponse => {
  const status = mapTerminalCommandResultStatus(result.status)
  const combined =
    result.stderr && result.stdout
      ? `${result.stderr}\n---\n${result.stdout}`
      : result.stderr || result.stdout

  if (status === ToolCallResponseStatus.Success) {
    return {
      status,
      data: { type: 'text', text: combined },
    }
  }
  if (status === ToolCallResponseStatus.Aborted) {
    return {
      status,
      data: combined ? { type: 'text', text: combined } : undefined,
    }
  }
  if (status === ToolCallResponseStatus.Error) {
    const label = result.status === 'timed_out' ? 'Timed out.' : 'Failed.'
    return {
      status,
      error: combined ? `${label}\n${combined}` : label,
    }
  }
  return fallback
}

const parseToolArguments = (
  rawArguments?: ToolCallRequest['arguments'],
): Record<string, unknown> | null => {
  return getToolCallArgumentsObject(rawArguments) ?? null
}

const getToolCallParametersText = (
  rawArguments: ToolCallRequest['arguments'] | undefined,
  noParametersLabel: string,
): string => {
  if (!rawArguments) {
    return noParametersLabel
  }
  const parsed = getToolCallArgumentsObject(rawArguments)
  if (parsed) {
    return JSON.stringify(parsed, null, 2)
  }
  return getToolCallArgumentsText(rawArguments) ?? noParametersLabel
}

const getFsReadOperationSummary = ({
  response,
}: {
  response?: ToolCallResponse
}): ToolFsReadOperationSummary | undefined => {
  if (response?.status !== ToolCallResponseStatus.Success) {
    return undefined
  }
  return response.data.metadata?.fsReadOperation
}

const formatFsReadHeadlineMode = (
  operation: ToolFsReadOperationSummary | undefined,
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

  let parsedToolName: { serverName: string; toolName: string }
  try {
    parsedToolName = parseToolName(request.name)
  } catch (error) {
    if (!(error instanceof InvalidToolNameException)) {
      throw error
    }
    return displayInfo
  }

  const { serverName, toolName } = parsedToolName
  if (serverName !== getLocalFileToolServerName()) {
    return displayInfo
  }

  if (toolName === 'fs_read') {
    const operation = getFsReadOperationSummary({ response })
    if (operation?.skillNames?.length) {
      return {
        displayName: labels.displayNames.open_skill || displayInfo.displayName,
        summaryText: operation.skillNames.join(', '),
      }
    }

    const modeText = formatFsReadHeadlineMode(operation, labels)
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

  if (toolName === 'delegate_subagent') {
    return {
      ...displayInfo,
      summaryText: getDelegateSubagentSummary({ request }),
    }
  }

  return displayInfo
}

type ToolSuccessIconKind = 'default' | 'skill' | 'terminal'

export const getToolSuccessIconKind = ({
  request,
  response,
}: {
  request: ToolRequestLike
  response?: ToolCallResponse
}): ToolSuccessIconKind => {
  if (isCliToolCallCapability(request, 'command_execution')) {
    return 'terminal'
  }
  let toolName: string
  try {
    const parsed = parseToolName(request.name)
    if (parsed.serverName !== getLocalFileToolServerName()) {
      return 'default'
    }
    toolName = parsed.toolName
  } catch (error) {
    if (!(error instanceof InvalidToolNameException)) {
      throw error
    }
    return 'default'
  }

  if (
    toolName === 'fs_read' &&
    getFsReadOperationSummary({ response })?.skillNames?.length
  ) {
    return 'skill'
  }

  return toolName === 'terminal_command' || toolName === 'bash'
    ? 'terminal'
    : 'default'
}

const DELEGATE_SUMMARY_MAX_CHARS = 80

const getDelegateSubagentSummary = ({
  request,
}: {
  request: ToolRequestLike
}): string | undefined => {
  const argsObject = parseToolArguments(request.arguments)
  const title =
    typeof argsObject?.description === 'string'
      ? argsObject.description.trim()
      : ''
  const mainText =
    typeof argsObject?.prompt === 'string' ? argsObject.prompt.trim() : ''

  const collapsedMain = mainText
    ? truncateText(mainText.replace(/\s+/g, ' '), DELEGATE_SUMMARY_MAX_CHARS)
    : ''

  if (!title && !collapsedMain) {
    return undefined
  }
  if (!title) return collapsedMain
  if (!collapsedMain) return title
  return `${title} | ${collapsedMain}`
}

/**
 * By-name summary dispatch (D8, phase2-migration.md). Replaced a ~12-branch
 * `if (toolName === 'x')` chain with a lookup into `TOOL_RENDERERS`
 * (`getToolRenderer(toolName).summary`) — the same exhaustive wiring table
 * `ToolMessage.tsx` uses below for custom card rendering.
 *
 * Retired tool names (`fs_list`, `fs_search`, `fs_delete`, `fs_create_dir`,
 * `fs_move`, and their even older `fs_create_file`/`fs_delete_file`/
 * `fs_delete_dir` aliases) have no registry entry, so they fall straight
 * through to the final dead-but-harmless fallback below and render with no
 * summary text at all (master.md decision 10 — deliberately not preserved;
 * see that decision's argument for why).
 */
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
  // `load_tool_schemas` is a protocol-internal tool (not a `CAPABILITIES`
  // member — see its own definition's doc comment), so it has no
  // `TOOL_RENDERERS` entry and is handled here explicitly, next to how
  // `displayNames` above folds in its `LOAD_TOOL_SCHEMAS_CHAT_LABEL`.
  if (toolName === LOAD_TOOL_SCHEMAS_TOOL_NAME) {
    return getLoadToolSchemasChatSummary({ argumentsObject })
  }

  if (isBuiltinToolName(toolName)) {
    const summary = getToolRenderer(toolName).summary?.({
      argumentsObject,
      labels,
    })
    if (summary !== undefined) {
      return summary
    }
  }

  // Dead-but-harmless fallback: `parseLocalFsActionFromToolArgs` only ever
  // returns a non-null action for the literal tool name `fs_write` (the
  // sole entry in `LOCAL_FS_SPLIT_ACTION_TOOL_TO_ACTION`), and `fs_write` is
  // always caught by the registry lookup above — so `action` can never be
  // non-null here in practice. Kept anyway to stay consistent with
  // `getToolDisplayInfo`'s parallel (and equally dead-for-fs_write) use of
  // the same helper just below.
  const action = parseLocalFsActionFromToolArgs({
    toolName,
    args: getToolCallArgumentsObject(rawArguments),
  })
  if (action) {
    return labels.writeActionLabels[action] ?? action
  }

  return undefined
}

export const getToolDisplayInfo = (
  request: ToolRequestLike,
  labels: ToolLabels = getToolLabels(),
): ToolDisplayInfo => {
  const localServerName = getLocalFileToolServerName()
  const argumentsObject = parseToolArguments(request.arguments)
  const cliToolCall = request.metadata?.cliToolCall
  if (cliToolCall) {
    const isCommandExecution = cliToolCall.capability === 'command_execution'
    const summaryText =
      isCommandExecution && typeof argumentsObject?.command === 'string'
        ? summarizeShellCommand(argumentsObject.command, { streaming: false })
        : undefined
    return {
      displayName: isCommandExecution
        ? (labels.displayNames.terminal_command ?? 'Terminal command')
        : getCliToolCallDisplayName(cliToolCall),
      ...(summaryText ? { summaryText } : {}),
    }
  }
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
  terminalCommandResultsByToolCallId,
  subagentResultsByToolCallId,
  onMessageUpdate,
  onToolCallResponseUpdate,
  onRecoverToolCall,
  onRecoverAnswerUserQuestion,
}: {
  message: ChatToolMessage
  conversationId: string
  isCompactionPending?: boolean
  showRunningFooter?: boolean
  terminalCommandResultsByToolCallId?: ReadonlyMap<
    string,
    ChatTerminalCommandResultMessage
  >
  subagentResultsByToolCallId?: ReadonlyMap<string, ChatSubagentResultMessage>
  onMessageUpdate: (message: ChatToolMessage) => void
  onToolCallResponseUpdate?: (
    toolMessageId: string,
    toolCallId: string,
    response: ToolCallResponse,
  ) => void
  onRecoverToolCall?: (payload: {
    conversationId: string
    toolMessageId: string
    request: ToolCallRequest
    allowForConversation?: boolean
  }) => Promise<boolean>
  onRecoverAnswerUserQuestion?: (payload: {
    resolvedMessages: ChatMessage[]
    toolCallId: string
  }) => void
}) {
  const handleParentToolCallResponseUpdate = useCallback(
    (toolCallId: string, response: ToolCallResponse) => {
      onToolCallResponseUpdate?.(message.id, toolCallId, response)
    },
    [message.id, onToolCallResponseUpdate],
  )
  const handleFallbackToolCallResponseUpdate = useCallback(
    (toolCallId: string, response: ToolCallResponse) => {
      // Fallback is for read-only/legacy hosts that have not adopted
      // onToolCallResponseUpdate; performance-sensitive chat surfaces should
      // use the parent-owned id update path above.
      onMessageUpdate({
        ...message,
        toolCalls: message.toolCalls.map((toolCall) =>
          toolCall.request.id === toolCallId
            ? { ...toolCall, response }
            : toolCall,
        ),
      })
    },
    [message, onMessageUpdate],
  )
  const handleToolCallResponseUpdate =
    onToolCallResponseUpdate !== undefined
      ? handleParentToolCallResponseUpdate
      : handleFallbackToolCallResponseUpdate

  return (
    <div className="yolo-toolcall-container">
      <AnimatePresence initial={false}>
        {message.toolCalls.map((toolCall, index) => (
          <motion.div
            key={toolCall.request.id}
            className={cx(index > 0 && 'yolo-toolcall-border-top')}
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{
              duration: MOTION_DURATION_ENTER_S,
              ease: MOTION_EASE_OUT,
            }}
          >
            <MemoizedToolCallItem
              request={toolCall.request}
              response={toolCall.response}
              conversationId={conversationId}
              toolMessageId={message.id}
              showCompactionPendingHint={
                isCompactionPending && index === message.toolCalls.length - 1
              }
              showRunningFooter={showRunningFooter}
              terminalCommandResult={terminalCommandResultsByToolCallId?.get(
                toolCall.request.id,
              )}
              subagentResult={subagentResultsByToolCallId?.get(
                toolCall.request.id,
              )}
              onRecoverToolCall={onRecoverToolCall}
              onRecoverAnswerUserQuestion={onRecoverAnswerUserQuestion}
              onResponseUpdate={handleToolCallResponseUpdate}
            />
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
})

type ToolCallItemProps = {
  request: ToolCallRequest
  response: ToolCallResponse
  conversationId: string
  toolMessageId: string
  showCompactionPendingHint?: boolean
  showRunningFooter?: boolean
  terminalCommandResult?: ChatTerminalCommandResultMessage
  subagentResult?: ChatSubagentResultMessage
  onRecoverToolCall?: (payload: {
    conversationId: string
    toolMessageId: string
    request: ToolCallRequest
    allowForConversation?: boolean
  }) => Promise<boolean>
  onRecoverAnswerUserQuestion?: (payload: {
    resolvedMessages: ChatMessage[]
    toolCallId: string
  }) => void
  onResponseUpdate: (toolCallId: string, response: ToolCallResponse) => void
}

/**
 * Subscribes to the ephemeral dangerous-operation gate (see
 * `src/core/agent/bash/dangerousOperationGate.ts`) for a single tool call.
 * Deliberately outside the chat message state tree — this is live "waiting
 * for a click" UI state, not something that belongs in the deep-frozen
 * conversation snapshot.
 */
function useDangerousBashApproval(toolCallId: string) {
  return useSyncExternalStore(
    subscribeDangerousBashApproval,
    () => getPendingDangerousBashApproval(toolCallId),
    () => null,
  )
}

function ToolCallItem({
  request,
  response,
  conversationId,
  toolMessageId,
  showCompactionPendingHint = false,
  showRunningFooter = true,
  terminalCommandResult,
  subagentResult,
  onRecoverToolCall,
  onRecoverAnswerUserQuestion,
  onResponseUpdate,
}: ToolCallItemProps) {
  const cliSubagent = useCliSubagent(request.id)
  const isNestedCliToolCall = Boolean(
    request.metadata?.cliToolCall?.parentCallId,
  )
  const isAskUserQuestion = useMemo(
    () =>
      isCliToolCallCapability(request, 'user_question') ||
      isAskUserQuestionToolName(request.name),
    [request],
  )
  if (isAskUserQuestion) {
    // The tool has no execute path: the gateway either parks it in
    // AwaitingUserInput (interactive form), or short-circuits to Error /
    // Rejected / Aborted / Success (recoveryless). Render the dedicated panel
    // regardless and let it pick its sub-variant.
    if (request.arguments?.kind === 'partial') {
      return (
        <div className="yolo-ask-user-question yolo-ask-user-question--pending">
          <div className="yolo-ask-user-question-header">
            <Loader2 size={14} className="yolo-spinner" />
            <span>正在生成提问…</span>
          </div>
        </div>
      )
    }
    if (!onRecoverAnswerUserQuestion) {
      throw new Error(
        'ask_user_question: hosting surface must pass onRecoverAnswerUserQuestion. The parent chat surface forgot to wire the recovery handler.',
      )
    }
    const presentationArguments = getCliToolPresentationArguments(request)
    const presentationRequest = presentationArguments
      ? {
          ...request,
          arguments: createCompleteToolCallArguments({
            value: presentationArguments,
          }),
        }
      : request
    return (
      <AskUserQuestionPanel
        request={presentationRequest}
        response={response}
        conversationId={conversationId}
        onRecoverAnswerUserQuestion={onRecoverAnswerUserQuestion}
      />
    )
  }
  const COMPACTION_PENDING_EXIT_MS = 180
  const reduceMotion = useReducedMotion()
  const motionDuration = reduceMotion ? 0 : MOTION_DURATION_EXIT_S
  const {
    handleToolCall,
    handleAllowForConversation,
    handleReject,
    handleAbort,
  } = useToolCall(
    request,
    conversationId,
    toolMessageId,
    (nextResponse) => onResponseUpdate(request.id, nextResponse),
    onRecoverToolCall,
  )
  const dangerousBashApproval = useDangerousBashApproval(request.id)

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
  const isShellCommandSummary = Boolean(
    headlineParts.summaryText &&
      (isTerminalCommandRequest(request) || isVirtualBashRequest(request)) &&
      typeof parseToolArguments(request.arguments)?.command === 'string',
  )
  const effectiveStatus =
    terminalCommandResult && isTerminalCommandRequest(request)
      ? mapTerminalCommandResultStatus(terminalCommandResult.status)
      : response.status
  // 是否禁用"始终允许"按钮（某些高危工具每次必须人审）
  const isExitPlanMode = request.name === CLAUDE_EXIT_PLAN_MODE_TOOL
  const isAlwaysAllowDisabled = useMemo(() => {
    if (isExitPlanMode) return true
    // Module chat mode tools declared `requiresApproval: true` are an
    // unconditional per-call confirmation gate (see `tool-gateway.ts`'s
    // `attachModuleChatModeSnapshot`) — the "always allow this
    // conversation" option would be misleading since the service layer
    // rejects it anyway (see `AgentService.approveToolCall`).
    if (request.metadata?.approvalPolicy === 'always-require-user') return true
    try {
      // D7 (phase2-migration.md D7 item 7): "always allow" is now a
      // capability-level fact (`approval.allowAlwaysAllow`) rather than a
      // hand-maintained tool-name list. Non-capability tools (third-party
      // MCP tools, retired local tool names) resolve to `undefined` here,
      // which correctly means "not disabled" — the pre-refactor list only
      // ever named `bash` and `terminal_command`.
      const { toolName } = parseToolName(request.name)
      return getCapabilityForTool(toolName)?.approval.allowAlwaysAllow === false
    } catch {
      return false
    }
  }, [isExitPlanMode, request.metadata?.approvalPolicy, request.name])
  const pendingAllowLabel = isExitPlanMode
    ? toolLabels.approvePlan
    : toolLabels.allow
  const pendingRejectLabel = isExitPlanMode
    ? toolLabels.stayInPlan
    : toolLabels.reject
  const [showRunningActions, setShowRunningActions] = useState(false)
  const [renderCompactionPendingHint, setRenderCompactionPendingHint] =
    useState(
      showCompactionPendingHint &&
        effectiveStatus === ToolCallResponseStatus.Success,
    )
  const [isCompactionPendingHintExiting, setIsCompactionPendingHintExiting] =
    useState(false)
  useEffect(() => {
    if (
      !showRunningFooter ||
      effectiveStatus !== ToolCallResponseStatus.Running
    ) {
      setShowRunningActions(false)
      return
    }

    const timer = window.setTimeout(() => {
      setShowRunningActions(true)
    }, RUNNING_ABORT_ACTION_DELAY_MS)

    return () => {
      window.clearTimeout(timer)
    }
  }, [effectiveStatus, showRunningFooter])

  const shouldShowPendingFooter =
    effectiveStatus === ToolCallResponseStatus.PendingApproval
  const isCompactLiveTaskRequest = isTerminalCommandRequest(request)
  const shouldShowRunningFooter =
    showRunningFooter &&
    effectiveStatus === ToolCallResponseStatus.Running &&
    showRunningActions &&
    !isCompactLiveTaskRequest
  // A pending rm/mv confirmation inside a running bash call takes priority
  // over the plain "abort" running footer — the user needs to answer it
  // before the script can continue either way.
  const shouldShowDangerousApprovalFooter =
    effectiveStatus === ToolCallResponseStatus.Running &&
    dangerousBashApproval !== null
  const footerMode: 'pending' | 'running' | 'dangerous-approval' | null =
    shouldShowDangerousApprovalFooter
      ? 'dangerous-approval'
      : shouldShowPendingFooter
        ? 'pending'
        : shouldShowRunningFooter
          ? 'running'
          : null
  const shouldShowParameters =
    !isCompactLiveTaskRequest ||
    effectiveStatus === ToolCallResponseStatus.PendingApproval
  useEffect(() => {
    const shouldShowCompactionPendingHint =
      showCompactionPendingHint &&
      effectiveStatus === ToolCallResponseStatus.Success

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
  }, [effectiveStatus, renderCompactionPendingHint, showCompactionPendingHint])

  // `kind: 'replace'` renderers (currently: only `delegate_subagent`'s
  // `SubagentCard`) take over the entire tool-call block — see
  // `tool-renderers/types.ts`'s doc comment. `render()` returns `null` while
  // pending approval (matching the pre-D8 `effectiveStatus !==
  // PendingApproval` guard this replaced — see `delegate_subagent/ui.tsx`'s
  // own doc comment), in which case we fall through to the normal
  // header/approval-footer rendering below exactly as before.
  const localToolRenderer = getLocalBuiltinToolRenderer(request)
  if (localToolRenderer?.kind === 'replace') {
    const rendered = localToolRenderer.render({
      toolCallId: request.id,
      request,
      response,
      conversationId,
      subagentResult,
      onAbort: () => {
        void handleAbort()
      },
    })
    if (rendered !== null) {
      return rendered
    }
  }

  if (
    cliSubagent.presentation &&
    cliSubagent.actions &&
    cliSubagent.sessionRef
  ) {
    return (
      <CliSubagentCard
        presentation={cliSubagent.presentation}
        actions={cliSubagent.actions}
        sessionRef={cliSubagent.sessionRef}
      />
    )
  }

  return (
    <div
      className={cx('yolo-toolcall', {
        'yolo-toolcall--nested': isNestedCliToolCall,
      })}
    >
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="yolo-toolcall-header"
        aria-expanded={isOpen}
        aria-controls={`yolo-toolcall-content-${request.id}`}
      >
        <div className="yolo-toolcall-header-content">
          <span className="yolo-toolcall-header-tool-name">
            <span className="yolo-toolcall-header-title">
              {headlineParts.titleText}
            </span>
            {headlineParts.summaryText && (
              <>
                <span className="yolo-toolcall-header-separator">: </span>
                <AnimatePresence mode="wait">
                  <motion.span
                    key={effectiveStatus}
                    className="yolo-toolcall-header-summary"
                    title={headlineParts.summaryText}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: motionDuration }}
                  >
                    {isShellCommandSummary ? (
                      <span className="yolo-toolcall-header-summary-command">
                        {headlineParts.summaryText}
                      </span>
                    ) : (
                      headlineParts.summaryText
                    )}
                  </motion.span>
                </AnimatePresence>
              </>
            )}
            {typeof headlineParts.addedLines === 'number' &&
              typeof headlineParts.removedLines === 'number' &&
              (headlineParts.addedLines > 0 ||
                headlineParts.removedLines > 0) && (
                <span className="yolo-toolcall-header-edit-deltas">
                  {headlineParts.addedLines > 0 && (
                    <span className="yolo-toolcall-header-edit-added">
                      +{headlineParts.addedLines}
                    </span>
                  )}
                  {headlineParts.removedLines > 0 && (
                    <span className="yolo-toolcall-header-edit-removed">
                      -{headlineParts.removedLines}
                    </span>
                  )}
                </span>
              )}
          </span>
        </div>
        <div className="yolo-toolcall-header-icon yolo-toolcall-header-icon--expand">
          {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </div>
      </button>
      {isOpen &&
        (() => {
          const parameters = getToolCallParametersText(
            request.arguments,
            toolLabels.noParameters,
          )
          const isTerminalLikeRequest =
            isTerminalCommandRequest(request) ||
            isLegacyDelegateExternalAgentRequest(request)
          const effectiveTerminalResponse =
            terminalCommandResult && isTerminalCommandRequest(request)
              ? buildHydratedTerminalCommandResponse(
                  terminalCommandResult,
                  response,
                )
              : response
          const syntheticLiveTaskOutput =
            isTerminalLikeRequest && !terminalCommandResult
              ? extractSyntheticLiveTaskOutput(request.arguments)
              : {}
          const resultDisplayText =
            response.status === ToolCallResponseStatus.Success
              ? getToolResultDisplayText({ response })
              : ''
          // `kind: 'body'` renderers (currently: only `terminal_command`'s
          // `LiveTaskCard` mount, via `core/tools/terminal_command/ui.tsx`)
          // render *inside* this card's content area rather than replacing
          // it — see `tool-renderers/types.ts`'s doc comment.
          const bodyRenderer =
            localToolRenderer?.kind === 'body' ? localToolRenderer : null

          return (
            <div
              id={`yolo-toolcall-content-${request.id}`}
              className="yolo-toolcall-content"
            >
              {shouldShowParameters && (
                <div className="yolo-toolcall-content-section">
                  <div>{toolLabels.parameters}:</div>
                  <ObsidianCodeBlock language="json" content={parameters} />
                </div>
              )}
              {bodyRenderer ? (
                bodyRenderer.render({
                  toolCallId: request.id,
                  request,
                  response: effectiveTerminalResponse,
                  conversationId,
                  terminalCommandResult,
                  onAbort: () => {
                    void handleAbort()
                  },
                })
              ) : isTerminalLikeRequest ? (
                // CLI `command_execution` capability calls and the legacy
                // `delegate_external_agent` tool name also render through
                // `LiveTaskCard`, but neither is tool-name-indexed, so both
                // stay as this inline branch rather than a `TOOL_RENDERERS`
                // entry (D8: non-tool-name branches stay as-is).
                <LiveTaskCard
                  toolCallId={request.id}
                  response={effectiveTerminalResponse}
                  args={
                    isLegacyDelegateExternalAgentRequest(request)
                      ? extractLegacyExternalAgentArgs(request.arguments)
                      : extractTerminalCommandArgs(request.arguments)
                  }
                  initialStdout={
                    terminalCommandResult?.stdout ??
                    syntheticLiveTaskOutput.stdout
                  }
                  initialStderr={
                    terminalCommandResult?.stderr ??
                    syntheticLiveTaskOutput.stderr
                  }
                  onAbort={handleAbort}
                />
              ) : (
                <>
                  {response.status === ToolCallResponseStatus.Success && (
                    <div className="yolo-toolcall-content-section">
                      <div>{toolLabels.result}:</div>
                      <ObsidianCodeBlock content={resultDisplayText} />
                    </div>
                  )}
                  {response.status === ToolCallResponseStatus.Error && (
                    <div className="yolo-toolcall-content-section">
                      <div>{toolLabels.error}:</div>
                      <ObsidianCodeBlock content={response.error} />
                    </div>
                  )}
                  {response.status === ToolCallResponseStatus.Rejected &&
                    response.reason && (
                      <div className="yolo-toolcall-content-section">
                        <div>{toolLabels.rejectionReason}:</div>
                        <ObsidianCodeBlock content={response.reason} />
                      </div>
                    )}
                </>
              )}
            </div>
          )
        })()}
      {renderCompactionPendingHint && (
        <div
          className={cx(
            'yolo-toolcall-compaction-pending',
            isCompactionPendingHintExiting &&
              'yolo-toolcall-compaction-pending--exiting',
          )}
          aria-live="polite"
        >
          <Loader2
            size={12}
            className="yolo-toolcall-compaction-pending-icon"
          />
          <span>
            {t(
              'chat.compaction.pendingStatus',
              '正在整理上下文，稍后将从新的上下文继续。',
            )}
          </span>
        </div>
      )}
      {footerMode && (
        <div key={footerMode} className="yolo-toolcall-footer">
          {footerMode === 'pending' && (
            <div className="yolo-toolcall-footer-actions">
              {isAlwaysAllowDisabled ? (
                // 始终允许已禁用：直接渲染普通按钮，不展示下拉菜单
                <button
                  type="button"
                  onClick={() => {
                    void handleToolCall()
                    setIsOpen(false)
                  }}
                >
                  {pendingAllowLabel}
                </button>
              ) : (
                <SplitButton
                  primaryText={pendingAllowLabel}
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
                {pendingRejectLabel}
              </button>
            </div>
          )}
          {footerMode === 'running' && (
            <div className="yolo-toolcall-footer-actions">
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
          {footerMode === 'dangerous-approval' && dangerousBashApproval && (
            <div className="yolo-toolcall-dangerous-approval">
              <div className="yolo-toolcall-dangerous-approval-title">
                {t(
                  'chat.toolCall.dangerousBash.title',
                  'Dangerous operation needs confirmation',
                )}
              </div>
              <div className="yolo-toolcall-dangerous-approval-summary">
                {dangerousBashApproval.kind === 'rm'
                  ? t(
                      'chat.toolCall.dangerousBash.rmSummary',
                      'About to delete the following paths (moved to trash):',
                    )
                  : t(
                      'chat.toolCall.dangerousBash.mvSummary',
                      'About to move/rename the following paths:',
                    )}
              </div>
              <ul className="yolo-toolcall-dangerous-approval-targets">
                {dangerousBashApproval.targets.map((target) => (
                  <li key={target}>{target}</li>
                ))}
              </ul>
              <div className="yolo-toolcall-footer-actions">
                <button
                  type="button"
                  onClick={() => {
                    resolveDangerousBashApproval(
                      request.id,
                      dangerousBashApproval.requestId,
                      true,
                    )
                  }}
                >
                  {toolLabels.allow}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    resolveDangerousBashApproval(
                      request.id,
                      dangerousBashApproval.requestId,
                      false,
                    )
                  }}
                >
                  {toolLabels.reject}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export const areToolCallItemPropsEqual = (
  prev: ToolCallItemProps,
  next: ToolCallItemProps,
): boolean =>
  prev.request === next.request &&
  prev.response === next.response &&
  prev.conversationId === next.conversationId &&
  prev.toolMessageId === next.toolMessageId &&
  prev.showCompactionPendingHint === next.showCompactionPendingHint &&
  prev.showRunningFooter === next.showRunningFooter &&
  prev.terminalCommandResult === next.terminalCommandResult &&
  prev.subagentResult === next.subagentResult &&
  prev.onRecoverToolCall === next.onRecoverToolCall &&
  prev.onRecoverAnswerUserQuestion === next.onRecoverAnswerUserQuestion &&
  prev.onResponseUpdate === next.onResponseUpdate

const MemoizedToolCallItem = memo(ToolCallItem, areToolCallItemPropsEqual)

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
  const { actions, conversation } = useChatRuntimeActions(conversationId)
  const suppressReloadNotice = isDelegateSubagentRequest(request)
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
    await handleRuntimeToolApproval({
      actions,
      conversation,
      toolCallId: request.id,
      recover: tryRecoverToolCall,
      onStale: suppressReloadNotice ? undefined : showReloadNotice,
    })
  }, [
    actions,
    conversation,
    request.id,
    showReloadNotice,
    suppressReloadNotice,
    tryRecoverToolCall,
  ])

  const handleAllowForConversation = useCallback(async () => {
    await handleRuntimeToolApproval({
      actions,
      conversation,
      toolCallId: request.id,
      allowForConversation: true,
      recover: () => tryRecoverToolCall(true),
      onStale: suppressReloadNotice ? undefined : showReloadNotice,
    })
  }, [
    actions,
    conversation,
    request.id,
    showReloadNotice,
    suppressReloadNotice,
    tryRecoverToolCall,
  ])

  const handleReject = useCallback(() => {
    void handleRuntimeToolRejection({
      actions,
      conversation,
      toolCallId: request.id,
      onStale: () =>
        onResponseUpdate({
          status: ToolCallResponseStatus.Rejected,
        }),
    })
  }, [actions, conversation, onResponseUpdate, request.id])

  const handleAbort = useCallback(async () => {
    await handleRuntimeToolAbort({
      actions,
      conversation,
      toolCallId: request.id,
      onStale: () =>
        onResponseUpdate({
          status: ToolCallResponseStatus.Aborted,
        }),
    })
  }, [actions, conversation, onResponseUpdate, request.id])

  return {
    handleToolCall,
    handleAllowForConversation,
    handleReject,
    handleAbort,
  }
}

export default ToolMessage
