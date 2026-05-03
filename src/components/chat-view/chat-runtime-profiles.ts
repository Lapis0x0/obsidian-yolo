import type { AgentRuntimeLoopConfig } from '../../core/agent/types'
import { getLocalFileToolServerName } from '../../core/mcp/localFileTools'
import { getToolName } from '../../core/mcp/tool-name-utils'
import type { Assistant } from '../../types/assistant.types'

import type { ChatMode } from './chat-input/ChatModeSelect'

type AssistantRuntimeOptions = Pick<
  Assistant,
  'enableTools' | 'includeBuiltinTools' | 'toolPreferences'
>

export const DEFAULT_AGENT_MAX_AUTO_ITERATIONS = 100

export const CHAT_BLOCKED_TOOL_NAMES: readonly string[] = [
  getToolName(getLocalFileToolServerName(), 'fs_file_ops'),
  getToolName(getLocalFileToolServerName(), 'fs_edit'),
  getToolName(getLocalFileToolServerName(), 'fs_create_file'),
  getToolName(getLocalFileToolServerName(), 'fs_delete_file'),
  getToolName(getLocalFileToolServerName(), 'fs_create_dir'),
  getToolName(getLocalFileToolServerName(), 'fs_delete_dir'),
  getToolName(getLocalFileToolServerName(), 'fs_move'),
]

export type ChatModeRuntime = {
  loopConfig: AgentRuntimeLoopConfig
  allowedToolNames: string[] | undefined
  toolPreferences: Assistant['toolPreferences']
}

export type ChatModeRuntimeInput = {
  mode: ChatMode
  assistant?: AssistantRuntimeOptions | null
  assistantEnabledToolNames: string[]
}

export function resolveChatModeRuntime({
  mode,
  assistant,
  assistantEnabledToolNames,
}: ChatModeRuntimeInput): ChatModeRuntime {
  const enableTools = assistant?.enableTools ?? true
  const includeBuiltinTools = enableTools
    ? (assistant?.includeBuiltinTools ?? true)
    : false

  const isAgentMode = mode === 'agent'
  const blocked = new Set(CHAT_BLOCKED_TOOL_NAMES)
  const allowedToolNames = enableTools
    ? isAgentMode
      ? assistantEnabledToolNames
      : assistantEnabledToolNames.filter((name) => !blocked.has(name))
    : undefined

  return {
    loopConfig: {
      enableTools,
      includeBuiltinTools,
      maxAutoIterations: DEFAULT_AGENT_MAX_AUTO_ITERATIONS,
    },
    allowedToolNames,
    toolPreferences: isAgentMode ? assistant?.toolPreferences : undefined,
  }
}
