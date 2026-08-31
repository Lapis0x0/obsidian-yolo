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

jest.mock('../../contexts/app-context', () => ({
  useApp: () => ({
    vault: { getAbstractFileByPath: jest.fn() },
    workspace: { getLeaf: jest.fn() },
  }),
}))

// The real module imports YoloPlugin, which pulls the whole plugin entry point
// into the test module graph.
jest.mock('../../contexts/plugin-context', () => ({
  usePlugin: () => ({ manifest: { id: 'yolo' } }),
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

jest.mock('./UserMessageItem', () => ({
  __esModule: true,
  default: ({
    message,
    isActionDisabled,
    canEdit,
    showReasoningSelect,
    showModelControl,
    showPlaceholder,
    allowAgentModeOption,
  }: {
    message: ChatUserMessage
    isActionDisabled?: boolean
    canEdit?: boolean
    showReasoningSelect?: boolean
    showModelControl?: boolean
    showPlaceholder?: boolean
    allowAgentModeOption?: boolean
  }) => {
    const { editorStateToPlainText } = jest.requireActual(
      './chat-input/utils/editor-state-to-plain-text',
    )
    return (
      <div
        data-action-disabled={String(isActionDisabled)}
        data-can-edit={String(canEdit !== false)}
        data-reasoning-select={String(showReasoningSelect)}
        data-model-control={String(showModelControl)}
        data-placeholder={String(showPlaceholder)}
        data-agent-mode={String(allowAgentModeOption)}
      >
        {editorStateToPlainText(message.content)}
      </div>
    )
  },
}))

const mockedAssistantGroup = jest.fn(
  (props: {
    messages: AssistantToolMessageGroup
    conversationId: string
    showRetryAction?: boolean
    showInsertAction?: boolean
    showCopyAction?: boolean
    showInlineInfo?: boolean
    showEditAction?: boolean
    showDeleteAction?: boolean
    showBranchAction?: boolean
    showQuoteAction?: boolean
    conversationRunSummary?: { anchorMessageId?: string }
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
        {props.showInsertAction ? <button>Insert message</button> : null}
        {props.showInlineInfo ? <span>Inline info</span> : null}
        {props.showEditAction ? <button>Edit</button> : null}
        {props.showDeleteAction ? <button>Delete</button> : null}
        {props.showBranchAction ? <button>Branch</button> : null}
        {props.showQuoteAction ? <button>Quote</button> : null}
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

jest.mock('./chat-input/CliRuntimeControls', () => ({
  CliRuntimeControls: () => <div data-testid="cli-runtime-controls" />,
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
    hasEarlierMessages,
  }: {
    showEmptyState: boolean
    emptyStateAgentTitle: string
    emptyStateAgentDescription: string
    emptyStateWorkspaceTitle?: ReactNode
    chatTimelineItems: ChatTimelineItem[]
    renderChatTimelineItem: (item: ChatTimelineItem) => ReactNode
    footerContent: ReactNode
    hasEarlierMessages?: boolean
  }) => (
    <div
      data-testid="conversation-pane"
      data-has-earlier={String(hasEarlierMessages)}
    >
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

import type { AcceptedCliDraft } from './cliChatIntegration'
import {
  CliChatSurface,
  getActiveStreamingMessageId,
  getCliTimelineRenderVersion,
  getCliUserMessageDisplay,
  getPendingResponseUserMessageId,
  handleVisiblePresentedCliDraft,
  hasCliTurnResponseFeedback,
} from './CliChatSurface'

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
  compactionBoundaries: [],
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
      presentedDraft={null}
      showEmptyState={
        snapshot.messages.length === 0 && snapshot.runState !== 'running'
      }
      actions={actions}
      footerContent={<div>Composer footer</div>}
      emptyStateWorkspaceTitle={emptyStateWorkspaceTitle}
      onRewriteUserMessage={async () => undefined}
      onPresentedDraftHandled={() => undefined}
    />,
  )

describe('CliChatSurface', () => {
  beforeEach(() => {
    mockedAssistantGroup.mockClear()
    capturedRuntimeConversation = undefined
  })

  it('forces the live edge before consuming a newly presented local turn', () => {
    const userMessage = makeUser('user-presented', 'Presented prompt')
    const presentedDraft: AcceptedCliDraft = {
      token: 1,
      draftRevision: 2,
      userMessage,
    }
    const forceScrollToBottom = jest.fn()
    const onHandled = jest.fn()

    expect(
      handleVisiblePresentedCliDraft({
        presentedDraft,
        messages: [userMessage],
        forceScrollToBottom,
        onHandled,
      }),
    ).toBe(true)
    expect(forceScrollToBottom).toHaveBeenCalledTimes(1)
    expect(onHandled).toHaveBeenCalledWith(presentedDraft)
    expect(forceScrollToBottom.mock.invocationCallOrder[0]).toBeLessThan(
      onHandled.mock.invocationCallOrder[0],
    )
  })

  it('does not consume a presented turn before it reaches the snapshot', () => {
    const presentedDraft: AcceptedCliDraft = {
      token: 1,
      draftRevision: 2,
      userMessage: makeUser('user-presented', 'Presented prompt'),
    }
    const forceScrollToBottom = jest.fn()
    const onHandled = jest.fn()

    expect(
      handleVisiblePresentedCliDraft({
        presentedDraft,
        messages: [makeUser('user-existing', 'Existing prompt')],
        forceScrollToBottom,
        onHandled,
      }),
    ).toBe(false)
    expect(forceScrollToBottom).not.toHaveBeenCalled()
    expect(onHandled).not.toHaveBeenCalled()
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
    expect(html).toContain('data-action-disabled="false"')
    expect(html).not.toContain('base64,ignored')
  })

  it('invalidates a user timeline row when it enters editing state', () => {
    const item: Extract<ChatTimelineItem, { kind: 'user-message' }> = {
      kind: 'user-message',
      id: 'user-1',
      renderKey: 'user-1',
      messageId: 'user-1',
      revision: 1,
      spacingBefore: 0,
      isPinnedForRender: false,
      isStreaming: false,
    }

    expect(getCliTimelineRenderVersion(item, 'idle', null)).not.toBe(
      getCliTimelineRenderVersion(item, 'idle', 'user-1'),
    )
  })

  it('restores the canonical CLI message after editing is dismissed', () => {
    const message = makeUser('user-1', 'Original')
    const draft = makeUser('user-1', 'Edited draft')

    expect(getCliUserMessageDisplay(message, draft, true)).toBe(draft)
    expect(getCliUserMessageDisplay(message, draft, false)).toBe(message)
  })

  it('exposes the supported CLI assistant actions and inline metrics', () => {
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
    expect(html).toContain('Regenerate')
    expect(html).toContain('Insert message')
    expect(html).toContain('Inline info')
    expect(html).not.toContain('Edit')
    expect(html).not.toContain('Delete')
    expect(html).not.toContain('Branch')
    expect(html).toContain('Quote')
  })

  it('assembles the CLI user-message preset without host-only controls', () => {
    const html = renderSurface(
      makeSnapshot({ messages: [makeUser('user-1', 'Prompt')] }),
    )

    expect(html).toContain('data-reasoning-select="false"')
    expect(html).toContain('data-model-control="false"')
    expect(html).toContain('data-placeholder="false"')
    expect(html).toContain('data-agent-mode="false"')
    expect(html).toContain('data-can-edit="true"')
  })

  it('does not offer historical edit or regenerate when the runtime cannot rewrite', () => {
    const html = renderSurface(
      makeSnapshot({
        runtimeId: 'hermes',
        surfaceId: 'hermes:native/session-1',
        sessionRef: {
          runtimeId: 'hermes',
          nativeSessionId: 'native/session-1',
        },
        messages: [makeUser('user-1', 'Prompt'), assistant, tool],
      }),
    )

    expect(html).toContain('data-can-edit="false"')
    expect(html).not.toContain('Regenerate')
  })

  it('offers historical edit when the runtime can rewrite', () => {
    const html = renderSurface(
      makeSnapshot({
        runtimeId: 'pi',
        surfaceId: 'pi:native/session-1',
        sessionRef: { runtimeId: 'pi', nativeSessionId: 'native/session-1' },
        messages: [makeUser('user-1', 'Prompt'), assistant, tool],
      }),
    )

    expect(html).toContain('data-can-edit="true"')
    expect(html).toContain('Regenerate')
  })

  it('does not bind a new running turn to the previous assistant footer', () => {
    const previousAssistant = {
      ...assistant,
      id: 'assistant-previous',
    }
    const currentUser = makeUser('user-current', 'Current prompt')

    renderSurface(
      makeSnapshot({
        messages: [
          makeUser('user-previous', 'Previous prompt'),
          previousAssistant,
          currentUser,
        ],
        runState: 'running',
      }),
    )

    expect(mockedAssistantGroup).toHaveBeenCalledTimes(1)
    expect(
      mockedAssistantGroup.mock.calls[0]?.[0].conversationRunSummary,
    ).toBeUndefined()
  })

  it('binds the running turn after its own assistant group appears', () => {
    const currentAssistant: ChatAssistantMessage = {
      role: 'assistant',
      id: 'assistant-current',
      content: 'Streaming response',
      metadata: { generationState: 'streaming' },
    }

    renderSurface(
      makeSnapshot({
        messages: [
          makeUser('user-previous', 'Previous prompt'),
          { ...assistant, id: 'assistant-previous' },
          makeUser('user-current', 'Current prompt'),
          currentAssistant,
        ],
        runState: 'running',
      }),
    )

    const previousGroup = mockedAssistantGroup.mock.calls.find(
      ([props]) => props.messages[0]?.id === 'assistant-previous',
    )?.[0]
    const currentGroup = mockedAssistantGroup.mock.calls.find(
      ([props]) => props.messages[0]?.id === 'assistant-current',
    )?.[0]
    expect(previousGroup?.conversationRunSummary).toBeUndefined()
    expect(currentGroup?.conversationRunSummary).toMatchObject({
      anchorMessageId: 'user-current',
    })
  })

  it('keeps even empty native user messages editable', () => {
    const snapshot = makeSnapshot({
      messages: [makeUser('user-empty', null)],
    })

    const html = renderSurface(snapshot)

    expect(html).toContain('data-action-disabled="false"')
  })

  it('provides pending runtime actions with the actual provider session ref', () => {
    const snapshot = makeSnapshot({ messages: [assistant, tool] })

    renderSurface(snapshot)

    expect(capturedRuntimeConversation).toBe(sessionRef)
  })

  it('shows the original error without provider actions when session binding fails', () => {
    const initializationError: ChatAssistantMessage = {
      role: 'assistant',
      id: 'assistant-initialization-error',
      content: '',
      metadata: {
        generationState: 'error',
        errorMessage: 'Provider initialization failed',
      },
    }
    const snapshot = makeSnapshot({
      messages: [initializationError],
      sessionRef: null,
      error: 'Provider initialization failed',
    })

    expect(renderSurface(snapshot)).toContain('Provider initialization failed')
    expect(capturedRuntimeConversation).toBeUndefined()
  })

  it('renders the snapshot supplied by the single surface owner', () => {
    expect(renderSurface(makeSnapshot({ sessionRef: null }))).toContain(
      '使用 CLI Agent',
    )
    expect(
      renderSurface(
        makeSnapshot({ messages: [makeUser('user-event', 'Event message')] }),
      ),
    ).toContain('Event message')
  })

  it('renders only the latest six CLI turns in the initial history window', () => {
    const messages = Array.from({ length: 8 }, (_, index) => {
      const turn = index + 1
      return [
        makeUser(`user-${turn}`, `CLI turn ${turn}`),
        {
          role: 'assistant' as const,
          id: `assistant-${turn}`,
          content: `Response ${turn}`,
          metadata: { generationState: 'completed' as const },
        },
      ]
    }).flat()

    const html = renderSurface(makeSnapshot({ messages }))

    expect(html).not.toContain('CLI turn 1')
    expect(html).not.toContain('CLI turn 2')
    expect(html).toContain('CLI turn 3')
    expect(html).toContain('CLI turn 8')
    expect(html).toContain('data-has-earlier="true"')
  })

  it('renders provider-native compaction boundaries as a timeline divider', () => {
    const html = renderSurface(
      makeSnapshot({
        messages: [assistant],
        compactionBoundaries: [
          {
            id: 'compact-1',
            afterMessageId: assistant.id,
            trigger: 'auto',
          },
        ],
      }),
    )

    expect(html).toContain('从这里继续当前任务')
    expect(html).toContain('以上对话已压缩为摘要')
  })

  it('reuses the compaction pending timeline while native compact is running', () => {
    const html = renderSurface(
      makeSnapshot({
        messages: [assistant],
        runState: 'running',
        isCompacting: true,
      }),
    )

    expect(html).toContain('正在压缩上下文')
    expect(html).toContain('正在整理上下文')
    expect(html).not.toContain('从这里继续当前任务')
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

    expect(renderSurface(empty)).toContain('使用 CLI Agent')
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

  it('does not mark the previous turn as streaming before the new response starts', () => {
    expect(
      getActiveStreamingMessageId(
        [assistant, makeUser('user-pending', 'Run the tests')],
        'running',
      ),
    ).toBeNull()
    expect(
      getActiveStreamingMessageId(
        [
          assistant,
          makeUser('user-pending', 'Run the tests'),
          { ...assistant, id: 'assistant-current' },
        ],
        'running',
      ),
    ).toBe('assistant-current')
  })

  it('keeps Requesting while only an empty completed assistant shell exists', () => {
    const emptyCompletedShell: ChatAssistantMessage = {
      role: 'assistant',
      id: 'assistant-empty',
      content: '',
      metadata: { generationState: 'completed' },
    }
    const snapshot = makeSnapshot({
      messages: [
        makeUser('user-pending', 'Run the tests'),
        emptyCompletedShell,
      ],
      runState: 'running',
    })

    expect(hasCliTurnResponseFeedback(snapshot.messages)).toBe(false)
    expect(getPendingResponseUserMessageId(snapshot.messages, 'running')).toBe(
      'user-pending',
    )
    expect(renderSurface(snapshot)).toContain('data-stage="requesting"')
  })

  it('drops the pending Requesting node once a streaming shell can carry it', () => {
    const streamingShell: ChatAssistantMessage = {
      role: 'assistant',
      id: 'assistant-streaming',
      content: '',
      metadata: { generationState: 'streaming' },
    }
    const snapshot = makeSnapshot({
      messages: [makeUser('user-pending', 'Run the tests'), streamingShell],
      runState: 'running',
    })

    expect(hasCliTurnResponseFeedback(snapshot.messages)).toBe(true)
    expect(
      getPendingResponseUserMessageId(snapshot.messages, 'running'),
    ).toBeNull()
  })

  it('uses the shared workspace greeting for an empty CLI conversation', () => {
    const empty = makeSnapshot({ sessionRef: null })

    const html = renderSurface(
      empty,
      <span>What would you like to do in Test Vault today?</span>,
    )

    expect(html).toContain('What would you like to do in Test Vault today?')
    expect(html).not.toContain('使用 CLI Agent')
  })
})
