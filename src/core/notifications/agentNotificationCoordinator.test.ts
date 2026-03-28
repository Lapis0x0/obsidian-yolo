import type { AgentConversationState } from '../agent/service'
import { ToolCallResponseStatus } from '../../types/tool-call.types'
import type { NotificationEvent } from './notificationService'

import { AgentNotificationCoordinator } from './agentNotificationCoordinator'

const createState = (
  overrides: Partial<AgentConversationState> = {},
): AgentConversationState => ({
  conversationId: 'conversation-1',
  status: 'idle',
  messages: [],
  ...overrides,
})

const createPendingApprovalState = (
  overrides: Partial<AgentConversationState> = {},
): AgentConversationState =>
  createState({
    status: 'running',
    runId: 1,
    messages: [
      {
        role: 'tool',
        id: 'tool-message-1',
        toolCalls: [
          {
            request: {
              id: 'tool-1',
              name: 'test_tool',
            },
            response: { status: ToolCallResponseStatus.PendingApproval },
          },
        ],
      },
    ],
    ...overrides,
  })

describe('AgentNotificationCoordinator', () => {
  it('does not notify for initial pending approvals and marks them as seen', () => {
    let subscriber: ((state: AgentConversationState) => void) | null = null
    const markApprovalKeysAsSeen = jest.fn<void, [Iterable<string>]>()
    const notify = jest
      .fn<Promise<void>, [NotificationEvent]>()
      .mockResolvedValue()

    const coordinator = new AgentNotificationCoordinator({
      agentService: {
        subscribeToConversationStates: (callback) => {
          subscriber = callback
          callback(createPendingApprovalState())
          return () => {}
        },
      },
      notificationService: {
        markApprovalKeysAsSeen,
        notify,
      } as never,
      translate: (_key, fallback) => fallback,
    })

    coordinator.start()

    expect(subscriber).not.toBeNull()
    expect(markApprovalKeysAsSeen).toHaveBeenCalledTimes(1)
    expect(Array.from(markApprovalKeysAsSeen.mock.calls[0][0])).toEqual([
      'tool-1',
    ])
    expect(notify).not.toHaveBeenCalled()
  })

  it('notifies when a new approval is required after initialization', async () => {
    let subscriber: ((state: AgentConversationState) => void) | null = null
    const notify = jest
      .fn<Promise<void>, [NotificationEvent]>()
      .mockResolvedValue()

    const coordinator = new AgentNotificationCoordinator({
      agentService: {
        subscribeToConversationStates: (callback) => {
          subscriber = callback
          callback(createState({ status: 'running', runId: 1 }))
          return () => {}
        },
      },
      notificationService: {
        markApprovalKeysAsSeen: jest.fn(),
        notify,
      } as never,
      translate: (_key, fallback) => fallback,
    })

    coordinator.start()
    expect(subscriber).not.toBeNull()
    subscriber!(
      createPendingApprovalState({
        messages: [
          {
            role: 'tool',
            id: 'tool-message-1',
            toolCalls: [
              {
                request: {
                  id: 'tool-2',
                  name: 'test_tool',
                },
                response: {
                  status: ToolCallResponseStatus.PendingApproval,
                },
              },
            ],
          },
        ],
      }),
    )

    expect(notify).toHaveBeenCalledWith({
      type: 'approval_required',
      dedupeKey: 'tool-2',
      title: 'YOLO 需要你的确认',
      body: '当前任务暂停中，正在等待你审批一个工具调用。',
    })
  })

  it('notifies when a run completes in the background', async () => {
    let subscriber: ((state: AgentConversationState) => void) | null = null
    const notify = jest
      .fn<Promise<void>, [NotificationEvent]>()
      .mockResolvedValue()

    const coordinator = new AgentNotificationCoordinator({
      agentService: {
        subscribeToConversationStates: (callback) => {
          subscriber = callback
          callback(createState({ status: 'running', runId: 3 }))
          return () => {}
        },
      },
      notificationService: {
        markApprovalKeysAsSeen: jest.fn(),
        notify,
      } as never,
      translate: (_key, fallback) => fallback,
    })

    coordinator.start()
    expect(subscriber).not.toBeNull()
    subscriber!(
      createState({
        status: 'completed',
        runId: 3,
      }),
    )

    expect(notify).toHaveBeenCalledWith({
      type: 'task_completed',
      dedupeKey: 'conversation-1:3',
      title: 'YOLO 任务已结束',
      body: '当前 Agent 任务已完成，可以回来看结果了。',
    })
  })

  it('notifies with error copy when a run fails', async () => {
    let subscriber: ((state: AgentConversationState) => void) | null = null
    const notify = jest
      .fn<Promise<void>, [NotificationEvent]>()
      .mockResolvedValue()

    const coordinator = new AgentNotificationCoordinator({
      agentService: {
        subscribeToConversationStates: (callback) => {
          subscriber = callback
          callback(createState({ status: 'running', runId: 4 }))
          return () => {}
        },
      },
      notificationService: {
        markApprovalKeysAsSeen: jest.fn(),
        notify,
      } as never,
      translate: (_key, fallback) => fallback,
    })

    coordinator.start()
    expect(subscriber).not.toBeNull()
    subscriber!(
      createState({
        status: 'error',
        runId: 4,
      }),
    )

    expect(notify).toHaveBeenCalledWith({
      type: 'task_completed',
      dedupeKey: 'conversation-1:4',
      title: 'YOLO 任务已结束',
      body: '当前 Agent 任务已结束，请回到窗口查看结果。',
    })
  })

  it('does not notify task completion while approvals are still pending', () => {
    let subscriber: ((state: AgentConversationState) => void) | null = null
    const notify = jest
      .fn<Promise<void>, [NotificationEvent]>()
      .mockResolvedValue()

    const coordinator = new AgentNotificationCoordinator({
      agentService: {
        subscribeToConversationStates: (callback) => {
          subscriber = callback
          callback(createState({ status: 'running', runId: 6 }))
          return () => {}
        },
      },
      notificationService: {
        markApprovalKeysAsSeen: jest.fn(),
        notify,
      } as never,
      translate: (_key, fallback) => fallback,
    })

    coordinator.start()
    expect(subscriber).not.toBeNull()
    subscriber!(
      createPendingApprovalState({
        status: 'completed',
        runId: 6,
        messages: [
          {
            role: 'tool',
            id: 'tool-message-1',
            toolCalls: [
              {
                request: {
                  id: 'tool-6',
                  name: 'test_tool',
                },
                response: {
                  status: ToolCallResponseStatus.PendingApproval,
                },
              },
            ],
          },
        ],
      }),
    )

    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith({
      type: 'approval_required',
      dedupeKey: 'tool-6',
      title: 'YOLO 需要你的确认',
      body: '当前任务暂停中，正在等待你审批一个工具调用。',
    })
  })

  it('does not notify when a run is aborted', async () => {
    let subscriber: ((state: AgentConversationState) => void) | null = null
    const notify = jest
      .fn<Promise<void>, [NotificationEvent]>()
      .mockResolvedValue()

    const coordinator = new AgentNotificationCoordinator({
      agentService: {
        subscribeToConversationStates: (callback) => {
          subscriber = callback
          callback(createState({ status: 'running', runId: 5 }))
          return () => {}
        },
      },
      notificationService: {
        markApprovalKeysAsSeen: jest.fn(),
        notify,
      } as never,
      translate: (_key, fallback) => fallback,
    })

    coordinator.start()
    expect(subscriber).not.toBeNull()
    subscriber!(
      createState({
        status: 'aborted',
        runId: 5,
      }),
    )

    expect(notify).not.toHaveBeenCalled()
  })
})
