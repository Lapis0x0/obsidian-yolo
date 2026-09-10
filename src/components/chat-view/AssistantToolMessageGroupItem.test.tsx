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

const mockDiscoveredCatalogs: Record<string, unknown> = {}

jest.mock('../../contexts/settings-context', () => ({
  useSettings: () => ({
    settings: { mcp: { discoveredCatalogs: mockDiscoveredCatalogs } },
  }),
}))

jest.mock('../../database/edit-review/editReviewSnapshotStore', () => ({
  readEditReviewSnapshot: jest.fn(),
  readEditReviewSnapshots: jest.fn().mockResolvedValue([]),
}))

jest.mock('./AssistantEditSummary', () => ({
  __esModule: true,
  default: () => null,
  renderDeltaPair: (added: number, removed: number) => `+${added} -${removed}`,
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

// 摘要行把数字拆成了独立节点（换 key 重挂来重播落位动画），所以 HTML 里
// 「Read 2 file(s)」是被 span 切开的。检查文案的断言一律看去掉标签后的文本，
// 检查类名和属性的仍然看原始 HTML。
const summaryText = (html: string) => html.replace(/<[^>]*>/g, '')

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
        /** Path this call reports as edited, as a real edit tool would. */
        editedPath?: string
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
              data: {
                type: 'text',
                text: 'ok',
                ...(call.editedPath
                  ? {
                      metadata: {
                        editSummary: {
                          files: [
                            {
                              path: call.editedPath,
                              addedLines: 1,
                              removedLines: 0,
                              operation: 'edit' as const,
                              undoStatus: 'unavailable' as const,
                            },
                          ],
                          totalFiles: 1,
                          totalAddedLines: 1,
                          totalRemovedLines: 0,
                          undoStatus: 'unavailable' as const,
                        },
                      },
                    }
                  : {}),
              },
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
      expect(summaryText(html)).toContain('Read 2 file(s)')
      expect(summaryText(html)).toContain('Virtual terminal 1 time(s)')
      expect(html).toContain('aria-expanded="false"')
      // 段已落定，不该还挂着光流。
      expect(html).not.toContain('is-active')
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
              { name: 'yolo_local__web_search' },
            ]),
            finalAssistantMessage,
          ]}
        />,
      )

      // The thinking block is folded into the run but does not count as a
      // tool call toward the two-call threshold.
      expect(html).toContain('yolo-tool-run-summary')
      expect(summaryText(html)).toContain('Read 1 file(s)')
      expect(summaryText(html)).toContain('1 web lookup(s)')
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

    // 这一组守的是折叠行的高度稳定性：一轮工具跑起来之后，模型每多调一次
    // 工具，都不能让折叠行之外多出一个节点——「现在在做什么」必须由折叠行
    // 自己说出来，而不是在它下面临时长出一行再收回去。
    it('folds an in-flight tool request into the run instead of ending it', () => {
      const requestingAssistantMessage: ChatAssistantMessage = {
        role: 'assistant',
        id: 'assistant-requesting',
        content: '',
        toolCallRequests: [
          { id: 'call-next', name: 'yolo_local__vault_search' },
        ],
        metadata: { generationState: 'streaming' },
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
            requestingAssistantMessage,
          ]}
        />,
      )

      // 仍然只有一个段，且它知道自己还在跑。若请求消息切断了段，这一段会被
      // 当成已落定，光流就不会挂上。
      expect(summaryText(html)).toContain('Read 2 file(s)')
      expect(html).toContain('is-active')
    })

    it('counts an in-flight request toward the threshold that materializes the summary', () => {
      const requestingAssistantMessage: ChatAssistantMessage = {
        role: 'assistant',
        id: 'assistant-requesting',
        content: '',
        toolCallRequests: [
          { id: 'call-next', name: 'yolo_local__vault_search' },
        ],
        metadata: { generationState: 'streaming' },
      }

      const html = renderToStaticMarkup(
        <AssistantToolMessageGroupItem
          {...baseProps}
          messages={[
            hiddenAssistantMessage,
            buildToolMessage('tool-1', [{ name: 'yolo_local__fs_read' }]),
            requestingAssistantMessage,
          ]}
        />,
      )

      // 一次已完成 + 一次在途 = 这一轮已经是复数，折叠行现在就该就位；等到
      // 第二条工具消息落地才成立的话，中间那一拍整块内容会先被顶下去一行。
      expect(html).toContain('yolo-tool-run-summary')
      expect(summaryText(html)).toContain('Read 1 file(s)')
      expect(html).toContain('is-active')
    })

    it('tallies a still-running call up front without restating it', () => {
      const html = renderToStaticMarkup(
        <AssistantToolMessageGroupItem
          {...baseProps}
          messages={[
            hiddenAssistantMessage,
            buildToolMessage('tool-1', [
              { name: 'yolo_local__fs_read' },
              {
                name: 'yolo_local__fs_read',
                status: ToolCallResponseStatus.Running,
              },
            ]),
          ]}
        />,
      )

      // 文字从调用进段的那一刻起就是终值，不会等它落定再被改写一次；在跑与否
      // 只体现为 is-active，不往行里添任何内容。
      expect(summaryText(html)).toContain('Read 2 file(s)')
      expect(html).toContain('is-active')
    })

    it('keeps the summary text identical while a turn opens with an empty shell', () => {
      const openingShellMessage: ChatAssistantMessage = {
        role: 'assistant',
        id: 'assistant-shell',
        content: '',
        metadata: { generationState: 'streaming' },
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
            openingShellMessage,
          ]}
        />,
      )

      // 新一轮刚开、还没吐出任何请求：折叠行的文字与落定时逐字相同，只是挂上
      // 光流——而不是在它下面长出一个思考占位行再收回去。
      expect(summaryText(html)).toContain('Read 2 file(s)')
      expect(html).toContain('is-active')
    })

    it('gives each count its own node so a change can replay its animation', () => {
      const html = renderToStaticMarkup(
        <AssistantToolMessageGroupItem
          {...baseProps}
          messages={[
            hiddenAssistantMessage,
            buildToolMessage('tool-1', [
              { name: 'yolo_local__fs_read' },
              { name: 'yolo_local__fs_read' },
              { name: 'yolo_local__vault_search' },
            ]),
            finalAssistantMessage,
          ]}
        />,
      )

      // 数字必须是独立节点：它靠自己的 key 重挂来重播落位动画，插值成一整串
      // 文案就没有可以重挂的东西了。文案本身仍要完整、顺序不变。
      expect(html).toContain('yolo-tool-run-summary__count')
      expect(html).toMatch(
        /Read <span class="yolo-tool-run-summary__count">2<\/span> file\(s\)/,
      )
      expect(summaryText(html)).toContain('Read 2 file(s)')
      expect(summaryText(html)).toContain('Searched 1 time(s)')
    })

    it("gives Max's native file tools the same verbs as the vault toolset", () => {
      const html = renderToStaticMarkup(
        <AssistantToolMessageGroupItem
          {...baseProps}
          messages={[
            hiddenAssistantMessage,
            buildToolMessage('tool-1', [
              { name: 'yolo_local__read_file' },
              { name: 'yolo_local__write_file' },
            ]),
            finalAssistantMessage,
          ]}
        />,
      )

      expect(summaryText(html)).toContain('Read 1 file(s)')
      expect(summaryText(html)).toContain('Edited 1 file(s)')
      expect(summaryText(html)).not.toContain('other action')
    })

    it('counts an edit once when the run also reports an edit summary', () => {
      const html = renderToStaticMarkup(
        <AssistantToolMessageGroupItem
          {...baseProps}
          messages={[
            hiddenAssistantMessage,
            buildToolMessage('tool-1', [
              { name: 'yolo_local__write_file', editedPath: 'a.md' },
              { name: 'yolo_local__edit_file', editedPath: 'b.md' },
            ]),
            finalAssistantMessage,
          ]}
        />,
      )

      // The edit summary names the files, so the `edit` bucket stays silent —
      // and the calls must not resurface as unclassified "other actions".
      expect(summaryText(html)).toContain('Edited 2 file(s)')
      expect(summaryText(html)).not.toContain('other action')
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

      expect(summaryText(html)).toContain('Ran 1 command(s)')
      expect(summaryText(html)).toContain('Edited 1 file(s)')
      expect(summaryText(html)).not.toContain('other action')
    })

    it('summarizes MCP and module calls by tool set rather than lumping them into other', () => {
      const html = renderToStaticMarkup(
        <AssistantToolMessageGroupItem
          {...baseProps}
          messages={[
            hiddenAssistantMessage,
            buildToolMessage('tool-1', [
              { name: 'deepwiki__read_wiki_structure' },
              { name: 'deepwiki__read_wiki_contents' },
              { name: 'whiteboard__add_card' },
            ]),
          ]}
        />,
      )

      expect(summaryText(html)).toContain('deepwiki 2 time(s)')
      // A lone call names the tool: "whiteboard 1 time" says nothing. The tool
      // name renders one layer down from the set name, so it carries its own
      // span rather than being part of the surrounding text.
      expect(summaryText(html)).toContain('whiteboard ·')
      expect(html).toContain(
        '<span class="yolo-tool-run-summary__tool">add_card</span>',
      )
      expect(summaryText(html)).not.toContain('other action')
    })

    it('names a tool set the way the server reports itself, as <tool_catalog> does', () => {
      mockDiscoveredCatalogs.cf = {
        toolNames: ['search_docs', 'read_docs'],
        serverInfo: { name: 'cloudflare-docs', title: 'Cloudflare Docs' },
      }
      try {
        const html = renderToStaticMarkup(
          <AssistantToolMessageGroupItem
            {...baseProps}
            messages={[
              hiddenAssistantMessage,
              buildToolMessage('tool-1', [
                { name: 'cf__search_docs' },
                { name: 'cf__read_docs' },
              ]),
            ]}
          />,
        )
        expect(summaryText(html)).toContain('Cloudflare Docs 2 time(s)')
      } finally {
        delete mockDiscoveredCatalogs.cf
      }
    })

    it('does not read a host verb into an MCP tool that shares its name', () => {
      const html = renderToStaticMarkup(
        <AssistantToolMessageGroupItem
          {...baseProps}
          messages={[
            hiddenAssistantMessage,
            buildToolMessage('tool-1', [
              { name: 'someserver__fs_read' },
              { name: 'someserver__fs_edit' },
            ]),
          ]}
        />,
      )

      expect(summaryText(html)).toContain('someserver 2 time(s)')
      expect(summaryText(html)).not.toContain('Read 1 file(s)')
      expect(summaryText(html)).not.toContain('Edited 1 file(s)')
    })
  })
})
