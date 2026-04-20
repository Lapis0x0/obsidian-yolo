import {
  ToolCallResponseStatus,
  createCompleteToolCallArguments,
} from '../../types/tool-call.types'
import { McpManager } from '../mcp/mcpManager'

import { AgentToolGateway } from './tool-gateway'

describe('AgentToolGateway', () => {
  const emptyArgs = createCompleteToolCallArguments({ value: {} })

  it('auto executes tools with full access', () => {
    const mcpManager = {
      isToolExecutionAllowed: jest.fn().mockReturnValue(true),
    } as unknown as McpManager

    const gateway = new AgentToolGateway(mcpManager, {
      allowedToolNames: ['server__tool_a'],
      toolPreferences: {
        server__tool_a: {
          enabled: true,
          approvalMode: 'full_access',
        },
      },
    })

    const message = gateway.createToolMessage({
      toolCallRequests: [
        { id: 'tool-1', name: 'server__tool_a', arguments: emptyArgs },
      ],
      conversationId: 'conv-1',
    })

    expect(message.toolCalls[0]?.response.status).toBe(
      ToolCallResponseStatus.Running,
    )
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest mock function accessed for assertion
    const isToolExecutionAllowedMock = mcpManager.isToolExecutionAllowed
    expect(isToolExecutionAllowedMock).toHaveBeenCalledWith({
      requestToolName: 'server__tool_a',
      conversationId: 'conv-1',
      requestArgs: {},
      requireAutoExecution: true,
    })
  })

  it('keeps tools pending when approval is required', () => {
    const mcpManager = {
      isToolExecutionAllowed: jest.fn().mockReturnValue(false),
    } as unknown as McpManager

    const gateway = new AgentToolGateway(mcpManager, {
      allowedToolNames: ['server__tool_a'],
      toolPreferences: {
        server__tool_a: {
          enabled: true,
          approvalMode: 'require_approval',
        },
      },
    })

    const message = gateway.createToolMessage({
      toolCallRequests: [
        { id: 'tool-1', name: 'server__tool_a', arguments: emptyArgs },
      ],
      conversationId: 'conv-1',
    })

    expect(message.toolCalls[0]?.response.status).toBe(
      ToolCallResponseStatus.PendingApproval,
    )
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest mock function accessed for assertion
    const isToolExecutionAllowedMock = mcpManager.isToolExecutionAllowed
    expect(isToolExecutionAllowedMock).toHaveBeenCalledWith({
      requestToolName: 'server__tool_a',
      conversationId: 'conv-1',
      requestArgs: {},
      requireAutoExecution: false,
    })
  })

  it('allows conversation-level approval to bypass per-tool approval', () => {
    const mcpManager = {
      isToolExecutionAllowed: jest.fn().mockReturnValue(true),
    } as unknown as McpManager

    const gateway = new AgentToolGateway(mcpManager, {
      allowedToolNames: ['server__tool_a'],
      toolPreferences: {
        server__tool_a: {
          enabled: true,
          approvalMode: 'require_approval',
        },
      },
    })

    const message = gateway.createToolMessage({
      toolCallRequests: [
        { id: 'tool-1', name: 'server__tool_a', arguments: emptyArgs },
      ],
      conversationId: 'conv-1',
    })

    expect(message.toolCalls[0]?.response.status).toBe(
      ToolCallResponseStatus.Running,
    )
  })

  it('runs fs_edit immediately when approval mode requires review', async () => {
    const mcpManager = {
      isToolExecutionAllowed: jest.fn().mockReturnValue(false),
      callTool: jest.fn().mockResolvedValue({
        status: ToolCallResponseStatus.Success,
        data: { type: 'text', text: '{}' },
      }),
    } as unknown as McpManager

    const gateway = new AgentToolGateway(mcpManager, {
      allowedToolNames: ['yolo_local__fs_edit'],
      toolPreferences: {
        yolo_local__fs_edit: {
          enabled: true,
          approvalMode: 'require_approval',
        },
      },
    })

    const message = gateway.createToolMessage({
      toolCallRequests: [
        { id: 'tool-1', name: 'yolo_local__fs_edit', arguments: emptyArgs },
      ],
      conversationId: 'conv-1',
    })

    expect(message.toolCalls[0]?.response.status).toBe(
      ToolCallResponseStatus.Running,
    )

    await gateway.executeAutoToolCalls({
      toolMessage: message,
      conversationId: 'conv-1',
    })

    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest mock function accessed for assertion
    const callToolMock = mcpManager.callTool
    expect(callToolMock).toHaveBeenCalledWith({
      name: 'yolo_local__fs_edit',
      args: {},
      id: 'tool-1',
      conversationId: 'conv-1',
      conversationMessages: undefined,
      roundId: message.id,
      requireReview: true,
      signal: undefined,
    })
  })

  it('rejects tool calls when tools are disabled', () => {
    const mcpManager = {
      isToolExecutionAllowed: jest.fn(),
    } as unknown as McpManager

    const gateway = new AgentToolGateway(mcpManager, {
      toolsEnabled: false,
      allowedToolNames: ['server__tool_a'],
    })

    const message = gateway.createToolMessage({
      toolCallRequests: [
        { id: 'tool-1', name: 'server__tool_a', arguments: emptyArgs },
      ],
      conversationId: 'conv-1',
    })

    expect(message.toolCalls[0]?.response.status).toBe(
      ToolCallResponseStatus.Rejected,
    )
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest mock function accessed for assertion
    const isToolExecutionAllowedMock = mcpManager.isToolExecutionAllowed
    expect(isToolExecutionAllowedMock).not.toHaveBeenCalled()
  })

  it('merges sibling fs_edit calls targeting the same path into one batched invocation', async () => {
    const callTool = jest.fn().mockResolvedValue({
      status: ToolCallResponseStatus.Success,
      data: { type: 'text', text: '{"tool":"fs_edit"}' },
    })
    const mcpManager = {
      isToolExecutionAllowed: jest.fn().mockReturnValue(true),
      callTool,
    } as unknown as McpManager

    const gateway = new AgentToolGateway(mcpManager, {
      allowedToolNames: ['yolo_local__fs_edit'],
      toolPreferences: {
        yolo_local__fs_edit: {
          enabled: true,
          approvalMode: 'full_access',
        },
      },
    })

    const message = gateway.createToolMessage({
      toolCallRequests: [
        {
          id: 'tool-1',
          name: 'yolo_local__fs_edit',
          arguments: createCompleteToolCallArguments({
            value: {
              path: 'note.md',
              operation: {
                type: 'replace',
                oldText: 'foo',
                newText: 'FOO',
              },
            },
          }),
        },
        {
          id: 'tool-2',
          name: 'yolo_local__fs_edit',
          arguments: createCompleteToolCallArguments({
            value: {
              path: 'note.md',
              operation: {
                type: 'replace',
                oldText: 'bar',
                newText: 'BAR',
              },
            },
          }),
        },
        {
          id: 'tool-3',
          name: 'yolo_local__fs_edit',
          arguments: createCompleteToolCallArguments({
            value: {
              path: 'other.md',
              operation: {
                type: 'append',
                content: 'tail',
              },
            },
          }),
        },
      ],
      conversationId: 'conv-1',
    })

    const result = await gateway.executeAutoToolCalls({
      toolMessage: message,
      conversationId: 'conv-1',
    })

    // Two distinct invocations: one batched for note.md, one for other.md.
    expect(callTool).toHaveBeenCalledTimes(2)
    const noteCall = callTool.mock.calls.find(
      ([args]: [{ args?: { path?: string } }]) => args.args?.path === 'note.md',
    )
    expect(noteCall).toBeDefined()
    expect(noteCall![0].id).toBe('tool-1')
    expect(noteCall![0].args).toEqual({
      path: 'note.md',
      operations: [
        { type: 'replace', oldText: 'foo', newText: 'FOO' },
        { type: 'replace', oldText: 'bar', newText: 'BAR' },
      ],
    })

    // All three tool calls resolve to Success.
    expect(result.toolCalls.map((call) => call.response.status)).toEqual([
      ToolCallResponseStatus.Success,
      ToolCallResponseStatus.Success,
      ToolCallResponseStatus.Success,
    ])

    // The leader carries the full response; followers get a batch note.
    const followerResponse = result.toolCalls[1].response
    if (followerResponse.status === ToolCallResponseStatus.Success) {
      expect(followerResponse.data.text).toContain('batched fs_edit')
      expect(followerResponse.data.text).toContain('note.md')
    }
  })

  it('rejects tool calls outside the allowed tool list', () => {
    const mcpManager = {
      isToolExecutionAllowed: jest.fn(),
    } as unknown as McpManager

    const gateway = new AgentToolGateway(mcpManager, {
      allowedToolNames: ['server__tool_a'],
    })

    const message = gateway.createToolMessage({
      toolCallRequests: [
        { id: 'tool-1', name: 'server__tool_b', arguments: emptyArgs },
      ],
      conversationId: 'conv-1',
    })

    expect(message.toolCalls[0]?.response.status).toBe(
      ToolCallResponseStatus.Rejected,
    )
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest mock function accessed for assertion
    const isToolExecutionAllowedMock = mcpManager.isToolExecutionAllowed
    expect(isToolExecutionAllowedMock).not.toHaveBeenCalled()
  })
})
