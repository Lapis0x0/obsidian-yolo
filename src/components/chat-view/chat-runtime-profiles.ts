import type { AgentRuntimeLoopConfig } from '../../core/agent/types'
import { getLocalFileToolServerName } from '../../core/mcp/localFileTools'
import { getToolName } from '../../core/mcp/tool-name-utils'
import type { Assistant } from '../../types/assistant.types'

import type { ChatMode } from './chat-input/ChatModeSelect'
import { isAgentChatMode } from './chat-input/ChatModeSelect'

type AssistantRuntimeOptions = Pick<
  Assistant,
  | 'enableTools'
  | 'includeBuiltinTools'
  | 'toolPreferences'
  | 'toolServerPreferences'
>

export const DEFAULT_AGENT_MAX_AUTO_ITERATIONS = 100

export const CHAT_BLOCKED_TOOL_NAMES: readonly string[] = [
  getToolName(getLocalFileToolServerName(), 'fs_file_ops'),
  getToolName(getLocalFileToolServerName(), 'fs_edit'),
  getToolName(getLocalFileToolServerName(), 'fs_write'),
  getToolName(getLocalFileToolServerName(), 'fs_delete'),
  getToolName(getLocalFileToolServerName(), 'fs_create_dir'),
  getToolName(getLocalFileToolServerName(), 'fs_move'),
  getToolName(getLocalFileToolServerName(), 'terminal_command'),
  getToolName(getLocalFileToolServerName(), 'todo_write'),
]

export type ChatModeRuntime = {
  loopConfig: AgentRuntimeLoopConfig
  allowedToolNames: string[] | undefined
  toolPreferences: Assistant['toolPreferences']
  toolServerPreferences: Assistant['toolServerPreferences']
  bypassToolApproval: boolean
  runtimeModePrompt?: string
}

export type ChatModeRuntimeInput = {
  mode: ChatMode
  /**
   * Auto-approve tool calls (YOLO). Orthogonal to `mode`; only takes effect in
   * Agent mode.
   */
  yoloEnabled?: boolean
  assistant?: AssistantRuntimeOptions | null
  assistantEnabledToolNames: string[]
}

export function resolveChatModeRuntime({
  mode,
  yoloEnabled = false,
  assistant,
  assistantEnabledToolNames,
}: ChatModeRuntimeInput): ChatModeRuntime {
  const enableTools = assistant?.enableTools ?? true
  const includeBuiltinTools = enableTools
    ? (assistant?.includeBuiltinTools ?? true)
    : false

  const isAgentMode = isAgentChatMode(mode)
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
    toolServerPreferences: isAgentMode
      ? assistant?.toolServerPreferences
      : undefined,
    bypassToolApproval: isAgentMode && yoloEnabled,
    runtimeModePrompt: isAgentMode
      ? undefined
      : `<runtime_mode>
You are currently in Ask mode. Some action tools are unavailable in this mode, including file modification, terminal command execution, and task-state writing tools. If the user asks you to use these capabilities, explain that they need to switch to Agent mode.
</runtime_mode>`,
  }
}
