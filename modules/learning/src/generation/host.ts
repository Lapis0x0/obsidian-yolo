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
  kind: 'learning-agent'
  title: string
  detail?: string
  action?: 'open-learning-view'
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
  isDebugEnabled(): boolean
}
