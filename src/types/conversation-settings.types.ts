export type ConversationOverrideSettings = {
  chatMode?: 'chat' | 'agent' | null
  temperature?: number | null
  top_p?: number | null
  maxContextMessages?: number | null
  stream?: boolean | null
  useWebSearch?: boolean | null
  useUrlContext?: boolean | null
  autoAttachCurrentFile?: boolean | null
}
