import type { App } from 'obsidian'

import type { YoloAgentEvent, YoloAgentRunRequest } from '../../agent/agent-api'

export type LearningGenerationCapability =
  | 'none'
  | 'readonly-vault'
  | 'edit-vault'

export type LearningGenerationAgentRequest = Omit<
  YoloAgentRunRequest,
  'tools'
> & {
  capability: LearningGenerationCapability
}

export type LearningGenerationAgent = {
  stream(request: LearningGenerationAgentRequest): AsyncIterable<YoloAgentEvent>
}

export type LearningGenerationHost = {
  app: App
  agent: LearningGenerationAgent
}
