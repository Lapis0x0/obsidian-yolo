import type { ChatMessage } from '../../types/chat'

import type { ConversationRef } from './types'
import type { CliSubagentRef, CliSubagentTranscriptListener } from './types'

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

export type ChatRuntimeActionResult = { kind: 'handled' } | { kind: 'stale' }

export type ChatRuntimeQuestionActionResult =
  | ChatRuntimeActionResult
  | { kind: 'needs_recovery'; resolvedMessages: ChatMessage[] }

export type ChatRuntimeActions = {
  cancelRun(conversation: ConversationRef): Promise<void>
  approveTool(
    action: ChatRuntimeApprovalAction,
  ): Promise<ChatRuntimeActionResult>
  rejectTool(action: ChatRuntimeToolAction): Promise<ChatRuntimeActionResult>
  abortTool(action: ChatRuntimeToolAction): Promise<ChatRuntimeActionResult>
  answerQuestion(
    action: ChatRuntimeQuestionAction,
  ): Promise<ChatRuntimeQuestionActionResult>
  cancelQuestion(
    action: ChatRuntimeToolAction,
  ): Promise<ChatRuntimeActionResult>
  readSubagent?(ref: CliSubagentRef): Promise<readonly ChatMessage[]>
  watchSubagent?(
    ref: CliSubagentRef,
    listener: CliSubagentTranscriptListener,
  ): Promise<() => void>
}
