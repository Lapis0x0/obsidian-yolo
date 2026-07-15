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
  default: () => null,
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
import type { ChatAssistantMessage } from '../../types/chat'

import AssistantToolMessageGroupActions from './AssistantToolMessageGroupActions'
import AssistantToolMessageGroupItem from './AssistantToolMessageGroupItem'

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
})
