import cx from 'clsx'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { Check, ChevronDown, ChevronRight, Loader2, X } from 'lucide-react'
import { Notice } from 'obsidian'
import { memo, useCallback, useEffect, useMemo, useState } from 'react'

import { useLanguage } from '../../contexts/language-context'
import { usePlugin } from '../../contexts/plugin-context'
import {
  BUILTIN_TOOL_UI_META,
  getBuiltinToolUiMeta,
} from '../../core/agent/builtinToolUiMeta'
import { subagentTaskRegistry } from '../../core/agent/subagent/task-registry'
import { ALWAYS_ALLOW_DISABLED_TOOL_NAMES } from '../../core/agent/tool-preferences'
import { InvalidToolNameException } from '../../core/mcp/exception'
import {
  getLocalFileToolServerName,
  isAskUserQuestionToolName,
  parseLocalFsActionFromToolArgs,
} from '../../core/mcp/localFileTools'
import { parseToolName } from '../../core/mcp/tool-name-utils'
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
  getToolCallArgumentsObject,
  getToolCallArgumentsText,
} from '../../types/tool-call.types'
import { SplitButton } from '../common/SplitButton'

import { AskUserQuestionPanel } from './AskUserQuestionPanel'
import { ObsidianCodeBlock } from './ObsidianMarkdown'
import { LiveTaskCard } from './tool-cards/LiveTaskCard'
import { SubagentCard } from './tool-cards/SubagentCard'
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
  fs_write: 'Write file',
  fs_delete: 'Delete',
  fs_create_dir: 'Create folder',
  fs_move: 'Move path',
  // Legacy tool names kept for displaying historical conversations.
  fs_create_file: 'Create file',
  fs_delete_file: 'Delete file',
  fs_delete_dir: 'Delete folder',
}

