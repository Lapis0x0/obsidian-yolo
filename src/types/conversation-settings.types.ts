export type ConversationOverrideSettings = {
  chatMode?: 'ask' | 'agent' | null
  agentYoloEnabled?: boolean | null
  /** Per-conversation CLI capability mode, keyed like settings `cliChatModeByRuntime`. */
  cliChatModeByRuntime?: {
    'claude-code'?: 'agent' | 'plan' | null
    codex?: 'agent' | 'plan' | null
  } | null
  /** Per-conversation CLI YOLO flag, keyed like settings `cliAgentYoloEnabledByRuntime`. */
  cliAgentYoloEnabledByRuntime?: {
    'claude-code'?: boolean | null
    codex?: boolean | null
  } | null
  temperature?: number | null
  top_p?: number | null
  stream?: boolean | null
  useWebSearch?: boolean | null
  useUrlContext?: boolean | null
}
