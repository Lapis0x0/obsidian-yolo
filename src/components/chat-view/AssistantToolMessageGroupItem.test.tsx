jest.mock('react', () => {
  const actual = jest.requireActual('react')

  return {
    ...actual,
    useLayoutEffect: actual.useEffect,
  }
})

jest.mock('../../contexts/app-context', () => ({
  useApp: () => ({}),
}))

// The real module imports YoloPlugin, which pulls the whole plugin entry point
// into the test module graph.
jest.mock('../../contexts/plugin-context', () => ({
  usePlugin: () => ({ manifest: { id: 'yolo' } }),
}))

jest.mock('../../contexts/language-context', () => ({
  useLanguage: () => ({
    t: (_key: string, fallback?: string) => fallback ?? '',
  }),
}))

jest.mock('../../contexts/settings-context', () => ({
  useSettings: () => ({
    settings: {},
  }),
}))

jest.mock('../../database/json/chat/editReviewSnapshotStore', () => ({
  readEditReviewSnapshot: jest.fn(),
}))

jest.mock('./AssistantEditSummary', () => ({
  __esModule: true,
  default: () => null,
}))
jest.mock('./AssistantMessageAnnotations', () => ({
  __esModule: true,
  default: () => null,
}))
jest.mock('./AssistantMessageContent', () => ({
  __esModule: true,
  default: () => null,
}))
jest.mock('./AssistantMessageEditor', () => ({
  __esModule: true,
  default: () => null,
}))
jest.mock('./AssistantMessageReasoning', () => ({
  __esModule: true,
  default: jest.fn(() => null),
}))
jest.mock('./AssistantToolMessageGroupActions', () => ({
  __esModule: true,
  default: jest.fn(() => null),
}))
jest.mock('./LLMResponseInlineInfo', () => ({
  __esModule: true,
  default: () => null,
}))
jest.mock('./ToolMessage', () => ({
  __esModule: true,
  default: () => null,
}))

import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { LLMResponseFormatError } from '../../core/llm/responseFormatError'
import type { ChatAssistantMessage, ChatToolMessage } from '../../types/chat'
import { ToolCallResponseStatus } from '../../types/tool-call.types'

import AssistantMessageReasoning from './AssistantMessageReasoning'
import AssistantToolMessageGroupActions from './AssistantToolMessageGroupActions'
import AssistantToolMessageGroupItem from './AssistantToolMessageGroupItem'

const mockedAssistantMessageReasoning =
  AssistantMessageReasoning as jest.MockedFunction<
    typeof AssistantMessageReasoning
  >

const mockedAssistantToolMessageGroupActions =
  AssistantToolMessageGroupActions as jest.MockedFunction<
    typeof AssistantToolMessageGroupActions
  >

