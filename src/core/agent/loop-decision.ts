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
}

export type LoopDecision =
  | { type: 'tool_phase' }
  | { type: 'llm_request'; nextIteration: number }
  | { type: 'done'; reason: 'completed' | 'max_iterations' }

export type LlmLoopDecision =
  | { type: 'tool_phase' }
  | { type: 'llm_request'; nextIteration: number }
  | { type: 'done'; reason: 'completed' | 'max_iterations' }

export type ToolLoopDecision =
  | { type: 'llm_request'; nextIteration: number }
  | { type: 'done'; reason: 'completed' | 'max_iterations' }

export const decideAfterLlmResult = ({
  hasToolCalls,
  hasAssistantOutput,
  iteration,
  maxIterations,
}: LlmResultInput): LlmLoopDecision => {
  if (hasToolCalls) {
    return { type: 'tool_phase' }
  }

  if (hasAssistantOutput) {
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

export const decideAfterToolResult = ({
  hasPendingTools,
  iteration,
  maxIterations,
}: ToolResultInput): ToolLoopDecision => {
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
