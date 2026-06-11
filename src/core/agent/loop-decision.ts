type LlmResultInput = {
  hasToolCalls: boolean
  hasAssistantOutput: boolean
  iteration: number
  maxIterations: number
}

type ToolResultInput = {
  hasPendingTools: boolean
  iteration: number
  maxIterations: number
  forceStopReason?: 'repeated_tool_failure'
}

export type LoopDoneReason =
  | 'completed'
  | 'max_iterations'
  | 'repeated_tool_failure'

export type LoopDecision =
  | { type: 'tool_phase' }
  | { type: 'llm_request'; nextIteration: number }
  | { type: 'done'; reason: LoopDoneReason }

export type LlmLoopDecision =
  | { type: 'tool_phase' }
  | { type: 'llm_request'; nextIteration: number }
  | { type: 'done'; reason: LoopDoneReason }

export type ToolLoopDecision =
  | { type: 'llm_request'; nextIteration: number }
  | { type: 'done'; reason: LoopDoneReason }

export const decideAfterLlmResult = ({
  hasToolCalls,
}: LlmResultInput): LlmLoopDecision => {
  if (hasToolCalls) {
    return { type: 'tool_phase' }
  }

  // No tool calls → the turn is complete.
  // Retrying with the same input would not produce a different result,
  // so there is no reason to continue the loop.
  return { type: 'done', reason: 'completed' }
}

export const decideAfterToolResult = ({
  forceStopReason,
  hasPendingTools,
  iteration,
  maxIterations,
}: ToolResultInput): ToolLoopDecision => {
  if (forceStopReason) {
    return { type: 'done', reason: forceStopReason }
  }

  if (hasPendingTools) {
    return { type: 'done', reason: 'completed' }
  }

  if (iteration >= maxIterations) {
    return { type: 'done', reason: 'max_iterations' }
  }

  return {
    type: 'llm_request',
    nextIteration: iteration + 1,
  }
}
