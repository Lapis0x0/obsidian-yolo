import type { ChatMessage } from '../../types/chat'
import type { ContentPart } from '../../types/llm/request'
import type { ToolEditSummary } from '../../types/tool-call.types'

import type { CliChatMode } from './permission-profile'

export type CliRuntimeId = 'claude-code' | 'codex'
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

export const isCliSessionRef = (ref: ConversationRef): ref is CliSessionRef =>
  ref.runtimeId !== 'yolo'

export type CliSessionHydration = {
  ref: CliSessionRef
  messages: ChatMessage[]
}

export type CliRuntimeSkill = {
  name: string
  description: string
  path: string
}

export type CliRuntimeReadyInput = {
  sessionRef?: CliSessionRef
}

export type CliReasoningEffortOption = {
  id: string
  description?: string
}

export type CliRuntimeModel = {
  id: string
  label: string
  description?: string
  reasoningEfforts: CliReasoningEffortOption[]
  defaultReasoningEffort?: string
  isDefault?: boolean
}

export type CliRuntimeConfiguration = {
  models: CliRuntimeModel[]
  /** `null` delegates model selection to the provider-native CLI default. */
  modelId: string | null
  /** `null` delegates reasoning effort to the provider-native CLI default. */
  reasoningEffort: string | null
}

export type CliRuntimeConfigurationUpdate = {
  modelId?: string | null
  reasoningEffort?: string | null
}

export type CliPermissionProfileUpdate = {
  mode: CliChatMode
  yoloEnabled: boolean
}

export type CliTurnConfiguration = Readonly<
  Pick<CliRuntimeConfiguration, 'modelId' | 'reasoningEffort'>
>

export type CliSessionOverlay = Readonly<{
  messages: readonly ChatMessage[]
  turnConfigurationByUserMessageId: Readonly<
    Record<string, CliTurnConfiguration>
  >
}>

export type CliTurnInput = {
  sessionRef?: CliSessionRef
  userMessageId?: string
  content: string | ContentPart[]
  selectedSkillNames?: string[]
}

export type CliRewriteTurnInput = Omit<CliTurnInput, 'sessionRef'> & {
  sessionRef: CliSessionRef
  sourceUserMessageId: string
  userMessageId: string
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
  | {
      type: 'turn_edit_summary'
      sourceUserMessageId: string
      summary: ToolEditSummary
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

export type CliRuntime = {
  readonly runtimeId: CliRuntimeId

  listModels?(): Promise<CliRuntimeModel[]>
  listSkills?(): Promise<CliRuntimeSkill[]>
  openSession(ref: CliSessionRef): Promise<CliSessionHydration>
  ensureReady(input: CliRuntimeReadyInput): Promise<void>
  getConfiguration(
    cachedModels?: readonly CliRuntimeModel[],
  ): Promise<CliRuntimeConfiguration>
  updateConfiguration(
    update: CliRuntimeConfigurationUpdate,
  ): Promise<CliRuntimeConfiguration>
  /**
   * Hot-update the live session permission profile.
   * Claude applies immediately via setPermissionMode; Codex stores the profile
   * and reasserts it on the next turn/start (and on subsequent thread
   * start/resume).
   */
  updatePermissionProfile?(
    update: CliPermissionProfileUpdate,
  ): Promise<void>
  sendTurn(input: CliTurnInput): Promise<void>
  rewriteTurn(input: CliRewriteTurnInput): Promise<void>
  cancel(): Promise<void>
  respondApproval(response: CliApprovalResponse): Promise<boolean>
  respondQuestion(response: CliQuestionResponse): Promise<boolean>
  subscribe(listener: CliRuntimeEventListener): () => void
  dispose(): Promise<void>
}
