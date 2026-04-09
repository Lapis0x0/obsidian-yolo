import type { AgentRuntimeLoopConfig } from '../../core/agent/types'
import type { Assistant } from '../../types/assistant.types'

import type { ChatMode } from './chat-input/ChatModeSelect'

type AssistantLoopOptions = Pick<
  Assistant,
  'enableTools' | 'includeBuiltinTools'
>

export const DEFAULT_AGENT_MAX_AUTO_ITERATIONS = 100
export const QUICK_ASK_CHAT_MAX_AUTO_ITERATIONS = 1
export const QUICK_ASK_AGENT_MAX_AUTO_ITERATIONS = 100

export type ChatRuntimeProfile = {
  id: 'chat-default' | 'quick-ask'
  resolveLoopConfig: (input: {
    mode: ChatMode
    assistant?: AssistantLoopOptions | null
  }) => AgentRuntimeLoopConfig
}

function resolveAssistantToolOptions(assistant?: AssistantLoopOptions | null): {
  enableTools: boolean
  includeBuiltinTools: boolean
} {
  const enableTools = assistant?.enableTools ?? true
  return {
    enableTools,
    includeBuiltinTools: enableTools
      ? (assistant?.includeBuiltinTools ?? true)
      : false,
  }
}

export const CHAT_RUNTIME_PROFILE: ChatRuntimeProfile = {
  id: 'chat-default',
  resolveLoopConfig: ({ assistant }) => {
    const { enableTools, includeBuiltinTools } =
      resolveAssistantToolOptions(assistant)
    return {
      enableTools,
      includeBuiltinTools,
      maxAutoIterations: DEFAULT_AGENT_MAX_AUTO_ITERATIONS,
    }
  },
}

export const QUICK_ASK_RUNTIME_PROFILE: ChatRuntimeProfile = {
  id: 'quick-ask',
  resolveLoopConfig: ({ mode, assistant }) => {
    const isAgentMode = mode === 'agent'
    const enableTools = isAgentMode ? (assistant?.enableTools ?? true) : false
    return {
      enableTools,
      includeBuiltinTools: enableTools
        ? (assistant?.includeBuiltinTools ?? true)
        : false,
      maxAutoIterations: isAgentMode
        ? QUICK_ASK_AGENT_MAX_AUTO_ITERATIONS
        : QUICK_ASK_CHAT_MAX_AUTO_ITERATIONS,
    }
  },
}

export function resolveChatRuntimeLoopConfig(input: {
  mode: ChatMode
  assistant?: AssistantLoopOptions | null
}) {
  return CHAT_RUNTIME_PROFILE.resolveLoopConfig(input)
}

export function resolveQuickAskRuntimeLoopConfig(input: {
  mode: ChatMode
  assistant?: AssistantLoopOptions | null
}) {
  return QUICK_ASK_RUNTIME_PROFILE.resolveLoopConfig(input)
}
