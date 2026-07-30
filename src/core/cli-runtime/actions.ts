import type { ConversationRef } from './types'

export type ChatRuntimeToolAction = {
  conversation: ConversationRef
  toolCallId: string
}

export type ChatRuntimeApprovalAction = ChatRuntimeToolAction & {
  allowForConversation?: boolean
}

export type ChatRuntimeQuestionAction = ChatRuntimeToolAction & {
  payload: unknown
}

export type ChatRuntimeActionResult =
  | { kind: 'handled' }
  | { kind: 'stale' }

export interface ChatRuntimeActions {
  cancelRun(conversation: ConversationRef): void
  approveTool(
    action: ChatRuntimeApprovalAction,
  ): Promise<ChatRuntimeActionResult>
  rejectTool(action: ChatRuntimeToolAction): ChatRuntimeActionResult
  abortTool(
    action: ChatRuntimeToolAction,
  ): Promise<ChatRuntimeActionResult>
  answerQuestion(
    action: ChatRuntimeQuestionAction,
  ): Promise<ChatRuntimeActionResult>
  cancelQuestion(action: ChatRuntimeToolAction): ChatRuntimeActionResult
}
