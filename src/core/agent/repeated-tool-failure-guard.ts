import type { ChatToolMessage } from '../../types/chat'
import { ToolCallResponseStatus } from '../../types/tool-call.types'

export type RepeatedToolFailureStopReason = 'repeated_tool_failure'

export type RepeatedToolFailureGuardState = {
  toolName: string | null
  consecutiveErrorCount: number
  warningIssued: boolean
}

export type RepeatedToolFailureGuardResult = {
  state: RepeatedToolFailureGuardState
  toolMessage: ChatToolMessage
  forceStopReason?: RepeatedToolFailureStopReason
}

export const createRepeatedToolFailureGuardState =
  (): RepeatedToolFailureGuardState => ({
    toolName: null,
    consecutiveErrorCount: 0,
    warningIssued: false,
  })

const WARNING_THRESHOLD = 3

export const createRepeatedToolFailureWarning = (toolName: string): string =>
  [
    `Repeated tool failure guard: "${toolName}" has returned Error 3 consecutive times in this run.`,
    `Before calling "${toolName}" again, inspect the error and change your strategy or arguments. Do not repeat the same call or make a blind retry.`,
    'If you cannot identify a specific correction, stop using this tool and answer with the available information or ask the user for clarification.',
    `If "${toolName}" returns Error again, this agent run will be stopped.`,
  ].join('\n\n')

export const createRepeatedToolFailureTermination = (
  toolName: string,
): string =>
  `Repeated tool failure guard: "${toolName}" returned Error again after the warning, so the current agent run is being stopped to avoid an infinite retry loop.`

const appendGuardMessage = (error: string, guardMessage: string): string => {
  return `${error}\n\n${guardMessage}`
}

export const applyRepeatedToolFailureGuard = ({
  state,
  toolMessage,
}: {
  state: RepeatedToolFailureGuardState
  toolMessage: ChatToolMessage
}): RepeatedToolFailureGuardResult => {
  let nextState: RepeatedToolFailureGuardState = { ...state }
  let forceStopReason: RepeatedToolFailureStopReason | undefined
  let updated = false

  const toolCalls = toolMessage.toolCalls.map((toolCall) => {
    const toolName = toolCall.request.name
    const response = toolCall.response

    if (response.status === ToolCallResponseStatus.Success) {
      if (nextState.toolName === toolName) {
        nextState = createRepeatedToolFailureGuardState()
      }
      return toolCall
    }

    if (response.status !== ToolCallResponseStatus.Error) {
      return toolCall
    }

    if (nextState.toolName === toolName) {
      nextState = {
        ...nextState,
        consecutiveErrorCount: nextState.consecutiveErrorCount + 1,
      }
    } else {
      nextState = {
        toolName,
        consecutiveErrorCount: 1,
        warningIssued: false,
      }
    }

    if (
      nextState.consecutiveErrorCount >= WARNING_THRESHOLD &&
      nextState.warningIssued
    ) {
      forceStopReason = 'repeated_tool_failure'
      updated = true
      return {
        ...toolCall,
        response: {
          ...response,
          error: appendGuardMessage(
            response.error,
            createRepeatedToolFailureTermination(toolName),
          ),
        },
      }
    }

    if (nextState.consecutiveErrorCount === WARNING_THRESHOLD) {
      nextState = { ...nextState, warningIssued: true }
      updated = true
      return {
        ...toolCall,
        response: {
          ...response,
          error: appendGuardMessage(
            response.error,
            createRepeatedToolFailureWarning(toolName),
          ),
        },
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
