// Kept structurally in sync with `PersistedChatMode`
// (`src/components/chat-view/chat-input/ChatModeSelect.tsx`) without
// importing it — `types/` stays a leaf module that `components/` depends on,
// never the reverse.
export type ConversationOverrideSettings = {
  chatMode?: 'ask' | 'agent' | 'max' | `module:${string}:${string}` | null
  /**
   * Per-mode YOLO trust profile. Agent and Max each own one; Ask has none and
   * reads Agent's. See `yoloPreferenceKeyForMode` for the single place that
   * decides which field a mode reads and writes.
   */
  agentYoloEnabled?: boolean | null
  maxYoloEnabled?: boolean | null
  /** Per-conversation CLI capability mode, keyed like settings `cliChatModeByRuntime`. */
  cliChatModeByRuntime?: {
    'claude-code'?: 'agent' | 'plan' | null
    codex?: 'agent' | 'plan' | null
    hermes?: 'agent' | 'plan' | null
    pi?: 'agent' | 'plan' | null
    omp?: 'agent' | 'plan' | null
    grok?: 'agent' | 'plan' | null
  } | null
  /** Per-conversation CLI YOLO flag, keyed like settings `cliAgentYoloEnabledByRuntime`. */
  cliAgentYoloEnabledByRuntime?: {
    'claude-code'?: boolean | null
    codex?: boolean | null
    hermes?: boolean | null
    pi?: boolean | null
    omp?: boolean | null
    grok?: boolean | null
  } | null
  temperature?: number | null
  top_p?: number | null
  stream?: boolean | null
  useWebSearch?: boolean | null
  useUrlContext?: boolean | null
}
