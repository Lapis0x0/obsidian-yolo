import type {
  YoloModuleAgentCapabilityV1,
  YoloModuleAgentMessageV1,
  YoloModuleAgentV1,
} from '../../modules/types'

import type {
  LearningGenerationAgent,
  LearningGenerationAgentRequest,
  LearningGenerationCapability,
  LearningGenerationMessage,
} from './host'

const CAPABILITY_MAP: Record<
  LearningGenerationCapability,
  YoloModuleAgentCapabilityV1
> = {
  none: 'none',
  'readonly-vault': 'vault-read',
  'edit-vault': 'vault-write',
}

export function createLearningGenerationAgent(
  agent: YoloModuleAgentV1,
): LearningGenerationAgent {
  return {
    stream: (request) => streamAgent(agent, request),
  }
}

async function* streamAgent(
  agent: YoloModuleAgentV1,
  request: LearningGenerationAgentRequest,
) {
  yield* agent.stream({
    ...(request.prompt !== undefined ? { prompt: request.prompt } : {}),
    ...(request.messages ? { messages: request.messages.map(mapMessage) } : {}),
    ...(request.modelId !== undefined ? { modelId: request.modelId } : {}),
    systemPrompt: request.systemPromptOverride,
    capability: CAPABILITY_MAP[request.capability],
    ...(request.activity
      ? {
          activity: {
            title: request.activity.title,
            ...(request.activity.detail !== undefined
              ? { detail: request.activity.detail }
              : {}),
          },
        }
      : {}),
    ...(request.workspaceScope
      ? {
          workspaceScope: {
            enabled: request.workspaceScope.enabled,
            include: [...request.workspaceScope.include],
            exclude: [...request.workspaceScope.exclude],
          },
        }
      : {}),
    ...(request.abortSignal ? { signal: request.abortSignal } : {}),
  })
}

function mapMessage(
  message: LearningGenerationMessage,
): YoloModuleAgentMessageV1 {
  return message.role === 'user'
    ? { role: 'user', id: message.id, content: message.promptContent }
    : { role: 'assistant', id: message.id, content: message.content }
}
