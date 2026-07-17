import type {
  LearningGenerationAgent,
  LearningGenerationAgentRequest,
  LearningGenerationCapability,
  LearningGenerationMessage,
} from './host'

type ModuleAgent = YoloModuleHostApiV1['agent']
type ModuleAgentCapability = Parameters<ModuleAgent['stream']>[0]['capability']
type ModuleAgentMessage = NonNullable<
  Parameters<ModuleAgent['stream']>[0]['messages']
>[number]

const CAPABILITY_MAP: Record<
  LearningGenerationCapability,
  ModuleAgentCapability
> = {
  none: 'none',
  'readonly-vault': 'vault-read',
  'edit-vault': 'vault-write',
}

export function createLearningGenerationAgent(
  agent: ModuleAgent,
): LearningGenerationAgent {
  return {
    stream: (request) => streamAgent(agent, request),
  }
}

async function* streamAgent(
  agent: ModuleAgent,
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

function mapMessage(message: LearningGenerationMessage): ModuleAgentMessage {
  return message.role === 'user'
    ? { role: 'user', id: message.id, content: message.promptContent }
    : { role: 'assistant', id: message.id, content: message.content }
}
