import { ChatModel } from '../../types/chat-model.types'

export type HostedToolDefinition = {
  type: 'web_search'
}

export function getHostedToolsForModel(
  model: Pick<ChatModel, 'toolType' | 'gptTools'>,
): HostedToolDefinition[] {
  if (model.toolType !== 'gpt') {
    return []
  }

  const tools: HostedToolDefinition[] = []

  if (model.gptTools?.webSearch?.enabled) {
    tools.push({ type: 'web_search' })
  }

  return tools
}
