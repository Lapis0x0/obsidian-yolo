import type { ChatToolMessage } from '../../types/chat'
import type { ToolCallResponse } from '../../types/tool-call.types'
import {
  ToolCallArguments,
  ToolCallResponseStatus,
  getToolCallArgumentsObject,
} from '../../types/tool-call.types'
import { parseToolName } from '../mcp/tool-name-utils'

export type RepeatedReadCallStopReason = 'repeated_read_call'

export type RepeatedReadCallGuardState = {
  signature: string | null
  consecutiveCount: number
  warningIssued: boolean
}

export type RepeatedReadCallGuardResult = {
  state: RepeatedReadCallGuardState
  toolMessage: ChatToolMessage
  forceStopReason?: RepeatedReadCallStopReason
}

export const createRepeatedReadCallGuardState =
  (): RepeatedReadCallGuardState => ({
    signature: null,
    consecutiveCount: 0,
    warningIssued: false,
  })

const LOCAL_FILE_TOOL_SERVER_NAME = 'yolo_local'
const FS_READ_TOOL_NAME = 'fs_read'
const WARNING_THRESHOLD = 3

const isFsReadToolName = (toolName: string): boolean => {
  try {
    const parsed = parseToolName(toolName)
    return (
      parsed.serverName === LOCAL_FILE_TOOL_SERVER_NAME &&
      parsed.toolName === FS_READ_TOOL_NAME
    )
  } catch {
    return false
  }
}

const stableStringify = (value: unknown): string => {
  if (value === undefined) {
    return 'undefined'
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([left], [right]) => left.localeCompare(right),
    )
    return `{${entries
      .map(
        ([key, entryValue]) =>
          `${JSON.stringify(key)}:${stableStringify(entryValue)}`,
      )
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

const getReadCallSignature = (
  toolName: string,
  args?: ToolCallArguments,
): string | null => {
  if (!isFsReadToolName(toolName)) {
    return null
  }

  return `${toolName}:${stableStringify(getToolCallArgumentsObject(args) ?? {})}`
}

export const createRepeatedReadCallWarning = (): string =>
  [
    'Repeated read guard: fs_read has been called with the exact same arguments 3 consecutive times in this run.',
    'The content from this file/range is already available in the conversation. Do not call fs_read with the same arguments again.',
    'Use the information already available, read a different file/range, search for missing information, answer the user, or ask the user for clarification.',
    'If you repeat this exact fs_read call again, this agent run will be stopped.',
  ].join('\n\n')

export const createRepeatedReadCallTermination = (): string =>
  'Repeated read guard: fs_read was called again with the exact same arguments after the warning, so the current agent run is being stopped to avoid an infinite read loop.'

const createErrorResponse = (error: string): ToolCallResponse => ({
  status: ToolCallResponseStatus.Error,
  error,
})

export const applyRepeatedReadCallGuard = ({
  state,
  toolMessage,
}: {
  state: RepeatedReadCallGuardState
  toolMessage: ChatToolMessage
}): RepeatedReadCallGuardResult => {
  let nextState: RepeatedReadCallGuardState = { ...state }
  let forceStopReason: RepeatedReadCallStopReason | undefined
  let updated = false

  const toolCalls = toolMessage.toolCalls.map((toolCall) => {
    const response = toolCall.response
    const signature = getReadCallSignature(
      toolCall.request.name,
      toolCall.request.arguments,
    )

    if (
      signature === null ||
      response.status !== ToolCallResponseStatus.Success
    ) {
      nextState = createRepeatedReadCallGuardState()
      return toolCall
    }

    if (nextState.signature === signature) {
      nextState = {
        ...nextState,
        consecutiveCount: nextState.consecutiveCount + 1,
      }
    } else {
      nextState = {
        signature,
        consecutiveCount: 1,
        warningIssued: false,
      }
    }

    if (
      nextState.consecutiveCount >= WARNING_THRESHOLD &&
      nextState.warningIssued
    ) {
      forceStopReason = 'repeated_read_call'
      updated = true
      return {
        ...toolCall,
        response: createErrorResponse(createRepeatedReadCallTermination()),
      }
    }

    if (nextState.consecutiveCount === WARNING_THRESHOLD) {
      nextState = { ...nextState, warningIssued: true }
      updated = true
      return {
        ...toolCall,
        response: createErrorResponse(createRepeatedReadCallWarning()),
      }
    }

    return toolCall
  })

  return {
    state: nextState,
    toolMessage: updated ? { ...toolMessage, toolCalls } : toolMessage,
    ...(forceStopReason ? { forceStopReason } : {}),
  }
}
