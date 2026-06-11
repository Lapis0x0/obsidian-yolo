export type ConversationOverrideSettings = {
  chatMode?: 'ask' | 'agent' | 'agent-full' | null
  temperature?: number | null
  top_p?: number | null
  stream?: boolean | null
  useWebSearch?: boolean | null
  useUrlContext?: boolean | null
}
