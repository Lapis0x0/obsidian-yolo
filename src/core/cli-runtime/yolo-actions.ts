import type {
  AgentSessionService,
  AnswerUserQuestionPayload,
} from '../agent/service'
import { subagentTaskRegistry } from '../agent/subagent/task-registry'
import type { SubagentTaskRecord } from '../agent/subagent/types'

import type {
  ChatRuntimeActionResult,
  ChatRuntimeActions,
  ChatRuntimeQuestionActionResult,
} from './actions'
import type { ConversationRef } from './types'

export type YoloChatRuntimeActionService = Pick<
  AgentSessionService,
  | 'abortConversation'
  | 'abortToolCall'
  | 'answerUserQuestion'
  | 'approveToolCall'
  | 'cancelAskUserQuestion'
  | 'rejectToolCall'
>

export type YoloChatRuntimeActionsOptions = {
  abortSubagentTask?: (taskId: string) => void
  listSubagentTasks?: (
    conversationId: string,
  ) => Pick<SubagentTaskRecord, 'source' | 'taskId'>[]
}

const HANDLED = { kind: 'handled' } as const
const STALE = { kind: 'stale' } as const

const toActionResult = (handled: boolean): ChatRuntimeActionResult =>
  handled ? HANDLED : STALE

const getYoloConversationId = (conversation: ConversationRef): string => {
  if (conversation.runtimeId !== 'yolo') {
    throw new Error(
      `YOLO runtime actions cannot handle ${conversation.runtimeId} conversations`,
    )
  }
  return conversation.conversationId
}

const resolveSubagentTaskId = (
  tasks: Pick<SubagentTaskRecord, 'source' | 'taskId'>[],
  toolCallId: string,
): string | undefined =>
  tasks.find((task) => task.source.toolCallId === toolCallId)?.taskId

export const createYoloChatRuntimeActions = (
  agentService: YoloChatRuntimeActionService,
  options: YoloChatRuntimeActionsOptions = {},
): ChatRuntimeActions => ({
  async cancelRun(conversation) {
    agentService.abortConversation(getYoloConversationId(conversation))
  },

  async approveTool(action) {
    return toActionResult(
      await agentService.approveToolCall({
        conversationId: getYoloConversationId(action.conversation),
        toolCallId: action.toolCallId,
        allowForConversation: action.allowForConversation,
      }),
    )
  },

  async rejectTool(action) {
    return toActionResult(
      agentService.rejectToolCall({
        conversationId: getYoloConversationId(action.conversation),
        toolCallId: action.toolCallId,
      }),
    )
  },

  async abortTool(action) {
    const conversationId = getYoloConversationId(action.conversation)
    const tasks = options.listSubagentTasks
      ? options.listSubagentTasks(conversationId)
      : subagentTaskRegistry.listByConversation(conversationId)
    const taskId = resolveSubagentTaskId(tasks, action.toolCallId)
    if (taskId) {
      if (options.abortSubagentTask) {
        options.abortSubagentTask(taskId)
      } else {
        subagentTaskRegistry.abort(taskId)
      }
    }
    const handledByService = agentService.abortToolCall({
      conversationId,
      toolCallId: action.toolCallId,
    })
    // A resolved subagent task means the cancel reached the child even when
    // the parent run is already gone (error/aborted conversation has no
    // active run to abort the tool call against). Reporting `stale` there
    // would make the card rewrite the accepted dispatch locally while the
    // child is still winding down (#647).
    return toActionResult(handledByService || Boolean(taskId))
  },

  async answerQuestion(action): Promise<ChatRuntimeQuestionActionResult> {
    const outcome = await agentService.answerUserQuestion({
      conversationId: getYoloConversationId(action.conversation),
      toolCallId: action.toolCallId,
      payload: action.payload as AnswerUserQuestionPayload,
    })

    if (outcome.kind === 'needs_recovery') {
      return outcome
    }
    if (outcome.kind === 'not_found' || outcome.kind === 'not_awaiting') {
      return STALE
    }
    return HANDLED
  },

  async cancelQuestion(action) {
    return toActionResult(
      agentService.cancelAskUserQuestion({
        conversationId: getYoloConversationId(action.conversation),
        toolCallId: action.toolCallId,
      }),
    )
  },
})
