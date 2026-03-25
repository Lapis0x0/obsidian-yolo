import type {
  AgentConversationState,
  AgentService,
} from '../agent/service'
import { ToolCallResponseStatus } from '../../types/tool-call.types'

import type { NotificationService } from './notificationService'

type AgentNotificationCoordinatorOptions = {
  agentService: Pick<AgentService, 'subscribeToConversationStates'>
  notificationService: NotificationService
  translate: (key: string, fallback: string) => string
}

type ConversationSnapshot = {
  status: AgentConversationState['status']
  runId?: number
  pendingApprovalIds: Set<string>
}

const getPendingApprovalToolCallIds = (
  messages: AgentConversationState['messages'],
): string[] => {
  return messages.flatMap((message) => {
    if (message.role !== 'tool') {
      return []
    }

    return message.toolCalls
      .filter(
        (toolCall) =>
          toolCall.response.status === ToolCallResponseStatus.PendingApproval,
      )
      .map((toolCall) => toolCall.request.id)
  })
}

const isTerminalStatus = (status: AgentConversationState['status']): boolean => {
  return status === 'completed' || status === 'aborted' || status === 'error'
}

export class AgentNotificationCoordinator {
  private readonly conversationSnapshots = new Map<string, ConversationSnapshot>()
  private unsubscribe: (() => void) | null = null

  constructor(private readonly options: AgentNotificationCoordinatorOptions) {}

  start(): void {
    if (this.unsubscribe) {
      return
    }

    this.unsubscribe = this.options.agentService.subscribeToConversationStates(
      (state) => {
        void this.handleStateChange(state)
      },
      { emitCurrent: true },
    )
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.conversationSnapshots.clear()
  }

  private async handleStateChange(state: AgentConversationState): Promise<void> {
    const pendingApprovalIds = getPendingApprovalToolCallIds(state.messages)
    const previousSnapshot = this.conversationSnapshots.get(state.conversationId)

    if (!previousSnapshot) {
      this.options.notificationService.markApprovalKeysAsSeen(pendingApprovalIds)
      this.conversationSnapshots.set(state.conversationId, {
        status: state.status,
        runId: state.runId,
        pendingApprovalIds: new Set(pendingApprovalIds),
      })
      return
    }

    for (const toolCallId of pendingApprovalIds) {
      if (previousSnapshot.pendingApprovalIds.has(toolCallId)) {
        continue
      }

      await this.options.notificationService.notify({
        type: 'approval_required',
        dedupeKey: toolCallId,
        title: this.options.translate(
          'chat.notification.approvalTitle',
          'YOLO 需要你的确认',
        ),
        body: this.options.translate(
          'chat.notification.approvalBody',
          '当前任务暂停中，正在等待你审批一个工具调用。',
        ),
      })
    }

    const shouldNotifyTaskCompleted =
      state.runId !== undefined &&
      previousSnapshot.runId === state.runId &&
      !isTerminalStatus(previousSnapshot.status) &&
      isTerminalStatus(state.status) &&
      pendingApprovalIds.length === 0 &&
      state.status !== 'aborted'

    if (shouldNotifyTaskCompleted) {
      await this.options.notificationService.notify({
        type: 'task_completed',
        dedupeKey: `${state.conversationId}:${state.runId}`,
        title: this.options.translate(
          'chat.notification.completedTitle',
          'YOLO 任务已结束',
        ),
        body:
          state.status === 'error'
            ? this.options.translate(
                'chat.notification.completedErrorBody',
                '当前 Agent 任务已结束，请回到窗口查看结果。',
              )
            : this.options.translate(
                'chat.notification.completedBody',
                '当前 Agent 任务已完成，可以回来看结果了。',
              ),
      })
    }

    this.conversationSnapshots.set(state.conversationId, {
      status: state.status,
      runId: state.runId,
      pendingApprovalIds: new Set(pendingApprovalIds),
    })
  }
}
