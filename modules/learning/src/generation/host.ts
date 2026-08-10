import type { LearningVaultReadApi } from '../domain/learningVaultReadApi'
import type { LearningVaultWriteApi } from '../domain/learningVaultWriteApi'

export type LearningGenerationCapability =
  | 'none'
  | 'readonly-vault'
  | 'edit-vault'

export type LearningWorkspaceScope = {
  enabled: boolean
  include: string[]
  exclude: string[]
}

export type LearningGenerationActivity = {
  title: string
  detail?: string
}

export type LearningGenerationToolResult = {
  /** Text returned to the model. */
  content: string
  /** True when the call failed validation — the model should self-correct. */
  isError?: boolean
}

/**
 * A run-scoped tool the model can call during a single `agent.stream` run
 * (see `YoloModuleAgentToolV1`). Used by the serial chapter engine to let
 * the model emit knowledge points and cards directly instead of writing
 * markdown for the host to parse.
 */
export type LearningGenerationTool = {
  /** Must match `^[a-z][a-z0-9_]*$` and be unique within a single request. */
  name: string
  description: string
  inputSchema: Record<string, unknown>
  handler: (
    input: Record<string, unknown>,
  ) => Promise<LearningGenerationToolResult> | LearningGenerationToolResult
}

export type LearningGenerationUserMessage = {
  role: 'user'
  id: string
  promptContent: string
}

export type LearningGenerationAssistantMessage = {
  role: 'assistant'
  id: string
  content: string
}

export type LearningGenerationMessage =
  | LearningGenerationUserMessage
  | LearningGenerationAssistantMessage

export type LearningGenerationAgentRequest = {
  prompt?: string
  messages?: LearningGenerationMessage[]
  modelId?: string
  systemPromptOverride: string
  capability: LearningGenerationCapability
  workspaceScope?: LearningWorkspaceScope
  activity?: LearningGenerationActivity
  /** Run-scoped custom tools (up to 16), registered for this run only. */
  tools?: readonly LearningGenerationTool[]
  abortSignal?: AbortSignal
}

export type LearningGenerationAgentEvent =
  | { type: 'text'; text: string; delta: string }
  | {
      type: 'tool'
      name: string
      status:
        | 'pending'
        | 'running'
        | 'completed'
        | 'error'
        | 'awaiting_approval'
      arguments?: Record<string, unknown>
    }
  | { type: 'completed'; text: string }
  | { type: 'aborted' }
  | { type: 'error'; message: string }

export type LearningGenerationAgent = {
  stream(
    request: LearningGenerationAgentRequest,
  ): AsyncIterable<LearningGenerationAgentEvent>
}

export type LearningGenerationHost = {
  vault: LearningVaultReadApi
  vaultWriter: LearningVaultWriteApi
  agent: LearningGenerationAgent
}