describe('AssistantToolMessageGroupItem', () => {
  beforeEach(() => {
    mockedAssistantToolMessageGroupActions.mockClear()
  })

  it('renders an assistant error card even when the message has no content', () => {
    const assistantMessage: ChatAssistantMessage = {
      role: 'assistant',
      id: 'assistant-1',
      content: '',
      metadata: {
        generationState: 'error',
        errorMessage: '400 Reasoning is mandatory for this endpoint.',
      },
    }

    const html = renderToStaticMarkup(
      <AssistantToolMessageGroupItem
        messages={[assistantMessage]}
        conversationId="conversation-1"
        isApplying={false}
        activeApplyRequestKey={null}
        onApply={() => {}}
        onToolMessageUpdate={() => {}}
        onEditStart={() => {}}
        onEditCancel={() => {}}
        onEditSave={() => {}}
        onDeleteGroup={() => {}}
        onRetryGroup={() => {}}
        onBranchGroup={() => {}}
        onQuoteAssistantSelection={() => {}}
        onOpenEditSummaryFile={() => {}}
      />,
    )

    expect(html).toContain('本次回复生成失败')
    expect(html).toContain('400 Reasoning is mandatory for this endpoint.')
  })

  it('renders Continue in the error card for an eligible partial response', () => {
    const assistantMessage: ChatAssistantMessage = {
      role: 'assistant',
      id: 'assistant-continue',
      content: 'partial response',
      metadata: {
        generationState: 'error',
        errorMessage: 'Premature close',
      },
    }

    const html = renderToStaticMarkup(
      <AssistantToolMessageGroupItem
        messages={[assistantMessage]}
        conversationId="conversation-1"
        continuableErrorMessageIds={new Set([assistantMessage.id])}
        onContinueError={() => {}}
        isApplying={false}
        activeApplyRequestKey={null}
        onApply={() => {}}
        onToolMessageUpdate={() => {}}
        onEditStart={() => {}}
        onEditCancel={() => {}}
        onEditSave={() => {}}
        onDeleteGroup={() => {}}
        onRetryGroup={() => {}}
        onBranchGroup={() => {}}
        onQuoteAssistantSelection={() => {}}
        onOpenEditSummaryFile={() => {}}
      />,
    )

    expect(html).toContain('Continue response')
    expect(html).toContain('yolo-assistant-error-card-continue')
    expect(html).toContain(
      'The connection to the model service was interrupted. Your partial response is still here—click Continue response to resume.',
    )
    expect(html).not.toContain('Premature close')
  })

  it('explains a dropped connection in the headline when it cannot continue', () => {
    const assistantMessage: ChatAssistantMessage = {
      role: 'assistant',
      id: 'assistant-disconnected',
      content: '',
      metadata: {
        generationState: 'error',
        errorMessage: 'socket hang up',
      },
    }

    const html = renderToStaticMarkup(
      <AssistantToolMessageGroupItem
        messages={[assistantMessage]}
        conversationId="conversation-1"
        isApplying={false}
        activeApplyRequestKey={null}
        onApply={() => {}}
        onToolMessageUpdate={() => {}}
        onEditStart={() => {}}
        onEditCancel={() => {}}
        onEditSave={() => {}}
        onDeleteGroup={() => {}}
        onRetryGroup={() => {}}
        onBranchGroup={() => {}}
        onQuoteAssistantSelection={() => {}}
        onOpenEditSummaryFile={() => {}}
      />,
    )

    // The headline explains the failure; the provider's own wording stays as
    // the description instead of being replaced by ours.
    expect(html).toContain(
      'The response stream was interrupted. Check your network stability or retry.',
    )
    expect(html).toContain('socket hang up')
  })

  it('renders structured LLM response format errors as user-facing text', () => {
    const error = new LLMResponseFormatError({
      adapter: 'Kimi',
      stage: 'non-streaming response',
      expected: 'choices 数组',
      response: {
        error: {
          message: 'bad response',
          type: 'invalid_request_error',
        },
      },
    })
    const assistantMessage: ChatAssistantMessage = {
      role: 'assistant',
      id: 'assistant-1',
      content: '',
      metadata: {
        generationState: 'error',
        errorMessage: error.message,
      },
    }

    const html = renderToStaticMarkup(
      <AssistantToolMessageGroupItem
        messages={[assistantMessage]}
        conversationId="conversation-1"
        isApplying={false}
        activeApplyRequestKey={null}
        onApply={() => {}}
        onToolMessageUpdate={() => {}}
        onEditStart={() => {}}
        onEditCancel={() => {}}
        onEditSave={() => {}}
        onDeleteGroup={() => {}}
        onRetryGroup={() => {}}
        onBranchGroup={() => {}}
        onQuoteAssistantSelection={() => {}}
        onOpenEditSummaryFile={() => {}}
      />,
    )

    expect(html).toContain(
      'The model service returned a response that cannot be parsed: missing choices array.',
    )
    expect(html).toContain('Stage: Kimi non-streaming response')
    expect(html).toContain('Upstream error: bad response')
    expect(html).not.toContain('YOLO_LLM_RESPONSE_FORMAT_ERROR')
  })

  it('enables retry action when the assistant group can be traced to a user message', () => {
    const assistantMessage: ChatAssistantMessage = {
      role: 'assistant',
      id: 'assistant-1',
      content: 'hello',
      metadata: {
        generationState: 'completed',
        sourceUserMessageId: 'user-1',
      },
    }

    renderToStaticMarkup(
      <AssistantToolMessageGroupItem
        messages={[assistantMessage]}
        conversationId="conversation-1"
        showRetryAction={true}
        isApplying={false}
        activeApplyRequestKey={null}
        onApply={() => {}}
        onToolMessageUpdate={() => {}}
        onEditStart={() => {}}
        onEditCancel={() => {}}
        onEditSave={() => {}}
        onDeleteGroup={() => {}}
        onRetryGroup={() => {}}
        onBranchGroup={() => {}}
        onQuoteAssistantSelection={() => {}}
        onOpenEditSummaryFile={() => {}}
      />,
    )

    expect(
      mockedAssistantToolMessageGroupActions.mock.calls.at(-1)?.[0],
    ).toEqual(
      expect.objectContaining({
        showRetry: true,
        onRetry: expect.any(Function),
      }),
    )
  })

  it('still shows retry action when the assistant group has no source user message', () => {
    const assistantMessage: ChatAssistantMessage = {
      role: 'assistant',
      id: 'assistant-1',
      content: 'hello',
      metadata: {
        generationState: 'completed',
      },
    }

    renderToStaticMarkup(
      <AssistantToolMessageGroupItem
        messages={[assistantMessage]}
        conversationId="conversation-1"
        showRetryAction={true}
        isApplying={false}
        activeApplyRequestKey={null}
        onApply={() => {}}
        onToolMessageUpdate={() => {}}
        onEditStart={() => {}}
        onEditCancel={() => {}}
        onEditSave={() => {}}
        onDeleteGroup={() => {}}
        onRetryGroup={() => {}}
        onBranchGroup={() => {}}
        onQuoteAssistantSelection={() => {}}
        onOpenEditSummaryFile={() => {}}
      />,
    )

    expect(
      mockedAssistantToolMessageGroupActions.mock.calls.at(-1)?.[0],
    ).toEqual(
      expect.objectContaining({
        showRetry: true,
        onRetry: expect.any(Function),
      }),
    )
  })

  it('does not preserve the rendered message height while editing a long group', () => {
    const assistantMessage: ChatAssistantMessage = {
      role: 'assistant',
      id: 'assistant-long',
      content: 'long response\n'.repeat(500),
      metadata: {
        generationState: 'completed',
      },
    }

    const html = renderToStaticMarkup(
      <AssistantToolMessageGroupItem
        messages={[assistantMessage]}
        conversationId="conversation-1"
        editingAssistantMessageId={assistantMessage.id}
        isApplying={false}
        activeApplyRequestKey={null}
        onApply={() => {}}
        onToolMessageUpdate={() => {}}
        onEditStart={() => {}}
        onEditCancel={() => {}}
        onEditSave={() => {}}
        onDeleteGroup={() => {}}
        onRetryGroup={() => {}}
        onBranchGroup={() => {}}
        onQuoteAssistantSelection={() => {}}
        onOpenEditSummaryFile={() => {}}
      />,
    )

    expect(html).toContain('yolo-assistant-group-editor')
    expect(html).not.toContain('min-height')
  })

  it('hides the footer while the owning foreground run is active', () => {
    const assistantMessage: ChatAssistantMessage = {
      role: 'assistant',
      id: 'assistant-1',
      content: 'tool calls are complete',
      metadata: {
        generationState: 'completed',
        sourceUserMessageId: 'user-1',
      },
    }

    const html = renderToStaticMarkup(
      <AssistantToolMessageGroupItem
        messages={[assistantMessage]}
        conversationId="conversation-1"
        conversationRunSummary={{
          conversationId: 'conversation-1',
          anchorMessageId: 'user-1',
          status: 'running',
          isRunning: true,
          isActive: true,
          isAbortable: true,
          isQueueable: true,
          isWaitingApproval: false,
          isWaitingUserInput: false,
        }}
        showRetryAction={true}
        isApplying={false}
        activeApplyRequestKey={null}
        onApply={() => {}}
        onToolMessageUpdate={() => {}}
        onEditStart={() => {}}
        onEditCancel={() => {}}
        onEditSave={() => {}}
        onDeleteGroup={() => {}}
        onRetryGroup={() => {}}
        onBranchGroup={() => {}}
        onQuoteAssistantSelection={() => {}}
        onOpenEditSummaryFile={() => {}}
      />,
    )

    expect(html).not.toContain('yolo-assistant-message-footer')
    expect(mockedAssistantToolMessageGroupActions).not.toHaveBeenCalled()
  })

  it('shows the footer for a completed branch while another branch is active', () => {
    const assistantMessage: ChatAssistantMessage = {
      role: 'assistant',
      id: 'assistant-1',
      content: 'branch complete',
      metadata: {
        generationState: 'completed',
        sourceUserMessageId: 'user-1',
        branchRunStatus: 'completed',
      },
    }

    const html = renderToStaticMarkup(
      <AssistantToolMessageGroupItem
        messages={[assistantMessage]}
        conversationId="conversation-1"
        conversationRunSummary={{
          conversationId: 'conversation-1',
          anchorMessageId: 'user-1',
          status: 'running',
          isRunning: true,
          isActive: true,
          isAbortable: true,
          isQueueable: true,
          isWaitingApproval: false,
          isWaitingUserInput: false,
        }}
        showRetryAction={true}
        isApplying={false}
        activeApplyRequestKey={null}
        onApply={() => {}}
        onToolMessageUpdate={() => {}}
        onEditStart={() => {}}
        onEditCancel={() => {}}
        onEditSave={() => {}}
        onDeleteGroup={() => {}}
        onRetryGroup={() => {}}
        onBranchGroup={() => {}}
        onQuoteAssistantSelection={() => {}}
        onOpenEditSummaryFile={() => {}}
      />,
    )

    expect(html).toContain('yolo-assistant-message-footer')
    expect(mockedAssistantToolMessageGroupActions).toHaveBeenCalledTimes(1)
  })

  describe('tool run collapsing', () => {
    const baseProps = {
      conversationId: 'conversation-1',
      isApplying: false,
      activeApplyRequestKey: null,
      onApply: () => {},
      onToolMessageUpdate: () => {},
      onEditStart: () => {},
      onEditCancel: () => {},
      onEditSave: () => {},
      onDeleteGroup: () => {},
      onRetryGroup: () => {},
      onBranchGroup: () => {},
      onQuoteAssistantSelection: () => {},
      onOpenEditSummaryFile: () => {},
    }

    const buildToolMessage = (
      id: string,
      calls: {
        name: string
        // Only the field-free response statuses; ones like Error carry
        // required payload fields this fixture never builds.
        status?:
          | ToolCallResponseStatus.PendingApproval
          | ToolCallResponseStatus.Running
          | ToolCallResponseStatus.AwaitingUserInput
        cliCapability?: 'command_execution' | 'file_change'
      }[],
    ): ChatToolMessage => ({
      role: 'tool',
      id,
      toolCalls: calls.map((call, index) => ({
        request: {
          id: `${id}-call-${index}`,
          name: call.name,
          ...(call.cliCapability
            ? {
                metadata: {
                  cliToolCall: {
                    runtimeId: 'codex' as const,
                    eventType: 'test',
                    name: call.name,
                    capability: call.cliCapability,
                  },
                },
              }
            : {}),
        },
        response: call.status
          ? { status: call.status }
          : {
              status: ToolCallResponseStatus.Success,
              data: { type: 'text', text: 'ok' },
            },
      })),
    })

    const hiddenAssistantMessage: ChatAssistantMessage = {
      role: 'assistant',
      id: 'assistant-hidden',
      content: '',
      metadata: { generationState: 'completed' },
    }

    const finalAssistantMessage: ChatAssistantMessage = {
      role: 'assistant',
      id: 'assistant-final',
      content: 'all done',
      metadata: { generationState: 'completed' },
    }

    it('collapses a settled tool run into a summary line', () => {
      const html = renderToStaticMarkup(
        <AssistantToolMessageGroupItem
          {...baseProps}
          messages={[
            hiddenAssistantMessage,
            buildToolMessage('tool-1', [
              { name: 'yolo_local__fs_read' },
              { name: 'yolo_local__fs_read' },
              { name: 'yolo_local__bash' },
            ]),
            finalAssistantMessage,
          ]}
        />,
      )

      expect(html).toContain('yolo-tool-run-summary')
      expect(html).toContain('Read 2 file(s)')
      expect(html).toContain('Virtual terminal 1 time(s)')
      expect(html).not.toContain('yolo-tool-run-summary__dot')
      expect(html).toContain('aria-expanded="false"')
    })

    it('folds interleaved thinking-only messages into the run without counting them', () => {
      const reasoningOnlyMessage: ChatAssistantMessage = {
        role: 'assistant',
        id: 'assistant-reasoning',
        content: '',
        reasoning: 'let me look around first',
        metadata: { generationState: 'completed' },
      }

      const html = renderToStaticMarkup(
        <AssistantToolMessageGroupItem
          {...baseProps}
          messages={[
            reasoningOnlyMessage,
            buildToolMessage('tool-1', [
              { name: 'yolo_local__fs_read' },
              { name: 'yolo_local__fs_list' },
            ]),
            finalAssistantMessage,
          ]}
        />,
      )

      // The thinking block is folded into the run but does not count as a
      // tool call toward the two-call threshold.
      expect(html).toContain('yolo-tool-run-summary')
      expect(html).toContain('Read 1 file(s)')
      expect(html).toContain('Searched 1 time(s)')
    })

    it('folds the answer message thinking block into the preceding collapsed run', () => {
      mockedAssistantMessageReasoning.mockClear()
      const finalWithReasoning: ChatAssistantMessage = {
        ...finalAssistantMessage,
        reasoning: 'now I can answer',
      }

      const html = renderToStaticMarkup(
        <AssistantToolMessageGroupItem
          {...baseProps}
          messages={[
            hiddenAssistantMessage,
            buildToolMessage('tool-1', [
              { name: 'yolo_local__fs_read' },
              { name: 'yolo_local__fs_read' },
            ]),
            finalWithReasoning,
          ]}
        />,
      )

      expect(html).toContain('yolo-tool-run-summary')
      expect(mockedAssistantMessageReasoning).not.toHaveBeenCalled()
    })

    it('summarizes a settled trailing tool run even while no answer follows', () => {
      const html = renderToStaticMarkup(
        <AssistantToolMessageGroupItem
          {...baseProps}
          messages={[
            hiddenAssistantMessage,
            buildToolMessage('tool-1', [
              { name: 'yolo_local__fs_read' },
              { name: 'yolo_local__fs_read' },
            ]),
          ]}
        />,
      )

      expect(html).toContain('yolo-tool-run-summary')
      expect(html).toContain('aria-expanded="false"')
    })

    it('keeps an active run expanded beneath its summary for pending approval', () => {
      const html = renderToStaticMarkup(
        <AssistantToolMessageGroupItem
          {...baseProps}
          messages={[
            hiddenAssistantMessage,
            buildToolMessage('tool-1', [
              { name: 'yolo_local__fs_read' },
              {
                name: 'yolo_local__bash',
                status: ToolCallResponseStatus.PendingApproval,
              },
            ]),
            finalAssistantMessage,
          ]}
        />,
      )

      expect(html).toContain('yolo-tool-run-summary')
      expect(html).toContain('aria-expanded="true"')
    })

    it('keeps an ordinary running tool run collapsed by default', () => {
      const html = renderToStaticMarkup(
        <AssistantToolMessageGroupItem
          {...baseProps}
          messages={[
            hiddenAssistantMessage,
            buildToolMessage('tool-1', [
              {
                name: 'yolo_local__bash',
                status: ToolCallResponseStatus.Running,
              },
              {
                name: 'yolo_local__js_eval',
                status: ToolCallResponseStatus.Running,
              },
            ]),
          ]}
        />,
      )

      expect(html).toContain('yolo-tool-run-summary')
      expect(html).toContain('aria-expanded="false"')
    })

    it('summarizes CLI capabilities instead of treating them as other actions', () => {
      const html = renderToStaticMarkup(
        <AssistantToolMessageGroupItem
          {...baseProps}
          messages={[
            hiddenAssistantMessage,
            buildToolMessage('tool-1', [
              { name: 'commandExecution', cliCapability: 'command_execution' },
              { name: 'fileChange', cliCapability: 'file_change' },
            ]),
          ]}
        />,
      )

      expect(html).toContain('Ran 1 command(s)')
      expect(html).toContain('Edited 1 file(s)')
      expect(html).not.toContain('other action')
    })
  })
})
