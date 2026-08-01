import React, { type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import type {
  ChatRuntimeActions,
  CliConversationSnapshot,
} from '../../core/cli-runtime'
import type {
  AssistantToolMessageGroup,
  ChatAssistantMessage,
  ChatToolMessage,
  ChatUserMessage,
} from '../../types/chat'
import type { ChatTimelineItem } from '../../types/chat-timeline'

let capturedRuntimeConversation: unknown

jest.mock('react', () => {
  const actual = jest.requireActual('react')
  return {
    ...actual,
    useLayoutEffect: actual.useEffect,
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

jest.mock('./AssistantMessageReasoning', () => ({
  __esModule: true,
  default: ({ generationState }: { generationState?: string }) => (
    <div data-stage="requesting">Requesting: {generationState}</div>
  ),
}))

jest.mock('./ChatConversationPane', () => ({
  ChatConversationPane: ({
    showEmptyState,
    emptyStateAgentTitle,
    emptyStateAgentDescription,
    emptyStateWorkspaceTitle,
    chatTimelineItems,
    renderChatTimelineItem,
    footerContent,
  }: {
    showEmptyState: boolean
    emptyStateAgentTitle: string
    emptyStateAgentDescription: string
    emptyStateWorkspaceTitle?: ReactNode
    chatTimelineItems: ChatTimelineItem[]
    renderChatTimelineItem: (item: ChatTimelineItem) => ReactNode
    footerContent: ReactNode
  }) => (
    <div data-testid="conversation-pane">
      {showEmptyState ? (
        <div data-testid="empty-state">
          {emptyStateWorkspaceTitle ?? emptyStateAgentTitle}{' '}
          {emptyStateAgentDescription}
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
  surfaceId: 'codex:native/session-1',
  runtimeId: 'codex',
  messages: [],
  sessionRef,
  runState: 'idle',
  error: null,
  ...overrides,
})

const renderSurface = (
  snapshot: CliConversationSnapshot,
  emptyStateWorkspaceTitle?: ReactNode,
): string =>
  renderToStaticMarkup(
    <CliChatSurface
      snapshot={snapshot}
      showEmptyState={
        snapshot.messages.length === 0 && snapshot.runState !== 'running'
      }
      actions={actions}
      footerContent={<div>Composer footer</div>}
      emptyStateWorkspaceTitle={emptyStateWorkspaceTitle}
    />,
  )

describe('CliChatSurface', () => {
  beforeEach(() => {
    mockedAssistantGroup.mockClear()
    capturedRuntimeConversation = undefined
  })

  it('renders provider-hydrated promptContent, including flattened text parts', () => {
    const snapshot = makeSnapshot({
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
    })

    const html = renderSurface(snapshot)

    expect(html).toContain('First prompt paragraph')
    expect(html).toContain('Second prompt paragraph')
    expect(html).toContain('data-interactive="false"')
    expect(html).not.toContain('base64,ignored')
  })

  it('groups assistant and tool messages and exposes only the copy action', () => {
    const snapshot = makeSnapshot({
      messages: [makeUser('user-1', 'Prompt'), assistant, tool],
    })

    const html = renderSurface(snapshot)

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
    const snapshot = makeSnapshot({
      messages: [makeUser('user-empty', null)],
    })

    const html = renderSurface(snapshot)

    expect(html).toContain('空消息')
    expect(html).not.toContain('Click to edit')
  })

  it('provides pending runtime actions with the actual provider session ref', () => {
    const snapshot = makeSnapshot({ messages: [assistant, tool] })

    renderSurface(snapshot)

    expect(capturedRuntimeConversation).toBe(sessionRef)
  })

  it('fails fast when an assistant/tool group has no bound provider session', () => {
    const snapshot = makeSnapshot({
      messages: [assistant, tool],
      sessionRef: null,
    })

    expect(() => renderSurface(snapshot)).toThrow(
      'CLI assistant/tool groups require a bound provider session.',
    )
  })

  it('renders the snapshot supplied by the single surface owner', () => {
    expect(renderSurface(makeSnapshot({ sessionRef: null }))).toContain(
      '开始一个 CLI 会话',
    )
    expect(
      renderSurface(
        makeSnapshot({ messages: [makeUser('user-event', 'Event message')] }),
      ),
    ).toContain('Event message')
  })

  it('does not render CLI-specific footer status or error labels', () => {
    const empty = makeSnapshot({ sessionRef: null })
    const failed = makeSnapshot({
      sessionRef: null,
      runState: 'error',
      error: 'Provider process exited',
    })
    const streaming = makeSnapshot({
      messages: [makeUser('user-streaming', 'Current turn')],
      runState: 'running',
    })

    expect(renderSurface(empty)).toContain('开始一个 CLI 会话')
    expect(renderSurface(failed)).not.toContain('CLI 会话出错')
    expect(renderSurface(failed)).not.toContain('CLI 运行出错')
    expect(renderSurface(streaming)).not.toContain('CLI 正在回复…')
    for (const runState of [
      'waiting_for_approval',
      'waiting_for_user',
      'completed',
      'aborted',
    ] as const) {
      const html = renderSurface(makeSnapshot({ runState }))

      expect(html).not.toContain('等待工具审批')
      expect(html).not.toContain('等待你的回答')
      expect(html).not.toContain('data-run-state=')
    }
  })

  it('derives a requesting timeline node until native output arrives', () => {
    const pending = makeSnapshot({
      messages: [makeUser('user-pending', 'Run the tests')],
      sessionRef: null,
      runState: 'running',
    })
    const answered = makeSnapshot({
      messages: [makeUser('user-pending', 'Run the tests'), assistant],
      runState: 'running',
    })

    expect(renderSurface(pending)).toContain('Requesting')
    expect(renderSurface(pending)).toContain('data-stage="requesting"')
    expect(renderSurface(answered)).not.toContain('data-stage="requesting"')
  })

  it('uses the shared workspace greeting for an empty CLI conversation', () => {
    const empty = makeSnapshot({ sessionRef: null })

    const html = renderSurface(
      empty,
      <span>What would you like to do in Test Vault today?</span>,
    )

    expect(html).toContain('What would you like to do in Test Vault today?')
    expect(html).not.toContain('开始一个 CLI 会话')
  })
})
