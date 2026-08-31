import { ToolCallResponseStatus } from '../../types/tool-call.types'

import {
  hasMatchingToolMessageForRequests,
  shouldRenderAssistantToolPreview,
} from './assistantToolPreview'

describe('assistantToolPreview helpers', () => {
  it('keeps the assistant tool preview visible until a tool message arrives', () => {
    expect(
      shouldRenderAssistantToolPreview({
        generationState: 'completed',
        toolCallRequestCount: 1,
        hasToolMessages: false,
      }),
    ).toBe(true)
  })

  it('shows the assistant tool preview while the assistant is still streaming', () => {
    expect(
      shouldRenderAssistantToolPreview({
        generationState: 'streaming',
        toolCallRequestCount: 2,
        hasToolMessages: false,
      }),
    ).toBe(true)
  })

  it('hides the preview once the real tool message is rendered', () => {
    expect(
      shouldRenderAssistantToolPreview({
        generationState: 'completed',
        toolCallRequestCount: 1,
        hasToolMessages: true,
      }),
    ).toBe(false)
  })

  it('does not render the preview for aborted or empty tool states', () => {
    expect(
      shouldRenderAssistantToolPreview({
        generationState: 'aborted',
        toolCallRequestCount: 1,
        hasToolMessages: false,
      }),
    ).toBe(false)

    expect(
      shouldRenderAssistantToolPreview({
        generationState: 'completed',
        toolCallRequestCount: 0,
        hasToolMessages: false,
      }),
    ).toBe(false)
  })

  it('finds a real tool card for the assistant request ids even when it is not the next message', () => {
    expect(
      hasMatchingToolMessageForRequests(
        ['call-1'],
        [
          {
            role: 'assistant',
            id: 'request-1',
            content: '',
            toolCallRequests: [{ id: 'call-1', name: 'ls' }],
          },
          {
            role: 'assistant',
            id: 'request-2',
            content: '',
            toolCallRequests: [{ id: 'call-2', name: 'search' }],
          },
          {
            role: 'tool',
            id: 'tool-1',
            toolCalls: [
              {
                request: { id: 'call-1', name: 'ls' },
                response: {
                  status: ToolCallResponseStatus.Success,
                  data: { type: 'text', text: 'ok' },
                },
              },
            ],
          },
        ],
      ),
    ).toBe(true)
    expect(hasMatchingToolMessageForRequests(['call-9'], [])).toBe(false)
  })
})
