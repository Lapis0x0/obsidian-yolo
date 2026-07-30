import React, { type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import type {
  ChatRuntimeActions,
  CliConversationController,
  CliConversationSnapshot,
} from '../../core/cli-runtime'
import type {
  AssistantToolMessageGroup,
  ChatAssistantMessage,
  ChatToolMessage,
  ChatUserMessage,
} from '../../types/chat'
import type { ChatTimelineItem } from '../../types/chat-timeline'

let latestExternalSnapshot: CliConversationSnapshot | undefined
let externalStoreNotificationCount = 0
let capturedRuntimeConversation: unknown

jest.mock('react', () => {
  const actual = jest.requireActual('react')
  return {
    ...actual,
    useLayoutEffect: actual.useEffect,
    useSyncExternalStore: (
      subscribe: (listener: () => void) => () => void,
      getSnapshot: () => CliConversationSnapshot,
    ) => {
      latestExternalSnapshot = getSnapshot()
      subscribe(() => {
        externalStoreNotificationCount += 1
        latestExternalSnapshot = getSnapshot()
      })
      return getSnapshot()
    },
  }
})

jest.mock('../../contexts/language-context', () => ({
  useLanguage: () => ({
    t: (_key: string, fallback?: string) => fallback ?? '',
  }),
}))

jest.mock('./UserMessageCard', () => ({
  __esModule: true,
  default: ({
    snapshot,
    className,
    interactive,
  }: {
    snapshot: { text: string }
    className?: string
    interactive?: boolean
  }) => (
    <div className={className} data-interactive={String(interactive)}>
      {snapshot.text}
    </div>
  ),
}))

const mockedAssistantGroup = jest.fn(
  (props: {
    messages: AssistantToolMessageGroup
    conversationId: string
    showRetryAction?: boolean
    showCopyAction?: boolean
    showEditAction?: boolean
    showDeleteAction?: boolean
  }) => {
    const { useChatRuntimeActions } = jest.requireActual(
      './chat-runtime-actions-context',
    )
    capturedRuntimeConversation = useChatRuntimeActions(
      props.conversationId,
    ).conversation
    return (
      <div data-testid="assistant-group">
        {props.messages.map((message) => message.role).join(',')}
        {props.showCopyAction ? <button>Copy message</button> : null}
        {props.showRetryAction ? <button>Regenerate</button> : null}
        {props.showEditAction ? <button>Edit</button> : null}
        {props.showDeleteAction ? <button>Delete</button> : null}
      </div>
    )
  },
)

jest.mock('./AssistantToolMessageGroupItem', () => ({
  __esModule: true,
  default: (props: Parameters<typeof mockedAssistantGroup>[0]) =>
    mockedAssistantGroup(props),
}))

jest.mock('./ChatConversationPane', () => ({
  ChatConversationPane: ({
    showEmptyState,
    emptyStateAgentTitle,
    emptyStateAgentDescription,
    chatTimelineItems,
    renderChatTimelineItem,
    footerContent,
  }: {
    showEmptyState: boolean
    emptyStateAgentTitle: string
    emptyStateAgentDescription: string
    chatTimelineItems: ChatTimelineItem[]
    renderChatTimelineItem: (item: ChatTimelineItem) => ReactNode
    footerContent: ReactNode
  }) => (
    <div data-testid="conversation-pane">
      {showEmptyState ? (
        <div data-testid="empty-state">
          {emptyStateAgentTitle} {emptyStateAgentDescription}
        </div>
      ) : null}
      {chatTimelineItems.map((item) => (
        <div key={item.renderKey}>{renderChatTimelineItem(item)}</div>
      ))}
      {footerContent}
    </div>
  ),
}))

jest.mock('./useAutoScroll', () => ({
  useAutoScroll: () => ({
    autoScrollToBottom: jest.fn(),
    forceScrollToBottom: jest.fn(),
    isAutoFollowEnabled: true,
  }),
}))

import { CliChatSurface } from './CliChatSurface'

const actions: ChatRuntimeActions = {
  cancelRun: async () => {},
  approveTool: async () => ({ kind: 'handled' }),
  rejectTool: async () => ({ kind: 'handled' }),
  abortTool: async () => ({ kind: 'handled' }),
  answerQuestion: async () => ({ kind: 'handled' }),
  cancelQuestion: async () => ({ kind: 'handled' }),
}

const sessionRef = {
  runtimeId: 'codex',
  nativeSessionId: 'native/session-1',
} as const

const makeUser = (
  id: string,
  promptContent: ChatUserMessage['promptContent'],
): ChatUserMessage => ({
  role: 'user',
  id,
  content: null,
  promptContent,
  mentionables: [],
})

const assistant: ChatAssistantMessage = {
  role: 'assistant',
  id: 'assistant-1',
  content: 'Assistant response',
  metadata: { generationState: 'completed' },
}

const tool: ChatToolMessage = {
  role: 'tool',
  id: 'tool-1',
  toolCalls: [],
}

const makeSnapshot = (
  overrides: Partial<CliConversationSnapshot> = {},
): CliConversationSnapshot => ({
  runtimeId: 'codex',
  messages: [],
  sessionRef,
  runState: 'idle',
  error: null,
  ...overrides,
})

const createController = (initial: CliConversationSnapshot) => {
  let snapshot = initial
  const listeners = new Set<() => void>()
  const controller = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  } as unknown as CliConversationController
  return {
    controller,
    publish(next: CliConversationSnapshot) {
      snapshot = next
      listeners.forEach((listener) => listener())
    },
  }
}

