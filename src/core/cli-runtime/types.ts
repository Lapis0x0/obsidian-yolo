import type { ChatMessage } from '../../types/chat'
import type { ContentPart } from '../../types/llm/request'

export const CLI_RUNTIME_IDS = ['claude-code', 'codex'] as const

export type CliRuntimeId = (typeof CLI_RUNTIME_IDS)[number]
export type ChatRuntimeId = 'yolo' | CliRuntimeId

export type YoloConversationRef = {
  runtimeId: 'yolo'
  conversationId: string
}

export type CliSessionRef = {
  runtimeId: CliRuntimeId
  nativeSessionId: string
  sessionPathHint?: string
}

export type ConversationRef = YoloConversationRef | CliSessionRef

export const isCliSessionRef = (
  ref: ConversationRef,
): ref is CliSessionRef => ref.runtimeId !== 'yolo'

export type CliSessionMetadata = {
  ref: CliSessionRef
  title: string
  preview?: string
  createdAt?: number
  updatedAt: number
  cwd?: string
  model?: string
}

export type CliSessionHydration = {
  ref: CliSessionRef
  messages: ChatMessage[]
}

export type CliAssistantBinding = {
  assistantId?: string
  systemPrompt: string
  enabledSkillNames: string[]
}

export type CliRuntimeReadyInput = {
  sessionRef?: CliSessionRef
  assistant: CliAssistantBinding
}

export type CliTurnInput = {
  sessionRef?: CliSessionRef
  content: string | ContentPart[]
}

export type CliRuntimeRunState =
  | 'idle'
  | 'running'
  | 'waiting_for_approval'
  | 'waiting_for_user'
  | 'completed'
  | 'aborted'
  | 'error'

export type CliRuntimeEvent =
  | {
      type: 'session_bound'
      ref: CliSessionRef
    }
  | {
      type: 'message_upsert'
      message: ChatMessage
    }
  | {
      type: 'message_remove'
      messageId: string
    }
  | {
      type: 'run_state'
      state: CliRuntimeRunState
      error?: string
    }

export type CliApprovalDecision =
  | 'approve_once'
  | 'approve_for_session'
  | 'reject'

export type CliApprovalResponse = {
  requestId: string
  decision: CliApprovalDecision
}

export type CliQuestionResponse = {
  requestId: string
  answer: unknown
}

export type CliRuntimeEventListener = (event: CliRuntimeEvent) => void

export interface CliRuntime {
  readonly runtimeId: CliRuntimeId

  listSessions(): Promise<CliSessionMetadata[]>
  openSession(ref: CliSessionRef): Promise<CliSessionHydration>
  ensureReady(input: CliRuntimeReadyInput): Promise<void>
  sendTurn(input: CliTurnInput): Promise<void>
  cancel(): Promise<void>
  respondApproval(response: CliApprovalResponse): Promise<void>
  respondQuestion(response: CliQuestionResponse): Promise<void>
  subscribe(listener: CliRuntimeEventListener): () => void
  dispose(): Promise<void>
}
