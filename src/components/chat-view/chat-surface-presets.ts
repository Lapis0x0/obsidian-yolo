export type AssistantActionSurfacePreset = {
  showInlineInfo: boolean
  showRetryAction: boolean
  showInsertAction: boolean
  showCopyAction: boolean
  showBranchAction: boolean
  showEditAction: boolean
  showDeleteAction: boolean
  showQuoteAction: boolean
}

export type UserMessageSurfacePreset = {
  showReasoningSelect: boolean
  allowAgentModeOption: boolean
}

export type ChatSurfacePreset = {
  id: 'chat' | 'quick-ask'
  assistantActions: AssistantActionSurfacePreset
  userMessage: UserMessageSurfacePreset
}

export const CHAT_SURFACE_PRESETS: Record<
  ChatSurfacePreset['id'],
  ChatSurfacePreset
> = {
  chat: {
    id: 'chat',
    assistantActions: {
      showInlineInfo: true,
      showRetryAction: true,
      showInsertAction: true,
      showCopyAction: true,
      showBranchAction: true,
      showEditAction: true,
      showDeleteAction: true,
      showQuoteAction: true,
    },
    userMessage: {
      showReasoningSelect: true,
      allowAgentModeOption: true,
    },
  },
  'quick-ask': {
    id: 'quick-ask',
    assistantActions: {
      showInlineInfo: false,
      showRetryAction: false,
      showInsertAction: false,
      showCopyAction: true,
      showBranchAction: false,
      showEditAction: false,
      showDeleteAction: true,
      showQuoteAction: false,
    },
    userMessage: {
      showReasoningSelect: false,
      allowAgentModeOption: false,
    },
  },
}

export function getChatSurfacePreset(id: ChatSurfacePreset['id']) {
  return CHAT_SURFACE_PRESETS[id]
}