const renderSurface = (controller: CliConversationController): string =>
  renderToStaticMarkup(
    <CliChatSurface
      controller={controller}
      actions={actions}
      footerContent={<div>Composer footer</div>}
    />,
  )

describe('CliChatSurface', () => {
  beforeEach(() => {
    mockedAssistantGroup.mockClear()
    capturedRuntimeConversation = undefined
    latestExternalSnapshot = undefined
    externalStoreNotificationCount = 0
  })

  it('renders provider-hydrated promptContent, including flattened text parts', () => {
    const store = createController(
      makeSnapshot({
        messages: [
          makeUser('user-1', [
            { type: 'text', text: 'First prompt paragraph' },
            {
              type: 'image_url',
              image_url: { url: 'data:image/png;base64,ignored' },
            },
            { type: 'text', text: 'Second prompt paragraph' },
          ]),
        ],
      }),
    )

    const html = renderSurface(store.controller)

    expect(html).toContain('First prompt paragraph')
    expect(html).toContain('Second prompt paragraph')
    expect(html).toContain('data-interactive="false"')
    expect(html).not.toContain('base64,ignored')
  })

  it('groups assistant and tool messages and exposes only the copy action', () => {
    const store = createController(
      makeSnapshot({
        messages: [makeUser('user-1', 'Prompt'), assistant, tool],
      }),
    )

    const html = renderSurface(store.controller)

    expect(mockedAssistantGroup).toHaveBeenCalledTimes(1)
    expect(mockedAssistantGroup.mock.calls[0]?.[0].messages).toEqual([
      assistant,
      tool,
    ])
    expect(html).toContain('assistant,tool')
    expect(html).toContain('Copy message')
    expect(html).not.toContain('Regenerate')
    expect(html).not.toContain('Edit')
    expect(html).not.toContain('Delete')
  })

  it('keeps even empty native user messages read-only', () => {
    const store = createController(
      makeSnapshot({ messages: [makeUser('user-empty', null)] }),
    )

    const html = renderSurface(store.controller)

    expect(html).toContain('空消息')
    expect(html).not.toContain('Click to edit')
  })

  it('provides pending runtime actions with the actual provider session ref', () => {
    const store = createController(
      makeSnapshot({ messages: [assistant, tool] }),
    )

    renderSurface(store.controller)

    expect(capturedRuntimeConversation).toBe(sessionRef)
  })

  it('fails fast when an assistant/tool group has no bound provider session', () => {
    const store = createController(
      makeSnapshot({ messages: [assistant, tool], sessionRef: null }),
    )

    expect(() => renderSurface(store.controller)).toThrow(
      'CLI assistant/tool groups require a bound provider session.',
    )
  })

  it('subscribes to controller events and reads the published snapshot', () => {
    const store = createController(makeSnapshot({ sessionRef: null }))
    expect(renderSurface(store.controller)).toContain('开始一个 CLI 会话')

    store.publish(
      makeSnapshot({ messages: [makeUser('user-event', 'Event message')] }),
    )

    expect(externalStoreNotificationCount).toBeGreaterThan(0)
    expect(latestExternalSnapshot?.messages[0]?.id).toBe('user-event')
    expect(renderSurface(store.controller)).toContain('Event message')
  })

  it('renders localized empty, error, and streaming states', () => {
    const empty = createController(makeSnapshot({ sessionRef: null }))
    const failed = createController(
      makeSnapshot({
        sessionRef: null,
        runState: 'error',
        error: 'Provider process exited',
      }),
    )
    const streaming = createController(
      makeSnapshot({
        messages: [makeUser('user-streaming', 'Current turn')],
        runState: 'running',
      }),
    )

    expect(renderSurface(empty.controller)).toContain('开始一个 CLI 会话')
    expect(renderSurface(failed.controller)).toContain(
      'CLI 会话出错：Provider process exited',
    )
    expect(renderSurface(failed.controller)).toContain('CLI 运行出错')
    expect(renderSurface(streaming.controller)).toContain('CLI 正在回复…')
    expect(renderSurface(streaming.controller)).toContain(
      'data-run-state="running"',
    )
  })
})