const DEFAULT_WRITE_ACTION_LABELS: Record<string, string> = {
  write: 'Write file',
  delete: 'Delete',
  create_dir: 'Create folder',
  move: 'Move path',
  // Legacy actions kept for displaying historical conversations.
  create_file: 'Create file',
  delete_file: 'Delete file',
  delete_dir: 'Delete folder',
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
    // Every name registered in BUILTIN_TOOL_UI_META is wired here automatically
    // so adding a new built-in tool only needs the meta entry (+ i18n keys),
    // not a manual update of this map. fs_* write-action labels live in a
    // separate translation namespace and stay as explicit overrides.
    displayNames: {
      ...Object.fromEntries(
        Object.keys(BUILTIN_TOOL_UI_META).map((name) => [
          name,
          translateBuiltinToolLabel(name, translate),
        ]),
      ),
      fs_write: translate(
        'chat.toolCall.writeAction.write',
        DEFAULT_LOCAL_FILE_TOOL_DISPLAY_NAMES.fs_write,
      ),
      fs_delete: translate(
        'chat.toolCall.writeAction.delete',
        DEFAULT_LOCAL_FILE_TOOL_DISPLAY_NAMES.fs_delete,
      ),
      fs_create_dir: translate(
        'chat.toolCall.writeAction.create_dir',
        DEFAULT_LOCAL_FILE_TOOL_DISPLAY_NAMES.fs_create_dir,
      ),
      fs_move: translate(
        'chat.toolCall.writeAction.move',
        DEFAULT_LOCAL_FILE_TOOL_DISPLAY_NAMES.fs_move,
      ),
      // Legacy tool names — keep rendering historical conversations.
      fs_create_file: translate(
        'chat.toolCall.writeAction.create_file',
        DEFAULT_LOCAL_FILE_TOOL_DISPLAY_NAMES.fs_create_file,
      ),
      fs_delete_file: translate(
        'chat.toolCall.writeAction.delete_file',
        DEFAULT_LOCAL_FILE_TOOL_DISPLAY_NAMES.fs_delete_file,
      ),
      fs_delete_dir: translate(
        'chat.toolCall.writeAction.delete_dir',
        DEFAULT_LOCAL_FILE_TOOL_DISPLAY_NAMES.fs_delete_dir,
      ),
    },
    writeActionLabels: {
      write: translate(
        'chat.toolCall.writeAction.write',
        DEFAULT_WRITE_ACTION_LABELS.write,
      ),
      delete: translate(
        'chat.toolCall.writeAction.delete',
        DEFAULT_WRITE_ACTION_LABELS.delete,
      ),
      create_dir: translate(
        'chat.toolCall.writeAction.create_dir',
        DEFAULT_WRITE_ACTION_LABELS.create_dir,
      ),
      move: translate(
        'chat.toolCall.writeAction.move',
        DEFAULT_WRITE_ACTION_LABELS.move,
      ),
      // Legacy actions — keep rendering historical conversations.
      create_file: translate(
        'chat.toolCall.writeAction.create_file',
        DEFAULT_WRITE_ACTION_LABELS.create_file,
      ),
      delete_file: translate(
        'chat.toolCall.writeAction.delete_file',
        DEFAULT_WRITE_ACTION_LABELS.delete_file,
      ),
      delete_dir: translate(
        'chat.toolCall.writeAction.delete_dir',
        DEFAULT_WRITE_ACTION_LABELS.delete_dir,
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
  try {
    const { toolName } = parseToolName(request.name)
    return toolName === 'terminal_command'
  } catch {
    return false
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

const extractSubagentArgs = (
  rawArguments?: ToolCallRequest['arguments'],
): { title?: string } | undefined => {
  const parsed = getToolCallArgumentsObject(rawArguments)
  if (!parsed) return undefined
  const title =
    typeof parsed.description === 'string' ? parsed.description : undefined
  return title ? { title } : undefined
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

const extractAcceptedTaskId = (
  response: ToolCallResponse,
): string | undefined => {
  if (response.status !== ToolCallResponseStatus.Success) return undefined
  try {
    const parsed = JSON.parse(response.data.text) as unknown
    if (!parsed || typeof parsed !== 'object') return undefined
    const taskId = (parsed as Record<string, unknown>).taskId
    return typeof taskId === 'string' ? taskId : undefined
  } catch {
    return undefined
  }
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

const SHELL_COMMAND_SUMMARY_MAX_CHARS = 80
const SHELL_COMMAND_SUMMARY_SIMPLE_MAX_CHARS = 48
const SHELL_COMMAND_SUMMARY_MAX_NAMES = 5
const SHELL_COMMAND_LONG_PREFIX = 'Long bash command'
const SHELL_COMMAND_STREAMING_PREFIX = 'Long bash command with streaming output'
const SHELL_COMMAND_KEYWORDS = new Set([
  'case',
  'do',
  'done',
  'elif',
  'else',
  'esac',
  'fi',
  'for',
  'function',
  'if',
  'in',
  'select',
  'then',
  'until',
  'while',
])
const SHELL_COMMAND_CONTROL_HEADS = new Set([
  'case',
  'for',
  'function',
  'if',
  'select',
  'until',
  'while',
])
const SHELL_COMMAND_WRAPPERS = new Set([
  'builtin',
  'command',
  'env',
  'exec',
  'nohup',
  'sudo',
  'time',
])

const summarizeShellCommand = (
  command: string,
  options: { streaming: boolean },
): string | undefined => {
  const preview = command.trim().replace(/\s+/g, ' ')
  if (!preview) return undefined

  if (
    !options.streaming &&
    preview.length <= SHELL_COMMAND_SUMMARY_SIMPLE_MAX_CHARS
  ) {
    return preview
  }

  const commandNames = extractShellCommandNames(command)
  if (commandNames.length === 0) {
    return truncateText(preview, SHELL_COMMAND_SUMMARY_MAX_CHARS)
  }

  const visibleNames = commandNames.slice(0, SHELL_COMMAND_SUMMARY_MAX_NAMES)
  const hiddenCount = commandNames.length - visibleNames.length
  const commandList = `${visibleNames.join(', ')}${
    hiddenCount > 0 ? ` +${hiddenCount}` : ''
  }`
  const prefix = options.streaming
    ? SHELL_COMMAND_STREAMING_PREFIX
    : SHELL_COMMAND_LONG_PREFIX

  return `${prefix} ${commandList}`
}

const extractShellCommandNames = (command: string): string[] => {
  const names: string[] = []
  const seen = new Set<string>()
  const segments = command.replace(/\$\(/g, ';').split(/[;&|(){}\n]+/)

  for (const segment of segments) {
    const name = extractCommandNameFromShellSegment(segment)
    if (!name || seen.has(name)) continue
    seen.add(name)
    names.push(name)
  }

  return names
}

const extractCommandNameFromShellSegment = (
  segment: string,
): string | undefined => {
  const words = segment
    .trim()
    .split(/\s+/)
    .map((word) => word.replace(/^['"]+|['",]+$/g, ''))
    .filter(Boolean)

  if (SHELL_COMMAND_CONTROL_HEADS.has(words[0])) {
    return undefined
  }

  for (const word of words) {
    if (SHELL_COMMAND_KEYWORDS.has(word)) continue
    if (SHELL_COMMAND_WRAPPERS.has(word)) continue
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue
    if (word.startsWith('-') || word.startsWith('$')) continue
    if (!/^[A-Za-z0-9_.:/-]+$/.test(word)) continue
    const basename = word.split('/').pop() ?? word
    return basename
  }

  return undefined
}

const splitTerminalCommandSummary = (
  summary: string,
): { prefix: string; commands: string } | null => {
  for (const prefix of [
    SHELL_COMMAND_STREAMING_PREFIX,
    SHELL_COMMAND_LONG_PREFIX,
  ]) {
    if (!summary.startsWith(`${prefix} `)) continue
    return {
      prefix,
      commands: summary.slice(prefix.length + 1),
    }
  }
  return null
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

const asInteger = (value: unknown): number | undefined => {
  return Number.isInteger(value) ? (value as number) : undefined
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

  if (toolName === 'delegate_subagent') {
    return {
      ...displayInfo,
      summaryText: getDelegateSubagentSummary({ request, response }),
    }
  }

  return displayInfo
}

const DELEGATE_SUMMARY_MAX_CHARS = 80

const getDelegateSubagentSummary = ({
  request,
  response,
}: {
  request: ToolRequestLike
  response?: ToolCallResponse
}): string | undefined => {
  const argsObject = parseToolArguments(request.arguments)
  const title =
    typeof argsObject?.description === 'string'
      ? argsObject.description.trim()
      : ''

  let mainText = ''
  if (response?.status === ToolCallResponseStatus.Success) {
    mainText = response.data.text?.trim() ?? ''
  } else if (response?.status === ToolCallResponseStatus.Error) {
    mainText = response.error?.trim() ?? ''
  } else if (
    response?.status === ToolCallResponseStatus.Aborted &&
    response.data
  ) {
    mainText = response.data.text?.trim() ?? ''
  }

  if (!mainText) {
    const prompt =
      typeof argsObject?.prompt === 'string' ? argsObject.prompt.trim() : ''
    mainText = prompt
  }

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

  if (toolName === 'todo_write') {
    const rawTodos = Array.isArray(argumentsObject?.todos)
      ? (argumentsObject.todos as unknown[])
      : []
    const todos = rawTodos.filter(
      (
        item,
      ): item is {
        content: string
        status: 'pending' | 'in_progress' | 'completed'
      } => {
        if (!item || typeof item !== 'object') return false
        const record = item as Record<string, unknown>
        return (
          typeof record.content === 'string' &&
          (record.status === 'pending' ||
            record.status === 'in_progress' ||
            record.status === 'completed')
        )
      },
    )
    if (todos.length === 0) return labels.todoWriteCleared
    const inProgress = todos.find((todo) => todo.status === 'in_progress')
    if (inProgress) return truncateText(inProgress.content, 60)
    const total = todos.length
    const done = todos.filter((todo) => todo.status === 'completed').length
    if (done === total) return labels.todoWriteAllCompleted(total)
    if (done === 0) return labels.todoWriteCreated(total)
    return labels.todoWriteProgress(done, total)
  }

  if (toolName === 'web_scrape') {
    const url =
      typeof argumentsObject?.url === 'string' ? argumentsObject.url : ''
    return url ? truncateText(url, 80) : undefined
  }

  if (toolName === 'terminal_command') {
    const command =
      typeof argumentsObject?.command === 'string'
        ? argumentsObject.command.trim()
        : ''
    if (command) {
      return summarizeShellCommand(command, {
        streaming: argumentsObject?.background === true,
      })
    }

    const sessionId = asInteger(argumentsObject?.session_id)
    if (typeof sessionId !== 'number') {
      return undefined
    }

    if (argumentsObject?.kill === true) {
      return labels.terminalCommandSessionKill(sessionId)
    }

    const input =
      typeof argumentsObject?.input === 'string'
        ? argumentsObject.input.trim()
        : ''
    if (input) {
      const preview = truncateText(input.replace(/\s+/g, ' '), 60)
      return labels.terminalCommandSessionInput(sessionId, preview)
    }

    return labels.terminalCommandSessionPoll(sessionId)
  }

  if (toolName === 'js_eval') {
    const code =
      typeof argumentsObject?.code === 'string' ? argumentsObject.code : ''
    const preview = code.trim().replace(/\s+/g, ' ')
    return preview ? truncateText(preview, 80) : undefined
  }

  if (toolName === 'load_tool_schemas') {
    const servers = asStringArray(argumentsObject?.servers)
    if (!servers || servers.length === 0) {
      return undefined
    }
    const head = servers.slice(0, 2).join(', ')
    const rest = servers.length - 2
    return rest > 0 ? `${head} +${rest}` : head
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
    toolName === 'fs_write' ||
    toolName === 'fs_delete' ||
    toolName === 'fs_create_dir' ||
    // Legacy tool names from historical conversations.
    toolName === 'fs_create_file' ||
    toolName === 'fs_delete_file' ||
    toolName === 'fs_delete_dir'
  ) {
    const path =
      typeof argumentsObject?.path === 'string' ? argumentsObject.path : ''
    return path || undefined
  }

  if (toolName === 'fs_move') {
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
  terminalCommandResultsByToolCallId,
  subagentResultsByToolCallId,
  onMessageUpdate,
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
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
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
              terminalCommandResult={terminalCommandResultsByToolCallId?.get(
                toolCall.request.id,
              )}
              subagentResult={subagentResultsByToolCallId?.get(
                toolCall.request.id,
              )}
              onRecoverToolCall={onRecoverToolCall}
              onRecoverAnswerUserQuestion={onRecoverAnswerUserQuestion}
              onResponseUpdate={(response) =>
                onMessageUpdate({
                  ...message,
                  toolCalls: message.toolCalls.map((t) =>
                    t.request.id === toolCall.request.id
                      ? { ...t, response }
                      : t,
                  ),
                })
              }
            />
          </motion.div>
        ))}
      </AnimatePresence>
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
  terminalCommandResult,
  subagentResult,
  onRecoverToolCall,
  onRecoverAnswerUserQuestion,
  onResponseUpdate,
}: {
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
  onResponseUpdate: (response: ToolCallResponse) => void
}) {
  const isAskUserQuestion = useMemo(
    () => isAskUserQuestionToolName(request.name),
    [request.name],
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
    return (
      <AskUserQuestionPanel
        request={request}
        response={response}
        conversationId={conversationId}
        onRecoverAnswerUserQuestion={onRecoverAnswerUserQuestion}
      />
    )
  }
  const COMPACTION_PENDING_EXIT_MS = 180
  const reduceMotion = useReducedMotion()
  const motionDuration = reduceMotion ? 0 : 0.16
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
  const terminalSummaryParts =
    headlineParts.summaryText && isTerminalCommandRequest(request)
      ? splitTerminalCommandSummary(headlineParts.summaryText)
      : null
  const effectiveTerminalResponse =
    terminalCommandResult && isTerminalCommandRequest(request)
      ? buildHydratedTerminalCommandResponse(terminalCommandResult, response)
      : response
  const effectiveStatus = effectiveTerminalResponse.status
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
    }, 1000)

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
  const footerMode: 'pending' | 'running' | null = shouldShowPendingFooter
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

  if (
    isDelegateSubagentRequest(request) &&
    effectiveStatus !== ToolCallResponseStatus.PendingApproval
  ) {
    return (
      <SubagentCard
        toolCallId={request.id}
        response={response}
        args={extractSubagentArgs(request.arguments)}
        subagentResult={subagentResult}
        initialStdout={extractSyntheticLiveTaskOutput(request.arguments).stdout}
        initialStderr={extractSyntheticLiveTaskOutput(request.arguments).stderr}
        onAbort={() => {
          const taskId = extractAcceptedTaskId(response)
          if (taskId) subagentTaskRegistry.abort(taskId)
          void handleAbort()
        }}
      />
    )
  }

  return (
    <div className="yolo-toolcall">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="yolo-toolcall-header"
        aria-expanded={isOpen}
        aria-controls={`yolo-toolcall-content-${request.id}`}
      >
        <div className="yolo-toolcall-header-icon yolo-toolcall-header-icon--status-inline">
          <AnimatePresence mode="wait">
            <motion.span
              key={effectiveStatus}
              initial={{ opacity: 0, scale: 0.92 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.92 }}
              transition={{ duration: motionDuration }}
              style={{ display: 'flex', alignItems: 'center' }}
            >
              <StatusIcon status={effectiveStatus} />
            </motion.span>
          </AnimatePresence>
        </div>
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
                    {terminalSummaryParts ? (
                      <>
                        <span className="yolo-toolcall-header-summary-prefix">
                          {terminalSummaryParts.prefix}
                        </span>
                        <span className="yolo-toolcall-header-summary-command">
                          {' '}
                          {terminalSummaryParts.commands}
                        </span>
                      </>
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
      {isOpen && (
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
          {isTerminalCommandRequest(request) ||
          isLegacyDelegateExternalAgentRequest(request) ? (
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
                extractSyntheticLiveTaskOutput(request.arguments).stdout
              }
              initialStderr={
                terminalCommandResult?.stderr ??
                extractSyntheticLiveTaskOutput(request.arguments).stderr
              }
              onAbort={handleAbort}
            />
          ) : (
            <>
              {response.status === ToolCallResponseStatus.Success && (
                <div className="yolo-toolcall-content-section">
                  <div>{toolLabels.result}:</div>
                  <ObsidianCodeBlock content={response.data.text} />
                </div>
              )}
              {response.status === ToolCallResponseStatus.Error && (
                <div className="yolo-toolcall-content-section">
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
      <AnimatePresence initial={false}>
        {footerMode && (
          <motion.div
            key={footerMode}
            className="yolo-toolcall-footer"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{
              duration: reduceMotion ? 0 : 0.18,
              ease: [0.22, 1, 0.36, 1],
            }}
            style={{ overflow: 'hidden' }}
          >
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
          </motion.div>
        )}
      </AnimatePresence>
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
    const approved = await plugin.getAgentService().approveToolCall({
      conversationId,
      toolCallId: request.id,
    })
    if (!approved) {
      const recovered = await tryRecoverToolCall()
      if (!recovered && !suppressReloadNotice) {
        showReloadNotice()
      }
    }
  }, [
    conversationId,
    plugin,
    request.id,
    showReloadNotice,
    suppressReloadNotice,
    tryRecoverToolCall,
  ])

  const handleAllowForConversation = useCallback(async () => {
    const approved = await plugin.getAgentService().approveToolCall({
      conversationId,
      toolCallId: request.id,
      allowForConversation: true,
    })
    if (!approved) {
      const recovered = await tryRecoverToolCall(true)
      if (!recovered && !suppressReloadNotice) {
        showReloadNotice()
      }
    }
  }, [
    conversationId,
    plugin,
    request.id,
    showReloadNotice,
    suppressReloadNotice,
    tryRecoverToolCall,
  ])

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
      return <span className="yolo-toolcall-status-dot" />
    case ToolCallResponseStatus.Rejected:
    case ToolCallResponseStatus.Aborted:
    case ToolCallResponseStatus.Error:
      return <X size={16} className="yolo-icon-error" />
    case ToolCallResponseStatus.Running:
      return <Loader2 size={16} className="yolo-spinner" />
    case ToolCallResponseStatus.Success:
      return (
        <span className="yolo-toolcall-status-success-ring">
          <Check size={11} className="yolo-toolcall-status-success-check" />
        </span>
      )
    default:
      return null
  }
}

export default ToolMessage
